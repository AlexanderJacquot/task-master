//! Meetings as text for agents (Scribe, ADR 025): a compact listing and one meeting in
//! full. Read-only: meetings are the user's.

use taskmaster_core::{Meeting, Snapshot};

use crate::calendar::Offset;

/// When a meeting takes place, in `offset`: `2026-11-05 09:00–10:00`.
fn when(offset: Offset, m: &Meeting) -> String {
    let start = format!(
        "{} {}",
        offset.date(m.started_at),
        offset.clock(m.started_at)
    );
    match m.ended_at {
        Some(end) if offset.date(end - 1) == offset.date(m.started_at) => {
            format!("{start}–{}", offset.clock(end))
        }
        Some(end) => format!("{start} – {} {}", offset.date(end), offset.clock(end)),
        None => format!("{start}, no end yet"),
    }
}

/// One line of a listing.
pub fn line(offset: Offset, m: &Meeting) -> String {
    let with = if m.participants.is_empty() {
        String::new()
    } else {
        format!(", with {}", m.participants.join(", "))
    };
    format!(
        "- {}: {} ({}{with}, `{}`)",
        when(offset, m),
        m.title,
        m.state.as_str(),
        m.id
    )
}

/// A meeting in full, as markdown: times, links, participants, notes, summary and
/// attachment names.
pub fn render(snapshot: &Snapshot, offset: Offset, m: &Meeting) -> String {
    let mut out = format!(
        "# Meeting: {}\n\n- Id: `{}`\n- When: {} ({})\n- State: {}\n",
        m.title,
        m.id,
        when(offset, m),
        offset.label(),
        m.state.as_str()
    );
    if let Some(id) = &m.project_id {
        let name = snapshot
            .projects
            .iter()
            .find(|p| &p.id == id)
            .map_or("(deleted)", |p| p.name.as_str());
        out.push_str(&format!("- Project: {name} (`{id}`)\n"));
    }
    if let Some(id) = &m.epic_id {
        let name = snapshot
            .epics
            .iter()
            .find(|e| &e.id == id)
            .map_or("(deleted)", |e| e.name.as_str());
        out.push_str(&format!("- Epic: {name} (`{id}`)\n"));
    }
    if let Some(id) = &m.task_id {
        let title = snapshot
            .tasks
            .iter()
            .find(|t| &t.id == id)
            .map_or("(deleted)", |t| t.title.as_str());
        out.push_str(&format!("- Task: {title} (`{id}`)\n"));
    }
    if !m.participants.is_empty() {
        out.push_str(&format!("- Participants: {}\n", m.participants.join(", ")));
    }
    let files: Vec<&str> = snapshot
        .attachments
        .iter()
        .filter(|a| a.meeting_id.as_deref() == Some(m.id.as_str()))
        .map(|a| a.name.as_str())
        .collect();
    if !files.is_empty() {
        out.push_str(&format!("- Attachments: {}\n", files.join(", ")));
    }
    let notes = m.notes.trim();
    out.push_str("\n## Notes\n\n");
    out.push_str(if notes.is_empty() { "(none)" } else { notes });
    out.push('\n');
    if let Some(summary) = m
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        out.push_str("\n## Summary\n\n");
        out.push_str(summary);
        out.push('\n');
    }
    out
}
