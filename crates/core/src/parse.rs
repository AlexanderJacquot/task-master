//! Quick-capture syntax (plan section 6), shared by every front end so the desktop app, the
//! CLI and the MCP server read a line the same way:
//!
//! ```text
//! Fix DNS on watch #homelab @Homelab !high ^fri +epic:IaC
//! ```
//!
//! - `#tag`: a tag (created if unknown). Several allowed.
//! - `@Project` or `@"Two words"`: the project.
//! - `+epic:Name` or `+epic:"Two words"`: the epic.
//! - `!urgent` `!high` `!normal` `!low` (or `!u` `!h` `!n` `!l`, `!1`..`!4`): the priority.
//! - `^today` `^tomorrow` `^mon`..`^sun` `^+3d` `^+2w` `^2026-12-01` `^12-01`: the due date.
//!
//! A marker only counts as a whole word; anything it cannot read stays in the title (with a
//! warning), so `email bob@example.com` or `C#` are left alone. For single-valued fields the
//! last marker wins.
//!
//! [`parse`] is pure. [`resolve`] matches names against live tags, projects and epics.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::model::{Id, IsoDate, Priority};

/// What a capture line says, before names are matched to entities.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Parsed {
    pub title: String,
    pub tags: Vec<String>,
    pub project: Option<String>,
    pub epic: Option<String>,
    pub priority: Option<Priority>,
    pub due_date: Option<IsoDate>,
    /// Markers that were not understood and were kept in the title.
    pub warnings: Vec<String>,
}

/// A name from the line and the live entity it matched, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NameMatch {
    pub name: String,
    /// `None`: no live entity has this name (a tag is then created; a project or epic is
    /// asked about).
    pub id: Option<Id>,
}

/// A parsed line with its names resolved, ready for the UI to preview and turn into
/// commands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Capture {
    pub title: String,
    pub tags: Vec<NameMatch>,
    pub project: Option<NameMatch>,
    pub epic: Option<NameMatch>,
    pub priority: Option<Priority>,
    pub due_date: Option<IsoDate>,
    pub warnings: Vec<String>,
}

/// Splits `text` into words, keeping `@"quoted names"` and `+epic:"quoted names"` whole.
fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in text.chars() {
        if c == '"' && (quoted || current.ends_with('@') || current.ends_with(':')) {
            quoted = !quoted;
            current.push(c);
        } else if c.is_whitespace() && !quoted {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
        } else {
            current.push(c);
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// A name after a sigil: a bare word, or a closed `"quoted name"`.
fn name(raw: &str) -> Option<String> {
    let value = match raw.strip_prefix('"') {
        Some(rest) => rest.strip_suffix('"')?.trim(),
        None => raw,
    };
    (!value.is_empty() && !value.contains('"')).then(|| value.to_owned())
}

fn priority(raw: &str) -> Option<Priority> {
    Some(match raw.to_ascii_lowercase().as_str() {
        "urgent" | "u" | "1" => Priority::Urgent,
        "high" | "h" | "2" => Priority::High,
        "normal" | "n" | "3" => Priority::Normal,
        "low" | "l" | "4" => Priority::Low,
        _ => return None,
    })
}

/// A tag name: letters, digits, `-`, `_`, `/`, starting with a letter or digit.
fn tag(raw: &str) -> Option<String> {
    let first = raw.chars().next()?;
    let ok = first.is_alphanumeric()
        && raw
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '/'));
    ok.then(|| raw.to_owned())
}

