//! Terminal sessions (M21, ADR 028): Claude Code sessions run outside the app, read from
//! their transcripts by the shell and recorded here so their cost and time count with the
//! app's own agent sessions.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::error::{Error, Result};
use rusqlite::OptionalExtension;

use crate::model::{AgentSession, Id, ProjectFolder, SessionState, Timestamp};
use crate::ops::{Batch, Change, Entity, OpKind};
use crate::query;

/// A terminal session as its transcript reads now. Recording it again updates the row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TerminalSessionRecord {
    /// Used when the session is new; a fresh one when `None`.
    #[serde(default)]
    pub id: Option<Id>,
    pub claude_session_id: String,
    pub folder: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    pub started_at: Timestamp,
    pub ended_at: Timestamp,
    #[serde(default)]
    pub cost_usd_micros: Option<i64>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub turns: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TerminalSessionChange {
    /// `None` for no project. Folders do not fill it in again once set by hand.
    ProjectId(Option<Id>),
    TaskId(Option<Id>),
}

/// The project whose folder on this device holds `folder` (the deepest, when folders
/// nest), as the same runtime sees it. Windows paths compare without case and with either
/// slash.
pub fn folder_project(folders: &[ProjectFolder], folder: &str) -> Option<Id> {
    let folder = normalized(folder);
    folders
        .iter()
        .filter_map(|f| {
            let root = normalized(&f.path);
            let inside = !root.is_empty()
                && (folder == root
                    || folder
                        .strip_prefix(&root)
                        .is_some_and(|rest| rest.starts_with('/') || root.ends_with('/')));
            inside.then_some((root.len(), &f.project_id))
        })
        .max_by_key(|(len, _)| *len)
        .map(|(_, id)| id.clone())
}

fn normalized(path: &str) -> String {
    let path = path.trim();
    let windows = path.contains('\\') || path.as_bytes().get(1) == Some(&b':');
    let path = if windows {
        path.replace('\\', "/").to_lowercase()
    } else {
        path.to_owned()
    };
    match path.trim_end_matches('/') {
        "" if path.starts_with('/') => "/".to_owned(),
        trimmed => trimmed.to_owned(),
    }
}

pub(crate) fn record(b: &mut Batch<'_, '_>, sessions: Vec<TerminalSessionRecord>) -> Result<()> {
    let folders = query::project_folders(b.tx)?;
    for r in sessions {
        record_one(b, &folders, r)?;
    }
    Ok(())
}

fn record_one(
    b: &mut Batch<'_, '_>,
    folders: &[ProjectFolder],
    r: TerminalSessionRecord,
) -> Result<()> {
    crate::clock::check_id(&r.claude_session_id)?;
    let folder = r.folder.trim();
    if folder.is_empty() {
        return Err(Error::invalid("folder cannot be empty"));
    }
    for (name, value) in [
        ("cost", r.cost_usd_micros),
        ("duration", r.duration_ms),
        ("turns", r.turns),
    ] {
        if value.is_some_and(|v| v < 0) {
            return Err(Error::invalid(format!("{name} cannot be negative")));
        }
    }
    // The app's own runs have their agent session already. One opened in the desktop
    // app, or that never reported a cost, takes its totals from the transcript (M22).
    if let Some(session) = own_run(b, &r.claude_session_id)? {
        return fill_own_run(b, &session, &r);
    }
    let title = clean(r.title);
    let model = clean(r.model);
    let ended_at = r.ended_at.max(r.started_at);
    let project = folder_project(folders, folder);
    let fields = json!({
        "folder": folder,
        "title": title,
        "model": model,
        "started_at": r.started_at,
        "ended_at": ended_at,
        "cost_usd_micros": r.cost_usd_micros,
        "duration_ms": r.duration_ms,
        "turns": r.turns,
    });
    let Value::Object(fields) = fields else {
        unreachable!("a JSON object")
    };

    match query::terminal_session_by_claude_id(b.tx, &r.claude_session_id)? {
        // Removed by the user: not brought back.
        Some(existing) if existing.deleted_at.is_some() => Ok(()),
        Some(existing) => {
            let current = json!(existing);
            let mut patch: Map<String, Value> = fields
                .into_iter()
                .filter(|(k, v)| current.get(k) != Some(v))
                .collect();
            // A folder that gets a project later brings its earlier sessions along.
            if existing.project_id.is_none()
                && let Some(project) = &project
                && !project_set_by_hand(b, &existing.id)?
            {
                patch.insert("project_id".into(), json!(project));
            }
            if patch.is_empty() {
                return Ok(());
            }
            patch.insert("updated_at".into(), json!(b.now));
            b.apply(Change::new(
                Entity::TerminalSession,
                &existing.id,
                OpKind::Update,
                Value::Object(patch),
            ))
        }
        None => {
            let id = match r.id {
                Some(id) => {
                    crate::clock::check_id(&id)?;
                    id
                }
                None => crate::clock::new_id(),
            };
            let mut row = fields;
            row.insert("claude_session_id".into(), json!(r.claude_session_id));
            row.insert("device_id".into(), json!(b.device_id()));
            row.insert("project_id".into(), json!(project));
            row.insert("task_id".into(), Value::Null);
            row.insert("created_at".into(), json!(b.now));
            row.insert("updated_at".into(), json!(b.now));
            row.insert("deleted_at".into(), Value::Null);
            b.apply(Change::new(
                Entity::TerminalSession,
                &id,
                OpKind::Create,
                Value::Object(row),
            ))
        }
    }
}

