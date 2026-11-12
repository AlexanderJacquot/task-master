//! The calendar as agents read it: time blocks, the user's shown Google events, and tasks
//! due or planned on each day of a range, in the user's UTC offset.

use std::collections::HashMap;

use taskmaster_core::calendar::{CalendarEvent, EventRange, format_utc, parse_rfc3339};
use taskmaster_core::{Snapshot, Status, Task, Timestamp, utc_date};

use crate::{by_id, closed, task_line};

const DAY_MS: i64 = 86_400_000;
/// Longest range get_calendar shows, in days.
pub const MAX_DAYS: i64 = 62;
const DEFAULT_DAYS: i64 = 7;

/// A UTC offset: `Z`, `+HH:MM` or `-HH:MM` (also `+HHMM`, `+HH`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Offset(pub i64);

impl Offset {
    pub fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim();
        if text.is_empty() || text.eq_ignore_ascii_case("z") || text == "UTC" {
            return Ok(Self(0));
        }
        let bad = || format!("utc_offset must look like +01:00 or -05:00, got '{text}'");
        let (sign, rest) = match text.as_bytes()[0] {
            b'+' => (1, &text[1..]),
            b'-' => (-1, &text[1..]),
            _ => return Err(bad()),
        };
        let digits: String = rest.chars().filter(|c| *c != ':').collect();
        if !digits.bytes().all(|b| b.is_ascii_digit()) || !matches!(digits.len(), 2 | 4) {
            return Err(bad());
        }
        let hours: i64 = digits[..2].parse().map_err(|_| bad())?;
        let minutes: i64 = if digits.len() == 4 {
            digits[2..].parse().map_err(|_| bad())?
        } else {
            0
        };
        if hours > 14 || minutes > 59 {
            return Err(bad());
        }
        Ok(Self(sign * (hours * 60 + minutes) * 60_000))
    }

    fn label(self) -> String {
        if self.0 == 0 {
            return "UTC".into();
        }
        let minutes = self.0.abs() / 60_000;
        let sign = if self.0 < 0 { '-' } else { '+' };
        format!("{sign}{:02}:{:02}", minutes / 60, minutes % 60)
    }

    /// The local date of an instant.
    fn date(self, ms: Timestamp) -> String {
        utc_date(ms + self.0)
    }

    /// Local midnight of a date, as an instant.
    fn midnight(self, date: &str) -> Option<Timestamp> {
        parse_rfc3339(&format!("{date}T00:00:00Z")).map(|ms| ms - self.0)
    }

    /// `HH:MM` local.
    fn clock(self, ms: Timestamp) -> String {
        format_utc(ms + self.0)[11..16].to_owned()
    }
}

/// An instant from `YYYY-MM-DDTHH:MM[:SS](Z|±HH:MM)`, or a date (local midnight).
pub fn parse_time(field: &str, text: &str, offset: Offset) -> Result<Timestamp, String> {
    let text = text.trim();
    if text.len() == 10 {
        return offset
            .midnight(text)
            .ok_or_else(|| format!("{field}: '{text}' is not a YYYY-MM-DD date"));
    }
    // Allow minutes precision (`09:00`), and a time without offset (local).
    let mut full = text.to_owned();
    if let Some((date, time)) = text.split_once(['T', 't']) {
        let digits = time.find(['Z', 'z', '+', '-']).unwrap_or(time.len());
        let (clock, zone) = time.split_at(digits);
        let clock = if clock.len() == 5 {
            format!("{clock}:00")
        } else {
            clock.to_owned()
        };
        let zone = if zone.is_empty() {
            if offset.0 == 0 {
                "Z".to_owned()
            } else {
                offset.label()
            }
        } else {
            zone.to_owned()
        };
        full = format!("{date}T{clock}{zone}");
    }
    parse_rfc3339(&full).ok_or_else(|| {
        format!("{field}: '{text}' is not a time like 2026-11-12T09:00:00+01:00 or a date")
    })
}

