//! The team space on the phone (ADR 033, ADR 040): a second database beside the personal
//! one, opened when the server says this phone's token belongs to a member, synced after
//! each personal round, and closed (its copy deleted) when the membership ends.
//!
//! Every read and write goes through the core's [`Spaces`]: reads see both spaces as one,
//! the way the desktop merges them, and a write lands in the space that owns its rows.

use std::collections::HashSet;
use std::ops::Deref;
use std::path::PathBuf;
use std::sync::Weak;

use taskmaster_client::{Client, Files};
use taskmaster_core::{
    ATTACHMENTS_DIR, Changes, Command, Id, Member, Snapshot, Space, Spaces, SpacesHistory, Status,
    Store, TeamInfo,
};

use crate::{AppError, AppResult, DATABASE, Inner, lock};

/// The team space's folder inside the app's, holding its database and attachments.
const TEAM_DIR: &str = "team";
/// Who this copy of the team space writes as, so it opens offline at the next start.
const TEAM_MEMBER: &str = "member.json";

pub(crate) type Borrowed<'a> = Spaces<&'a mut Store, &'a mut Store, &'a mut SpacesHistory>;

/// Both spaces' live rows as one snapshot, as the desktop merges them: the team's tasks,
/// projects, epics, tags, attachments, notes and comments next to the personal ones, team
/// tasks carrying this person's Today picks. Statuses are the personal workflow's plus
/// any the team added (the defaults share their ids in every space).
pub(crate) struct Data {
    pub snapshot: Snapshot,
    /// Ids of the rows that live in the team space.
    pub team_ids: HashSet<Id>,
    /// The team's statuses, in its order; empty without a team.
    pub team_statuses: Vec<Status>,
    /// Statuses only the team has (left out of personal boards and pickers).
    pub team_only_statuses: HashSet<Id>,
    pub members: Vec<Member>,
    /// The team, and the member this phone writes as; `None` without a team.
    pub team: Option<TeamInfo>,
}

impl Deref for Data {
    type Target = Snapshot;
    fn deref(&self) -> &Snapshot {
        &self.snapshot
    }
}

impl Data {
    pub fn is_team(&self, id: &str) -> bool {
        self.team_ids.contains(id)
    }

    /// The member this phone writes as in the team space.
    pub fn me(&self) -> Option<&str> {
        self.team
            .as_ref()
            .and_then(|t| t.me.as_ref())
            .map(|m| m.id.as_str())
    }

    pub fn member_name(&self, id: &str) -> Option<String> {
        self.members
            .iter()
            .find(|m| m.id == id)
            .map(|m| m.name.clone())
    }

    /// The statuses a task can take: the team's for a team task, else the personal ones.
    pub fn statuses_for(&self, task_id: &str) -> Vec<&Status> {
        if self.is_team(task_id) {
            self.team_statuses.iter().collect()
        } else {
            self.personal_statuses()
        }
    }

    /// The personal workflow, without statuses only the team has.
    pub fn personal_statuses(&self) -> Vec<&Status> {
        self.snapshot
            .statuses
            .iter()
            .filter(|s| !self.team_only_statuses.contains(&s.id))
            .collect()
    }
}

fn merge<T>(mine: &mut Vec<T>, theirs: Vec<T>, id: impl Fn(&T) -> &str, ids: &mut HashSet<Id>) {
    let team: HashSet<String> = theirs.iter().map(|t| id(t).to_owned()).collect();
    mine.retain(|t| !team.contains(id(t)));
    ids.extend(team);
    mine.extend(theirs);
}

impl Inner {
    /// Runs `f` over both spaces, locking history, then the personal store, then the
    /// team's: the one order every caller keeps (the desktop's too).
    pub(crate) fn with_spaces<T>(
        &self,
        f: impl FnOnce(&mut Borrowed<'_>) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut history = lock(&self.history);
        let mut store = lock(&self.store);
        let mut team = lock(&self.team);
        let mut spaces = Spaces::borrowed(&mut store, team.as_mut(), &mut history);
        f(&mut spaces)
    }

    /// Both spaces as one, for reading.
    pub(crate) fn data(&self) -> AppResult<Data> {
        let info = lock(&self.team_info).clone();
        self.with_spaces(|spaces| {
            let mut snapshot = spaces.snapshot()?;
            let mut data = Data {
                team_ids: HashSet::new(),
                team_statuses: Vec::new(),
                team_only_statuses: HashSet::new(),
                members: Vec::new(),
                team: None,
                snapshot: Snapshot::default(),
            };
            if let Some(team) = spaces.team_snapshot()? {
                let ids = &mut data.team_ids;
                merge(&mut snapshot.tasks, team.tasks, |t| &t.id, ids);
                merge(&mut snapshot.projects, team.projects, |t| &t.id, ids);
                merge(&mut snapshot.epics, team.epics, |t| &t.id, ids);
                merge(&mut snapshot.tags, team.tags, |t| &t.id, ids);
                merge(&mut snapshot.attachments, team.attachments, |t| &t.id, ids);
                merge(&mut snapshot.notes, team.notes, |t| &t.id, ids);
                merge(
                    &mut snapshot.note_folders,
                    team.note_folders,
                    |t| &t.id,
                    ids,
                );
                merge(&mut snapshot.comments, team.comments, |t| &t.id, ids);
                for status in &team.statuses {
                    if !snapshot.statuses.iter().any(|s| s.id == status.id) {
                        data.team_only_statuses.insert(status.id.clone());
                        snapshot.statuses.push(status.clone());
                    }
                }
                data.team_statuses = team.statuses;
                data.members = team.members;
                data.team = info;
            }
            data.snapshot = snapshot;
            Ok(data)
        })
    }

    /// Runs `commands` as one undoable edit in the spaces that own their rows. `space`
    /// says where rows without a container go (a tag, an Inbox task); `None` is personal.
    pub(crate) fn execute(
        &self,
        commands: Vec<Command>,
        space: Option<Space>,
    ) -> AppResult<Changes> {
        self.with_spaces(|spaces| Ok(spaces.execute(commands, space)?))
    }

    pub(crate) fn team_dir(&self) -> PathBuf {
        self.dir.join(TEAM_DIR)
    }

    /// Opens this phone's copy of the team space at start, before any server is reached,
    /// so team work is there offline. Nothing happens without a saved copy.
    pub(crate) fn open_saved_team(&self) {
        let saved = std::fs::read(self.team_dir().join(TEAM_MEMBER))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<TeamInfo>(&bytes).ok())
            .filter(|t| t.me.is_some());
        if let Some(info) = saved
            && let Err(e) = self.open_team(info)
        {
            eprintln!("cannot open the team space: {e}");
        }
    }

