//! Reads: entity loading, the hydration snapshot and full-text search.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Row, params_from_iter, types::ToSql};

use crate::error::{Error, Result};
use crate::model::{
    AgentNote, AgentRuntime, AgentSession, Attachment, BlockOutcome, Epic, EpicState, Id, Priority,
    Project, ProjectFolder, SessionState, Snapshot, Status, StatusCategory, Tag, Task, TaskOwner,
    TimeBlock, View,
};

const TASK_COLS: &str = "id, project_id, epic_id, parent_id, status_id, title, description, \
    priority, due_date, today_on, estimate_min, rank, created_at, updated_at, completed_at, deleted_at, dependency_ids, \
    owner";
const PROJECT_COLS: &str =
    "id, parent_id, name, color, icon, rank, archived_at, created_at, updated_at, deleted_at";
const EPIC_COLS: &str = "id, project_id, name, description, target_date, state, rank, \
    created_at, updated_at, deleted_at, color, icon";
const TAG_COLS: &str = "id, name, color, created_at, updated_at, deleted_at";
const STATUS_COLS: &str =
    "id, name, category, color, rank, wip_limit, created_at, updated_at, deleted_at";
const VIEW_COLS: &str = "id, name, spec, rank, created_at, updated_at, deleted_at";
const ATTACHMENT_COLS: &str =
    "id, task_id, hash, name, mime, size, created_at, updated_at, deleted_at";

const TIME_BLOCK_COLS: &str =
    "id, task_id, start_at, end_at, outcome, created_at, updated_at, deleted_at";

const SESSION_COLS: &str = "s.id, s.task_id, s.device_id, s.claude_session_id, s.folder, \
    s.runtime, s.permission_mode, s.prompt, s.state, s.started_at, s.ended_at, s.summary, \
    s.cost_usd_micros, s.turns, s.error, s.created_at, s.updated_at, s.deleted_at, s.model";

const NOTE_COLS: &str =
    "n.id, n.session_id, n.task_id, n.body, n.created_at, n.updated_at, n.deleted_at";

fn bad_value(col: usize, value: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        col,
        rusqlite::types::Type::Text,
        format!("unexpected value '{value}'").into(),
    )
}

