//! Connection setup and migrations.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};
use rusqlite_migration::{M, Migrations, SchemaVersion};

use crate::clock::{new_id, now_ms};
use crate::error::Result;

/// Embedded migrations, applied in order at startup. Never edit a shipped one: add a new file.
const MIGRATIONS: &[M<'static>] = &[
    M::up(include_str!("../migrations/0001_init.sql")),
    M::up(include_str!("../migrations/0002_views.sql")),
    M::up(include_str!("../migrations/0003_statuses.sql")),
    M::up(include_str!("../migrations/0004_attachments.sql")),
    M::up(include_str!("../migrations/0005_time_blocks.sql")),
    M::up(include_str!("../migrations/0006_calendar_sync.sql")),
    M::up(include_str!("../migrations/0007_sync.sql")),
    M::up(include_str!("../migrations/0008_epic_appearance.sql")),
    M::up(include_str!("../migrations/0009_task_dependencies.sql")),
    M::up(include_str!("../migrations/0010_agent_sessions.sql")),
];

pub(crate) fn migrations() -> Migrations<'static> {
    Migrations::from_slice(MIGRATIONS)
}

/// Opens (creating if needed) the database file and brings it to the latest schema.
///
/// An existing database is copied to `<dir>/backups/` before any pending migration runs.
pub(crate) fn open_file(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let existed = path.exists();
    let mut conn = Connection::open(path)?;
    configure(&conn)?;
    if existed {
        let applied = applied_migrations(&conn)?;
        if applied < MIGRATIONS.len() {
            backup_before_migration(&conn, path, applied)?;
        }
    }
    migrations().to_latest(&mut conn)?;
    Ok(conn)
}

pub(crate) fn open_in_memory() -> Result<Connection> {
    let mut conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrations().to_latest(&mut conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    // journal_mode returns a row, so it cannot go through execute_batch on every SQLite.
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}

pub(crate) fn applied_migrations(conn: &Connection) -> Result<usize> {
    Ok(match migrations().current_version(conn)? {
        SchemaVersion::NoneSet => 0,
        SchemaVersion::Inside(n) | SchemaVersion::Outside(n) => n.get(),
    })
}

fn backup_before_migration(conn: &Connection, path: &Path, applied: usize) -> Result<PathBuf> {
    let dir = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("backups");
    std::fs::create_dir_all(&dir)?;
    let stem = path
        .file_stem()
        .map_or_else(|| "db".into(), |s| s.to_string_lossy());
    let target = dir.join(format!("{stem}-v{applied}-{}.sqlite", now_ms()));
    conn.execute("VACUUM INTO ?1", [target.to_string_lossy()])?;
    Ok(target)
}

/// This installation's device id, created on first open.
pub(crate) fn device_id(conn: &Connection) -> Result<String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'device_id'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = new_id();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('device_id', ?1)",
        [&id],
    )?;
    Ok(id)
}

/// Highest HLC recorded, so the clock never goes backwards across restarts.
pub(crate) fn last_hlc(conn: &Connection) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT MAX(hlc) FROM ops", [], |r| r.get(0))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_valid() {
        migrations().validate().unwrap();
    }

    #[test]
    fn fresh_db_has_schema_fts5_and_default_statuses() {
        let conn = open_in_memory().unwrap();
        let names: Vec<String> = conn
            .prepare("SELECT name FROM statuses ORDER BY rank")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            names,
            [
                "Backlog",
                "To do",
                "In progress",
                "Waiting",
                "Done",
                "Cancelled"
            ]
        );
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1);
        conn.execute_batch("SELECT * FROM tasks_fts WHERE tasks_fts MATCH 'x'")
            .unwrap();
    }

    #[test]
    fn device_id_is_stable() {
        let conn = open_in_memory().unwrap();
        let a = device_id(&conn).unwrap();
        assert_eq!(device_id(&conn).unwrap(), a);
    }
}
