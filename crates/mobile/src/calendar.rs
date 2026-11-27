//! Calendar events in the day plan (ADR 014, ADR 040): the events of the calendars shown
//! in the app, read-only, beside the time blocks.
//!
//! Events are not ops: whoever runs the calendar sync keeps them (ADR 014). When that is
//! the server, the phone fetches the coming days from `/calendar/events` after a sync
//! round (at most every few minutes) or when asked, and keeps them in `calendar.json`, so
//! the day plan reads them offline and never waits on the network. When a desktop runs
//! the calendar sync (classic Outlook always does), its events stay on that desktop and
//! the phone says so.

use std::sync::MutexGuard;

use serde::{Deserialize, Serialize};
use taskmaster_client::Client;
use taskmaster_core::calendar::{CalendarEvent, CalendarRunner, CalendarSource, EventRange};
use taskmaster_core::{Timestamp, now_ms};

use crate::plan::{DAY_MS, days_from_civil, local_midnight};
use crate::{AppError, AppResult, Core, Day, Inner, lock};

const CALENDAR_CACHE: &str = "calendar.json";
/// A round refreshes the events when they are older than this.
const REFRESH_AFTER_MS: i64 = 5 * 60_000;
/// The days fetched around today: a little before (time zones, yesterday's plan) and two
/// weeks ahead.
const DAYS_BEFORE: i64 = 2;
const DAYS_AFTER: i64 = 15;

/// Where the calendar's events come from, as far as the phone can tell.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum CalendarAvailability {
    /// Not asked yet (no sync server, or no round since the app was installed).
    #[default]
    Unknown,
    /// The server runs the calendar sync: its events are here.
    Available,
    /// The server is to run the calendar sync but has no calendar account connected.
    NotConnected,
    /// A desktop runs the calendar sync (or none is set up): its events stay there.
    OnDesktop,
    /// The server is older than calendar sync.
    Unsupported,
}

/// What the day plan says about the calendar.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarInfo {
    pub availability: CalendarAvailability,
    /// When the events were last fetched (Unix ms).
    pub fetched_at: Option<i64>,
    /// The last fetch failed (the events shown are the ones fetched before).
    pub last_error: Option<String>,
}

/// An event of a calendar shown in the app. Read-only: change it in the calendar.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EventItem {
    pub id: String,
    pub calendar_id: String,
    pub calendar_name: String,
    pub title: String,
    /// Timed events (Unix ms); `None` for an all-day event.
    pub start_at: Option<i64>,
    pub end_at: Option<i64>,
    /// All-day events: the first day and the day after the last (`YYYY-MM-DD`).
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub location: Option<String>,
    /// The event's page (or a meeting link) when the calendar gives one.
    pub link: Option<String>,
    pub color: Option<String>,
}

/// The phone's copy of the server's events, saved as `calendar.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct CalendarCache {
    availability: CalendarAvailability,
    fetched_at: Option<Timestamp>,
    /// Set by a failed fetch; the events are the last good ones.
    last_error: Option<String>,
    /// Attempted, successful or not (the refresh pause counts from here).
    tried_at: Option<Timestamp>,
    sources: Vec<CalendarSource>,
    events: Vec<CalendarEvent>,
}

