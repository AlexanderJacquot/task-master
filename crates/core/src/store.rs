//! The public entry point: one `Store` per database, owned by an adapter.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::mpsc::Receiver;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::clock::{Hlc, now_ms};
use crate::commands::{self, Command};
use crate::error::{Error, Result};
use crate::events::{Changed, EntityRef, EventBus};
use crate::files::FileStore;
use crate::history::{self, History};
use crate::model::{
    AgentNote, AgentRuntime, AgentSession, Attachment, Epic, Id, Project, ProjectFolder,
    SessionState, Snapshot, Status, Tag, Task, TimeBlock, View,
};
use crate::ops::{Batch, EntityKind};
use crate::sync::{self, Merged, OpsPage, SyncOp};
use crate::{db, query};

/// Entities changed by one batch, as they are after it (deleted ones have `deleted_at` set),
/// so a front end can reconcile its optimistic state.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Changes {
    /// `None` when nothing changed (no op was written).
    pub batch_id: Option<Id>,
    pub op_seq: Option<i64>,
    pub tasks: Vec<Task>,
    pub projects: Vec<Project>,
    pub epics: Vec<Epic>,
    pub tags: Vec<Tag>,
    pub views: Vec<View>,
    pub statuses: Vec<Status>,
    pub attachments: Vec<Attachment>,
    pub time_blocks: Vec<TimeBlock>,
    pub agent_sessions: Vec<AgentSession>,
    pub agent_notes: Vec<AgentNote>,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.batch_id.is_none()
    }
}

/// Owns the database connection. Not thread-safe by itself: adapters wrap it in a mutex.
pub struct Store {
    conn: Connection,
    device_id: String,
    clock: Hlc,
    history: History,
    events: EventBus,
    /// Attachment content; `attachments/` next to the database file.
    files: Option<FileStore>,
    /// Added to the system clock (see [`Store::set_clock_offset`]).
    clock_offset_ms: i64,
    data_version: i64,
}

/// Name of the attachment folder, next to the database and inside backup folders.
pub const ATTACHMENTS_DIR: &str = "attachments";

