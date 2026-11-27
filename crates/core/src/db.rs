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
    M::up(include_str!("../migrations/0011_review_status.sql")),
    M::up(include_str!("../migrations/0012_agent_session_model.sql")),
    M::up(include_str!(
        "../migrations/0013_agent_session_duration.sql"
    )),
    M::up(include_str!("../migrations/0014_block_missed.sql")),
    M::up(include_str!("../migrations/0015_meetings.sql")),
    M::up(include_str!("../migrations/0016_transcripts.sql")),
    M::up(include_str!("../migrations/0017_terminal_sessions.sql")),
    M::up(include_str!("../migrations/0018_notes.sql")),
    M::up(include_str!("../migrations/0019_note_search_and_files.sql")),
    M::up(include_str!("../migrations/0020_team_spaces.sql")).foreign_key_check(),
    M::up(include_str!("../migrations/0021_identity.sql")),
    M::up(include_str!("../migrations/0022_comments.sql")),
    M::up(include_str!("../migrations/0023_meeting_show_as.sql")),
    M::up(include_str!("../migrations/0024_nested_note_folders.sql")),
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
    migrate(&mut conn)?;
    Ok(conn)
}

pub(crate) fn open_in_memory() -> Result<Connection> {
    let mut conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

/// Brings the schema to the latest version with foreign keys off, as SQLite's procedure for
/// rebuilding a table requires (a dropped parent table would otherwise fail its children).
/// Migrations that rebuild tables check the keys before they commit.
fn migrate(conn: &mut Connection) -> Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = OFF")?;
    let migrated = migrations().to_latest(conn);
    conn.execute_batch("PRAGMA foreign_keys = ON")?;
    migrated?;
    Ok(())
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
                "Review",
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
    fn review_is_seeded_once_and_not_next_to_a_users_own() {
        let count = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT count(*) FROM statuses
                 WHERE lower(trim(name)) = 'review' AND deleted_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        let fresh = open_in_memory().unwrap();
        assert_eq!(count(&fresh), 1);
        let (id, category): (String, String) = fresh
            .query_row(
                "SELECT id, category FROM statuses WHERE name = 'Review'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(id, crate::model::REVIEW_STATUS_ID);
        assert_eq!(category, "in_progress", "an open status");

        // A workflow that already has a Review keeps just its own.
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&conn).unwrap();
        migrations().to_version(&mut conn, 10).unwrap();
        conn.execute(
            "INSERT INTO statuses (id, name, category, rank) VALUES ('mine', ' review ', 'todo', 'a9')",
            [],
        )
        .unwrap();
        migrations().to_latest(&mut conn).unwrap();
        assert_eq!(count(&conn), 1);
        let seeded: i64 = conn
            .query_row(
                "SELECT count(*) FROM statuses WHERE id = ?1",
                [crate::model::REVIEW_STATUS_ID],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(seeded, 0);
    }

    #[test]
    fn team_spaces_migration_keeps_rows_search_and_references() {
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&conn).unwrap();
        migrations().to_version(&mut conn, 19).unwrap();
        let status: String = conn
            .query_row("SELECT id FROM statuses LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute_batch(&format!(
            "INSERT INTO tasks (id, status_id, title, rank, created_at, updated_at)
               VALUES ('t', '{status}', 'T', 'a0', 1, 1);
             INSERT INTO time_blocks (id, task_id, start_at, end_at, created_at, updated_at)
               VALUES ('b', 't', 10, 20, 1, 1);
             INSERT INTO meetings (id, title, started_at, task_id, created_at, updated_at)
               VALUES ('m', 'Standup', 5, 't', 1, 1);
             INSERT INTO attachments (id, meeting_id, hash, name, mime, size, created_at,
                                      updated_at)
               VALUES ('a', 'm', 'h', 'x.txt', 'text/plain', 3, 1, 1);
             INSERT INTO agent_sessions (id, task_id, device_id, claude_session_id, folder,
                                         runtime, permission_mode, started_at, created_at,
                                         updated_at, model)
               VALUES ('s', 't', 'd', 'c', '/x', 'native', 'default', 1, 1, 1, 'opus');
             INSERT INTO agent_notes (id, session_id, task_id, body, created_at, updated_at)
               VALUES ('n', 's', 't', 'progress', 1, 1);
             INSERT INTO notes (id, title, body, task_id, rank, created_at, updated_at)
               VALUES ('note', 'Roadmap draft', 'body', 't', 'a0', 1, 1);"
        ))
        .unwrap();
        // The meeting is a parent of attachments: its rebuild needs foreign keys off.
        migrate(&mut conn).unwrap();
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(
            count("SELECT count(*) FROM time_blocks WHERE task_id = 't'"),
            1
        );
        assert_eq!(
            count("SELECT count(*) FROM meetings WHERE task_id = 't'"),
            1
        );
        assert_eq!(
            count("SELECT count(*) FROM attachments WHERE meeting_id = 'm'"),
            1
        );
        assert_eq!(
            count("SELECT count(*) FROM agent_sessions WHERE model = 'opus'"),
            1
        );
        assert_eq!(
            count("SELECT count(*) FROM agent_notes WHERE session_id = 's'"),
            1
        );
        assert_eq!(
            count("SELECT count(*) FROM notes_fts WHERE notes_fts MATCH 'roadmap'"),
            1,
            "search still finds the note"
        );
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1, "foreign keys are back on");
        // A block may now name a task of another database.
        conn.execute(
            "INSERT INTO time_blocks (id, task_id, start_at, end_at, created_at, updated_at)
             VALUES ('b2', 'elsewhere', 10, 20, 1, 1)",
            [],
        )
        .unwrap();
        // Keys kept elsewhere still hold.
        assert!(
            conn.execute(
                "INSERT INTO agent_notes (id, session_id, task_id, body, created_at, updated_at)
                 VALUES ('n2', 'missing', 't', 'x', 1, 1)",
                [],
            )
            .is_err()
        );
        conn.execute("UPDATE notes SET title = 'Plan' WHERE id = 'note'", [])
            .unwrap();
        assert_eq!(
            count("SELECT count(*) FROM notes_fts WHERE notes_fts MATCH 'plan'"),
            1,
            "the search triggers were recreated"
        );
    }

    #[test]
    fn meetings_migration_keeps_task_attachments() {
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&conn).unwrap();
        migrations().to_version(&mut conn, 14).unwrap();
        let status: String = conn
            .query_row("SELECT id FROM statuses LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, status_id, title, rank, created_at, updated_at)
             VALUES ('t', ?1, 'T', 'a0', 1, 1)",
            [status],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments (id, task_id, hash, name, mime, size, created_at, updated_at)
             VALUES ('a', 't', 'h', 'x.txt', 'text/plain', 3, 1, 1)",
            [],
        )
        .unwrap();
        migrations().to_latest(&mut conn).unwrap();
        let (task_id, meeting_id, name): (String, Option<String>, String) = conn
            .query_row(
                "SELECT task_id, meeting_id, name FROM attachments WHERE id = 'a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (task_id.as_str(), meeting_id, name.as_str()),
            ("t", None, "x.txt")
        );
        // An attachment names exactly one owner.
        assert!(
            conn.execute(
                "INSERT INTO attachments (id, hash, name, mime, size, created_at, updated_at)
                 VALUES ('b', 'h', 'y', 'text/plain', 1, 1, 1)",
                [],
            )
            .is_err()
        );
    }

    #[test]
    fn show_as_migration_keeps_meetings_busy_and_private() {
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&conn).unwrap();
        migrations().to_version(&mut conn, 22).unwrap();
        conn.execute(
            "INSERT INTO meetings (id, title, started_at, created_at, updated_at)
             VALUES ('m', 'Old', 1, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO calendar_events (calendar_id, event_id, title) VALUES ('c', 'e', 'E')",
            [],
        )
        .unwrap();
        migrations().to_latest(&mut conn).unwrap();
        let meeting: (String, bool) = conn
            .query_row("SELECT show_as, private FROM meetings", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(meeting, ("busy".to_string(), true));
        let event: (String, bool) = conn
            .query_row("SELECT show_as, private FROM calendar_events", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(event, ("busy".to_string(), false));
    }

    #[test]
    fn transcripts_migration_gives_meetings_no_speaker_names() {
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&conn).unwrap();
        migrations().to_version(&mut conn, 15).unwrap();
        conn.execute(
            "INSERT INTO meetings (id, title, started_at, created_at, updated_at)
             VALUES ('m', 'Old', 1, 1, 1)",
            [],
        )
        .unwrap();
        migrations().to_latest(&mut conn).unwrap();
        let speakers: String = conn
            .query_row("SELECT speakers FROM meetings WHERE id = 'm'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(speakers, "{}");
        // A segment needs its meeting.
        assert!(
            conn.execute(
                "INSERT INTO transcript_segments
                   (id, meeting_id, start_ms, end_ms, speaker, text, created_at, updated_at)
                 VALUES ('s', 'nope', 0, 1, 'me', 'x', 1, 1)",
                [],
            )
            .is_err()
        );
    }

    #[test]
    fn device_id_is_stable() {
        let conn = open_in_memory().unwrap();
        let a = device_id(&conn).unwrap();
        assert_eq!(device_id(&conn).unwrap(), a);
    }
}
