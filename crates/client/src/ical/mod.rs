//! iCalendar (RFC 5545) for CalDAV and .ics feeds (ADR 037): a reader for calendars as
//! servers and feeds send them, recurrence expansion (`RRULE`, `RDATE`, `EXDATE`,
//! `RECURRENCE-ID` overrides, time zones by name), and a writer for the one `VEVENT`
//! shape the app pushes.

pub mod tz;

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use taskmaster_core::ShowAs;
use taskmaster_core::calendar::{EventBody, When};

pub use tz::Zone;

/// The property that names the local item an event was pushed from.
pub const KEY_PROPERTY: &str = "X-TASKMASTER-KEY";
const PRODID: &str = "-//solarnexus//task-master//EN";
/// Occurrences of one recurring event kept in a window, at most.
const MAX_OCCURRENCES: u16 = 2000;

// ---------------------------------------------------------------------------------------
// Reading

/// `BEGIN:NAME` … `END:NAME` with its properties and nested components.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Component {
    pub name: String,
    pub props: Vec<Property>,
    pub children: Vec<Component>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Property {
    /// Upper case.
    pub name: String,
    /// Names upper case, values without quotes.
    pub params: Vec<(String, String)>,
    /// As written (escapes kept; see [`unescape`]).
    pub value: String,
}

impl Component {
    pub fn prop(&self, name: &str) -> Option<&Property> {
        self.props.iter().find(|p| p.name == name)
    }

    pub fn value(&self, name: &str) -> Option<&str> {
        self.prop(name).map(|p| p.value.as_str())
    }

    pub fn all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Property> + 'a {
        self.props.iter().filter(move |p| p.name == name)
    }

    /// The text of a property, unescaped.
    pub fn text(&self, name: &str) -> Option<String> {
        self.value(name).map(unescape)
    }
}

impl Property {
    pub fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Reads every top-level component (normally one `VCALENDAR`). Lenient: unknown lines
/// are skipped, and a missing `END` closes at the end of the text.
pub fn parse(text: &str) -> Result<Vec<Component>, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut stack: Vec<Component> = Vec::new();
    let mut done = Vec::new();
    for line in unfold(text) {
        let Some(prop) = content_line(&line) else {
            continue;
        };
        match prop.name.as_str() {
            "BEGIN" => stack.push(Component {
                name: prop.value.trim().to_ascii_uppercase(),
                ..Component::default()
            }),
            "END" => {
                let name = prop.value.trim().to_ascii_uppercase();
                // Close up to the matching BEGIN (tolerates a missing END inside).
                if !stack.iter().any(|c| c.name == name) {
                    continue;
                }
                while let Some(component) = stack.pop() {
                    let matched = component.name == name;
                    match stack.last_mut() {
                        Some(parent) => parent.children.push(component),
                        None => done.push(component),
                    }
                    if matched {
                        break;
                    }
                }
            }
            _ => {
                if let Some(current) = stack.last_mut() {
                    current.props.push(prop);
                }
            }
        }
    }
    while let Some(component) = stack.pop() {
        match stack.last_mut() {
            Some(parent) => parent.children.push(component),
            None => done.push(component),
        }
    }
    if done.is_empty() {
        return Err("not an iCalendar file".into());
    }
    Ok(done)
}

/// Joins folded lines (a line starting with a space or a tab continues the previous one).
fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = raw.strip_prefix([' ', '\t'])
            && let Some(last) = lines.last_mut()
        {
            last.push_str(rest);
            continue;
        }
        if !raw.is_empty() {
            lines.push(raw.to_owned());
        }
    }
    lines
}