/// The range to show: `from` (default: today) to `to` (default: a week later).
pub fn range(
    from: Option<&str>,
    to: Option<&str>,
    offset: Offset,
    now: Timestamp,
) -> Result<(Timestamp, Timestamp), String> {
    let from = match from {
        Some(text) => parse_time("from", text, offset)?,
        None => offset
            .midnight(&offset.date(now))
            .ok_or("cannot compute today")?,
    };
    let to = match to {
        // A bare date as `to` includes that day.
        Some(text) if text.trim().len() == 10 => parse_time("to", text, offset)? + DAY_MS,
        Some(text) => parse_time("to", text, offset)?,
        None => from + DEFAULT_DAYS * DAY_MS,
    };
    if to <= from {
        return Err("`to` must be after `from`".into());
    }
    if to - from > MAX_DAYS * DAY_MS {
        return Err(format!("show at most {MAX_DAYS} days at a time"));
    }
    Ok((from, to))
}

/// The event range for a time range, padded a day both ways (all-day events use dates).
pub fn event_range(from: Timestamp, to: Timestamp) -> EventRange {
    EventRange {
        from,
        to,
        from_date: utc_date(from - DAY_MS),
        to_date: utc_date(to + DAY_MS),
    }
}

/// The calendar from `from` to `to` (exclusive), day by day.
pub fn render(
    snapshot: &Snapshot,
    events: &[CalendarEvent],
    from: Timestamp,
    to: Timestamp,
    offset: Offset,
) -> String {
    let statuses = by_id(&snapshot.statuses);
    let tasks: HashMap<&str, &Task> = snapshot.tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    let first = offset.date(from);
    let last = offset.date(to - 1);
    let mut out = format!(
        "Calendar {first} to {last} (times in {}). Block outcomes: planned, worked, done, \
         missed, cancelled.\n",
        offset.label()
    );
    let mut day_start = offset.midnight(&first).unwrap_or(from);
    let mut empty = true;
    while day_start < to {
        let day_end = day_start + DAY_MS;
        let date = offset.date(day_start);
        let mut lines: Vec<(Timestamp, String)> = Vec::new();

        for block in &snapshot.time_blocks {
            let overlaps = block.start_at < day_end.min(to)
                && block.end_at > day_start.max(from)
                && block.deleted_at.is_none();
            // A block over midnight shows on the day it starts (or the first day shown).
            let starts_here = offset.date(block.start_at.max(from)) == date;
            if !overlaps || !starts_here {
                continue;
            }
            let Some(task) = tasks.get(block.task_id.as_str()) else {
                continue;
            };
            lines.push((
                block.start_at,
                format!(
                    "- {} {}: {} (task `{}`, block `{}`)",
                    span(offset, block.start_at, block.end_at),
                    block.outcome.as_str(),
                    task.title,
                    task.id,
                    block.id
                ),
            ));
        }

        for event in events {
            if let (Some(start), Some(end)) = (event.start_at, event.end_at) {
                let starts_here = offset.date(start.max(from)) == date;
                if start < day_end.min(to) && end > day_start.max(from) && starts_here {
                    lines.push((
                        start,
                        format!(
                            "- {} event: {}",
                            span(offset, start, end),
                            event_title(event)
                        ),
                    ));
                }
            } else if let (Some(start), Some(end)) = (&event.start_date, &event.end_date)
                && start.as_str() <= date.as_str()
                && date.as_str() < end.as_str()
            {
                lines.push((
                    day_start,
                    format!("- all day event: {}", event_title(event)),
                ));
            }
        }
        lines.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

        let due = day_tasks(snapshot, &statuses, |t| {
            t.due_date.as_deref() == Some(&*date)
        });
        let planned = day_tasks(snapshot, &statuses, |t| {
            t.today_on.as_deref() == Some(&*date)
        });

        if !lines.is_empty() || !due.is_empty() || !planned.is_empty() {
            empty = false;
            out.push_str(&format!("\n## {date}\n"));
            for (_, line) in lines {
                out.push_str(&line);
                out.push('\n');
            }
            if !planned.is_empty() {
                out.push_str("Planned for the day (no time set):\n");
                out.push_str(&planned.join("\n"));
                out.push('\n');
            }
            if !due.is_empty() {
                out.push_str("Due:\n");
                out.push_str(&due.join("\n"));
                out.push('\n');
            }
        }
        day_start = day_end;
    }
    if empty {
        out.push_str("\nNothing on the calendar in this range.\n");
    }
    out
}

