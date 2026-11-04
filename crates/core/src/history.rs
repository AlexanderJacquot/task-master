//! Undo and redo: a batch is undone by applying the inverse of its ops, newest first, as a
//! new batch. Redo undoes that undo the same way. Nothing is ever erased from `ops`.

use crate::error::Result;
use crate::ops::{self, Batch, Change};

/// Applies the inverse of every op in `batch_id` into `b`.
pub(crate) fn invert_batch(b: &mut Batch<'_, '_>, batch_id: &str) -> Result<()> {
    for op in ops::batch_ops(b.tx, batch_id)? {
        b.apply(Change {
            entity: op.entity,
            entity_id: op.entity_id,
            kind: op.kind.inverse(),
            patch: op.inverse,
        })?;
    }
    Ok(())
}

/// In-memory undo/redo stacks of batch ids for this session.
#[derive(Debug, Default)]
pub(crate) struct History {
    undo: Vec<String>,
    redo: Vec<String>,
}

impl History {
    /// A new user action: it becomes undoable and clears the redo stack.
    pub(crate) fn record(&mut self, batch_id: String) {
        self.undo.push(batch_id);
        self.redo.clear();
    }

    pub(crate) fn next_undo(&self) -> Option<&str> {
        self.undo.last().map(String::as_str)
    }

    pub(crate) fn next_redo(&self) -> Option<&str> {
        self.redo.last().map(String::as_str)
    }

    /// The undo top was inverted by `inverse_batch` (None if that wrote nothing).
    pub(crate) fn did_undo(&mut self, inverse_batch: Option<String>) {
        self.undo.pop();
        self.redo.extend(inverse_batch);
    }

    /// The redo top was inverted by `inverse_batch`, which becomes undoable again.
    pub(crate) fn did_redo(&mut self, inverse_batch: Option<String>) {
        self.redo.pop();
        self.undo.extend(inverse_batch);
    }
}
