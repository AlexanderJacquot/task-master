//! The CalDAV provider (ADR 037) against an in-memory server, alone and under the
//! calendar sync engine.

use std::cell::RefCell;

use taskmaster_client::caldav::{Account, CaldavCalendar};
use taskmaster_core::calendar::{
    CalendarProvider, EventRange, ProviderError, TARGET_CALENDAR, linked_event, sync,
};
use taskmaster_core::*;

#[path = "support/fake_dav.rs"]
mod fake_dav;
use fake_dav::{BASE, FakeDav, PASSWORD, USER};

const HOUR: i64 = 3_600_000;
/// 2026-11-05 09:00 UTC.
const NOW: i64 = 1_793_869_200_000;
const TODAY: &str = "2026-11-05";

fn account(password: &str) -> Account {
    Account {
        server_url: BASE.into(),
        username: USER.into(),
        password: password.into(),
    }
}

fn provider(dav: FakeDav) -> CaldavCalendar<FakeDav> {
    CaldavCalendar::with_transport(dav, account(PASSWORD), None).unwrap()
}

fn add_task(s: &RefCell<Store>, title: &str, today_on: Option<&str>) -> Task {
    let task = NewTask {
        title: title.into(),
        today_on: today_on.map(Into::into),
        ..NewTask::default()
    };
    s.borrow_mut()
        .execute(Command::CreateTask { task })
        .unwrap()
        .tasks
        .remove(0)
}

fn schedule(s: &RefCell<Store>, task_id: &str, start_at: i64, end_at: i64) -> TimeBlock {
    let block = NewTimeBlock {
        id: None,
        task_id: task_id.into(),
        start_at,
        end_at,
        outcome: None,
    };
    s.borrow_mut()
        .execute(Command::CreateTimeBlock { block })
        .unwrap()
        .time_blocks
        .remove(0)
}

fn block_of(s: &RefCell<Store>, id: &str) -> Option<TimeBlock> {
    s.borrow()
        .snapshot()
        .unwrap()
        .time_blocks
        .into_iter()
        .find(|b| b.id == id)
}

fn stamp(ms: i64) -> String {
    calendar::format_utc(ms).replace(['-', ':'], "")
}

