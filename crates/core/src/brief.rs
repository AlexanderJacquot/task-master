//! The context brief an agent gets when it starts on a task (docs/adr/017): everything
//! about the task a person would look up first, as markdown. Ids are included so the agent
//! can address tasks through the MCP tools.

use std::fmt::Write as _;

use rusqlite::Connection;

use crate::error::{Error, Result};
use crate::model::{Id, SessionState, StatusCategory, Task, TaskOwner};
use crate::query;

/// `writeln!` into a `String`, which cannot fail, as a core `Result` so `?` reads alike.
macro_rules! w {
    ($($arg:tt)*) => {{
        let _ = writeln!($($arg)*);
        Ok::<(), Error>(())
    }};
}

/// Longest earlier-session summary quoted, in characters.
const SUMMARY_CHARS: usize = 600;
/// Agent notes quoted, the newest.
const NOTES: u32 = 20;

pub(crate) fn brief(conn: &Connection, task_id: &str) -> Result<String> {
    let task = query::task(conn, task_id)?;
    if task.deleted_at.is_some() {
        return Err(Error::not_found("task", task_id));
    }
    let mut out = String::new();
    let status = query::status(conn, &task.status_id)?;

    w!(out, "# Task: {}", task.title)?;
    w!(out)?;
    w!(out, "- Id: `{}`", task.id)?;
    w!(
        out,
        "- Status: {} ({})",
        status.name,
        status.category.as_str()
    )?;
    w!(out, "- Priority: {}", priority(&task))?;
    if task.owner == TaskOwner::Agent {
        w!(out, "- Owner: agent (an agent's own task)")?;
    }
    if let Some(due) = &task.due_date {
        w!(out, "- Due: {due}")?;
    }
    if let Some(day) = &task.today_on {
        w!(out, "- Planned for: {day}")?;
    }
    if let Some(minutes) = task.estimate_min {
        w!(out, "- Estimate: {minutes} min")?;
    }
    if !task.tag_ids.is_empty() {
        let mut names = Vec::new();
        for id in &task.tag_ids {
            names.push(format!("#{}", query::tag(conn, id)?.name));
        }
        w!(out, "- Tags: {}", names.join(", "))?;
    }
    match &task.project_id {
        Some(id) => {
            let project = query::project(conn, id)?;
            let area = match &project.parent_id {
                Some(parent) => format!("{} / ", query::project(conn, parent)?.name),
                None => String::new(),
            };
            w!(out, "- Project: {area}{} (`{}`)", project.name, project.id)?;
        }
        None => w!(out, "- Project: none (Inbox)")?,
    }
    let epic = task
        .epic_id
        .as_deref()
        .map(|id| query::epic(conn, id))
        .transpose()?;
    if let Some(epic) = &epic {
        let target = epic
            .target_date
            .as_deref()
            .map(|d| format!(", target {d}"))
            .unwrap_or_default();
        w!(
            out,
            "- Epic: {} ({}{target}, `{}`)",
            epic.name,
            epic.state.as_str(),
            epic.id
        )?;
    }

    section(&mut out, "Description")?;
    let description = task.description.trim();
    w!(
        out,
        "{}",
        if description.is_empty() {
            "_No description._"
        } else {
            description
        }
    )?;

    if let Some(description) = epic
        .as_ref()
        .and_then(|e| e.description.as_deref())
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        section(&mut out, "Epic description")?;
        w!(out, "{description}")?;
    }

    if let Some(parent) = &task.parent_id {
        section(&mut out, "Parent task")?;
        line(conn, &mut out, &query::task(conn, parent)?)?;
    }

    let children = live_ids(
        conn,
        "SELECT id FROM tasks WHERE parent_id = ?1 AND deleted_at IS NULL ORDER BY rank, id",
        &task.id,
    )?;
    task_list(conn, &mut out, "Subtasks", &children)?;

    let prerequisites: Vec<Id> = task
        .dependency_ids
        .iter()
        .filter(|id| query::task(conn, id).is_ok_and(|t| t.deleted_at.is_none()))
        .cloned()
        .collect();
    task_list(
        conn,
        &mut out,
        "Prerequisites (to finish first)",
        &prerequisites,
    )?;

    let dependents = live_ids(
        conn,
        "SELECT t.id FROM tasks t, json_each(t.dependency_ids) j
         WHERE j.value = ?1 AND t.deleted_at IS NULL ORDER BY t.rank, t.id",
        &task.id,
    )?;
    task_list(
        conn,
        &mut out,
        "Dependents (waiting on this task)",
        &dependents,
    )?;

    let attachments: Vec<(String, String)> = {
        let mut stmt = conn.prepare_cached(
            "SELECT name, mime FROM attachments WHERE task_id = ?1 AND deleted_at IS NULL
             ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map([&task.id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    if !attachments.is_empty() {
        section(&mut out, "Attachments")?;
        for (name, mime) in attachments {
            w!(out, "- {name} ({mime})")?;
        }
    }

    let sessions = query::task_sessions(conn, &task.id)?;
    let finished: Vec<_> = sessions
        .iter()
        .filter(|s| s.state != SessionState::Running)
        .collect();
    if !finished.is_empty() {
        section(&mut out, "Earlier agent sessions")?;
        for session in finished {
            let summary = session
                .summary
                .as_deref()
                .map(|s| clip(s.trim(), SUMMARY_CHARS))
                .unwrap_or_else(|| "no summary".to_owned());
            w!(
                out,
                "- {} in `{}`: {}",
                session.state.as_str(),
                session.folder,
                summary.replace('\n', " ")
            )?;
        }
    }

    let notes = query::agent_notes(conn, &task.id, None, NOTES)?;
    if !notes.is_empty() {
        section(&mut out, "Agent notes")?;
        for note in notes {
            w!(out, "- {}", note.body.trim().replace('\n', " "))?;
        }
    }
    Ok(out)
}

fn section(out: &mut String, title: &str) -> Result<()> {
    w!(out)?;
    w!(out, "## {title}")?;
    w!(out)?;
    Ok(())
}

fn task_list(conn: &Connection, out: &mut String, title: &str, ids: &[Id]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    section(out, title)?;
    for id in ids {
        line(conn, out, &query::task(conn, id)?)?;
    }
    Ok(())
}

/// `- [x] Title (Status, `id`)`; checked when done or cancelled.
fn line(conn: &Connection, out: &mut String, task: &Task) -> Result<()> {
    let status = query::status(conn, &task.status_id)?;
    let closed = matches!(
        status.category,
        StatusCategory::Done | StatusCategory::Cancelled
    );
    let agent = if task.owner == TaskOwner::Agent {
        ", agent"
    } else {
        ""
    };
    w!(
        out,
        "- [{}] {} ({}{agent}, `{}`)",
        if closed { "x" } else { " " },
        task.title,
        status.name,
        task.id
    )?;
    Ok(())
}

fn priority(task: &Task) -> &'static str {
    match task.priority {
        crate::model::Priority::Urgent => "urgent",
        crate::model::Priority::High => "high",
        crate::model::Priority::Normal => "normal",
        crate::model::Priority::Low => "low",
    }
}

fn clip(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_owned(),
    }
}

fn live_ids(conn: &Connection, sql: &str, param: &str) -> Result<Vec<Id>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map([param], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
