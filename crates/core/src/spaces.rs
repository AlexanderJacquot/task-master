//! Spaces (docs/adr/033-team-spaces.md): the personal database and, when the server runs
//! with `TM_TEAM=on`, the team's. Each is a whole [`Store`] (its own ops log, clocks and
//! sync cursors); this layer routes commands to the space that owns their rows, merges
//! reads, and keeps one undo history across both.
//!
//! Without a team it is a pass-through over the personal store.
//!
//! Rules:
//! - Every row lives in exactly one space. A personal row may point at a team row (a time
//!   block, an agent session, a meeting, a note or a terminal session on a team task); a
//!   team row never points at a personal one.
//! - A team task's Today pick is personal: front ends write `today_on` on any task, and
//!   for a team task it becomes a [`TaskMark`] in the personal space. Front ends read it
//!   back as the task's `today_on`.
//! - Each command writes one space. A batch whose commands belong to both is run as one
//!   batch per space (team first, so personal rows can point at rows it creates), and
//!   undone together.

use std::borrow::{Borrow, BorrowMut};
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::commands::{Command, NewAttachment, NewEpic, NewProject, NewTag, NewTask, TaskChange};
use crate::error::{Error, Result};
use crate::model::{Id, Snapshot, Space, StatusCategory, Task};
use crate::notes::NewNote;
use crate::store::{Changes, Store};

/// The spaces' shared undo history: which spaces each undoable action wrote. Adapters
/// that keep their stores apart (each behind its own lock) keep one of these next to them
/// and build a borrowed [`Spaces`] for each call.
#[derive(Debug, Default)]
pub struct SpacesHistory {
    /// Oldest first; one entry per action.
    undo: Vec<Vec<Space>>,
    redo: Vec<Vec<Space>>,
}

impl SpacesHistory {
    /// Forgets the team's part of every action (the team space is gone).
    pub fn forget_team(&mut self) {
        for stack in [&mut self.undo, &mut self.redo] {
            for action in stack.iter_mut() {
                action.retain(|s| *s == Space::Personal);
            }
            stack.retain(|a| !a.is_empty());
        }
    }
}

/// The user's spaces: owned stores ([`Spaces::new`]), or stores an adapter holds and lends
/// for one call ([`Spaces::borrowed`]).
pub struct Spaces<P = Store, T = Store, H = SpacesHistory> {
    personal: P,
    team: Option<T>,
    history: H,
}

impl Spaces {
    pub fn new(personal: Store) -> Self {
        Self {
            personal,
            team: None,
            history: SpacesHistory::default(),
        }
    }
}

impl<'a> Spaces<&'a mut Store, &'a mut Store, &'a mut SpacesHistory> {
    /// Spaces over stores the caller holds (locked) for the length of one call.
    pub fn borrowed(
        personal: &'a mut Store,
        team: Option<&'a mut Store>,
        history: &'a mut SpacesHistory,
    ) -> Self {
        Self {
            personal,
            team,
            history,
        }
    }
}