/// The event as another client would save it after moving it.
fn moved(data: &str, start_at: i64, end_at: i64) -> String {
    data.split("\r\n")
        .map(|line| {
            if line.starts_with("DTSTART:") {
                format!("DTSTART:{}", stamp(start_at))
            } else if line.starts_with("DTEND:") {
                format!("DTEND:{}", stamp(end_at))
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\r\n")
}

#[test]
fn discovers_the_home_through_well_known_and_lists_event_calendars() {
    let mut cal = provider(FakeDav::new());
    let home = cal.discover().unwrap();
    assert_eq!(home, format!("{BASE}/calendars/alice/"));
    let calendars = cal.calendars().unwrap();
    let names: Vec<(&str, bool, bool)> = calendars
        .iter()
        .map(|c| (c.name.as_str(), c.owned, c.primary))
        .collect();
    // The reminders list (VTODO only) is left out; the shared one is read-only.
    assert_eq!(names, [("Home", true, true), ("Family", false, false)]);
    assert_eq!(calendars[0].color.as_deref(), Some("#ff2968"));
    assert_eq!(calendars[0].id, FakeDav::url("home"));
    let requests = &cal.transport_mut().requests;
    assert!(
        requests
            .iter()
            .any(|(_, u)| u.ends_with("/.well-known/caldav"))
    );
}

#[test]
fn a_moved_calendar_home_is_found_again() {
    let stale = format!("{BASE}/calendars/old-partition/");
    let mut cal =
        CaldavCalendar::with_transport(FakeDav::new(), account(PASSWORD), Some(&stale)).unwrap();
    assert_eq!(cal.calendars().unwrap().len(), 2);
    assert_eq!(
        cal.home_url(),
        Some(format!("{BASE}/calendars/alice/").as_str())
    );
}

#[test]
fn a_wrong_password_asks_to_sign_in_again() {
    let mut cal = CaldavCalendar::with_transport(FakeDav::new(), account("nope"), None).unwrap();
    assert!(matches!(cal.discover(), Err(ProviderError::Auth(_))));
}

#[test]
fn blocks_and_plans_round_trip_through_the_engine() {
    let s = RefCell::new(Store::open_in_memory().unwrap());
    let mut cal = provider(FakeDav::new());
    let task = add_task(&s, "Write report", Some(TODAY));
    let block = schedule(&s, &task.id, NOW, NOW + HOUR);

    // First sync: the app's calendar is made and both items pushed.
    let report = sync(&s, &mut cal, NOW, TODAY).unwrap();
    assert_eq!(report.created, 2);
    let slug = cal
        .transport_mut()
        .slug_named(TARGET_CALENDAR)
        .expect("created");
    let block_key = format!("block:{}", block.id);
    let (file, data) = cal.transport_mut().by_key(&slug, &block_key).unwrap();
    assert!(data.contains(&format!("DTSTART:{}\r\n", stamp(NOW))));
    assert!(data.contains("SUMMARY:Write report\r\n"));
    let (_, plan) = cal
        .transport_mut()
        .by_key(&slug, &format!("plan:{}", task.id))
        .unwrap();
    assert!(plan.contains("DTSTART;VALUE=DATE:20261105\r\n"));

    // Nothing changed: nothing written.
    let again = sync(&s, &mut cal, NOW, TODAY).unwrap();
    assert_eq!(
        (again.created, again.updated, again.deleted, again.pulled),
        (0, 0, 0, 0)
    );

    // Moved on the phone: the block follows.
    let edited = moved(&data, NOW + 2 * HOUR, NOW + 3 * HOUR);
    cal.transport_mut().user_put(&slug, &file, &edited);
    let report = sync(&s, &mut cal, NOW, TODAY).unwrap();
    assert_eq!(report.pulled, 1);
    let b = block_of(&s, &block.id).unwrap();
    assert_eq!((b.start_at, b.end_at), (NOW + 2 * HOUR, NOW + 3 * HOUR));

    // Changed here: updated in place, under its ETag.
    s.borrow_mut()
        .execute(Command::UpdateTask {
            id: task.id.clone(),
            changes: vec![TaskChange::Title("Write the report".into())],
        })
        .unwrap();
    let report = sync(&s, &mut cal, NOW, TODAY).unwrap();
    assert_eq!(report.updated, 2);
    let (same_file, data) = cal.transport_mut().by_key(&slug, &block_key).unwrap();
    assert_eq!(same_file, file);
    assert!(data.contains("SUMMARY:Write the report\r\n"));

    // Deleted on the phone: the block goes too.
    cal.transport_mut().user_delete(&slug, &file);
    let report = sync(&s, &mut cal, NOW, TODAY).unwrap();
    assert_eq!(report.pulled, 1);
    assert!(block_of(&s, &block.id).is_none(), "deleted");
}

#[test]
fn an_expired_sync_token_lists_everything_again_without_duplicates() {
    let s = RefCell::new(Store::open_in_memory().unwrap());
    let mut cal = provider(FakeDav::new());
    let task = add_task(&s, "Review", None);
    let block = schedule(&s, &task.id, NOW, NOW + HOUR);
    sync(&s, &mut cal, NOW, TODAY).unwrap();
    let slug = cal.transport_mut().slug_named(TARGET_CALENDAR).unwrap();
    let count = cal.transport_mut().cals[&slug].items.len();

    let dav = cal.transport_mut();
    dav.expired_before = dav.seq + 1;
    let report = sync(&s, &mut cal, NOW, TODAY).unwrap();
    assert_eq!(report.created, 0);
    assert_eq!(cal.transport_mut().cals[&slug].items.len(), count);
    assert!(
        linked_event(&s.borrow(), &format!("block:{}", block.id))
            .unwrap()
            .is_some()
    );
}

#[test]
fn servers_without_sync_tokens_are_followed_by_etags() {
    let s = RefCell::new(Store::open_in_memory().unwrap());
    let mut dav = FakeDav::new();
    dav.cals.insert(
        "tm".into(),
        fake_dav::Cal {
            name: TARGET_CALENDAR.into(),
            sync: false,
            ..fake_dav::Cal::default()
        },
    );
    dav.no_etag_header = true;
    let mut cal = provider(dav);
    let task = add_task(&s, "Plan sprint", None);
    let block = schedule(&s, &task.id, NOW, NOW + HOUR);
    sync(&s, &mut cal, NOW, TODAY).unwrap();
    let key = format!("block:{}", block.id);
    let (file, data) = cal.transport_mut().by_key("tm", &key).unwrap();

    let edited = moved(&data, NOW + HOUR, NOW + 2 * HOUR);
    cal.transport_mut().user_put("tm", &file, &edited);
    let report = sync(&s, &mut cal, NOW, TODAY).unwrap();
    assert_eq!(report.pulled, 1);
    let b = block_of(&s, &block.id).unwrap();
    assert_eq!((b.start_at, b.end_at), (NOW + HOUR, NOW + 2 * HOUR));

    cal.transport_mut().user_delete("tm", &file);
    let report = sync(&s, &mut cal, NOW, TODAY).unwrap();
    assert_eq!(report.pulled, 1);
    assert!(block_of(&s, &block.id).is_none(), "deleted");
}

#[test]
fn a_concurrent_edit_is_overwritten_once_with_the_new_etag() {
    let s = RefCell::new(Store::open_in_memory().unwrap());
    let mut cal = provider(FakeDav::new());
    let task = add_task(&s, "Draft", None);
    let block = schedule(&s, &task.id, NOW, NOW + HOUR);
    sync(&s, &mut cal, NOW, TODAY).unwrap();
    s.borrow_mut()
        .execute(Command::UpdateTimeBlock {
            id: block.id.clone(),
            changes: vec![TimeBlockChange::EndAt(NOW + 2 * HOUR)],
        })
        .unwrap();
    cal.transport_mut().race_next_put = true;
    let report = sync(&s, &mut cal, NOW, TODAY).unwrap();
    assert_eq!(report.updated, 1);
    let slug = cal.transport_mut().slug_named(TARGET_CALENDAR).unwrap();
    let (_, data) = cal
        .transport_mut()
        .by_key(&slug, &format!("block:{}", block.id))
        .unwrap();
    assert!(data.contains(&format!("DTEND:{}\r\n", stamp(NOW + 2 * HOUR))));
}

#[test]
fn shown_calendars_are_read_with_recurrences_expanded() {
    let s = RefCell::new(Store::open_in_memory().unwrap());
    let mut dav = FakeDav::new();
    dav.user_put(
        "home",
        "standup.ics",
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:standup\r\n\
         DTSTART;TZID=Europe/Paris:20261102T093000\r\nDTEND;TZID=Europe/Paris:20261102T094500\r\n\
         RRULE:FREQ=DAILY;COUNT=5\r\nEXDATE;TZID=Europe/Paris:20261104T093000\r\n\
         SUMMARY:Standup\r\nLOCATION:Room 2\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    );
    let mut cal = provider(dav);
    sync(&s, &mut cal, NOW, TODAY).unwrap();
    // The first writable calendar is shown by default.
    let sources = s.borrow().calendar_sources().unwrap();
    let home = sources.iter().find(|c| c.name == "Home").unwrap();
    assert!(home.shown && home.primary && !home.target);
    let events = s
        .borrow()
        .calendar_events(&EventRange {
            from: NOW - 7 * 24 * HOUR,
            to: NOW + 7 * 24 * HOUR,
            from_date: "2026-10-29".into(),
            to_date: "2026-11-12".into(),
        })
        .unwrap();
    let starts: Vec<i64> = events.iter().filter_map(|e| e.start_at).collect();
    // 2–6 November at 08:30 UTC, without the 4th.
    let first = NOW - 3 * 24 * HOUR - 30 * 60_000;
    assert_eq!(
        starts,
        [
            first,
            first + 24 * HOUR,
            first + 3 * 24 * HOUR,
            first + 4 * 24 * HOUR
        ]
    );
    assert_eq!(events[0].location.as_deref(), Some("Room 2"));
    let ids: std::collections::HashSet<&str> = events.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids.len(), 4, "each occurrence has its own id");

    // A read-only calendar is shown too when asked, and never written.
    let shared = FakeDav::url("shared");
    s.borrow().set_calendar_shown(&shared, true).unwrap();
    let writes_before = cal
        .transport_mut()
        .requests
        .iter()
        .filter(|(m, u)| m == "PUT" && u.starts_with(&shared))
        .count();
    sync(&s, &mut cal, NOW, TODAY).unwrap();
    assert_eq!(
        cal.transport_mut()
            .requests
            .iter()
            .filter(|(m, u)| m == "PUT" && u.starts_with(&shared))
            .count(),
        writes_before
    );
}
