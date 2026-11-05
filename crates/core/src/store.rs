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
use crate::model::{Attachment, Epic, Id, Project, Snapshot, Status, Tag, Task, TimeBlock, View};
use crate::ops::{Batch, EntityKind};
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
        let device_id = db::device_id(&conn)?;
        let clock = Hlc::new(device_id.clone(), db::last_hlc(&conn)?.as_deref());
        Ok(Self {
            conn,
            device_id,
            clock,
            history: History::default(),
            events: EventBus::default(),
            files: None,
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
        let changes = self.write(|b| {
            commands
                .into_iter()
                .try_for_each(|command| commands::run(b, command))
        })?;
        if let Some(batch_id) = &changes.batch_id {
            self.history.record(batch_id.clone());
        }
        Ok(changes)
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

    /// Runs `f` in one transaction and batch, then reports and broadcasts what changed.
    fn write(&mut self, f: impl FnOnce(&mut Batch<'_, '_>) -> Result<()>) -> Result<Changes> {
        let tx = self.conn.transaction()?;
        let (batch_id, touched, last_seq) = {
            let mut batch = Batch::new(&tx, &mut self.clock, &self.device_id, now_ms());
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
        }
    }
    Ok(changes)
}
