//! Change notifications, broadcast after each commit so every adapter sees every write.

use std::sync::mpsc::{Receiver, Sender, channel};

use serde::{Deserialize, Serialize};

use crate::model::Id;
use crate::ops::EntityKind;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct EntityRef {
    pub kind: EntityKind,
    pub id: Id,
}

/// Sent after a batch commits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Changed {
    pub batch_id: Id,
    /// Highest `ops.seq` written by the batch.
    pub op_seq: i64,
    pub entities: Vec<EntityRef>,
}

#[derive(Debug, Default)]
pub(crate) struct EventBus {
    subscribers: Vec<Sender<Changed>>,
}

impl EventBus {
    pub(crate) fn subscribe(&mut self) -> Receiver<Changed> {
        let (tx, rx) = channel();
        self.subscribers.push(tx);
        rx
    }

    /// Delivers to every live subscriber and forgets those whose receiver was dropped.
    pub(crate) fn publish(&mut self, event: &Changed) {
        self.subscribers.retain(|s| s.send(event.clone()).is_ok());
    }
}