impl<P, T, H> Spaces<P, T, H>
where
    P: BorrowMut<Store>,
    T: BorrowMut<Store>,
    H: BorrowMut<SpacesHistory>,
{
    pub fn personal(&self) -> &Store {
        self.personal.borrow()
    }

    pub fn personal_mut(&mut self) -> &mut Store {
        self.personal.borrow_mut()
    }

    pub fn team(&self) -> Option<&Store> {
        self.team.as_ref().map(Borrow::borrow)
    }

    pub fn team_mut(&mut self) -> Option<&mut Store> {
        self.team.as_mut().map(BorrowMut::borrow_mut)
    }

    pub fn has_team(&self) -> bool {
        self.team.is_some()
    }

    fn hist(&self) -> &SpacesHistory {
        self.history.borrow()
    }

    fn hist_mut(&mut self) -> &mut SpacesHistory {
        self.history.borrow_mut()
    }

    /// The store of `space`; an error for the team when there is none.
    pub fn store(&self, space: Space) -> Result<&Store> {
        match space {
            Space::Personal => Ok(self.personal()),
            Space::Team => self.team().ok_or_else(no_team),
        }
    }

    pub fn store_mut(&mut self, space: Space) -> Result<&mut Store> {
        match space {
            Space::Personal => Ok(self.personal_mut()),
            Space::Team => self.team_mut().ok_or_else(no_team),
        }
    }

    /// Adds the team space (its database opened by the adapter).
    pub fn attach_team(&mut self, team: T) {
        self.team = Some(team);
    }

    /// Removes the team space (the user left the team, or the server turned it off), and
    /// forgets its part of the undo history.
    pub fn detach_team(&mut self) -> Option<T> {
        self.hist_mut().forget_team();
        self.team.take()
    }

    /// The space whose database holds the row `id`, preferring a live copy (a row shared
    /// to the team stays deleted in the personal space under the same id).
    pub fn space_of(&self, id: &str) -> Result<Option<Space>> {
        if let Some(team) = self.team() {
            if team.holds(id, true)? {
                return Ok(Some(Space::Team));
            }
            if self.personal().holds(id, true)? {
                return Ok(Some(Space::Personal));
            }
            if team.holds(id, false)? {
                return Ok(Some(Space::Team));
            }
        }
        Ok(self.personal().holds(id, false)?.then_some(Space::Personal))
    }

    // -----------------------------------------------------------------------------------
    // Reads

    /// The personal space's live entities. Without a team this is [`Store::snapshot`];
    /// with one, time blocks and agent sessions on team tasks are kept while the task is
    /// live there.
    pub fn snapshot(&self) -> Result<Snapshot> {
        let Some(team) = self.team() else {
            return self.personal().snapshot();
        };
        let mut snapshot = self.personal().snapshot_keeping_task_rows()?;
        let mut live: HashSet<Id> = snapshot.tasks.iter().map(|t| t.id.clone()).collect();
        live.extend(team.live_task_ids()?);
        snapshot.time_blocks.retain(|b| live.contains(&b.task_id));
        snapshot
            .agent_sessions
            .retain(|s| live.contains(&s.task_id));
        Ok(snapshot)
    }

    /// The team space's live entities, team tasks carrying this person's Today picks.
    /// `None` without a team.
    pub fn team_snapshot(&self) -> Result<Option<Snapshot>> {
        let Some(team) = self.team() else {
            return Ok(None);
        };
        let mut snapshot = team.snapshot()?;
        let marks = self.marks()?;
        for task in &mut snapshot.tasks {
            task.today_on = marks.get(&task.id).cloned().flatten();
        }
        // Personal entities never live in the team space.
        snapshot.time_blocks.clear();
        snapshot.agent_sessions.clear();
        snapshot.meetings.clear();
        snapshot.terminal_sessions.clear();
        snapshot.views.clear();
        Ok(Some(snapshot))
    }

    /// Live task ids matching `text`, personal ones first.
    pub fn search(&self, text: &str, limit: u32) -> Result<Vec<Id>> {
        let mut ids = self.personal().search(text, limit)?;
        if let Some(team) = self.team() {
            ids.extend(team.search(text, limit)?);
            ids.truncate(limit as usize);
        }
        Ok(ids)
    }

    /// Notes matching `text` in both spaces, personal ones first.
    pub fn search_notes(&self, text: &str, limit: u32) -> Result<Vec<crate::notes::NoteHit>> {
        let mut hits = self.personal().search_notes(text, limit)?;
        if let Some(team) = self.team() {
            hits.extend(team.search_notes(text, limit)?);
            hits.truncate(limit as usize);
        }
        Ok(hits)
    }

    /// A task's activity, from the space that owns it.
    pub fn task_activity(&self, task_id: &str, limit: u32) -> Result<Vec<crate::Activity>> {
        let space = self.space_of(task_id)?.unwrap_or(Space::Personal);
        self.store(space)?.task_activity(task_id, limit)
    }

    /// This person's Today picks on team tasks, by task id.
    fn marks(&self) -> Result<HashMap<Id, Option<String>>> {
        Ok(self
            .personal()
            .task_marks()?
            .into_iter()
            .map(|m| (m.id, m.today_on))
            .collect())
    }

    // -----------------------------------------------------------------------------------
    // Writes

    /// Runs `commands` as one undoable action. `space` says where commands that create
    /// rows without a container go (a tag, a status, a top-level project or note folder,
    /// an Inbox task); `None` is the personal space. Everything else follows the rows it
    /// names.
    pub fn execute(&mut self, commands: Vec<Command>, space: Option<Space>) -> Result<Changes> {
        if self.team.is_none() {
            let team_only = commands.iter().any(|c| {
                matches!(
                    c,
                    Command::CreateMember { .. }
                        | Command::UpdateMember { .. }
                        | Command::DeleteMember { .. }
                )
            });
            if space == Some(Space::Team) || team_only {
                return Err(no_team());
            }
            let changes = self.personal_mut().execute_all(commands)?;
            self.record(&[(Space::Personal, &changes)]);
            return Ok(changes);
        }
        let (team_cmds, personal_cmds) = self.split(commands, space.unwrap_or_default())?;
        let mut written = Vec::new();
        if !team_cmds.is_empty() {
            // Files are stored in the personal space's folder first; a team attachment's
            // content goes along to the team's (content-addressed, so a copy is the same).
            self.copy_files_to_team(&team_cmds)?;
            let changes = mark_team(self.store_mut(Space::Team)?.execute_all(team_cmds)?);
            written.push((Space::Team, changes));
        }
        if !personal_cmds.is_empty() {
            let linked = self.linked_rows(&personal_cmds)?;
            match self.personal_mut().execute_linked(personal_cmds, linked) {
                Ok(changes) => written.push((Space::Personal, changes)),
                Err(e) => {
                    // Keep the action whole: take back the team part already written.
                    if let Some((Space::Team, changes)) = written.first()
                        && changes.batch_id.is_some()
                        && let Some(team) = self.team_mut()
                    {
                        team.undo()?;
                    }
                    return Err(e);
                }
            }
        }
        let parts: Vec<(Space, &Changes)> = written.iter().map(|(s, c)| (*s, c)).collect();
        self.record(&parts);
        let merged = merge(written.into_iter().map(|(_, c)| c));
        self.present(merged)
    }

    fn copy_files_to_team(&self, commands: &[Command]) -> Result<()> {
        let (Some(team), Ok(from)) = (self.team(), self.personal().files()) else {
            return Ok(());
        };
        let Ok(to) = team.files() else {
            return Ok(());
        };
        for command in commands {
            if let Command::CreateAttachment { attachment } = command
                && !to.contains(&attachment.hash)
                && from.contains(&attachment.hash)
            {
                to.put_file(from.path(&attachment.hash)?)?;
            }
        }
        Ok(())
    }

    /// Undoes the last action, in every space it wrote. `None` when there is none.
    pub fn undo(&mut self) -> Result<Option<Changes>> {
        self.step(true)
    }

    /// Re-applies the last undone action.
    pub fn redo(&mut self) -> Result<Option<Changes>> {
        self.step(false)
    }

    pub fn can_undo(&self) -> bool {
        !self.hist().undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.hist().redo.is_empty()
    }

    fn step(&mut self, undo: bool) -> Result<Option<Changes>> {
        let action = if undo {
            self.hist_mut().undo.pop()
        } else {
            self.hist_mut().redo.pop()
        };
        let Some(action) = action else {
            // The stores may hold history this layer did not record (none yet with a team).
            if self.team.is_none() {
                return if undo {
                    self.personal_mut().undo()
                } else {
                    self.personal_mut().redo()
                };
            }
            return Ok(None);
        };
        let mut done = Vec::new();
        let mut parts = Vec::new();
        for space in action.iter().rev() {
            let store = self.store_mut(*space)?;
            let changes = if undo { store.undo()? } else { store.redo()? };
            let changes = changes.map(|c| {
                if *space == Space::Team {
                    mark_team(c)
                } else {
                    c
                }
            });
            if let Some(changes) = changes {
                parts.push(*space);
                done.push(changes);
            }
        }
        if done.is_empty() {
            return Ok(None);
        }
        if undo {
            self.hist_mut().redo.push(parts);
        } else {
            self.hist_mut().undo.push(parts);
        }
        self.present(merge(done)).map(Some)
    }

    fn record(&mut self, parts: &[(Space, &Changes)]) {
        let spaces: Vec<Space> = parts
            .iter()
            .filter(|(_, c)| c.batch_id.is_some())
            .map(|(s, _)| *s)
            .collect();
        if !spaces.is_empty() {
            self.hist_mut().undo.push(spaces);
            self.hist_mut().redo.clear();
        }
    }

    /// Sorts commands into the team's and the personal space's, turning Today picks on team
    /// tasks into personal marks.
    fn split(
        &self,
        commands: Vec<Command>,
        default: Space,
    ) -> Result<(Vec<Command>, Vec<Command>)> {
        let mut team = Vec::new();
        let mut personal = Vec::new();
        // A tag made in the same batch as the team task it goes on is the team's.
        let mut team_tags: HashSet<Id> = HashSet::new();
        for command in &commands {
            match command {
                Command::TagTask { tag_id, .. } if self.route(command, default)? == Space::Team => {
                    team_tags.insert(tag_id.clone());
                }
                Command::CreateTask { task } if self.route(command, default)? == Space::Team => {
                    team_tags.extend(task.tag_ids.iter().cloned());
                }
                _ => {}
            }
        }
        for command in commands {
            let space = match &command {
                Command::CreateTag { tag }
                    if tag.id.as_ref().is_some_and(|id| team_tags.contains(id)) =>
                {
                    Space::Team
                }
                _ => self.route(&command, default)?,
            };
            match (space, command) {
                (Space::Team, Command::UpdateTask { id, changes }) => {
                    let (today, rest): (Vec<_>, Vec<_>) = changes
                        .into_iter()
                        .partition(|c| matches!(c, TaskChange::TodayOn(_)));
                    if !rest.is_empty() {
                        team.push(Command::UpdateTask {
                            id: id.clone(),
                            changes: rest,
                        });
                    }
                    for change in today {
                        if let TaskChange::TodayOn(today_on) = change {
                            personal.push(Command::SetTaskMark {
                                task_id: id.clone(),
                                today_on,
                            });
                        }
                    }
                }
                (Space::Team, Command::CreateTask { mut task }) => {
                    let today_on = task.today_on.take();
                    if today_on.is_some() {
                        let id = task.id.get_or_insert_with(crate::clock::new_id).clone();
                        team.push(Command::CreateTask { task });
                        personal.push(Command::SetTaskMark {
                            task_id: id,
                            today_on,
                        });
                    } else {
                        team.push(Command::CreateTask { task });
                    }
                }
                (Space::Team, command) => team.push(command),
                (Space::Personal, command) => personal.push(command),
            }
        }
        Ok((team, personal))
    }

    /// The space a command writes.
    fn route(&self, command: &Command, default: Space) -> Result<Space> {
        use Command as C;
        let follow = |id: Option<&Id>| -> Result<Space> {
            match id {
                Some(id) => Ok(self.space_of(id)?.unwrap_or(default)),
                None => Ok(default),
            }
        };
        Ok(match command {
            // Entities that only ever live in the personal space.
            C::CreateTimeBlock { .. }
            | C::UpdateTimeBlock { .. }
            | C::DeleteTimeBlock { .. }
            | C::CreateAgentSession { .. }
            | C::UpdateAgentSession { .. }
            | C::DeleteAgentSession { .. }
            | C::AddAgentNote { .. }
            | C::CreateMeeting { .. }
            | C::UpdateMeeting { .. }
            | C::DeleteMeeting { .. }
            | C::SetTranscript { .. }
            | C::UpdateSegment { .. }
            | C::SplitSegment { .. }
            | C::DeleteSegment { .. }
            | C::ReassignSpeaker { .. }
            | C::RecordTerminalSessions { .. }
            | C::UpdateTerminalSession { .. }
            | C::DeleteTerminalSession { .. }
            | C::CreateView { .. }
            | C::UpdateView { .. }
            | C::DeleteView { .. }
            | C::SetTaskMark { .. } => Space::Personal,
            // Members only live in the team space.
            C::CreateMember { .. } | C::UpdateMember { .. } | C::DeleteMember { .. } => Space::Team,
            C::CreateTask { task } => follow(
                task.parent_id
                    .as_ref()
                    .or(task.epic_id.as_ref())
                    .or(task.project_id.as_ref()),
            )?,
            C::CreateProject { project } => follow(project.parent_id.as_ref())?,
            C::CreateEpic { epic } => follow(epic.project_id.as_ref())?,
            // The default statuses have the same fixed ids in every database: a status
            // command follows the space the front end names.
            C::CreateStatus { .. } | C::UpdateStatus { .. } | C::DeleteStatus { .. } => default,
            C::CreateTag { .. } | C::CreateNoteFolder { .. } => default,
            C::CreateNote { note } => follow(note.folder_id.as_ref())?,
            C::CreateAttachment { attachment } => follow(
                attachment
                    .task_id
                    .as_ref()
                    .or(attachment.meeting_id.as_ref())
                    .or(attachment.note_id.as_ref()),
            )?,
            C::TagTask { task_id, .. } | C::UntagTask { task_id, .. } => follow(Some(task_id))?,
            C::CreateComment { comment } => follow(Some(&comment.task_id))?,
            C::UpdateComment { id, .. } | C::DeleteComment { id } => follow(Some(id))?,
            C::UpdateTask { id, .. }
            | C::MoveTask { id, .. }
            | C::SetParent { id, .. }
            | C::DeleteTask { id }
            | C::UpdateProject { id, .. }
            | C::DeleteProject { id }
            | C::UpdateEpic { id, .. }
            | C::DeleteEpic { id }
            | C::UpdateTag { id, .. }
            | C::DeleteTag { id }
            | C::UpdateAttachment { id, .. }
            | C::DeleteAttachment { id }
            | C::UpdateNote { id, .. }
            | C::DeleteNote { id }
            | C::UpdateNoteFolder { id, .. }
            | C::DeleteNoteFolder { id } => follow(Some(id))?,
        })
    }

    /// Team rows that personal commands point at and that are live there.
    fn linked_rows(&self, commands: &[Command]) -> Result<HashSet<Id>> {
        use crate::commands::MeetingChange;
        use crate::notes::NoteChange;
        use crate::terminal::TerminalSessionChange;
        let Some(team) = self.team() else {
            return Ok(HashSet::new());
        };
        let mut refs: Vec<Id> = Vec::new();
        for command in commands {
            match command {
                Command::CreateTimeBlock { block } => refs.push(block.task_id.clone()),
                Command::CreateAgentSession { session } => refs.push(session.task_id.clone()),
                Command::AddAgentNote { note } => {
                    if let Ok(session) = self.personal().agent_session(&note.session_id) {
                        refs.push(session.task_id);
                    }
                }
                Command::CreateMeeting { meeting } => refs.extend(
                    [&meeting.project_id, &meeting.epic_id, &meeting.task_id]
                        .into_iter()
                        .flatten()
                        .cloned(),
                ),
                Command::UpdateMeeting { changes, .. } => {
                    for change in changes {
                        match change {
                            MeetingChange::ProjectId(Some(id))
                            | MeetingChange::EpicId(Some(id))
                            | MeetingChange::TaskId(Some(id)) => refs.push(id.clone()),
                            _ => {}
                        }
                    }
                }
                Command::CreateNote { note } => refs.extend(note.task_id.clone()),
                Command::UpdateNote { changes, .. } => {
                    for change in changes {
                        if let NoteChange::TaskId(Some(id)) = change {
                            refs.push(id.clone());
                        }
                    }
                }
                Command::UpdateTerminalSession { changes, .. } => {
                    for change in changes {
                        match change {
                            TerminalSessionChange::ProjectId(Some(id))
                            | TerminalSessionChange::TaskId(Some(id)) => refs.push(id.clone()),
                            _ => {}
                        }
                    }
                }
                Command::SetTaskMark { task_id, .. } => refs.push(task_id.clone()),
                _ => {}
            }
        }
        let mut linked = HashSet::new();
        for id in refs {
            if team.is_live_container(&id)? {
                linked.insert(id);
            }
        }
        Ok(linked)
    }

    /// Changes as front ends see them: team tasks carry this person's Today picks, and a
    /// changed mark shows as its task.
    fn present(&self, mut changes: Changes) -> Result<Changes> {
        let Some(team) = self.team() else {
            return Ok(changes);
        };
        let marks = self.marks()?;
        let mut seen: HashSet<Id> = HashSet::new();
        for task in &mut changes.tasks {
            if team.holds(&task.id, true)? {
                task.today_on = marks.get(&task.id).cloned().flatten();
            }
            seen.insert(task.id.clone());
        }
        for mark in std::mem::take(&mut changes.task_marks) {
            if seen.contains(&mark.id) {
                continue;
            }
            if let Ok(mut task) = team.task(&mark.id) {
                task.today_on = if mark.deleted_at.is_none() {
                    mark.today_on.clone()
                } else {
                    None
                };
                seen.insert(task.id.clone());
                changes.team_ids.push(task.id.clone());
                changes.tasks.push(task);
            }
            changes.task_marks.push(mark);
        }
        Ok(changes)
    }

    // -----------------------------------------------------------------------------------
    // Share to team

    /// Moves a personal project to the team space (ADR 033): the project with its areas'
    /// children, epics, tasks (and subtasks), tag links, attachments and the notes attached
    /// to its tasks are created in the team space under the same ids, then deleted here.
    /// Time blocks, agent sessions, meetings and Today picks stay personal and keep
    /// pointing at the moved tasks. One undoable action.
    pub fn share_project(&mut self, project_id: &str) -> Result<Changes> {
        let Some(team) = self.team() else {
            return Err(no_team());
        };
        if self.space_of(project_id)? != Some(Space::Personal) {
            return Err(Error::not_found("personal project", project_id));
        }
        let personal = self.personal().snapshot()?;
        let team_snap = team.snapshot()?;
        let plan = SharePlan::new(&personal, &team_snap, project_id)?;

        // Attachment content goes along (content-addressed: a copy is the same file).
        if let (Ok(from), Ok(to)) = (self.personal().files(), team.files()) {
            for attachment in &plan.attachments {
                if !to.contains(&attachment.hash)
                    && let Ok(path) = from.path(&attachment.hash)
                    && path.is_file()
                {
                    to.put_file(&path)?;
                }
            }
        }

        let team_cmds = plan.team_commands();
        let personal_cmds = plan.personal_commands();
        let team_changes = mark_team(self.store_mut(Space::Team)?.execute_all(team_cmds)?);
        let mut marks: Vec<Command> = Vec::new();
        for task in &plan.tasks {
            if task.today_on.is_some() {
                marks.push(Command::SetTaskMark {
                    task_id: task.id.clone(),
                    today_on: task.today_on.clone(),
                });
            }
        }
        let mut cmds = marks;
        cmds.extend(personal_cmds);
        let linked: HashSet<Id> = plan.tasks.iter().map(|t| t.id.clone()).collect();
        let personal_changes = match self.personal_mut().execute_linked(cmds, linked) {
            Ok(c) => c,
            Err(e) => {
                if team_changes.batch_id.is_some()
                    && let Some(team) = self.team_mut()
                {
                    team.undo()?;
                }
                return Err(e);
            }
        };
        self.record(&[
            (Space::Team, &team_changes),
            (Space::Personal, &personal_changes),
        ]);
        self.present(merge([team_changes, personal_changes]))
    }
}