/// Parses one capture line. `today` (the user's local date) anchors relative due dates.
pub fn parse(text: &str, today: &str) -> Parsed {
    let mut parsed = Parsed::default();
    let mut title = Vec::new();
    for word in words(text) {
        let mut keep = |warning: Option<String>, parsed: &mut Parsed| {
            if let Some(w) = warning {
                parsed.warnings.push(w);
            }
            title.push(word.clone());
        };
        if let Some(rest) = word.strip_prefix('#') {
            match tag(rest) {
                Some(t) => {
                    if !parsed.tags.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
                        parsed.tags.push(t);
                    }
                }
                None => keep(None, &mut parsed),
            }
        } else if let Some(rest) = word.strip_prefix('@') {
            match name(rest) {
                Some(n) => parsed.project = Some(n),
                None => keep(None, &mut parsed),
            }
        } else if let Some(rest) = word.strip_prefix("+epic:") {
            match name(rest) {
                Some(n) => parsed.epic = Some(n),
                None => keep(Some(format!("'{word}' needs an epic name")), &mut parsed),
            }
        } else if let Some(rest) = word.strip_prefix('!').filter(|r| !r.is_empty()) {
            match priority(rest) {
                Some(p) => parsed.priority = Some(p),
                None => keep(Some(format!("'{word}' is not a priority")), &mut parsed),
            }
        } else if let Some(rest) = word.strip_prefix('^').filter(|r| !r.is_empty()) {
            match dates::due(rest, today) {
                Some(d) => parsed.due_date = Some(d),
                None => keep(Some(format!("'{word}' is not a date")), &mut parsed),
            }
        } else {
            keep(None, &mut parsed);
        }
    }
    parsed.title = title.join(" ");
    parsed
}

/// Best live match for `name` among `(id, name)` pairs: exact (ignoring case), else the
/// only one starting with it, else the only one containing it as a word.
fn best_match(name: &str, candidates: &[(Id, String)]) -> Option<Id> {
    let lower = name.to_lowercase();
    let unique = |hits: Vec<&(Id, String)>| (hits.len() == 1).then(|| hits[0].0.clone());
    if let Some((id, _)) = candidates.iter().find(|(_, n)| n.to_lowercase() == lower) {
        return Some(id.clone());
    }
    unique(
        candidates
            .iter()
            .filter(|(_, n)| n.to_lowercase().starts_with(&lower))
            .collect(),
    )
    .or_else(|| {
        unique(
            candidates
                .iter()
                .filter(|(_, n)| {
                    n.to_lowercase()
                        .split(|c: char| !c.is_alphanumeric())
                        .any(|w| w == lower)
                })
                .collect(),
        )
    })
}

fn pairs(conn: &Connection, sql: &str) -> Result<Vec<(Id, String)>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Matches the parsed names to live entities. Tags match exactly (ignoring case); projects
/// (archived ones last) and epics also by unique prefix or word.
pub(crate) fn resolve(conn: &Connection, parsed: Parsed) -> Result<Capture> {
    let tags = pairs(conn, "SELECT id, name FROM tags WHERE deleted_at IS NULL")?;
    let projects = pairs(
        conn,
        "SELECT id, name FROM projects WHERE deleted_at IS NULL AND archived_at IS NULL
         ORDER BY rank, id",
    )?;
    let epics = pairs(
        conn,
        "SELECT id, name FROM epics WHERE deleted_at IS NULL ORDER BY rank, id",
    )?;
    let tag_id = |name: &str| {
        tags.iter()
            .find(|(_, n)| n.eq_ignore_ascii_case(name))
            .map(|(id, _)| id.clone())
    };
    Ok(Capture {
        title: parsed.title,
        tags: parsed
            .tags
            .into_iter()
            .map(|name| NameMatch {
                id: tag_id(&name),
                name,
            })
            .collect(),
        project: parsed.project.map(|name| NameMatch {
            id: best_match(&name, &projects),
            name,
        }),
        epic: parsed.epic.map(|name| NameMatch {
            id: best_match(&name, &epics),
            name,
        }),
        priority: parsed.priority,
        due_date: parsed.due_date,
        warnings: parsed.warnings,
    })
}

/// Calendar arithmetic on ISO dates, without a date crate.
pub(crate) mod dates {
    use crate::clock::check_date;