/// `NAME;PARAM=a;PARAM2="b:c":value`.
fn content_line(line: &str) -> Option<Property> {
    let mut chars = line.char_indices().peekable();
    let mut name_end = None;
    for (i, c) in chars.by_ref() {
        if c == ';' || c == ':' {
            name_end = Some((i, c));
            break;
        }
    }
    let (end, mut sep) = name_end?;
    let name = line[..end].trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let mut params = Vec::new();
    let mut pos = end + 1;
    while sep == ';' {
        // A parameter: NAME=VALUE[,VALUE], values possibly quoted.
        let rest = &line[pos..];
        let eq = rest.find('=')?;
        let pname = rest[..eq].trim().to_ascii_uppercase();
        let mut value = String::new();
        let mut quoted = false;
        let mut next = None;
        for (i, c) in rest[eq + 1..].char_indices() {
            match c {
                '"' => quoted = !quoted,
                ';' | ':' if !quoted => {
                    next = Some((pos + eq + 1 + i, c));
                    break;
                }
                _ => value.push(c),
            }
        }
        let (at, c) = next?;
        params.push((pname, value));
        pos = at + 1;
        sep = c;
    }
    Some(Property {
        name,
        params,
        value: line[pos..].to_owned(),
    })
}

/// TEXT values: `\n`, `\,`, `\;`, `\\`.
pub fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

// ---------------------------------------------------------------------------------------
// Events

/// A date or a date-time as an event gives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DateValue {
    Date(NaiveDate),
    Utc(DateTime<Utc>),
    /// A wall-clock time in a zone (`TZID=`), or floating (the machine's zone).
    Local(NaiveDateTime, Zone),
}

impl DateValue {
    pub fn is_date(self) -> bool {
        matches!(self, DateValue::Date(_))
    }

    /// The instant; dates at midnight UTC.
    pub fn instant(self) -> DateTime<Utc> {
        match self {
            DateValue::Date(d) => Utc.from_utc_datetime(&d.and_time(NaiveTime::MIN)),
            DateValue::Utc(t) => t,
            DateValue::Local(t, zone) => zone.to_utc(t),
        }
    }

    pub fn ms(self) -> i64 {
        self.instant().timestamp_millis()
    }
}

/// One `VEVENT`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub uid: String,
    pub summary: Option<String>,
    pub location: Option<String>,
    pub start: DateValue,
    pub end: Option<DateValue>,
    pub duration: Option<Duration>,
    pub rrule: Option<String>,
    pub rdates: Vec<DateValue>,
    pub exdates: Vec<DateValue>,
    pub recurrence_id: Option<DateValue>,
    /// `STATUS:CANCELLED`.
    pub cancelled: bool,
    /// [`KEY_PROPERTY`].
    pub key: Option<String>,
    pub last_modified: Option<DateTime<Utc>>,
}

/// The `VEVENT`s of parsed calendars. Events without a usable `DTSTART` are skipped.
pub fn events(calendars: &[Component]) -> Vec<Event> {
    let mut out = Vec::new();
    for calendar in calendars {
        let timezones: Vec<&Component> = calendar
            .children
            .iter()
            .filter(|c| c.name == "VTIMEZONE")
            .collect();
        for component in calendar.children.iter().filter(|c| c.name == "VEVENT") {
            if let Some(event) = event(component, &timezones) {
                out.push(event);
            }
        }
    }
    out
}

fn event(c: &Component, timezones: &[&Component]) -> Option<Event> {
    let start = date_values(c.prop("DTSTART")?, timezones)
        .into_iter()
        .next()?;
    let end = c
        .prop("DTEND")
        .and_then(|p| date_values(p, timezones).into_iter().next());
    let all = |name: &str| -> Vec<DateValue> {
        c.all(name)
            .flat_map(|p| date_values(p, timezones))
            .collect()
    };
    Some(Event {
        uid: c.text("UID").unwrap_or_default(),
        summary: c.text("SUMMARY").filter(|s| !s.trim().is_empty()),
        location: c.text("LOCATION").filter(|s| !s.trim().is_empty()),
        start,
        end,
        duration: c.value("DURATION").and_then(parse_duration),
        rrule: c.value("RRULE").map(str::to_owned),
        rdates: all("RDATE"),
        exdates: all("EXDATE"),
        recurrence_id: c
            .prop("RECURRENCE-ID")
            .and_then(|p| date_values(p, timezones).into_iter().next()),
        cancelled: c
            .value("STATUS")
            .is_some_and(|s| s.trim().eq_ignore_ascii_case("CANCELLED")),
        key: c.text(KEY_PROPERTY).filter(|k| !k.is_empty()),
        last_modified: c
            .prop("LAST-MODIFIED")
            .and_then(|p| date_values(p, timezones).into_iter().next())
            .map(DateValue::instant),
    })
}