/// What sharing a project moves, read from both snapshots.
struct SharePlan {
    projects: Vec<crate::model::Project>,
    epics: Vec<crate::model::Epic>,
    /// Parents before children.
    tasks: Vec<Task>,
    attachments: Vec<crate::model::Attachment>,
    notes: Vec<crate::model::Note>,
    /// Personal status id → team status id.
    statuses: HashMap<Id, Id>,
    /// Personal tag id → (team tag id, its name, created here when new).
    tags: BTreeMap<Id, (Id, String, Option<String>, bool)>,
}

impl SharePlan {
    fn new(personal: &Snapshot, team: &Snapshot, project_id: &str) -> Result<Self> {
        let root = personal
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .ok_or_else(|| Error::not_found("project", project_id))?;
        if root.parent_id.is_some()
            && personal
                .projects
                .iter()
                .any(|p| Some(&p.id) == root.parent_id.as_ref())
        {
            return Err(Error::invalid(
                "share the area this project sits in, or move the project out of it first",
            ));
        }
        let mut projects = vec![root.clone()];
        projects.extend(
            personal
                .projects
                .iter()
                .filter(|p| p.parent_id.as_deref() == Some(project_id))
                .cloned(),
        );
        let project_ids: HashSet<&str> = projects.iter().map(|p| p.id.as_str()).collect();
        let epics: Vec<_> = personal
            .epics
            .iter()
            .filter(|e| {
                e.project_id
                    .as_deref()
                    .is_some_and(|p| project_ids.contains(p))
            })
            .cloned()
            .collect();
        let epic_ids: HashSet<&str> = epics.iter().map(|e| e.id.as_str()).collect();

        // Tasks of the projects (or their epics), with every subtask at any depth.
        let mut chosen: HashSet<Id> = personal
            .tasks
            .iter()
            .filter(|t| {
                t.project_id
                    .as_deref()
                    .is_some_and(|p| project_ids.contains(p))
                    || t.epic_id.as_deref().is_some_and(|e| epic_ids.contains(e))
            })
            .map(|t| t.id.clone())
            .collect();
        loop {
            let before = chosen.len();
            for t in &personal.tasks {
                if t.parent_id.as_ref().is_some_and(|p| chosen.contains(p)) {
                    chosen.insert(t.id.clone());
                }
            }
            if chosen.len() == before {
                break;
            }
        }
        // Parents first.
        let mut tasks: Vec<Task> = Vec::new();
        let mut placed: HashSet<Id> = HashSet::new();
        let mut pending: Vec<&Task> = personal
            .tasks
            .iter()
            .filter(|t| chosen.contains(&t.id))
            .collect();
        while !pending.is_empty() {
            let before = pending.len();
            pending.retain(|t| {
                let ready = t
                    .parent_id
                    .as_ref()
                    .is_none_or(|p| placed.contains(p) || !chosen.contains(p));
                if ready {
                    placed.insert(t.id.clone());
                    tasks.push((*t).clone());
                }
                !ready
            });
            if pending.len() == before {
                return Err(Error::invalid("the project's subtasks form a cycle"));
            }
        }
        let attachments = personal
            .attachments
            .iter()
            .filter(|a| a.task_id.as_ref().is_some_and(|t| chosen.contains(t)))
            .cloned()
            .collect();
        let notes = personal
            .notes
            .iter()
            .filter(|n| n.task_id.as_ref().is_some_and(|t| chosen.contains(t)))
            .cloned()
            .collect();

        // Statuses by category: the team's first of the same category, else its first.
        let mut statuses = HashMap::new();
        let first_team = team
            .statuses
            .first()
            .ok_or_else(|| Error::invalid("the team space has no status"))?;
        for status in &personal.statuses {
            let target = team
                .statuses
                .iter()
                .find(|s| {
                    s.name.eq_ignore_ascii_case(&status.name) && s.category == status.category
                })
                .or_else(|| team.statuses.iter().find(|s| s.category == status.category))
                .or_else(|| {
                    (status.category == StatusCategory::InProgress)
                        .then(|| {
                            team.statuses
                                .iter()
                                .find(|s| s.category == StatusCategory::Todo)
                        })
                        .flatten()
                })
                .unwrap_or(first_team);
            statuses.insert(status.id.clone(), target.id.clone());
        }

        // Tags by name; missing ones are created in the team space.
        let mut tags = BTreeMap::new();
        let used: HashSet<&Id> = tasks.iter().flat_map(|t| t.tag_ids.iter()).collect();
        for tag in personal.tags.iter().filter(|t| used.contains(&t.id)) {
            match team
                .tags
                .iter()
                .find(|t| t.name.eq_ignore_ascii_case(&tag.name))
            {
                Some(existing) => {
                    tags.insert(
                        tag.id.clone(),
                        (existing.id.clone(), existing.name.clone(), None, false),
                    );
                }
                None => {
                    tags.insert(
                        tag.id.clone(),
                        (
                            crate::clock::new_id(),
                            tag.name.clone(),
                            tag.color.clone(),
                            true,
                        ),
                    );
                }
            }
        }
        Ok(Self {
            projects,
            epics,
            tasks,
            attachments,
            notes,
            statuses,
            tags,
        })
    }

