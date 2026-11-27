//! Meetings as text for agents (Scribe, ADR 025): a compact listing and one meeting in
//! full, with its transcript when asked. Meetings are the user's: an agent writes only a
//! summary, through `set_meeting_summary` (ADR 040).

use taskmaster_core::{Meeting, Snapshot, TranscriptSegment};

use crate::calendar::{Offset, availability};

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
        "- {}: {}{} ({}{with}, `{}`)",
        when(offset, m),
        m.title,
        availability(m.show_as),
        m.state.as_str(),
        m.id
    )
}

/// A meeting in full, as markdown: times, links, participants, notes, summary and
/// attachment names.
pub fn render(snapshot: &Snapshot, offset: Offset, m: &Meeting) -> String {
    let mut out = format!(
        "# Meeting: {}\n\n- Id: `{}`\n- When: {} ({})\n- State: {}\n- Shows as: {}, {}\n",
        m.title,
        m.id,
        when(offset, m),
        offset.label(),
        m.state.as_str(),
        m.show_as.as_str(),
        if m.private { "private" } else { "visible" }
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

/// A speaker key as the app shows it: its given name, "Me", or "Speaker N".
fn speaker(m: &Meeting, key: &str) -> String {
    if let Some(name) = m
        .speakers
        .get(key)
        .map(|n| n.trim())
        .filter(|n| !n.is_empty())
    {
        return name.to_owned();
    }
    match key {
        "me" => "Me".to_owned(),
        _ => key
            .strip_prefix('s')
            .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            .map_or_else(|| key.to_owned(), |n| format!("Speaker {n}")),
    }
}

/// `m:ss` (or `h:mm:ss`) from the start of the recording.
fn clock(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    let (h, m, s) = (s / 3600, s / 60 % 60, s % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// The transcript section of a meeting: one line per segment, in time order.
pub fn transcript(m: &Meeting, lines: &[TranscriptSegment]) -> String {
    let mut out = String::from("\n## Transcript\n\n");
    if lines.is_empty() {
        out.push_str(if m.transcribed_at.is_some() {
            "(nothing was said)\n"
        } else {
            "(not transcribed)\n"
        });
        return out;
    }
    if m.validated_at.is_none() {
        out.push_str("Not checked by the user yet: names and words may be wrong.\n\n");
    }
    for line in lines {
        out.push_str(&format!(
            "[{}] {}: {}\n",
            clock(line.start_ms),
            speaker(m, &line.speaker),
            line.text.trim()
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speakers_and_times_read_as_in_the_app() {
        let mut m = Meeting {
            id: "m".into(),
            title: "t".into(),
            started_at: 0,
            ended_at: None,
            project_id: None,
            epic_id: None,
            task_id: None,
            state: Default::default(),
            participants: vec![],
            notes: String::new(),
            summary: None,
            transcribed_at: Some(1),
            validated_at: Some(1),
            speakers: Default::default(),
            show_as: Default::default(),
            private: true,
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
        };
        m.speakers.insert("s2".into(), " Ada ".into());
        assert_eq!(speaker(&m, "me"), "Me");
        assert_eq!(speaker(&m, "s1"), "Speaker 1");
        assert_eq!(speaker(&m, "s2"), "Ada");
        assert_eq!(clock(65_400), "1:05");
        assert_eq!(clock(3_725_000), "1:02:05");
        let seg = |speaker: &str, start_ms: i64, text: &str| TranscriptSegment {
            id: format!("{speaker}{start_ms}"),
            meeting_id: "m".into(),
            start_ms,
            end_ms: start_ms + 1000,
            speaker: speaker.into(),
            text: text.into(),
            edited: false,
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
        };
        let out = transcript(&m, &[seg("me", 0, "Hello "), seg("s2", 61_000, "Hi")]);
        assert_eq!(out, "\n## Transcript\n\n[0:00] Me: Hello\n[1:01] Ada: Hi\n");
        assert_eq!(
            transcript(&m, &[]),
            "\n## Transcript\n\n(nothing was said)\n"
        );
    }
}