/// The values of a date property (several for `EXDATE`/`RDATE`; a period gives its
/// start).
pub fn date_values(prop: &Property, timezones: &[&Component]) -> Vec<DateValue> {
    let zone = prop.param("TZID").map(|id| tz::resolve(id, timezones));
    let as_date = prop
        .param("VALUE")
        .is_some_and(|v| v.eq_ignore_ascii_case("DATE"));
    prop.value
        .split(',')
        .filter_map(|v| {
            let v = v.split('/').next().unwrap_or(v).trim();
            parse_date_value(v, zone, as_date)
        })
        .collect()
}

fn parse_date_value(text: &str, zone: Option<Zone>, as_date: bool) -> Option<DateValue> {
    if as_date || (text.len() == 8 && !text.contains('T')) {
        return NaiveDate::parse_from_str(text.get(..8)?, "%Y%m%d")
            .ok()
            .map(DateValue::Date);
    }
    let (body, utc) = match text.strip_suffix(['Z', 'z']) {
        Some(body) => (body, true),
        None => (text, false),
    };
    let naive = NaiveDateTime::parse_from_str(body, "%Y%m%dT%H%M%S")
        .or_else(|_| NaiveDateTime::parse_from_str(body, "%Y%m%dT%H%M"))
        .ok()?;
    Some(if utc {
        DateValue::Utc(Utc.from_utc_datetime(&naive))
    } else {
        DateValue::Local(naive, zone.unwrap_or(Zone::Local))
    })
}

/// `P1W`, `P1DT2H`, `PT15M`, `-PT5M`, `P0D`.
pub fn parse_duration(text: &str) -> Option<Duration> {
    let text = text.trim();
    let (sign, text) = match text.as_bytes().first()? {
        b'-' => (-1, &text[1..]),
        b'+' => (1, &text[1..]),
        _ => (1, text),
    };
    let text = text.strip_prefix(['P', 'p'])?;
    let mut secs: i64 = 0;
    let mut number = String::new();
    let mut seen = false;
    for c in text.chars() {
        match c.to_ascii_uppercase() {
            'T' => {}
            d if d.is_ascii_digit() => number.push(d),
            unit => {
                let n: i64 = number.parse().ok()?;
                number.clear();
                seen = true;
                secs += n * match unit {
                    'W' => 7 * 86_400,
                    'D' => 86_400,
                    'H' => 3_600,
                    'M' => 60,
                    'S' => 1,
                    _ => return None,
                };
            }
        }
    }
    (seen && number.is_empty()).then(|| Duration::seconds(sign * secs))
}

// ---------------------------------------------------------------------------------------
// Occurrences

/// One occurrence of an event in a window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occurrence<'a> {
    pub event: &'a Event,
    pub when: When,
    /// Set for occurrences of recurring events: their `RECURRENCE-ID` in UTC
    /// (`20261105T090000Z`) or as a date (`20261105`).
    pub instance: Option<String>,
}

