//! Reads: entity loading, the hydration snapshot and full-text search.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Row, params_from_iter, types::ToSql};

use crate::error::{Error, Result};
use crate::model::{
    Epic, EpicState, Id, Priority, Project, Snapshot, Status, StatusCategory, Tag, Task, View,
};

const TASK_COLS: &str = "id, project_id, epic_id, parent_id, status_id, title, description, \
    priority, due_date, today_on, estimate_min, rank, created_at, updated_at, completed_at, deleted_at";
const PROJECT_COLS: &str =
    "id, parent_id, name, color, icon, rank, archived_at, created_at, updated_at, deleted_at";
const EPIC_COLS: &str = "id, project_id, name, description, target_date, state, rank, \
    created_at, updated_at, deleted_at";
const TAG_COLS: &str = "id, name, color, created_at, updated_at, deleted_at";

fn bad_value(col: usize, value: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        col,
        rusqlite::types::Type::Text,
        format!("unexpected value '{value}'").into(),
    )
}

fn task_row(r: &Row<'_>) -> rusqlite::Result<Task> {
    let priority: i64 = r.get(7)?;
    Ok(Task {
        id: r.get(0)?,
        project_id: r.get(1)?,
        epic_id: r.get(2)?,
        parent_id: r.get(3)?,
        status_id: r.get(4)?,
        title: r.get(5)?,
        description: r.get(6)?,
        priority: Priority::from_db(priority).ok_or_else(|| bad_value(7, priority.to_string()))?,
        due_date: r.get(8)?,
        today_on: r.get(9)?,
        estimate_min: r.get(10)?,
        rank: r.get(11)?,
        tag_ids: Vec::new(),
        created_at: r.get(12)?,
        updated_at: r.get(13)?,
        completed_at: r.get(14)?,
        deleted_at: r.get(15)?,
    })
}

fn project_row(r: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get(0)?,
        parent_id: r.get(1)?,
        name: r.get(2)?,
        color: r.get(3)?,
        icon: r.get(4)?,
        rank: r.get(5)?,
        archived_at: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        deleted_at: r.get(9)?,
    })
}

fn epic_row(r: &Row<'_>) -> rusqlite::Result<Epic> {
    let state: String = r.get(5)?;
    Ok(Epic {
        id: r.get(0)?,
        project_id: r.get(1)?,
        name: r.get(2)?,
        description: r.get(3)?,
        target_date: r.get(4)?,
        state: EpicState::parse(&state).ok_or_else(|| bad_value(5, state))?,
        rank: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        deleted_at: r.get(9)?,
    })
}

fn tag_row(r: &Row<'_>) -> rusqlite::Result<Tag> {
    Ok(Tag {
        id: r.get(0)?,
        name: r.get(1)?,
        color: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
        deleted_at: r.get(5)?,
    })
}

fn status_row(r: &Row<'_>) -> rusqlite::Result<Status> {
    let category: String = r.get(2)?;
    Ok(Status {
        id: r.get(0)?,
        name: r.get(1)?,
        category: StatusCategory::parse(&category).ok_or_else(|| bad_value(2, category))?,
        color: r.get(3)?,
        rank: r.get(4)?,
        wip_limit: r.get(5)?,
    })
}

