//! task-master core: all logic and data live here.
//!
//! Front ends (the Tauri desktop shell now; a CLI, an MCP server and a sync server later)
//! are thin adapters over [`Store`]. Every write is a [`Command`] run by
//! [`Store::execute`], which writes rows and their `ops` entries in one transaction.
//! See `docs/plan.md`.

mod clock;
mod commands;
mod db;
mod dump;
mod error;
mod events;
mod history;
mod model;
mod ops;
mod parse;
mod query;
pub mod rank;
mod store;

pub use clock::{new_id, now_ms, utc_date};
pub use commands::{
    Command, EpicChange, MAX_RANK_LEN, NewEpic, NewProject, NewStatus, NewTag, NewTask, NewView,
    ProjectChange, StatusChange, TagChange, TaskChange, ViewChange,
};
pub use dump::{EXPORT_FORMAT, ExportFile, ImportSummary};
pub use error::{Error, Result};
pub use events::{Changed, EntityRef};
pub use model::{
    DueFilter, Epic, EpicState, GroupBy, Id, IsoDate, Layout, Priority, Project, Snapshot, SortBy,
    Status, StatusCategory, Swimlane, Tag, Task, Timestamp, VIEW_SPEC_VERSION, View, ViewFilter,
    ViewScope, ViewSpec,
};
pub use ops::EntityKind;
pub use parse::{Capture, NameMatch, Parsed, parse};
pub use query::{Activity, FieldChange};
pub use store::{Changes, Store};

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