fn task_row(r: &Row<'_>) -> rusqlite::Result<Task> {
    let priority: i64 = r.get(7)?;
    let dependencies: String = r.get(16)?;
    let owner: String = r.get(17)?;
    Ok(Task {
        owner: TaskOwner::parse(&owner).ok_or_else(|| bad_value(17, owner))?,
        dependency_ids: serde_json::from_str(&dependencies).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(16, rusqlite::types::Type::Text, Box::new(e))
        })?,
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
        color: r.get(10)?,
        icon: r.get(11)?,
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

fn view_row(r: &Row<'_>) -> rusqlite::Result<View> {
    let spec: String = r.get(2)?;
    let spec = serde_json::from_str(&spec).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(View {
        id: r.get(0)?,
        name: r.get(1)?,
        spec,
        rank: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        deleted_at: r.get(6)?,
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

fn attachment_row(r: &Row<'_>) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        id: r.get(0)?,
        task_id: r.get(1)?,
        hash: r.get(2)?,
        name: r.get(3)?,
        mime: r.get(4)?,
        size: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        deleted_at: r.get(8)?,
    })
}

fn time_block_row(r: &Row<'_>) -> rusqlite::Result<TimeBlock> {
    let outcome: String = r.get(4)?;
    Ok(TimeBlock {
        id: r.get(0)?,
        task_id: r.get(1)?,
        start_at: r.get(2)?,
        end_at: r.get(3)?,
        outcome: BlockOutcome::parse(&outcome).ok_or_else(|| bad_value(4, outcome))?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
        deleted_at: r.get(7)?,
    })
}

fn session_row(r: &Row<'_>) -> rusqlite::Result<AgentSession> {
    let runtime: String = r.get(5)?;
    let state: String = r.get(8)?;
    Ok(AgentSession {
        id: r.get(0)?,
        task_id: r.get(1)?,
        device_id: r.get(2)?,
        claude_session_id: r.get(3)?,
        folder: r.get(4)?,
        runtime: AgentRuntime::parse(&runtime).ok_or_else(|| bad_value(5, runtime))?,
        permission_mode: r.get(6)?,
        prompt: r.get(7)?,
        state: SessionState::parse(&state).ok_or_else(|| bad_value(8, state))?,
        started_at: r.get(9)?,
        ended_at: r.get(10)?,
        summary: r.get(11)?,
        cost_usd_micros: r.get(12)?,
        turns: r.get(13)?,
        error: r.get(14)?,
        created_at: r.get(15)?,
        updated_at: r.get(16)?,
        deleted_at: r.get(17)?,
        model: r.get(18)?,
    })
}

fn note_row(r: &Row<'_>) -> rusqlite::Result<AgentNote> {
    Ok(AgentNote {
        id: r.get(0)?,
        session_id: r.get(1)?,
        task_id: r.get(2)?,
        body: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        deleted_at: r.get(6)?,
    })
}

/// Any agent session, including soft-deleted ones.
pub(crate) fn agent_session(conn: &Connection, id: &str) -> Result<AgentSession> {
    conn.query_row(
        &format!("SELECT {SESSION_COLS} FROM agent_sessions s WHERE s.id = ?1"),
        [id],
        session_row,
    )
    .optional()?
    .ok_or_else(|| Error::not_found("agent session", id))
}

/// Any agent note, including soft-deleted ones.
pub(crate) fn agent_note(conn: &Connection, id: &str) -> Result<AgentNote> {
    conn.query_row(
        &format!("SELECT {NOTE_COLS} FROM agent_notes n WHERE n.id = ?1"),
        [id],
        note_row,
    )
    .optional()?
    .ok_or_else(|| Error::not_found("agent note", id))
}

/// Live sessions of a task, oldest first.
pub(crate) fn task_sessions(conn: &Connection, task_id: &str) -> Result<Vec<AgentSession>> {
    query(
        conn,
        &format!(
            "SELECT {SESSION_COLS} FROM agent_sessions s
             WHERE s.task_id = ?1 AND s.deleted_at IS NULL ORDER BY s.started_at, s.id"
        ),
        &[&task_id],
        session_row,
    )
}

/// Live notes of a task (`session_id` narrows to one session), oldest first, the newest
/// `limit`.
pub(crate) fn agent_notes(
    conn: &Connection,
    task_id: &str,
    session_id: Option<&str>,
    limit: u32,
) -> Result<Vec<AgentNote>> {
    let mut notes = query(
        conn,
        &format!(
            "SELECT {NOTE_COLS} FROM agent_notes n JOIN agent_sessions s ON s.id = n.session_id
             WHERE n.task_id = ?1 AND (?2 IS NULL OR n.session_id = ?2)
               AND n.deleted_at IS NULL AND s.deleted_at IS NULL
             ORDER BY n.created_at DESC, n.id DESC LIMIT ?3"
        ),
        &[&task_id, &session_id, &limit],
        note_row,
    )?;
    notes.reverse();
    Ok(notes)
}

/// This device's project folders, for projects that still exist.
pub(crate) fn project_folders(conn: &Connection) -> Result<Vec<ProjectFolder>> {
    query(
        conn,
        "SELECT f.project_id, f.path, f.runtime, f.updated_at FROM project_folders f
         JOIN projects p ON p.id = f.project_id WHERE p.deleted_at IS NULL
         ORDER BY f.project_id",
        &[],
        |r| {
            let runtime: String = r.get(2)?;
            Ok(ProjectFolder {
                project_id: r.get(0)?,
                path: r.get(1)?,
                runtime: AgentRuntime::parse(&runtime).ok_or_else(|| bad_value(2, runtime))?,
                updated_at: r.get(3)?,
            })
        },
    )
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
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        deleted_at: r.get(8)?,
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

pub(crate) fn view(conn: &Connection, id: &str) -> Result<View> {
    let sql = format!("SELECT {VIEW_COLS} FROM views WHERE id = ?1");
    conn.query_row(&sql, [id], view_row)
        .optional()?
        .ok_or_else(|| Error::not_found("view", id))
}

pub(crate) fn status(conn: &Connection, id: &str) -> Result<Status> {
    conn.query_row(
        &format!("SELECT {STATUS_COLS} FROM statuses WHERE id = ?1"),
        [id],
        status_row,
    )
    .optional()?
    .ok_or_else(|| Error::not_found("status", id))
}

/// Any attachment, including soft-deleted ones.
pub(crate) fn attachment(conn: &Connection, id: &str) -> Result<Attachment> {
    conn.query_row(
        &format!("SELECT {ATTACHMENT_COLS} FROM attachments WHERE id = ?1"),
        [id],
        attachment_row,
    )
    .optional()?
    .ok_or_else(|| Error::not_found("attachment", id))
}

/// Any time block, including soft-deleted ones.
pub(crate) fn time_block(conn: &Connection, id: &str) -> Result<TimeBlock> {
    conn.query_row(
        &format!("SELECT {TIME_BLOCK_COLS} FROM time_blocks WHERE id = ?1"),
        [id],
        time_block_row,
    )
    .optional()?
    .ok_or_else(|| Error::not_found("time block", id))
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
            &format!(
                "SELECT {STATUS_COLS} FROM statuses WHERE deleted_at IS NULL ORDER BY rank, id"
            ),
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
            &format!("SELECT {VIEW_COLS} FROM views WHERE deleted_at IS NULL ORDER BY rank, id"),
            &[],
            view_row,
        )?,
        // A deleted task keeps its attachment rows, so undoing the delete restores them.
        attachments: query(
            conn,
            "SELECT a.id, a.task_id, a.hash, a.name, a.mime, a.size, a.created_at,
                    a.updated_at, a.deleted_at
             FROM attachments a JOIN tasks t ON t.id = a.task_id
             WHERE a.deleted_at IS NULL AND t.deleted_at IS NULL
             ORDER BY a.created_at, a.id",
            &[],
            attachment_row,
        )?,
        // Like attachments, a deleted task hides its blocks without deleting them.
        time_blocks: query(
            conn,
            "SELECT b.id, b.task_id, b.start_at, b.end_at, b.outcome, b.created_at,
                    b.updated_at, b.deleted_at
             FROM time_blocks b JOIN tasks t ON t.id = b.task_id
             WHERE b.deleted_at IS NULL AND t.deleted_at IS NULL
             ORDER BY b.start_at, b.id",
            &[],
            time_block_row,
        )?,
        agent_sessions: query(
            conn,
            &format!(
                "SELECT {SESSION_COLS} FROM agent_sessions s JOIN tasks t ON t.id = s.task_id
                 WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL
                 ORDER BY s.started_at, s.id"
            ),
            &[],
            session_row,
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
    /// `create`, `update`, `delete`, `restore`, `link` (tag added), `unlink` (tag removed),
    /// or for attachments `attach`, `detach` and `rename_attachment` (field `name`), or for
    /// time blocks `schedule`, `unschedule`, `reschedule` (fields `start_at`, `end_at`) and
    /// `block_outcome` (field `outcome`), or for agent sessions `agent_start` (field
    /// `folder`), `agent_end` (fields `state`, `summary`) and `agent_note` (field `body`).
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

/// A task's history, newest first, including its attachments. Bookkeeping-only updates
/// (`updated_at`, rank rebalances) are skipped.
pub(crate) fn task_activity(conn: &Connection, task_id: &str, limit: u32) -> Result<Vec<Activity>> {
    type Row = (
        i64,
        String,
        Option<String>,
        String,
        String,
        String,
        String,
        String,
    );
    let rows: Vec<Row> = query(
        conn,
        "SELECT seq, hlc, batch_id, entity, entity_id, kind, patch, inverse FROM ops
         WHERE (entity IN ('task', 'task_tag') AND entity_id = ?1)
            OR (entity = 'attachment'
                AND entity_id IN (SELECT id FROM attachments WHERE task_id = ?1))
            OR (entity = 'time_block'
                AND entity_id IN (SELECT id FROM time_blocks WHERE task_id = ?1))
            OR (entity = 'agent_session'
                AND entity_id IN (SELECT id FROM agent_sessions WHERE task_id = ?1))
            OR (entity = 'agent_note'
                AND entity_id IN (SELECT id FROM agent_notes WHERE task_id = ?1))
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
                r.get(7)?,
            ))
        },
    )?;
    let mut out = Vec::new();
    for (seq, hlc, batch_id, entity, entity_id, kind, patch, inverse) in rows {
        let patch: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&patch)?;
        let inverse: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&inverse)?;
        let (kind, fields) = if entity == "attachment" {
            match attachment_entry(conn, &entity_id, &kind, &patch, &inverse)? {
                Some(entry) => entry,
                None => continue,
            }
        } else if entity == "time_block" {
            match time_block_entry(conn, &entity_id, &kind, &patch, &inverse)? {
                Some(entry) => entry,
                None => continue,
            }
        } else if entity == "agent_session" || entity == "agent_note" {
            match agent_entry(&entity, &kind, &patch) {
                Some(entry) => entry,
                None => continue,
            }
        } else {
            // A rank-only update without `updated_at` is a column rebalance, not a user edit.
            if kind == "update" && patch.len() == 1 && patch.contains_key("rank") {
                continue;
            }
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
            (kind, fields)
        };
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

/// An agent op as an activity entry: `agent_start` (field `folder`), `agent_end` (when a
/// session leaves `running`; fields `state` and `summary`) or `agent_note` (field `body`).
fn agent_entry(
    entity: &str,
    kind: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
) -> Option<(String, Vec<FieldChange>)> {
    let field = |name: &str| {
        patch.get(name).map(|after| FieldChange {
            field: name.to_owned(),
            before: "null".to_owned(),
            after: after.to_string(),
        })
    };
    match (entity, kind) {
        ("agent_session", "create") => Some((
            "agent_start".to_owned(),
            field("folder").into_iter().collect(),
        )),
        ("agent_session", "update") => {
            let state = patch.get("state")?.as_str()?;
            // Only an end is news; starting again or moving to a terminal is not.
            if SessionState::parse(state).is_none_or(SessionState::is_active) {
                return None;
            }
            Some((
                "agent_end".to_owned(),
                [field("state"), field("summary")]
                    .into_iter()
                    .flatten()
                    .collect(),
            ))
        }
        ("agent_note", "create") => {
            Some(("agent_note".to_owned(), field("body").into_iter().collect()))
        }
        _ => None,
    }
}

/// An attachment op as an activity entry: `attach` (created or restored), `detach`, or
/// `rename_attachment`, with a `name` field.
fn attachment_entry(
    conn: &Connection,
    id: &str,
    kind: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
    inverse: &serde_json::Map<String, serde_json::Value>,
) -> Result<Option<(String, Vec<FieldChange>)>> {
    let name = serde_json::Value::String(attachment(conn, id)?.name);
    let null = serde_json::Value::Null;
    let (kind, before, after) = match kind {
        "create" | "restore" => ("attach", &null, patch.get("name").unwrap_or(&name)),
        "delete" => ("detach", &null, &name),
        "update" => match patch.get("name") {
            Some(after) => (
                "rename_attachment",
                inverse.get("name").unwrap_or(&null),
                after,
            ),
            None => return Ok(None),
        },
        _ => return Ok(None),
    };
    Ok(Some((
        kind.to_owned(),
        vec![FieldChange {
            field: "name".to_owned(),
            before: before.to_string(),
            after: after.to_string(),
        }],
    )))
}

/// A time block op as an activity entry: `schedule` (created or restored), `unschedule`,
/// `reschedule` (moved or resized) or `block_outcome`. Times are the block's after the op.
fn time_block_entry(
    conn: &Connection,
    id: &str,
    kind: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
    inverse: &serde_json::Map<String, serde_json::Value>,
) -> Result<Option<(String, Vec<FieldChange>)>> {
    let block = time_block(conn, id)?;
    let null = serde_json::Value::Null;
    let times = |before: bool| -> Vec<FieldChange> {
        ["start_at", "end_at"]
            .into_iter()
            .map(|field| {
                let current = serde_json::json!(if field == "start_at" {
                    block.start_at
                } else {
                    block.end_at
                });
                let after = patch.get(field).unwrap_or(&current);
                FieldChange {
                    field: field.to_owned(),
                    before: if before {
                        inverse.get(field).unwrap_or(after).to_string()
                    } else {
                        null.to_string()
                    },
                    after: after.to_string(),
                }
            })
            .collect()
    };
    let entry = match kind {
        "create" | "restore" => ("schedule", times(false)),
        "delete" => ("unschedule", times(false)),
        "update" if patch.contains_key("start_at") || patch.contains_key("end_at") => {
            ("reschedule", times(true))
        }
        "update" => match patch.get("outcome") {
            Some(after) => (
                "block_outcome",
                vec![FieldChange {
                    field: "outcome".to_owned(),
                    before: inverse.get("outcome").unwrap_or(&null).to_string(),
                    after: after.to_string(),
                }],
            ),
            None => return Ok(None),
        },
        _ => return Ok(None),
    };
    Ok(Some((entry.0.to_owned(), entry.1)))
}