    fn team_commands(&self) -> Vec<Command> {
        use crate::commands::{EpicChange, ProjectChange};
        let mut out = Vec::new();
        for (team_id, name, color, create) in self.tags.values() {
            if *create {
                out.push(Command::CreateTag {
                    tag: NewTag {
                        id: Some(team_id.clone()),
                        name: name.clone(),
                        color: color.clone(),
                    },
                });
            }
        }
        for p in &self.projects {
            out.push(Command::CreateProject {
                project: NewProject {
                    id: Some(p.id.clone()),
                    name: p.name.clone(),
                    parent_id: p.parent_id.clone().filter(|_| p.id != self.projects[0].id),
                    color: p.color.clone(),
                    icon: p.icon.clone(),
                    rank: Some(p.rank.clone()),
                },
            });
            if p.archived_at.is_some() {
                out.push(Command::UpdateProject {
                    id: p.id.clone(),
                    changes: vec![ProjectChange::Archived(true)],
                });
            }
        }
        for e in &self.epics {
            out.push(Command::CreateEpic {
                epic: NewEpic {
                    id: Some(e.id.clone()),
                    name: e.name.clone(),
                    color: e.color.clone(),
                    icon: e.icon.clone(),
                    project_id: e.project_id.clone(),
                    description: e.description.clone(),
                    target_date: e.target_date.clone(),
                    rank: Some(e.rank.clone()),
                },
            });
            if e.state != crate::model::EpicState::Active {
                out.push(Command::UpdateEpic {
                    id: e.id.clone(),
                    changes: vec![EpicChange::State(e.state)],
                });
            }
        }
        let moved: HashSet<&Id> = self.tasks.iter().map(|t| &t.id).collect();
        let epic_ids: HashSet<&Id> = self.epics.iter().map(|e| &e.id).collect();
        for t in &self.tasks {
            out.push(Command::CreateTask {
                task: NewTask {
                    id: Some(t.id.clone()),
                    title: t.title.clone(),
                    description: t.description.clone(),
                    owner: t.owner,
                    project_id: t.project_id.clone(),
                    epic_id: t.epic_id.clone().filter(|e| epic_ids.contains(e)),
                    parent_id: t.parent_id.clone().filter(|p| moved.contains(p)),
                    status_id: self.statuses.get(&t.status_id).cloned(),
                    priority: t.priority,
                    due_date: t.due_date.clone(),
                    today_on: None,
                    estimate_min: t.estimate_min,
                    rank: Some(t.rank.clone()),
                    tag_ids: t
                        .tag_ids
                        .iter()
                        .filter_map(|id| self.tags.get(id).map(|(team_id, ..)| team_id.clone()))
                        .collect(),
                    assignee_id: None,
                },
            });
        }
        for t in &self.tasks {
            let deps: Vec<Id> = t
                .dependency_ids
                .iter()
                .filter(|d| moved.contains(d))
                .cloned()
                .collect();
            if !deps.is_empty() {
                out.push(Command::UpdateTask {
                    id: t.id.clone(),
                    changes: vec![TaskChange::DependencyIds(deps)],
                });
            }
        }
        for a in &self.attachments {
            out.push(Command::CreateAttachment {
                attachment: NewAttachment {
                    id: Some(a.id.clone()),
                    task_id: a.task_id.clone(),
                    meeting_id: None,
                    note_id: None,
                    hash: a.hash.clone(),
                    name: a.name.clone(),
                    mime: Some(a.mime.clone()),
                    size: a.size,
                },
            });
        }
        for n in &self.notes {
            out.push(Command::CreateNote {
                note: NewNote {
                    id: Some(n.id.clone()),
                    title: n.title.clone(),
                    body: n.body.clone(),
                    folder_id: None,
                    task_id: n.task_id.clone(),
                    rank: Some(n.rank.clone()),
                },
            });
        }
        out
    }

