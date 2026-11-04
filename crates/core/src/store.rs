//! The public entry point: one `Store` per database, owned by an adapter.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::mpsc::Receiver;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::clock::{Hlc, now_ms};
use crate::commands::{self, Command};
use crate::error::Result;
use crate::events::{Changed, EntityRef, EventBus};
use crate::history::{self, History};
use crate::model::{Epic, Id, Project, Snapshot, Tag, Task};
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
}

impl Store {
    /// Opens or creates the database at `path`, migrating it (after a backup) if needed.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_connection(db::open_file(path.as_ref())?)
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
        })
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

    /// A task's change history, newest first.
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
        }
    }
    Ok(changes)
}