/// Every occurrence overlapping `[from, to)` (Unix ms): single events, recurring ones
/// expanded with their exceptions and overrides. Cancelled events and occurrences are
/// left out.
pub fn expand(events: &[Event], from: i64, to: i64) -> Vec<Occurrence<'_>> {
    let mut out = Vec::new();
    // Overrides by UID, keyed by the instant they replace.
    let mut overridden: std::collections::HashMap<&str, std::collections::HashSet<i64>> =
        std::collections::HashMap::new();
    for event in events {
        if let Some(rid) = event.recurrence_id {
            overridden
                .entry(event.uid.as_str())
                .or_default()
                .insert(rid.ms());
            if !event.cancelled
                && let Some(when) = occurrence_when(event, event.start)
                && overlaps(&when, from, to)
            {
                out.push(Occurrence {
                    event,
                    when,
                    instance: Some(instance_id(rid)),
                });
            }
        }
    }
    for event in events.iter().filter(|e| e.recurrence_id.is_none()) {
        if event.cancelled {
            continue;
        }
        let recurring = event.rrule.is_some() || !event.rdates.is_empty();
        if !recurring {
            if let Some(when) = occurrence_when(event, event.start)
                && overlaps(&when, from, to)
            {
                out.push(Occurrence {
                    event,
                    when,
                    instance: None,
                });
            }
            continue;
        }
        let skip = overridden.get(event.uid.as_str());
        let length = length_ms(event);
        let excluded: std::collections::HashSet<i64> = event
            .exdates
            .iter()
            .map(|d| same_kind(*d, event.start).ms())
            .collect();
        for start in starts(event, from - length.max(0) - 1, to) {
            let ms = start.ms();
            if excluded.contains(&ms) || skip.is_some_and(|s| s.contains(&ms)) {
                continue;
            }
            if let Some(when) = occurrence_when(event, start)
                && overlaps(&when, from, to)
            {
                out.push(Occurrence {
                    event,
                    when,
                    instance: Some(instance_id(start)),
                });
            }
        }
    }
    out.sort_by_key(|o| when_start(&o.when));
    out
}

fn when_start(when: &When) -> i64 {
    match when {
        When::Timed { start_at, .. } => *start_at,
        When::AllDay { start, .. } => iso_ms(start),
    }
}

fn iso_ms(iso: &str) -> i64 {
    NaiveDate::parse_from_str(iso, "%Y-%m-%d")
        .map(|d| DateValue::Date(d).ms())
        .unwrap_or(0)
}

fn overlaps(when: &When, from: i64, to: i64) -> bool {
    let (start, end) = match when {
        When::Timed { start_at, end_at } => (*start_at, *end_at),
        When::AllDay { start, end } => (iso_ms(start), iso_ms(end)),
    };
    if end <= start {
        start >= from && start < to
    } else {
        start < to && end > from
    }
}

/// An `EXDATE` written as a date for a timed event (or the reverse) compares as the
/// event's own kind.
fn same_kind(value: DateValue, start: DateValue) -> DateValue {
    match (value, start) {
        (DateValue::Date(d), DateValue::Local(t, zone)) => {
            DateValue::Local(d.and_time(t.time()), zone)
        }
        (DateValue::Date(d), DateValue::Utc(t)) => {
            DateValue::Utc(Utc.from_utc_datetime(&d.and_time(t.time())))
        }
        (DateValue::Utc(t), DateValue::Date(_)) => DateValue::Date(t.date_naive()),
        (DateValue::Local(t, _), DateValue::Date(_)) => DateValue::Date(t.date()),
        _ => value,
    }
}

fn instance_id(value: DateValue) -> String {
    match value {
        DateValue::Date(d) => d.format("%Y%m%d").to_string(),
        other => other.instant().format("%Y%m%dT%H%M%SZ").to_string(),
    }
}

/// The event's length in ms (in days × 86 400 000 for all-day events).
fn length_ms(event: &Event) -> i64 {
    if let Some(end) = event.end {
        let end = same_kind(end, event.start);
        return match (event.start, end) {
            (DateValue::Date(s), DateValue::Date(e)) => (e - s).num_days().max(1) * 86_400_000,
            _ => (end.ms() - event.start.ms()).max(0),
        };
    }
    match event.duration {
        Some(d) if event.start.is_date() => d.num_days().max(1) * 86_400_000,
        Some(d) => d.num_milliseconds().max(0),
        None if event.start.is_date() => 86_400_000,
        None => 0,
    }
}