    /// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
    fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
        let y = if m <= 2 { y - 1 } else { y };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }

    fn civil_from_days(z: i64) -> (i64, i64, i64) {
        let z = z + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        (yoe + era * 400 + i64::from(m <= 2), m, d)
    }

    fn to_days(iso: &str) -> Option<i64> {
        check_date("date", iso).ok()?;
        let n = |r: std::ops::Range<usize>| iso[r].parse::<i64>().ok();
        Some(days_from_civil(n(0..4)?, n(5..7)?, n(8..10)?))
    }

    pub(crate) fn to_iso(days: i64) -> String {
        let (y, m, d) = civil_from_days(days);
        format!("{y:04}-{m:02}-{d:02}")
    }

    /// 0 = Monday .. 6 = Sunday.
    fn weekday(days: i64) -> i64 {
        (days + 3).rem_euclid(7)
    }

    const WEEKDAYS: [&str; 7] = [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    ];

    /// A due-date marker (without `^`) relative to `today`, as an ISO date.
    pub(super) fn due(raw: &str, today: &str) -> Option<String> {
        let now = to_days(today)?;
        let lower = raw.to_ascii_lowercase();
        match lower.as_str() {
            "today" | "tod" => return Some(to_iso(now)),
            "tomorrow" | "tmr" | "tom" => return Some(to_iso(now + 1)),
            _ => {}
        }
        // A weekday: the next one, today included.
        if lower.len() >= 3
            && let Some(target) = WEEKDAYS.iter().position(|w| w.starts_with(&lower))
        {
            let ahead = (i64::try_from(target).ok()? - weekday(now)).rem_euclid(7);
            return Some(to_iso(now + ahead));
        }
        // +3d, +2w
        if let Some(rest) = lower.strip_prefix('+') {
            let (num, unit) = rest.split_at(rest.len().checked_sub(1)?);
            let n: i64 = num.parse().ok().filter(|n| (1..=3650).contains(n))?;
            return match unit {
                "d" => Some(to_iso(now + n)),
                "w" => Some(to_iso(now + 7 * n)),
                _ => None,
            };
        }
        // 2026-12-01
        if to_days(raw).is_some() {
            return Some(raw.to_owned());
        }
        // 12-01: this year, or next year once the date has passed.
        if raw.len() == 5 && raw.as_bytes()[2] == b'-' {
            let year = &today[0..4];
            let this_year = format!("{year}-{raw}");
            let days = to_days(&this_year)?;
            if days >= now {
                return Some(this_year);
            }
            let next: i64 = year.parse::<i64>().ok()? + 1;
            let next_year = format!("{next:04}-{raw}");
            to_days(&next_year)?;
            return Some(next_year);
        }
        None
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn civil_roundtrip_and_weekdays() {
            for iso in ["1970-01-01", "2000-02-29", "2026-11-04", "2100-12-31"] {
                assert_eq!(to_iso(to_days(iso).unwrap()), iso);
            }
            // 2026-11-04 is a Wednesday.
            assert_eq!(weekday(to_days("2026-11-04").unwrap()), 2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: &str = "2026-11-04"; // a Wednesday

    /// Plan section 6 examples and the edge cases, as one reviewed snapshot.
    #[test]
    fn capture_lines() {
        let lines = [
            "Fix DNS on watch #homelab @Homelab !high ^fri +epic:IaC",
            "Call mum",
            "Pay rent ^today !u",
            "Book flights @\"Perso / Admin\" ^tomorrow",
            "Renew passport ^12-01 #admin #Admin #papers",
            "Draft roadmap ^+2w +epic:\"Go freelance\"",
            "Water plants ^wed",
            "Old report ^01-15",
            "email bob@example.com about C# and 50% off",
            "Typo ^someday !maybe +epic:",
            "Last wins !low !urgent @Work @Home",
            "Unclosed @\"Perso Admin",
            "  spaced   out   title  ",
            "#only #tags",
        ];
        let parsed: Vec<(&str, Parsed)> = lines.iter().map(|l| (*l, parse(l, TODAY))).collect();
        insta::assert_yaml_snapshot!(parsed);
    }

    #[test]
    fn best_match_prefers_exact_then_unique_prefix_then_word() {
        let c = |names: &[&str]| -> Vec<(Id, String)> {
            names
                .iter()
                .enumerate()
                .map(|(i, n)| (i.to_string(), (*n).to_owned()))
                .collect()
        };
        let projects = c(&["Homelab", "Home", "Perso / Admin"]);
        assert_eq!(best_match("home", &projects), Some("1".into()));
        assert_eq!(best_match("homel", &projects), Some("0".into()));
        assert_eq!(best_match("admin", &projects), Some("2".into()));
        assert_eq!(best_match("ho", &projects), None, "ambiguous prefix");
        let epics = c(&["Migrate homelab to IaC", "Go freelance"]);
        assert_eq!(best_match("IaC", &epics), Some("0".into()));
        assert_eq!(best_match("nothing", &epics), None);
    }
}