fn query<T>(
    conn: &Connection,
    sql: &str,
    params: &[&dyn ToSql],
    map: fn(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map(params_from_iter(params.iter()), map)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn attach_tags(conn: &Connection, tasks: &mut [Task], only_task: Option<&str>) -> Result<()> {
    let mut by_task: HashMap<String, Vec<Id>> = HashMap::new();
    let pairs: Vec<(String, String)> = match only_task {
        Some(id) => query(
            conn,
            "SELECT task_id, tag_id FROM task_tags WHERE task_id = ?1 ORDER BY tag_id",
            &[&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?,
        None => query(
            conn,
            "SELECT task_id, tag_id FROM task_tags ORDER BY tag_id",
            &[],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?,
    };
    for (task_id, tag_id) in pairs {
        by_task.entry(task_id).or_default().push(tag_id);
    }
    for task in tasks {
        task.tag_ids = by_task.remove(&task.id).unwrap_or_default();
    }
    Ok(())
}

/// Any task, including soft-deleted ones.
pub(crate) fn task(conn: &Connection, id: &str) -> Result<Task> {
    let sql = format!("SELECT {TASK_COLS} FROM tasks WHERE id = ?1");
    let mut task = conn
        .query_row(&sql, [id], task_row)
        .optional()?
        .ok_or_else(|| Error::not_found("task", id))?;
    attach_tags(conn, std::slice::from_mut(&mut task), Some(id))?;
    Ok(task)
}

pub(crate) fn project(conn: &Connection, id: &str) -> Result<Project> {
    let sql = format!("SELECT {PROJECT_COLS} FROM projects WHERE id = ?1");
    conn.query_row(&sql, [id], project_row)
        .optional()?
        .ok_or_else(|| Error::not_found("project", id))
}

pub(crate) fn epic(conn: &Connection, id: &str) -> Result<Epic> {
    let sql = format!("SELECT {EPIC_COLS} FROM epics WHERE id = ?1");
    conn.query_row(&sql, [id], epic_row)
        .optional()?
        .ok_or_else(|| Error::not_found("epic", id))
}

pub(crate) fn tag(conn: &Connection, id: &str) -> Result<Tag> {
    let sql = format!("SELECT {TAG_COLS} FROM tags WHERE id = ?1");
    conn.query_row(&sql, [id], tag_row)
        .optional()?
        .ok_or_else(|| Error::not_found("tag", id))
}

pub(crate) fn status(conn: &Connection, id: &str) -> Result<Status> {
    conn.query_row(
        "SELECT id, name, category, color, rank, wip_limit FROM statuses WHERE id = ?1",
        [id],
        status_row,
    )
    .optional()?
    .ok_or_else(|| Error::not_found("status", id))
}

/// Every live entity, in display order (rank, then id).
pub(crate) fn snapshot(conn: &Connection) -> Result<Snapshot> {
    let mut tasks = query(
        conn,
        &format!("SELECT {TASK_COLS} FROM tasks WHERE deleted_at IS NULL ORDER BY rank, id"),
        &[],
        task_row,
    )?;
    attach_tags(conn, &mut tasks, None)?;
    Ok(Snapshot {
        tasks,
        projects: query(
            conn,
            &format!(
                "SELECT {PROJECT_COLS} FROM projects WHERE deleted_at IS NULL ORDER BY rank, id"
            ),
            &[],
            project_row,
        )?,
        epics: query(
            conn,
            &format!("SELECT {EPIC_COLS} FROM epics WHERE deleted_at IS NULL ORDER BY rank, id"),
            &[],
            epic_row,
        )?,
        statuses: query(
            conn,
            "SELECT id, name, category, color, rank, wip_limit FROM statuses ORDER BY rank, id",
            &[],
            status_row,
        )?,
        tags: query(
            conn,
            &format!("SELECT {TAG_COLS} FROM tags WHERE deleted_at IS NULL ORDER BY name, id"),
            &[],
            tag_row,
        )?,
        views: query(
            conn,
            "SELECT id, name, spec, rank FROM views ORDER BY rank, id",
            &[],
            |r| {
                Ok(View {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    spec: r.get(2)?,
                    rank: r.get(3)?,
                })
            },
        )?,
    })
}

/// Live task ids matching every word of `text` (prefix match on title and description),
/// best match first.
pub(crate) fn search(conn: &Connection, text: &str, limit: u32) -> Result<Vec<Id>> {
    let terms: Vec<String> = text
        .split_whitespace()
        .map(|word| format!("\"{}\"*", word.replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let fts_query = terms.join(" ");
    query(
        conn,
        "SELECT t.id FROM tasks_fts
         JOIN tasks t ON t.rowid = tasks_fts.rowid
         WHERE tasks_fts MATCH ?1 AND t.deleted_at IS NULL
         ORDER BY bm25(tasks_fts), t.rank
         LIMIT ?2",
        &[&fts_query, &limit],
        |r| r.get(0),
    )
}

/// One recorded change to a task, for its activity feed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Activity {
    pub seq: i64,
    /// When it happened (wall-clock part of the HLC), Unix ms.
    pub at: crate::model::Timestamp,
    pub batch_id: Option<Id>,
    /// `create`, `update`, `delete`, `restore`, `link` (tag added) or `unlink` (tag removed).
    pub kind: String,
    pub fields: Vec<FieldChange>,
}

/// A field's value before and after, JSON-encoded (`null` for none).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct FieldChange {
    pub field: String,
    pub before: String,
    pub after: String,
}

/// A task's history, newest first. Bookkeeping-only updates (`updated_at`) are skipped.
pub(crate) fn task_activity(conn: &Connection, task_id: &str, limit: u32) -> Result<Vec<Activity>> {
    type Row = (i64, String, Option<String>, String, String, String, String);
    let rows: Vec<Row> = query(
        conn,
        "SELECT seq, hlc, batch_id, entity, kind, patch, inverse FROM ops
         WHERE entity IN ('task', 'task_tag') AND entity_id = ?1
         ORDER BY seq DESC LIMIT ?2",
        &[&task_id, &(limit * 2)],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        },
    )?;
    let mut out = Vec::new();
    for (seq, hlc, batch_id, entity, kind, patch, inverse) in rows {
        let patch: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&patch)?;
        let inverse: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&inverse)?;
        let fields: Vec<FieldChange> = patch
            .iter()
            .filter(|(k, _)| k.as_str() != "updated_at")
            .filter(|_| kind != "create" || entity == "task_tag")
            .map(|(k, after)| FieldChange {
                field: k.clone(),
                before: if entity == "task_tag" {
                    "null".to_owned()
                } else {
                    inverse
                        .get(k)
                        .unwrap_or(&serde_json::Value::Null)
                        .to_string()
                },
                after: after.to_string(),
            })
            .collect();
        if fields.is_empty() && kind == "update" {
            continue;
        }
        out.push(Activity {
            seq,
            at: hlc
                .split('-')
                .next()
                .and_then(|w| w.parse().ok())
                .unwrap_or(0),
            batch_id,
            kind,
            fields,
        });
        if out.len() == limit as usize {
            break;
        }
    }
    Ok(out)
}
