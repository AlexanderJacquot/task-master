//! task-master core: all logic and data live here.
//!
//! Front ends (the Tauri desktop shell now; a CLI, an MCP server and a sync
//! server later) are thin adapters over this crate. See `docs/plan.md`.

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
