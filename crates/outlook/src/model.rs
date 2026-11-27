//! The platform-neutral half: OLE Automation dates, event ids and the change token that
//! stands in for a sync token (classic Outlook has none). Tested on every platform.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use taskmaster_core::ShowAs;
use taskmaster_core::calendar::{ProviderError, ProviderResult, RemoteEvent};

const DAY_MS: i64 = 86_400_000;
/// `OlSensitivity`: `olNormal` and `olPrivate`.
const NORMAL: i32 = 0;
const PRIVATE: i32 = 2;

/// An appointment's `BusyStatus` (`OlBusyStatus`) for a show-as (ADR 038).
pub fn busy_status(show_as: ShowAs) -> i32 {
    match show_as {
        ShowAs::Free => 0,
        ShowAs::Tentative => 1,
        ShowAs::Busy => 2,
    }
}

/// The show-as of a `BusyStatus`: out of office counts as busy, working elsewhere as free.
pub fn show_as(busy_status: i64) -> ShowAs {
    match busy_status {
        0 | 4 => ShowAs::Free,
        1 => ShowAs::Tentative,
        _ => ShowAs::Busy,
    }
}

/// The `Sensitivity` to write. Without a choice, pushed items stay private: the main
/// calendar is visible to colleagues (ADR 030).
pub fn sensitivity(private: Option<bool>) -> i32 {
    if private.unwrap_or(true) {
        PRIVATE
    } else {
        NORMAL
    }
}

/// Private and confidential items show only as taken time; normal and personal ones do
/// not hide their details.
pub fn is_private(sensitivity: i64) -> bool {
    sensitivity >= i64::from(PRIVATE)
}
/// 1899-12-30T00:00:00Z, day 0 of OLE Automation dates, in Unix ms.
const OLE_EPOCH_MS: i64 = -25_569 * DAY_MS;

/// An OLE Automation date (days since 1899-12-30, the fraction is the time of day) read as
/// UTC, in Unix ms. Outlook's `StartUTC`/`EndUTC` are UTC; its local dates (`Start` of an
/// all-day event) go through here too and are then read as wall dates.
pub fn ole_to_ms(date: f64) -> i64 {
    // Dates before 1899-12-30 count the fraction the other way; calendars never hold them.
    (date * DAY_MS as f64).round() as i64 + OLE_EPOCH_MS
}

pub fn ms_to_ole(ms: i64) -> f64 {
    (ms - OLE_EPOCH_MS) as f64 / DAY_MS as f64
}

/// `YYYY-MM-DD` of an OLE date's day (its wall date).
pub fn ole_date(date: f64) -> String {
    taskmaster_core::utc_date(ole_to_ms(date.floor()))
}

/// The OLE date of midnight starting `YYYY-MM-DD` (wall time).
pub fn date_ole(iso: &str) -> ProviderResult<f64> {
    let bad = || ProviderError::Other(format!("not a date: {iso}"));
    let mut parts = iso.splitn(3, '-').map(str::parse::<i64>);
    let (Some(Ok(y)), Some(Ok(m)), Some(Ok(d))) = (parts.next(), parts.next(), parts.next()) else {
        return Err(bad());
    };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Err(bad());
    }
    Ok(ms_to_ole(days_from_civil(y, m, d) * DAY_MS))
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// One occurrence of a recurring meeting has its series' EntryID: its start makes the id
/// unique in the app. Single items keep their EntryID, so they can be found again.
pub fn event_id(entry_id: &str, occurrence_start_ms: Option<i64>) -> String {
    match occurrence_start_ms {
        Some(start) => format!("{entry_id}|{start}"),
        None => entry_id.to_owned(),
    }
}

/// The EntryID of an event id (the series' for an occurrence).
pub fn entry_id(event_id: &str) -> &str {
    event_id.split_once('|').map_or(event_id, |(id, _)| id)
}

/// The change token: the events pushed from here that the target calendar held at the
/// last listing (EntryID → last change), so edits and deletions made in Outlook show up.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seen(pub BTreeMap<String, i64>);

impl Seen {
    pub fn parse(token: &str) -> ProviderResult<Self> {
        serde_json::from_str(token).map_err(|_| ProviderError::TokenExpired)
    }

    pub fn token(&self) -> String {
        serde_json::to_string(self).expect("a map of strings to numbers serializes")
    }
}