impl CalendarCache {
    pub(crate) fn load(dir: &std::path::Path) -> Self {
        std::fs::read(dir.join(CALENDAR_CACHE))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn info(&self) -> CalendarInfo {
        CalendarInfo {
            availability: self.availability,
            fetched_at: self.fetched_at,
            last_error: self.last_error.clone(),
        }
    }
}

/// `YYYY-MM-DD` of a day number (days since 1970-01-01).
fn iso_of(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// The days fetched around `now`, wide enough for any time zone.
fn window(now: Timestamp) -> EventRange {
    let today = now.div_euclid(DAY_MS);
    let (first, after) = (today - DAYS_BEFORE, today + DAYS_AFTER);
    EventRange {
        from: first * DAY_MS,
        to: after * DAY_MS,
        from_date: iso_of(first),
        to_date: iso_of(after),
    }
}

/// Whether an event shows on the local day starting at `start` (Unix ms) dated `date`.
fn on_day(event: &CalendarEvent, start: Timestamp, date: &str) -> bool {
    match (
        event.start_at,
        event.end_at,
        &event.start_date,
        &event.end_date,
    ) {
        (Some(from), Some(to), _, _) => from < start + DAY_MS && to > start,
        (_, _, Some(first), Some(after)) => first.as_str() <= date && date < after.as_str(),
        _ => false,
    }
}

fn save(dir: &std::path::Path, cache: &CalendarCache) -> Result<(), String> {
    let json = serde_json::to_vec(cache).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{CALENDAR_CACHE}.tmp"));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(CALENDAR_CACHE)).map_err(|e| e.to_string())
}

impl Inner {
    fn calendar(&self) -> MutexGuard<'_, CalendarCache> {
        lock(&self.calendar)
    }

    /// Fetches the coming days' events when the server runs the calendar sync. Without
    /// `force`, does nothing when they were fetched in the last few minutes. A failure
    /// keeps the last good events and is reported in [`CalendarInfo::last_error`], not as
    /// the sync round's error (the tasks synced fine).
    pub(crate) fn refresh_calendar(&self, client: &Client, force: bool) {
        let now = now_ms();
        if !force
            && self
                .calendar()
                .tried_at
                .is_some_and(|at| now - at < REFRESH_AFTER_MS)
        {
            return;
        }
        let fetched = fetch(client, now);
        let changed = {
            let mut cache = self.calendar();
            let before = (cache.availability, cache.events.clone());
            cache.tried_at = Some(now);
            match fetched {
                Ok((availability, sources, events)) => {
                    cache.availability = availability;
                    cache.sources = sources;
                    cache.events = events;
                    cache.fetched_at = Some(now);
                    cache.last_error = None;
                }
                Err(e) => cache.last_error = Some(e),
            }
            if let Err(e) = save(&self.dir, &cache) {
                eprintln!("cannot save the calendar's events: {e}");
            }
            before != (cache.availability, cache.events.clone())
        };
        if changed && let Some(listener) = self.listener() {
            listener.data_changed();
        }
    }

    /// Forgets the server's events (the phone left the server).
    pub(crate) fn forget_calendar(&self) {
        *self.calendar() = CalendarCache::default();
        let _ = std::fs::remove_file(self.dir.join(CALENDAR_CACHE));
    }
}

type Fetched = (
    CalendarAvailability,
    Vec<CalendarSource>,
    Vec<CalendarEvent>,
);

fn fetch(client: &Client, now: Timestamp) -> Result<Fetched, String> {
    let status = match client.calendar_status() {
        Ok(status) => status,
        Err(taskmaster_client::Error::Http(404 | 405, _)) => {
            return Ok((CalendarAvailability::Unsupported, Vec::new(), Vec::new()));
        }
        Err(e) => return Err(e.to_string()),
    };
    if status.runner != CalendarRunner::Server {
        return Ok((CalendarAvailability::OnDesktop, Vec::new(), Vec::new()));
    }
    if !status.connected {
        return Ok((CalendarAvailability::NotConnected, Vec::new(), Vec::new()));
    }
    let events = client
        .calendar_events(&window(now))
        .map_err(|e| e.to_string())?;
    Ok((CalendarAvailability::Available, status.sources, events))
}

#[uniffi::export]
impl Core {
    /// The calendar events on a day (`YYYY-MM-DD`, the phone's day), all-day ones first,
    /// then by start. From the phone's copy: never waits on the network.
    pub fn day_events(&self, date: String, day: Day) -> AppResult<Vec<EventItem>> {
        if days_from_civil(&date).is_none() {
            return Err(AppError::Invalid {
                message: format!("{date} is not a date (YYYY-MM-DD)"),
            });
        }
        let start = local_midnight(&date, &day)?;
        let cache = self.inner.calendar();
        let name = |id: &str| {
            cache
                .sources
                .iter()
                .find(|s| s.id == id)
                .map(|s| s.name.clone())
                .unwrap_or_default()
        };
        let mut events: Vec<EventItem> = cache
            .events
            .iter()
            .filter(|e| on_day(e, start, &date))
            .map(|e| EventItem {
                id: e.id.clone(),
                calendar_id: e.calendar_id.clone(),
                calendar_name: name(&e.calendar_id),
                title: e.title.clone(),
                start_at: e.start_at,
                end_at: e.end_at,
                start_date: e.start_date.clone(),
                end_date: e.end_date.clone(),
                location: e.location.clone(),
                link: e.link.clone(),
                color: e.color.clone(),
            })
            .collect();
        events.sort_by(|a, b| {
            (a.start_at.is_some(), a.start_at, &a.title).cmp(&(
                b.start_at.is_some(),
                b.start_at,
                &b.title,
            ))
        });
        Ok(events)
    }

