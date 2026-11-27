//! Calendar events in the phone's day plan (ADR 014, ADR 040): fetched from the server
//! when it runs the calendar sync, kept for offline use, and gone when a desktop takes the
//! calendar sync back.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use taskmaster_client::Client;
use taskmaster_core::calendar::{CalendarRunner, GoogleCredentials, RunnerRequest, When};
use taskmaster_core::{Store, now_ms, utc_date};
use taskmaster_mobile::{CalendarAvailability, Core, Day, JoinMode};
use taskmaster_server::auth::Tokens;
use taskmaster_server::config::Config;
use taskmaster_server::{AppState, router};

// Shared with the core's and the server's tests; this one uses part of it.
#[allow(dead_code)]
#[path = "../../core/tests/support/calendar.rs"]
mod calendar_fake;

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tm-mobile-calendar-{label}-{}",
        taskmaster_core::new_id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn serve(app: axum::Router) -> String {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap()).unwrap();
            axum::serve(listener, app).await.unwrap();
        });
    });
    format!("http://{}", rx.recv().unwrap())
}

fn open(dir: &Path) -> Arc<Core> {
    Core::open(dir.to_string_lossy().into_owned(), "Phone".into()).unwrap()
}

/// Today in UTC, as a phone in UTC sees it.
fn day(now: i64) -> Day {
    Day {
        today: utc_date(now),
        utc_offset_min: 0,
    }
}

fn titles(app: &Core, now: i64) -> Vec<String> {
    let today = day(now);
    app.day_events(today.today.clone(), today)
        .unwrap()
        .into_iter()
        .map(|e| e.title)
        .collect()
}

#[test]
fn the_day_plan_shows_the_servers_calendar_events_offline_too() {
    let dir = temp_dir("server");
    let state = AppState::new(
        Config {
            data_dir: dir.clone(),
            ..Config::default()
        },
        Store::open(dir.join("tasks.sqlite")).unwrap(),
        Tokens::open_in_memory().unwrap(),
    );
    let url = serve(router(state.clone()));
    let client = Client::new(&url, None);
    let now = now_ms();
    // Midnight UTC today, so the events below fall on today whatever the hour.
    let midnight = now - now.rem_euclid(86_400_000);

    // A desktop hands the calendar sync to the server, which syncs a Google account
    // with a shown calendar holding a meeting and an all-day trip.
    let desktop = Mutex::new(
        Store::open_in_memory()
            .unwrap()
            .with_files(temp_dir("desktop-files")),
    );
    taskmaster_client::sync(&client, &desktop).unwrap();
    let device_id = desktop.lock().unwrap().device_id().to_owned();
    assert!(client.calendar_lease(&device_id, false).unwrap());
    client
        .calendar_runner(&RunnerRequest {
            runner: CalendarRunner::Server,
            device_id: device_id.clone(),
            credentials: Some(GoogleCredentials {
                client_id: "client".into(),
                client_secret: "secret".into(),
                refresh_token: "refresh".into(),
            }),
            caldav: None,
        })
        .unwrap();
    let mut google = calendar_fake::FakeServer::with_primary();
    taskmaster_server::calendar::cycle_with(&state, &mut google).unwrap();
    google.user_add(
        "me@example.com",
        "Standup",
        When::Timed {
            start_at: midnight + 9 * 3_600_000,
            end_at: midnight + 9 * 3_600_000 + 900_000,
        },
    );
    google.user_add(
        "me@example.com",
        "Offsite",
        When::AllDay {
            start: utc_date(midnight),
            end: utc_date(midnight + 2 * 86_400_000),
        },
    );
    google.user_add(
        "me@example.com",
        "Next week",
        When::Timed {
            start_at: midnight + 7 * 86_400_000,
            end_at: midnight + 7 * 86_400_000 + 3_600_000,
        },
    );
    client.calendar_shown("me@example.com", true).unwrap();
    taskmaster_server::calendar::cycle_with(&state, &mut google).unwrap();

    // Before joining, the phone knows nothing of the calendar.
    let phone_dir = temp_dir("phone");
    let app = open(&phone_dir);
    assert_eq!(
        app.refresh_calendar().availability,
        CalendarAvailability::Unknown
    );
    assert!(titles(&app, now).is_empty());

    // A sync round fetches the coming days.
    app.sync_connect(url.clone()).unwrap();
    app.sync_join(JoinMode::Merge).unwrap();
    assert_eq!(app.sync_now().last_error, None);
    let info = app.calendar_info();
    assert_eq!(info.availability, CalendarAvailability::Available);
    assert!(info.fetched_at.is_some() && info.last_error.is_none());
    // All-day first, then by start; next week's meeting is on its own day.
    assert_eq!(titles(&app, now), ["Offsite", "Standup"]);
    let standup = app
        .day_events(utc_date(now), day(now))
        .unwrap()
        .into_iter()
        .find(|e| e.title == "Standup")
        .unwrap();
    assert_eq!(standup.start_at, Some(midnight + 9 * 3_600_000));
    assert!(!standup.calendar_name.is_empty());
    let next_week = midnight + 7 * 86_400_000;
    assert_eq!(
        app.day_events(utc_date(next_week), day(next_week))
            .unwrap()
            .into_iter()
            .map(|e| e.title)
            .collect::<Vec<_>>(),
        ["Next week"]
    );
    assert!(app.day_events("tomorrow".into(), day(now)).is_err());

    // Offline after a restart, the copy is still there.
    drop(app);
    let app = open(&phone_dir);
    assert_eq!(titles(&app, now), ["Offsite", "Standup"]);

    // A desktop takes the calendar sync back: its events stay there.
    client
        .calendar_runner(&RunnerRequest {
            runner: CalendarRunner::ThisDevice,
            device_id,
            credentials: None,
            caldav: None,
        })
        .unwrap();
    assert_eq!(
        app.refresh_calendar().availability,
        CalendarAvailability::OnDesktop
    );
    assert!(titles(&app, now).is_empty());

    // Leaving the server forgets the calendar.
    app.sync_disconnect().unwrap();
    assert_eq!(
        app.calendar_info().availability,
        CalendarAvailability::Unknown
    );
    assert!(!phone_dir.join("calendar.json").exists());
}