/// The occurrence starting at `start` (one of the event's starts), with the event's
/// length. Timed lengths stay in elapsed time; all-day ones in days.
fn occurrence_when(event: &Event, start: DateValue) -> Option<When> {
    let length = length_ms(event);
    match start {
        DateValue::Date(d) => {
            let days = (length / 86_400_000).max(1);
            Some(When::AllDay {
                start: d.format("%Y-%m-%d").to_string(),
                end: (d + Duration::days(days)).format("%Y-%m-%d").to_string(),
            })
        }
        other => {
            let start_at = other.ms();
            Some(When::Timed {
                start_at,
                end_at: start_at + length,
            })
        }
    }
}

/// When an event happens as written (its first occurrence, for a recurring one).
pub fn event_when(event: &Event) -> Option<When> {
    occurrence_when(event, event.start)
}

/// Starts of a recurring event that may overlap `[from, to)`: `RRULE` and `RDATE`.
fn starts(event: &Event, from: i64, to: i64) -> Vec<DateValue> {
    let mut out: Vec<DateValue> = Vec::new();
    if let Some(rule) = &event.rrule {
        out.extend(rule_starts(event, rule, from, to));
    }
    for rdate in &event.rdates {
        let value = same_kind(*rdate, event.start);
        let ms = value.ms();
        if ms >= from && ms < to {
            out.push(value);
        }
    }
    // DTSTART is always the first occurrence, also when the rule does not match it.
    let first = event.start.ms();
    if first >= from && first < to {
        out.push(event.start);
    }
    out.sort_by_key(|d| d.ms());
    out.dedup_by_key(|d| d.ms());
    out
}

fn rule_starts(event: &Event, rule: &str, from: i64, to: i64) -> Vec<DateValue> {
    // UNTIL is read here: the rrule crate wants it in UTC, which many feeds do not use.
    let mut until: Option<DateValue> = None;
    let parts: Vec<&str> = rule
        .split(';')
        .filter(|part| {
            let Some((name, value)) = part.split_once('=') else {
                return false;
            };
            if name.trim().eq_ignore_ascii_case("UNTIL") {
                let zone = match event.start {
                    DateValue::Local(_, zone) => Some(zone),
                    _ => None,
                };
                until = parse_date_value(value.trim(), zone, false);
                return false;
            }
            true
        })
        .collect();
    let Ok(parsed) = parts.join(";").parse::<rrule::RRule<rrule::Unvalidated>>() else {
        return Vec::new();
    };

    // Expanded in the event's zone (wall-clock times keep across DST changes); dates and
    // fixed offsets in UTC.
    let (tz, start_local) = match event.start {
        DateValue::Date(d) => (rrule::Tz::UTC, d.and_time(NaiveTime::MIN)),
        DateValue::Utc(t) => (rrule::Tz::UTC, t.naive_utc()),
        DateValue::Local(t, zone) => match zone.rrule_tz() {
            Some(tz) => (tz, t),
            None => (rrule::Tz::UTC, t),
        },
    };
    let Some(dt_start) = tz.from_local_datetime(&start_local).earliest() else {
        return Vec::new();
    };
    let mut parsed = parsed;
    if let Some(until) = until {
        // A date UNTIL includes that whole day.
        let end = match (until, event.start) {
            (DateValue::Date(d), DateValue::Date(_)) => DateValue::Date(d).instant(),
            (DateValue::Date(d), DateValue::Local(_, zone)) => {
                zone.to_utc(d.and_hms_opt(23, 59, 59).unwrap_or_default())
            }
            (DateValue::Date(d), DateValue::Utc(_)) => {
                Utc.from_utc_datetime(&d.and_hms_opt(23, 59, 59).unwrap_or_default())
            }
            (other, _) => other.instant(),
        };
        if end.timestamp_millis() < dt_start.timestamp_millis() {
            return Vec::new();
        }
        parsed = parsed.until(end.with_timezone(&rrule::Tz::UTC));
    }
    let Ok(set) = parsed.build(dt_start) else {
        return Vec::new();
    };
    let shift = match event.start {
        DateValue::Local(_, Zone::Fixed(secs)) => i64::from(secs) * 1000,
        _ => 0,
    };
    let window = |ms: i64| {
        Utc.timestamp_millis_opt(ms)
            .single()
            .map(|t| t.with_timezone(&tz))
    };
    let (Some(after), Some(before)) = (window(from + shift), window(to + shift)) else {
        return Vec::new();
    };
    set.after(after)
        .before(before)
        .all(MAX_OCCURRENCES)
        .dates
        .into_iter()
        .map(|t| match event.start {
            DateValue::Date(_) => DateValue::Date(t.date_naive()),
            DateValue::Utc(_) => DateValue::Utc(t.with_timezone(&Utc)),
            DateValue::Local(_, zone) => DateValue::Local(t.naive_local(), zone),
        })
        .collect()
}