fn span(offset: Offset, start: Timestamp, end: Timestamp) -> String {
    let end_text = if offset.date(end - 1) == offset.date(start) {
        offset.clock(end)
    } else {
        format!("{} {}", offset.date(end), offset.clock(end))
    };
    format!("{}–{end_text}", offset.clock(start))
}

fn event_title(event: &CalendarEvent) -> String {
    let title = if event.title.trim().is_empty() {
        "(busy)"
    } else {
        event.title.as_str()
    };
    match &event.location {
        Some(place) if !place.trim().is_empty() => format!("{title} ({place})"),
        _ => title.to_owned(),
    }
}

/// Open tasks matching `keep`, as task lines.
fn day_tasks(
    snapshot: &Snapshot,
    statuses: &HashMap<&str, &Status>,
    keep: impl Fn(&Task) -> bool,
) -> Vec<String> {
    snapshot
        .tasks
        .iter()
        .filter(|&t| t.deleted_at.is_none() && !closed(statuses, t) && keep(t))
        .map(|t| task_line(statuses, t))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets() {
        assert_eq!(Offset::parse("Z").unwrap(), Offset(0));
        assert_eq!(Offset::parse("+01:00").unwrap(), Offset(3_600_000));
        assert_eq!(Offset::parse("-0530").unwrap(), Offset(-19_800_000));
        assert_eq!(Offset::parse("+02").unwrap(), Offset(7_200_000));
        assert!(Offset::parse("01:00").is_err());
        assert!(Offset::parse("+25:00").is_err());
        assert_eq!(Offset(-19_800_000).label(), "-05:30");
    }

    #[test]
    fn times_and_dates() {
        let plus_one = Offset(3_600_000);
        let utc = |s| parse_rfc3339(s).unwrap();
        assert_eq!(
            parse_time("t", "2026-11-12", plus_one).unwrap(),
            utc("2026-11-11T23:00:00Z")
        );
        assert_eq!(
            parse_time("t", "2026-11-12T09:00", plus_one).unwrap(),
            utc("2026-11-12T08:00:00Z")
        );
        assert_eq!(
            parse_time("t", "2026-11-12T09:00Z", plus_one).unwrap(),
            utc("2026-11-12T09:00:00Z")
        );
        assert_eq!(
            parse_time("t", "2026-11-12T09:00:00-05:00", plus_one).unwrap(),
            utc("2026-11-12T14:00:00Z")
        );
        assert!(parse_time("t", "tomorrow", plus_one).is_err());
    }

    #[test]
    fn ranges() {
        let now = parse_rfc3339("2026-11-11T23:30:00Z").unwrap();
        let plus_one = Offset(3_600_000);
        let (from, to) = range(None, None, plus_one, now).unwrap();
        // 00:30 on the 12th locally: today is the 12th.
        assert_eq!(from, parse_rfc3339("2026-11-11T23:00:00Z").unwrap());
        assert_eq!(to - from, 7 * DAY_MS);
        let (from, to) = range(Some("2026-11-12"), Some("2026-11-12"), Offset(0), now).unwrap();
        assert_eq!(to - from, DAY_MS, "a bare `to` date includes the day");
        assert!(range(Some("2026-11-12"), Some("2026-11-11"), Offset(0), now).is_err());
        assert!(range(Some("2026-01-01"), Some("2026-12-31"), Offset(0), now).is_err());
    }
}
