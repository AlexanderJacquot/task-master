//! Backups and JSON export/import (plan section 4).
//!
//! - A backup is a consistent SQLite copy made with `VACUUM INTO` (compacted, safe while
//!   the app runs). Daily backups rotate, keeping the newest `keep`.
//! - An export is every user table as JSON rows, versioned with the schema number, so it
//!   can be read by a person, diffed, or imported on another machine.
//! - An import replaces everything in one transaction. It is not undoable: the caller
//!   takes a backup first (the desktop shell does).

use std::path::{Path, PathBuf};

use rusqlite::{Connection, types::ValueRef};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::clock::now_ms;
use crate::error::{Error, Result};

/// Identifies an export file.
pub const EXPORT_FORMAT: &str = "task-master-export";

/// User tables in dependency order (parents first). `settings` stays out: it holds this
/// device's id. `tasks_fts` is rebuilt by its triggers.
pub(crate) const TABLES: &[&str] = &[
    "statuses",
    "tags",
    "projects",
    "epics",
    "tasks",
    "task_tags",
    "views",
    "attachments",
    "time_blocks",
    "agent_sessions",
    "agent_notes",
    "ops",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExportFile {
    pub format: String,
    /// Number of migrations applied to the exporting database.
    pub schema_version: usize,
    pub exported_at: i64,
    /// Table name → rows (column → value).
    pub tables: Map<String, Value>,
}

/// What an import replaced, for the UI to report.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ImportSummary {
    pub tasks: u32,
    pub projects: u32,
    pub epics: u32,
    pub tags: u32,
    pub views: u32,
    pub attachments: u32,
    pub time_blocks: u32,
    /// Attachments whose file was not found (an export copied without its folder).
    pub missing_files: u32,
}

pub(crate) fn backup_to(conn: &Connection, target: &Path) -> Result<()> {
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // VACUUM INTO refuses an existing file; write beside it, then swap in.
    let tmp = target.with_extension("partial");
    let _ = std::fs::remove_file(&tmp);
    conn.execute("VACUUM INTO ?1", [tmp.to_string_lossy()])?;
    std::fs::rename(&tmp, target)?;
    Ok(())
}

/// Writes `daily-<today>.sqlite` into `dir` unless it exists, then deletes the oldest daily
/// backups beyond `keep`. Returns the new file, or `None` if today's already existed.
pub(crate) fn daily_backup(
    conn: &Connection,
    dir: &Path,
    today: &str,
    keep: usize,
) -> Result<Option<PathBuf>> {
    crate::clock::check_date("today", today)?;
    let target = dir.join(format!("daily-{today}.sqlite"));
    let created = if target.exists() {
        None
    } else {
        backup_to(conn, &target)?;
        Some(target)
    };
    let mut daily: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("daily-") && n.ends_with(".sqlite"))
        })
        .collect();
    daily.sort();
    while daily.len() > keep {
        std::fs::remove_file(daily.remove(0))?;
    }
    Ok(created)
}

fn rows(conn: &Connection, table: &str) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table}"))?;
    let cols: Vec<String> = stmt
        .column_names()
        .iter()
        .map(|c| (*c).to_owned())
        .collect();
    let mut out = Vec::new();
    let mut q = stmt.query([])?;
    while let Some(r) = q.next()? {
        let mut row = Map::new();
        for (i, col) in cols.iter().enumerate() {
            let v = match r.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => Value::from(n),
                ValueRef::Real(f) => Value::from(f),
                ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
                ValueRef::Blob(_) => {
                    return Err(Error::invalid(format!("{table}.{col} holds a blob")));
                }
            };
            row.insert(col.clone(), v);
        }
        out.push(Value::Object(row));
    }
    Ok(out)
}

pub(crate) fn export(conn: &Connection, schema_version: usize) -> Result<ExportFile> {
    let mut tables = Map::new();
    for table in TABLES {
        tables.insert((*table).to_owned(), Value::Array(rows(conn, table)?));
    }
    Ok(ExportFile {
        format: EXPORT_FORMAT.to_owned(),
        schema_version,
        exported_at: now_ms(),
        tables,
    })
}

fn columns(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = stmt.query_map([], |r| r.get::<_, String>(1))?;
    Ok(cols.collect::<rusqlite::Result<_>>()?)
}

fn sql_value(v: &Value) -> Result<rusqlite::types::Value> {
    use rusqlite::types::Value as V;
    Ok(match v {
        Value::Null => V::Null,
        Value::Bool(b) => V::Integer(i64::from(*b)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => V::Integer(i),
            None => V::Real(n.as_f64().unwrap_or_default()),
        },
        Value::String(s) => V::Text(s.clone()),
        other => {
            return Err(Error::invalid(format!(
                "unexpected value {other} in import"
            )));
        }
    })
}

/// Replaces every user table with the file's rows, atomically. Rows are checked against
/// the live schema; a file from another schema version is refused.
pub(crate) fn import(
    conn: &mut Connection,
    file: &ExportFile,
    schema_version: usize,
) -> Result<ImportSummary> {
    if file.format != EXPORT_FORMAT {
        return Err(Error::invalid("not a task-master export file"));
    }
    if file.schema_version != schema_version {
        return Err(Error::invalid(format!(
            "this export is from schema version {}, this app is at {schema_version}; \
             open it with the matching version of task-master",
            file.schema_version
        )));
    }
    let tx = conn.transaction()?;
    // Subtasks may precede their parent: check references once, at the end.
    tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
    for table in TABLES.iter().rev() {
        tx.execute(&format!("DELETE FROM {table}"), [])?;
    }
    let mut summary = ImportSummary::default();
    for table in TABLES {
        let allowed = columns(&tx, table)?;
        let list = match file.tables.get(*table) {
            Some(Value::Array(list)) => list.as_slice(),
            Some(_) => return Err(Error::invalid(format!("'{table}' must be a list of rows"))),
            None => &[],
        };
        for row in list {
            let Value::Object(row) = row else {
                return Err(Error::invalid(format!(
                    "a row of '{table}' is not an object"
                )));
            };
            if let Some(bad) = row.keys().find(|k| !allowed.contains(k)) {
                return Err(Error::invalid(format!("unknown column '{table}.{bad}'")));
            }
            let cols: Vec<&str> = row.keys().map(String::as_str).collect();
            let marks = vec!["?"; cols.len()].join(", ");
            let values = row.values().map(sql_value).collect::<Result<Vec<_>>>()?;
            tx.execute(
                &format!("INSERT INTO {table} ({}) VALUES ({marks})", cols.join(", ")),
                rusqlite::params_from_iter(values),
            )?;
        }
        let n = u32::try_from(list.len()).unwrap_or(u32::MAX);
        match *table {
            "tasks" => summary.tasks = n,
            "projects" => summary.projects = n,
            "epics" => summary.epics = n,
            "tags" => summary.tags = n,
            "views" => summary.views = n,
            "attachments" => summary.attachments = n,
            "time_blocks" => summary.time_blocks = n,
            _ => {}
        }
    }
    // Foreign keys are checked per statement; this catches dangling references overall.
    let broken: i64 = tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
        r.get(0)
    })?;
    if broken > 0 {
        return Err(Error::invalid(format!(
            "the export has {broken} broken reference(s); nothing was imported"
        )));
    }
    // Sync bookkeeping: clocks come from the imported ops; every op is pushed again (the
    // server ignores the ones it has) and pulls start over.
    tx.execute_batch(crate::sync::REBUILD_CLOCKS)?;
    tx.execute_batch("UPDATE ops SET received = 0; DELETE FROM sync_state;")?;
    tx.commit()?;
    Ok(summary)
}