// ---------------------------------------------------------------------------------------
// Writing

/// The calendar object the app stores for one pushed item.
pub fn write_event(uid: &str, body: &EventBody, stamp_ms: i64) -> String {
    let utc = |ms: i64| {
        Utc.timestamp_millis_opt(ms)
            .single()
            .unwrap_or_default()
            .format("%Y%m%dT%H%M%SZ")
            .to_string()
    };
    let date = |iso: &str| iso.replace('-', "");
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_owned(),
        "VERSION:2.0".to_owned(),
        format!("PRODID:{PRODID}"),
        "CALSCALE:GREGORIAN".to_owned(),
        "BEGIN:VEVENT".to_owned(),
        format!("UID:{}", escape(uid)),
        format!("DTSTAMP:{}", utc(stamp_ms)),
        format!("LAST-MODIFIED:{}", utc(stamp_ms)),
    ];
    match &body.when {
        When::Timed { start_at, end_at } => {
            lines.push(format!("DTSTART:{}", utc(*start_at)));
            lines.push(format!("DTEND:{}", utc(*end_at)));
        }
        When::AllDay { start, end } => {
            lines.push(format!("DTSTART;VALUE=DATE:{}", date(start)));
            lines.push(format!("DTEND;VALUE=DATE:{}", date(end)));
        }
    }
    // Show as (ADR 038): day plans and deadlines are free, blocks busy, meetings as set.
    // iCalendar has no "tentative" transparency: a tentative event is one whose status is.
    lines.push(match body.show_as {
        ShowAs::Free => "TRANSP:TRANSPARENT".into(),
        ShowAs::Busy | ShowAs::Tentative => "TRANSP:OPAQUE".into(),
    });
    if body.show_as == ShowAs::Tentative {
        lines.push("STATUS:TENTATIVE".into());
    }
    lines.push(format!("SUMMARY:{}", escape(&body.title)));
    if !body.description.is_empty() {
        lines.push(format!("DESCRIPTION:{}", escape(&body.description)));
    }
    // Private unless the item says otherwise (a meeting made visible).
    lines.push(
        if body.private == Some(false) {
            "CLASS:PUBLIC"
        } else {
            "CLASS:PRIVATE"
        }
        .into(),
    );
    lines.push(format!("{KEY_PROPERTY}:{}", escape(&body.key)));
    lines.push("END:VEVENT".into());
    lines.push("END:VCALENDAR".into());
    let mut out = String::new();
    for line in lines {
        fold(&line, &mut out);
    }
    out
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            c => out.push(c),
        }
    }
    out
}

/// Lines of at most 75 octets, continued with a space, never splitting a character.
fn fold(line: &str, out: &mut String) {
    let mut width = 0;
    for c in line.chars() {
        let len = c.len_utf8();
        if width + len > 75 {
            out.push_str("\r\n ");
            width = 1;
        }
        out.push(c);
        width += len;
    }
    out.push_str("\r\n");
}

#[cfg(test)]
mod tests;