    /// Opens the team space when the server runs one this phone's token is a member of,
    /// and closes it when it does not. Returns whether there is a team to sync.
    pub(crate) fn follow_team(&self, info: Option<&TeamInfo>) -> Result<bool, String> {
        let Some(info) = info.filter(|t| t.me.is_some()) else {
            self.close_team();
            return Ok(false);
        };
        let me = info.me.as_ref().map(|m| m.id.as_str());
        let same_member = lock(&self.team)
            .as_ref()
            .is_some_and(|store| store.author() == me);
        if same_member {
            // The team may have been renamed: keep what the server says.
            *lock(&self.team_info) = Some(info.clone());
            self.engine.set_team(Some(info.clone()));
            return Ok(true);
        }
        // Another member's token now: their copy is not this one's.
        self.close_team();
        self.open_team(info.clone())
            .map_err(|e| format!("cannot open the team space: {e}"))?;
        Ok(true)
    }

    fn open_team(&self, info: TeamInfo) -> AppResult<()> {
        let Some(me) = info.me.clone() else {
            return Ok(());
        };
        let dir = self.team_dir();
        std::fs::create_dir_all(&dir).map_err(|e| AppError::internal(e.to_string()))?;
        let mut store = Store::open(dir.join(DATABASE))?.with_files(dir.join(ATTACHMENTS_DIR));
        let json =
            serde_json::to_vec_pretty(&info).map_err(|e| AppError::internal(e.to_string()))?;
        let tmp = dir.join(format!("{TEAM_MEMBER}.tmp"));
        std::fs::write(&tmp, json).map_err(|e| AppError::internal(e.to_string()))?;
        std::fs::rename(&tmp, dir.join(TEAM_MEMBER))
            .map_err(|e| AppError::internal(e.to_string()))?;
        store.set_author(Some(me.id));
        // Repairs are the personal space's job; the team space takes what the server has.
        store.set_repairs(false);
        let changes = store.subscribe();
        *lock(&self.team) = Some(store);
        *lock(&self.team_info) = Some(info.clone());
        self.engine.set_team(Some(info));
        let weak: Weak<Inner> = self.this.clone();
        std::thread::Builder::new()
            .name("team-events".into())
            .spawn(move || {
                for _changed in changes {
                    let Some(inner) = weak.upgrade() else { return };
                    inner.engine.local_change();
                    if let Some(listener) = inner.listener() {
                        listener.data_changed();
                    }
                }
            })
            .map_err(|e| AppError::internal(e.to_string()))?;
        if let Some(listener) = self.listener() {
            listener.data_changed();
        }
        Ok(())
    }

    /// Closes the team space and deletes this phone's copy: the server keeps the team's
    /// data, and joining again pulls it back. The undo history forgets its part.
    pub(crate) fn close_team(&self) {
        let closed = {
            let mut history = lock(&self.history);
            let mut team = lock(&self.team);
            history.forget_team();
            team.take()
        };
        *lock(&self.team_info) = None;
        self.engine.set_team(None);
        if closed.is_none() {
            return;
        }
        drop(closed); // closes the database before its folder goes
        let dir = self.team_dir();
        if let Err(e) = std::fs::remove_dir_all(&dir)
            && e.kind() != std::io::ErrorKind::NotFound
        {
            eprintln!("cannot delete {}: {e}", dir.display());
        }
        if let Some(listener) = self.listener() {
            listener.data_changed();
        }
    }

    /// One round for the team space, after the personal one. A refused token (the member
    /// was removed) closes the team space.
    pub(crate) fn sync_team(&self, client: &Client) -> Result<(), String> {
        let info = client.info().map_err(|e| e.to_string())?;
        if !self.follow_team(info.team.as_ref())? {
            return Ok(());
        }
        match taskmaster_client::sync_with(&client.team(), &self.team, Files::OnDemand) {
            Ok(_) => Ok(()),
            Err(taskmaster_client::Error::Unauthorized(_)) => {
                self.close_team();
                Ok(())
            }
            Err(e) => Err(format!("team: {e}")),
        }
    }

    /// The attachment folder of a space (the team's for team rows).
    pub(crate) fn files(&self, team: bool) -> Option<taskmaster_core::FileStore> {
        if team {
            lock(&self.team).as_ref()?.files().ok().cloned()
        } else {
            lock(&self.store).files().ok().cloned()
        }
    }

    /// Local team changes not on the server yet.
    pub(crate) fn team_pending(&self) -> u32 {
        lock(&self.team).as_ref().map_or(0, |store| {
            store
                .outbox(1000)
                .map(|p| u32::try_from(p.ops.len()).unwrap_or(u32::MAX))
                .unwrap_or(0)
        })
    }
}