    /// The personal copies, deleted: notes, then tasks (each with its subtasks), epics and
    /// projects (children first).
    fn personal_commands(&self) -> Vec<Command> {
        let mut out = Vec::new();
        for n in &self.notes {
            out.push(Command::DeleteNote { id: n.id.clone() });
        }
        let moved: HashSet<&Id> = self.tasks.iter().map(|t| &t.id).collect();
        for t in self
            .tasks
            .iter()
            .filter(|t| t.parent_id.as_ref().is_none_or(|p| !moved.contains(p)))
        {
            out.push(Command::DeleteTask { id: t.id.clone() });
        }
        for e in &self.epics {
            out.push(Command::DeleteEpic { id: e.id.clone() });
        }
        for p in self.projects.iter().rev() {
            out.push(Command::DeleteProject { id: p.id.clone() });
        }
        out
    }
}

/// Changes of several batches as one (the last batch's id).
fn merge(parts: impl IntoIterator<Item = Changes>) -> Changes {
    let mut out = Changes::default();
    for c in parts {
        if c.batch_id.is_none() {
            continue;
        }
        out.batch_id = c.batch_id;
        out.op_seq = c.op_seq;
        out.tasks.extend(c.tasks);
        out.projects.extend(c.projects);
        out.epics.extend(c.epics);
        out.tags.extend(c.tags);
        out.views.extend(c.views);
        out.statuses.extend(c.statuses);
        out.attachments.extend(c.attachments);
        out.time_blocks.extend(c.time_blocks);
        out.agent_sessions.extend(c.agent_sessions);
        out.agent_notes.extend(c.agent_notes);
        out.meetings.extend(c.meetings);
        out.transcript_segments.extend(c.transcript_segments);
        out.terminal_sessions.extend(c.terminal_sessions);
        out.note_folders.extend(c.note_folders);
        out.notes.extend(c.notes);
        out.task_marks.extend(c.task_marks);
        out.members.extend(c.members);
        out.comments.extend(c.comments);
        out.team_ids.extend(c.team_ids);
    }
    out
}

/// Lists every entity of a team batch's changes in `team_ids`.
fn mark_team(mut changes: Changes) -> Changes {
    let ids: Vec<Id> = changes
        .tasks
        .iter()
        .map(|e| e.id.clone())
        .chain(changes.projects.iter().map(|e| e.id.clone()))
        .chain(changes.epics.iter().map(|e| e.id.clone()))
        .chain(changes.tags.iter().map(|e| e.id.clone()))
        .chain(changes.statuses.iter().map(|e| e.id.clone()))
        .chain(changes.attachments.iter().map(|e| e.id.clone()))
        .chain(changes.notes.iter().map(|e| e.id.clone()))
        .chain(changes.note_folders.iter().map(|e| e.id.clone()))
        .chain(changes.members.iter().map(|e| e.id.clone()))
        .chain(changes.comments.iter().map(|e| e.id.clone()))
        .collect();
    changes.team_ids.extend(ids);
    changes
}

fn no_team() -> Error {
    Error::invalid("this app is not connected to a team")
}