    /// Where the events come from and when they were fetched.
    pub fn calendar_info(&self) -> CalendarInfo {
        self.inner.calendar().info()
    }

    /// Fetches the events now (the day plan opened, pull to refresh). Uses the network:
    /// never call it on the main thread. Does nothing before the phone joined a server.
    pub fn refresh_calendar(&self) -> CalendarInfo {
        let account = taskmaster_client::engine::Host::account(&*self.inner).filter(|a| a.joined);
        if let Some(account) = account {
            let client = Client::new(&account.url, account.token);
            self.inner.refresh_calendar(&client, true);
        }
        self.calendar_info()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_numbers_become_dates() {
        assert_eq!(iso_of(0), "1970-01-01");
        assert_eq!(iso_of(20_777), "2026-11-20");
        assert_eq!(iso_of(11_017), "2000-03-01");
        for days in [-1, 59, 365, 20_000, 30_000] {
            assert_eq!(days_from_civil(&iso_of(days)), Some(days));
        }
    }

    #[test]
    fn the_window_covers_the_coming_two_weeks() {
        let now = 20_777 * DAY_MS + 3_600_000;
        let range = window(now);
        assert_eq!(range.from_date, "2026-11-18");
        assert_eq!(range.to_date, "2026-12-05");
        assert_eq!(range.from, 20_775 * DAY_MS);
    }

    #[test]
    fn events_land_on_their_local_days() {
        let event =
            |start_at, end_at, start_date: Option<&str>, end_date: Option<&str>| CalendarEvent {
                calendar_id: "c".into(),
                id: "e".into(),
                title: "t".into(),
                start_at,
                end_at,
                start_date: start_date.map(Into::into),
                end_date: end_date.map(Into::into),
                location: None,
                link: None,
                color: None,
                show_as: Default::default(),
                private: false,
            };
        let day = Day {
            today: "2026-11-20".into(),
            utc_offset_min: 60,
        };
        let start = local_midnight("2026-11-20", &day).unwrap();
        // 23:30 UTC on the 19th is 00:30 on the 20th one hour east.
        let late = event(
            Some(start + 30 * 60_000),
            Some(start + 90 * 60_000),
            None,
            None,
        );
        assert!(on_day(&late, start, "2026-11-20"));
        assert!(!on_day(&late, start - DAY_MS, "2026-11-19"));
        // Ends exactly at midnight: not on the next day.
        let evening = event(Some(start - 3_600_000), Some(start), None, None);
        assert!(!on_day(&evening, start, "2026-11-20"));
        let trip = event(None, None, Some("2026-11-19"), Some("2026-11-21"));
        assert!(on_day(&trip, start, "2026-11-20"));
        assert!(
            !on_day(&trip, start + DAY_MS, "2026-11-21"),
            "end_date is exclusive"
        );
    }
}