impl Store {
    /// Opens or creates the database at `path`, migrating it (after a backup) if needed.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let store = Self::from_connection(db::open_file(path)?)?;
        let dir = path.parent().unwrap_or_else(|| Path::new("."));
        Ok(store.with_files(dir.join(ATTACHMENTS_DIR)))
    }

    /// Keeps attachment content in `dir` (an in-memory store has none until set).
    pub fn with_files(mut self, dir: impl Into<std::path::PathBuf>) -> Self {
        self.files = Some(FileStore::new(dir));
        self
    }

    /// The attachment content folder.
    pub fn files(&self) -> Result<&FileStore> {
        self.files
            .as_ref()
            .ok_or_else(|| Error::invalid("this store has no attachment folder"))
    }

    /// A throwaway database, for tests.
    pub fn open_in_memory() -> Result<Self> {
        Self::from_connection(db::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<Self> {
        let data_version = conn.query_row("PRAGMA data_version", [], |r| r.get(0))?;
        let device_id = db::device_id(&conn)?;
        let clock = Hlc::new(device_id.clone(), db::last_hlc(&conn)?.as_deref());
        Ok(Self {
            conn,
            device_id,
            clock,
            history: History::default(),
            events: EventBus::default(),
            files: None,
            clock_offset_ms: 0,
            data_version,
        })
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// Runs one command as an undoable batch.
    pub fn execute(&mut self, command: Command) -> Result<Changes> {
        self.execute_all(vec![command])
    }

    /// Runs several commands atomically as one undoable batch: all apply or none do.
    pub fn execute_all(&mut self, commands: Vec<Command>) -> Result<Changes> {
        let changes = self.run_commands(commands)?;
        if let Some(batch_id) = &changes.batch_id {
            self.history.record(batch_id.clone());
        }
        Ok(changes)
    }

    /// Runs commands atomically like [`Store::execute_all`], but keeps them out of the
    /// undo history: bookkeeping such as an agent session starting or ending, which the
    /// user did not do and should not undo with their own edits.
    pub fn execute_without_undo(&mut self, commands: Vec<Command>) -> Result<Changes> {
        self.run_commands(commands)
    }

    fn run_commands(&mut self, commands: Vec<Command>) -> Result<Changes> {
        // An attachment row must name content that is actually stored.
        for command in &commands {
            if let Command::CreateAttachment { attachment } = command
                && !self.files()?.contains(&attachment.hash)
            {
                return Err(Error::invalid(format!(
                    "no stored file has hash {}; store it before attaching it",
                    attachment.hash
                )));
            }
        }
        self.write(|b| {
            commands
                .into_iter()
                .try_for_each(|command| commands::run(b, command))
        })
    }

    // -----------------------------------------------------------------------------------
    // Agent sessions (docs/adr/017-agent-sessions.md)

    /// Marks this device's `running` sessions `interrupted`: at start-up, no process of
    /// a previous run survives. Not undoable.
    pub fn interrupt_running_sessions(&mut self) -> Result<Changes> {
        let ids: Vec<Id> = {
            let mut stmt = self.conn.prepare(
                "SELECT id FROM agent_sessions
                 WHERE device_id = ?1 AND state = 'running' AND deleted_at IS NULL ORDER BY id",
            )?;
            let rows = stmt.query_map([&self.device_id], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        self.execute_without_undo(
            ids.into_iter()
                .map(|id| Command::UpdateAgentSession {
                    id,
                    changes: vec![commands::AgentSessionChange::State(
                        SessionState::Interrupted,
                    )],
                })
                .collect(),
        )
    }

    /// One session, deleted ones included.
    pub fn agent_session(&self, id: &str) -> Result<AgentSession> {
        query::agent_session(&self.conn, id)
    }

    /// The newest `limit` live notes of a task (or of one of its sessions), oldest first.
    pub fn agent_notes(
        &self,
        task_id: &str,
        session_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<AgentNote>> {
        query::agent_notes(&self.conn, task_id, session_id, limit)
    }

    /// Markdown context for an agent working on a task: the task, its containers,
    /// hierarchy, dependencies and earlier sessions (docs/adr/017).
    pub fn agent_brief(&self, task_id: &str) -> Result<String> {
        crate::brief::brief(&self.conn, task_id)
    }

    /// This device's working folders, by project.
    pub fn project_folders(&self) -> Result<Vec<ProjectFolder>> {
        query::project_folders(&self.conn)
    }

    /// Sets (or with `None`, clears) this device's folder for a project. Device
    /// configuration: written directly, not synced, exported or undoable.
    pub fn set_project_folder(
        &mut self,
        project_id: &str,
        folder: Option<(String, AgentRuntime)>,
    ) -> Result<()> {
        match folder {
            None => {
                self.conn.execute(
                    "DELETE FROM project_folders WHERE project_id = ?1",
                    [project_id],
                )?;
            }
            Some((path, runtime)) => {
                let project = query::project(&self.conn, project_id)?;
                if project.deleted_at.is_some() {
                    return Err(Error::not_found("project", project_id));
                }
                let path = path.trim();
                if path.is_empty() {
                    return Err(Error::invalid("folder cannot be empty"));
                }
                self.conn.execute(
                    "INSERT INTO project_folders (project_id, path, runtime, updated_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT (project_id) DO UPDATE SET path = excluded.path,
                       runtime = excluded.runtime, updated_at = excluded.updated_at",
                    rusqlite::params![project_id, path, runtime.as_str(), self.now()],
                )?;
            }
        }
        Ok(())
    }

    pub fn can_undo(&self) -> bool {
        self.history.next_undo().is_some()
    }

    pub fn can_redo(&self) -> bool {
        self.history.next_redo().is_some()
    }

    /// Undoes the last batch of this session. `None` when there is nothing to undo.
    pub fn undo(&mut self) -> Result<Option<Changes>> {
        let Some(batch_id) = self.history.next_undo().map(str::to_owned) else {
            return Ok(None);
        };
        let changes = self.write(|b| history::invert_batch(b, &batch_id))?;
        self.history.did_undo(changes.batch_id.clone());
        Ok(Some(changes))
    }

    /// Re-applies the last undone batch. `None` when there is nothing to redo.
    pub fn redo(&mut self) -> Result<Option<Changes>> {
        let Some(batch_id) = self.history.next_redo().map(str::to_owned) else {
            return Ok(None);
        };
        let changes = self.write(|b| history::invert_batch(b, &batch_id))?;
        self.history.did_redo(changes.batch_id.clone());
        Ok(Some(changes))
    }

    /// Every live entity, for hydrating a front end.
    pub fn snapshot(&self) -> Result<Snapshot> {
        query::snapshot(&self.conn)
    }

    /// Live task ids matching all words of `text` (prefix match), best first.
    pub fn search(&self, text: &str, limit: u32) -> Result<Vec<Id>> {
        query::search(&self.conn, text, limit)
    }

    /// One attachment (deleted ones included), e.g. to serve or open its file.
    pub fn attachment(&self, id: &str) -> Result<Attachment> {
        query::attachment(&self.conn, id)
    }

    /// Where an attachment's content is on disk.
    pub fn attachment_path(&self, id: &str) -> Result<std::path::PathBuf> {
        let attachment = self.attachment(id)?;
        let path = self.files()?.path(&attachment.hash)?;
        if !path.is_file() {
            return Err(Error::not_found("attachment file", attachment.hash));
        }
        Ok(path)
    }

    /// Hashes named by live attachments whose content is missing (e.g. after importing
    /// an export without its attachment folder).
    pub fn missing_files(&self) -> Result<Vec<String>> {
        let files = self.files()?;
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT hash FROM attachments WHERE deleted_at IS NULL ORDER BY hash",
        )?;
        let hashes = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut missing = Vec::new();
        for hash in hashes {
            let hash = hash?;
            if !files.contains(&hash) {
                missing.push(hash);
            }
        }
        Ok(missing)
    }

    /// Writes a consistent copy of the database to `target` (replacing it).
    pub fn backup_to(&self, target: impl AsRef<Path>) -> Result<()> {
        crate::dump::backup_to(&self.conn, target.as_ref())
    }

    /// Today's rotating backup in `dir` (`daily-YYYY-MM-DD.sqlite`), keeping the newest
    /// `keep`. Returns the new file, or `None` when today's already exists.
    ///
    /// Attachment content is mirrored into `dir/attachments/` on every call (only new
    /// files are copied; files never change). Mirrored files are not rotated out, so any
    /// kept database finds the files it names.
    pub fn daily_backup(
        &self,
        dir: impl AsRef<Path>,
        today: &str,
        keep: usize,
    ) -> Result<Option<std::path::PathBuf>> {
        let dir = dir.as_ref();
        let created = crate::dump::daily_backup(&self.conn, dir, today, keep)?;
        if let Some(files) = &self.files {
            files.copy_missing_to(dir.join(ATTACHMENTS_DIR))?;
        }
        Ok(created)
    }

    /// Copies every attachment file into `dir` (an export's attachment folder).
    pub fn export_files_to(&self, dir: impl AsRef<Path>) -> Result<u32> {
        self.files()?.copy_missing_to(dir)
    }

    /// Takes in the attachment files of an export folder (checked against their hashes).
    pub fn import_files_from(&self, dir: impl AsRef<Path>) -> Result<u32> {
        self.files()?.import_from(dir)
    }

    /// Every user table as JSON, versioned with the schema.
    pub fn export(&self) -> Result<crate::dump::ExportFile> {
        crate::dump::export(&self.conn, db::applied_migrations(&self.conn)?)
    }

    /// Replaces all data with an export, atomically. Not undoable: the history is cleared
    /// (take a backup first). Subscribers get a change event so they re-read everything.
    pub fn import(&mut self, file: &crate::dump::ExportFile) -> Result<crate::dump::ImportSummary> {
        let version = db::applied_migrations(&self.conn)?;
        let mut summary = crate::dump::import(&mut self.conn, file, version)?;
        // Links name the replaced rows; the next sync matches events by their keys again.
        crate::calendar::forget_links(&self.conn)?;
        if self.files.is_some() {
            summary.missing_files = u32::try_from(self.missing_files()?.len()).unwrap_or(u32::MAX);
        }
        self.history = History::default();
        self.clock = Hlc::new(self.device_id.clone(), db::last_hlc(&self.conn)?.as_deref());
        let op_seq: i64 =
            self.conn
                .query_row("SELECT COALESCE(MAX(seq), 0) FROM ops", [], |r| r.get(0))?;
        self.events.publish(&Changed {
            batch_id: crate::clock::new_id(),
            op_seq,
            entities: Vec::new(),
        });
        Ok(summary)
    }

    /// Parses a quick-capture line and matches its names to live entities. `today` is the
    /// user's local date (`YYYY-MM-DD`), which relative due dates count from.
    pub fn parse_capture(&self, text: &str, today: &str) -> Result<crate::parse::Capture> {
        crate::clock::check_date("today", today)?;
        crate::parse::resolve(&self.conn, crate::parse::parse(text, today))
    }

    pub fn task_activity(&self, task_id: &str, limit: u32) -> Result<Vec<query::Activity>> {
        query::task_activity(&self.conn, task_id, limit)
    }

    /// Receives a [`Changed`] event after every committed batch.
    pub fn subscribe(&mut self) -> Receiver<Changed> {
        self.events.subscribe()
    }

    /// Notices writes committed by another connection (CLI or local MCP), and asks
    /// subscribers to reload. Writes through this connection do not change data_version.
    pub fn refresh_external_changes(&mut self) -> Result<bool> {
        let version = self
            .conn
            .query_row("PRAGMA data_version", [], |r| r.get(0))?;
        if version == self.data_version {
            return Ok(false);
        }
        self.data_version = version;
        self.history = History::default();
        self.events.publish(&Changed {
            batch_id: crate::clock::new_id(),
            op_seq: self.last_seq()?,
            entities: Vec::new(),
        });
        Ok(true)
    }

    // -----------------------------------------------------------------------------------
    // Sync (docs/adr/015-sync-server.md)

    /// Corrects this device's clock by `offset_ms` (the server's time minus ours), so a
    /// wrong system clock does not decide which edit is the latest.
    pub fn set_clock_offset(&mut self, offset_ms: i64) {
        self.clock_offset_ms = offset_ms;
    }

    /// Current time as written into new rows and clocks.
    fn now(&self) -> crate::model::Timestamp {
        now_ms().saturating_add(self.clock_offset_ms)
    }

    /// Every op with `seq > after` (a server serving pulls), at most `limit`.
    pub fn ops_after(&self, after: i64, limit: u32) -> Result<OpsPage> {
        sync::ops_after(&self.conn, after, limit, false)
    }

    /// This replica's own ops the server does not have yet, at most `limit`. Push them,
    /// then call [`Store::mark_pushed`] with the page's `last_seq`.
    pub fn outbox(&self, limit: u32) -> Result<OpsPage> {
        let pushed = sync::state(&self.conn, sync::PUSHED_SEQ)?;
        sync::ops_after(&self.conn, pushed, limit, true)
    }

    /// Records that the server has every local op up to `seq`.
    pub fn mark_pushed(&mut self, seq: i64) -> Result<()> {
        let pushed = sync::state(&self.conn, sync::PUSHED_SEQ)?;
        sync::set_state(&self.conn, sync::PUSHED_SEQ, pushed.max(seq))
    }

    /// The last server op applied here: pull from after it.
    pub fn sync_cursor(&self) -> Result<i64> {
        sync::state(&self.conn, sync::CURSOR)
    }

    /// Forgets the sync position: the next round pushes every retained op again and pulls
    /// from the start. For a server that lost data (restored from a backup, or new);
    /// it ignores what it already has.
    pub fn restart_sync(&mut self) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM sync_state", [])?;
        // This replica may be the only surviving copy of another device's work.
        tx.execute("UPDATE ops SET received = 0", [])?;
        tx.commit()?;
        Ok(())
    }

    /// The newest op `seq` (0 when there is none): a server's head.
    pub fn last_seq(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT COALESCE(MAX(seq), 0) FROM ops", [], |r| r.get(0))?)
    }

    /// Number of migrations applied. Replicas exchange ops only at the same version.
    pub fn schema_version(&self) -> Result<u32> {
        Ok(u32::try_from(db::applied_migrations(&self.conn)?).unwrap_or(u32::MAX))
    }

    /// Empties this replica before it takes the server's data ("replace with the
    /// server's tasks"): every task, project, epic, tag, view, attachment row, time block
    /// and op goes, and sync starts over. Statuses reset to the same defaults as a
    /// fresh replica, then the server's ops overwrite them. Not undoable: back up first.
    pub fn clear_for_replace(&mut self) -> Result<()> {
        // Use the same seed data as a fresh replica. Keeping local statuses would
        // retain custom columns and edits that the server never made.
        let empty = Self::open_in_memory()?.export()?;
        self.import(&empty)?;
        Ok(())
    }

    /// Applies ops from another replica (latest edit wins, per field), repairs the merged
    /// state, and moves the pull cursor to `cursor` when given, all in one transaction.
    /// Not undoable; subscribers get a change event as for a local batch.
    pub fn apply_remote(&mut self, ops: Vec<SyncOp>, cursor: Option<i64>) -> Result<Merged> {
        let now = self.now();
        let tx = self.conn.transaction()?;
        // Ops can arrive before the rows they reference within one page.
        tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
        observe_stored_clock(&tx, &mut self.clock)?;
        let applied = sync::apply(&tx, &mut self.clock, &self.device_id, ops, now)?;
        if cursor.is_some() && applied.merged.skipped > 0 {
            return Err(Error::invalid(
                "sync received operations for missing rows; the pull was not acknowledged",
            ));
        }
        if let Some(cursor) = cursor {
            sync::set_state(&tx, sync::CURSOR, cursor)?;
        }
        let mut merged = applied.merged;
        if let Some(op_seq) = applied.last_seq {
            merged.changes = load_changes(&tx, &applied.touched, applied.batch_id.clone(), op_seq)?;
        }
        tx.commit()?;
        if let Some(op_seq) = applied.last_seq {
            self.events.publish(&Changed {
                batch_id: applied.batch_id,
                op_seq,
                entities: applied
                    .touched
                    .into_iter()
                    .map(|(kind, id)| EntityRef { kind, id })
                    .collect(),
            });
        }
        Ok(merged)
    }

    /// Runs `f` in one transaction and batch, then reports and broadcasts what changed.
    fn write(&mut self, f: impl FnOnce(&mut Batch<'_, '_>) -> Result<()>) -> Result<Changes> {
        let now = self.now();
        let tx = self.conn.transaction()?;
        observe_stored_clock(&tx, &mut self.clock)?;
        let (batch_id, touched, last_seq) = {
            let mut batch = Batch::new(&tx, &mut self.clock, &self.device_id, now);
            f(&mut batch)?;
            (batch.batch_id, batch.touched, batch.last_seq)
        };
        let Some(op_seq) = last_seq else {
            return Ok(Changes::default()); // nothing written; the transaction rolls back empty
        };
        let changes = load_changes(&tx, &touched, batch_id.clone(), op_seq)?;
        tx.commit()?;
        self.events.publish(&Changed {
            batch_id,
            op_seq,
            entities: touched
                .into_iter()
                .map(|(kind, id)| EntityRef { kind, id })
                .collect(),
        });
        Ok(changes)
    }
}

/// Moves the clock past every op already stored, including ones another process (the CLI,
/// a local MCP server) wrote to this database since this store last wrote.
fn observe_stored_clock(tx: &rusqlite::Transaction<'_>, clock: &mut Hlc) -> Result<()> {
    let last: Option<String> = tx.query_row("SELECT MAX(hlc) FROM ops", [], |r| r.get(0))?;
    if let Some(last) = last {
        clock.observe(&last);
    }
    Ok(())
}

fn load_changes(
    conn: &Connection,
    touched: &BTreeSet<(EntityKind, Id)>,
    batch_id: Id,
    op_seq: i64,
) -> Result<Changes> {
    let mut changes = Changes {
        batch_id: Some(batch_id),
        op_seq: Some(op_seq),
        ..Changes::default()
    };
    for (kind, id) in touched {
        match kind {
            EntityKind::Task => changes.tasks.push(query::task(conn, id)?),
            EntityKind::Project => changes.projects.push(query::project(conn, id)?),
            EntityKind::Epic => changes.epics.push(query::epic(conn, id)?),
            EntityKind::Tag => changes.tags.push(query::tag(conn, id)?),
            EntityKind::View => changes.views.push(query::view(conn, id)?),
            EntityKind::Status => changes.statuses.push(query::status(conn, id)?),
            EntityKind::Attachment => changes.attachments.push(query::attachment(conn, id)?),
            EntityKind::TimeBlock => changes.time_blocks.push(query::time_block(conn, id)?),
            EntityKind::AgentSession => {
                changes.agent_sessions.push(query::agent_session(conn, id)?);
            }
            EntityKind::AgentNote => changes.agent_notes.push(query::agent_note(conn, id)?),
        }
    }
    Ok(changes)
}