/// The live agent session that ran this Claude Code session, if the app started it.
fn own_run(b: &Batch<'_, '_>, claude_session_id: &str) -> Result<Option<AgentSession>> {
    let id: Option<Id> =
        b.tx.query_row(
            "SELECT id FROM agent_sessions WHERE claude_session_id = ?1 AND deleted_at IS NULL
             ORDER BY created_at LIMIT 1",
            [claude_session_id],
            |row| row.get(0),
        )
        .optional()?;
    id.map(|id| query::agent_session(b.tx, &id)).transpose()
}

/// Gives a session started from a task the transcript's cost, time and requests when the
/// app has none of its own for it: a session in the desktop app, or one that ended without
/// reporting a cost (never a run in progress). Only on the device that started it.
fn fill_own_run(
    b: &mut Batch<'_, '_>,
    session: &AgentSession,
    r: &TerminalSessionRecord,
) -> Result<()> {
    // A headless run adds its own cost when it ends: never before.
    let from_transcript = session.state == SessionState::Desktop
        || (!session.state.is_active() && session.cost_usd_micros.is_none());
    if session.device_id != b.device_id() || !from_transcript || r.cost_usd_micros.is_none() {
        return Ok(());
    }
    let mut patch = Map::new();
    for (key, now, then) in [
        (
            "cost_usd_micros",
            session.cost_usd_micros,
            r.cost_usd_micros,
        ),
        ("duration_ms", session.duration_ms, r.duration_ms),
        ("turns", session.turns, r.turns),
    ] {
        if then.is_some() && now != then {
            patch.insert(key.into(), json!(then));
        }
    }
    if patch.is_empty() {
        return Ok(());
    }
    patch.insert("updated_at".into(), json!(b.now));
    b.apply(Change::new(
        Entity::AgentSession,
        &session.id,
        OpKind::Update,
        Value::Object(patch),
    ))
}

/// Whether the session's project was ever changed with [`TerminalSessionChange`] (an op
/// writing `project_id` after the one creating it): then "no project" is the user's.
fn project_set_by_hand(b: &Batch<'_, '_>, id: &str) -> Result<bool> {
    Ok(b.tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM ops WHERE entity = 'terminal_session' AND entity_id = ?1
           AND kind = 'update' AND json_type(patch, '$.project_id') IS NOT NULL)",
        [id],
        |row| row.get(0),
    )?)
}

pub(crate) fn update(
    b: &mut Batch<'_, '_>,
    id: &str,
    changes: Vec<TerminalSessionChange>,
) -> Result<()> {
    if changes.is_empty() {
        return Err(Error::invalid(
            "update_terminal_session needs at least one change",
        ));
    }
    live(b, id)?;
    let mut patch = Map::new();
    for change in changes {
        match change {
            TerminalSessionChange::ProjectId(p) => {
                if let Some(p) = &p {
                    let project = query::project(b.tx, p)?;
                    if project.deleted_at.is_some() {
                        return Err(Error::not_found("project", p));
                    }
                }
                patch.insert("project_id".into(), json!(p));
            }
            TerminalSessionChange::TaskId(t) => {
                if let Some(t) = &t {
                    let task = query::task(b.tx, t)?;
                    if task.deleted_at.is_some() {
                        return Err(Error::not_found("task", t));
                    }
                }
                patch.insert("task_id".into(), json!(t));
            }
        }
    }
    patch.insert("updated_at".into(), json!(b.now));
    b.apply(Change::new(
        Entity::TerminalSession,
        id,
        OpKind::Update,
        Value::Object(patch),
    ))
}

pub(crate) fn delete(b: &mut Batch<'_, '_>, id: &str) -> Result<()> {
    live(b, id)?;
    b.apply(Change::new(
        Entity::TerminalSession,
        id,
        OpKind::Delete,
        json!({ "deleted_at": b.now, "updated_at": b.now }),
    ))
}

fn live(b: &Batch<'_, '_>, id: &str) -> Result<()> {
    if query::terminal_session(b.tx, id)?.deleted_at.is_some() {
        return Err(Error::not_found("terminal session", id));
    }
    Ok(())
}

fn clean(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AgentRuntime;

    fn folder(project: &str, path: &str) -> ProjectFolder {
        ProjectFolder {
            project_id: project.into(),
            path: path.into(),
            runtime: AgentRuntime::Native,
            updated_at: 0,
        }
    }

    #[test]
    fn a_folder_belongs_to_the_deepest_project_folder_holding_it() {
        let folders = [
            folder("code", "/home/alex/Code"),
            folder("tm", "/home/alex/Code/task-master/"),
            folder("win", r"C:\Users\Alex\Work"),
        ];
        let at = |path| folder_project(&folders, path);
        assert_eq!(at("/home/alex/Code/task-master").as_deref(), Some("tm"));
        assert_eq!(
            at("/home/alex/Code/task-master/.claude/worktrees/x").as_deref(),
            Some("tm")
        );
        assert_eq!(at("/home/alex/Code/gringotts").as_deref(), Some("code"));
        // A sibling whose name only starts the same is not inside.
        assert_eq!(at("/home/alex/Code-old").as_deref(), None);
        assert_eq!(at("/home/alex").as_deref(), None);
        assert_eq!(at("c:/users/alex/work/site").as_deref(), Some("win"));
        assert_eq!(at(r"C:\Users\Alex\Workbench").as_deref(), None);
    }
}