/// What changed between the last listing (`None`: report everything) and `current`, the
/// pushed events the calendar holds now. Gone ones come back cancelled.
pub fn changes(previous: Option<&Seen>, current: Vec<RemoteEvent>) -> (Vec<RemoteEvent>, Seen) {
    let seen = Seen(current.iter().map(|e| (e.id.clone(), e.updated)).collect());
    let Some(previous) = previous else {
        return (current, seen);
    };
    let mut changed: Vec<RemoteEvent> = current
        .into_iter()
        .filter(|e| previous.0.get(&e.id) != Some(&e.updated))
        .collect();
    for (id, updated) in &previous.0 {
        if !seen.0.contains_key(id) {
            changed.push(RemoteEvent {
                id: id.clone(),
                cancelled: true,
                title: String::new(),
                when: None,
                updated: *updated,
                key: None,
                location: None,
                link: None,
                show_as: None,
                private: None,
            });
        }
    }
    (changed, seen)
}

/// The Jet filter for items overlapping a range of wall dates, with dates already written
/// in the user's short date format (Outlook reads Jet dates that way).
pub fn window_filter(from_date: &str, to_date: &str) -> String {
    format!("[Start] <= '{to_date}' AND [End] >= '{from_date}'")
}

#[cfg(test)]
mod tests {
    use super::*;
    use taskmaster_core::calendar::When;

    fn event(id: &str, updated: i64) -> RemoteEvent {
        RemoteEvent {
            id: id.into(),
            cancelled: false,
            title: id.into(),
            when: Some(When::Timed {
                start_at: 0,
                end_at: 1,
            }),
            updated,
            key: Some(format!("block:{id}")),
            location: None,
            link: None,
            show_as: Some(ShowAs::Busy),
            private: Some(true),
        }
    }

    #[test]
    fn ole_dates_round_trip_through_unix_ms() {
        assert_eq!(ole_to_ms(25_569.0), 0);
        // 2026-11-05 09:00 UTC.
        let ms = 1_793_869_200_000;
        assert_eq!(ole_to_ms(ms_to_ole(ms)), ms);
        assert_eq!(ole_date(ms_to_ole(ms)), "2026-11-05");
        assert_eq!(date_ole("2026-11-05").unwrap(), ms_to_ole(ms).floor());
        assert_eq!(date_ole("1970-01-01").unwrap(), 25_569.0);
        assert_eq!(date_ole("2024-02-29").map(ole_date).unwrap(), "2024-02-29");
        assert!(date_ole("2026-13-01").is_err());
        assert!(date_ole("soon").is_err());
    }

    #[test]
    fn occurrences_get_their_own_ids_and_keep_the_series_entry_id() {
        assert_eq!(event_id("AB12", None), "AB12");
        let id = event_id("AB12", Some(1_000));
        assert_eq!(id, "AB12|1000");
        assert_eq!(entry_id(&id), "AB12");
        assert_eq!(entry_id("AB12"), "AB12");
    }

    #[test]
    fn the_token_reports_new_edited_and_deleted_events_only() {
        let (all, seen) = changes(None, vec![event("a", 1), event("b", 1)]);
        assert_eq!(all.len(), 2, "no token: a full listing");
        let seen = Seen::parse(&seen.token()).unwrap();

        let (changed, next) = changes(Some(&seen), vec![event("a", 1), event("b", 1)]);
        assert!(changed.is_empty());
        assert_eq!(next, seen);

        let (changed, next) = changes(Some(&seen), vec![event("a", 2), event("c", 5)]);
        let summary: Vec<(String, bool)> = changed
            .iter()
            .map(|e| (e.id.clone(), e.cancelled))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("a".to_string(), false),
                ("c".to_string(), false),
                ("b".to_string(), true)
            ]
        );
        assert_eq!(next.0.keys().collect::<Vec<_>>(), vec!["a", "c"]);
        assert_eq!(Seen::parse("not json"), Err(ProviderError::TokenExpired));
    }

    #[test]
    fn the_window_filter_uses_jet_start_and_end() {
        assert_eq!(
            window_filter("05/11/2026", "06/05/2027"),
            "[Start] <= '06/05/2027' AND [End] >= '05/11/2026'"
        );
    }

    #[test]
    fn show_as_and_sensitivity_map_both_ways() {
        for value in [ShowAs::Busy, ShowAs::Tentative, ShowAs::Free] {
            assert_eq!(show_as(i64::from(busy_status(value))), value);
        }
        assert_eq!(show_as(3), ShowAs::Busy, "out of office");
        assert_eq!(show_as(4), ShowAs::Free, "working elsewhere");
        assert_eq!(sensitivity(None), 2, "blocks stay private");
        assert_eq!(sensitivity(Some(true)), 2);
        assert_eq!(sensitivity(Some(false)), 0);
        assert!(is_private(2) && is_private(3));
        assert!(!is_private(0) && !is_private(1));
    }
}
