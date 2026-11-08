//! Where a user's task goes when an agent works on it (ADR 017): a software rule applied
//! by the app and the MCP server, not something the agent is asked to do.
//!
//! - Sent to an agent (a new session or a follow-up message): the task moves to the
//!   "started" status, In progress by default.
//! - The agent reports it done (complete_session, or a headless run that ends well): the
//!   task moves to the "done" status, Review by default, unless the user already closed it.
//!
//! Both statuses are picked in Settings → Agents; a pick that no longer exists falls back
//! to the default.

use serde::{Deserialize, Serialize};

use crate::commands::{Command, TaskChange};
use crate::model::{Id, Status, StatusCategory, Task, TaskOwner, review_status};

/// The baseline In progress status (migration 0001).
pub const IN_PROGRESS_STATUS_ID: &str = "00000000-0000-7000-8000-000000000003";

/// The statuses picked for agent work; `None` is the default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AgentWorkflow {
    /// Where a task goes when it is sent to an agent.
    #[serde(default)]
    pub started_status_id: Option<Id>,
    /// Where a task goes when the agent reports it done.
    #[serde(default)]
    pub done_status_id: Option<Id>,
}

fn live<'a>(statuses: &'a [Status], id: &str) -> Option<&'a Status> {
    statuses
        .iter()
        .find(|s| s.id == id && s.deleted_at.is_none())
}

impl AgentWorkflow {
    /// The status a task goes to when it is sent to an agent: the pick, else the seeded In
    /// progress, else the first open in-progress status that is not the done one.
    pub fn started_status<'a>(&self, statuses: &'a [Status]) -> Option<&'a Status> {
        if let Some(chosen) = self
            .started_status_id
            .as_deref()
            .and_then(|id| live(statuses, id))
        {
            return Some(chosen);
        }
        if let Some(seeded) = live(statuses, IN_PROGRESS_STATUS_ID) {
            return Some(seeded);
        }
        let done = self.done_status(statuses).map(|s| s.id.as_str());
        let mut open: Vec<&Status> = statuses
            .iter()
            .filter(|s| {
                s.deleted_at.is_none()
                    && s.category == StatusCategory::InProgress
                    && Some(s.id.as_str()) != done
            })
            .collect();
        open.sort_by(|a, b| a.rank.cmp(&b.rank));
        open.first().copied()
    }

    /// The status a task goes to when the agent reports it done: the pick, else Review.
    pub fn done_status<'a>(&self, statuses: &'a [Status]) -> Option<&'a Status> {
        self.done_status_id
            .as_deref()
            .and_then(|id| live(statuses, id))
            .or_else(|| review_status(statuses))
    }

    /// The move of `task` when it is sent to an agent, if it is not there already.
    pub fn on_start(&self, statuses: &[Status], task: &Task) -> Option<Command> {
        let target = self.started_status(statuses)?;
        move_to(task, target, statuses, true)
    }

    /// The move of `task` when the agent reports it done. A task the user already closed
    /// (done or cancelled) stays where it is.
    pub fn on_done(&self, statuses: &[Status], task: &Task) -> Option<Command> {
        let target = self.done_status(statuses)?;
        move_to(task, target, statuses, false)
    }
}

fn move_to(task: &Task, target: &Status, statuses: &[Status], reopen: bool) -> Option<Command> {
    if task.owner != TaskOwner::Me || task.deleted_at.is_some() || task.status_id == target.id {
        return None;
    }
    let closed = statuses
        .iter()
        .find(|s| s.id == task.status_id)
        .is_some_and(|s| matches!(s.category, StatusCategory::Done | StatusCategory::Cancelled));
    if closed && !reopen {
        return None;
    }
    Some(Command::UpdateTask {
        id: task.id.clone(),
        changes: vec![TaskChange::StatusId(target.id.clone())],
    })
}
