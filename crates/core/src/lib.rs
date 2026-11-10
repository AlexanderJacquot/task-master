//! task-master core: all logic and data live here.
//!
//! Front ends (the Tauri desktop shell now; a CLI, an MCP server and a sync server later)
//! are thin adapters over [`Store`]. Every write is a [`Command`] run by
//! [`Store::execute`], which writes rows and their `ops` entries in one transaction.
//! See `docs/plan.md`.

mod agent_workflow;
mod brief;
pub mod calendar;
mod clock;
mod commands;
mod db;
mod dump;
mod error;
mod events;
mod files;
mod history;
mod model;
mod ops;
mod parse;
mod query;
pub mod rank;
mod store;
mod sync;
pub mod views;

pub use agent_workflow::{AgentWorkflow, IN_PROGRESS_STATUS_ID};
pub use clock::{new_id, now_ms, utc_date};
pub use commands::{
    AgentSessionChange, AttachmentChange, Command, EpicChange, MAX_BLOCK_MS, MAX_NOTE_CHARS,
    MAX_RANK_LEN, NewAgentNote, NewAgentSession, NewAttachment, NewEpic, NewProject, NewStatus,
    NewTag, NewTask, NewTimeBlock, NewView, PERMISSION_MODES, ProjectChange, StatusChange,
    TagChange, TaskChange, TimeBlockChange, ViewChange,
};
pub use dump::{EXPORT_FORMAT, ExportFile, ImportSummary};
pub use error::{Error, Result};
pub use events::{Changed, EntityRef};
pub use files::{FileStore, MAX_ATTACHMENT_BYTES, StoredFile, clean_file_name, is_hash, mime_for};
pub use model::{
    AgentNote, AgentRuntime, AgentSession, Attachment, BlockOutcome, DueFilter, Epic, EpicState,
    FILTER_NONE, GroupBy, Id, IsoDate, Layout, Priority, Project, ProjectFolder, REVIEW_STATUS_ID,
    SessionState, Snapshot, SortBy, Status, StatusCategory, Swimlane, Tag, Task, TaskOwner,
    TimeBlock, Timestamp, VIEW_SPEC_VERSION, View, ViewFilter, ViewScope, ViewSpec, review_status,
};
pub use ops::EntityKind;
pub use parse::{Capture, NameMatch, Parsed, parse};
pub use query::{Activity, FieldChange};
pub use store::{ATTACHMENTS_DIR, Changes, Store};
pub use sync::{
    AuthMode, IssuedToken, Merged, OidcExchange, OpsPage, PullPage, PushRequest, PushResult,
    ServerInfo, SyncOp,
};

/// Crate version, reported to adapters for diagnostics.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Liveness check used to prove the core → shell → UI wiring.
pub fn ping() -> String {
    format!("pong from taskmaster-core v{VERSION}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_reports_core_version() {
        assert_eq!(ping(), format!("pong from taskmaster-core v{VERSION}"));
    }
}
