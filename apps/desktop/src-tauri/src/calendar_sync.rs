//! Calendar sync in the desktop shell (M10, ADR 014): the Google account in settings, a
//! background thread running `taskmaster_core::calendar::sync`, and the commands and event
//! the UI uses.
//!
//! A sync runs every 5 minutes, a few seconds after tasks or time blocks change (several
//! quick edits make one sync), and on "Sync now".

use std::sync::Mutex;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use taskmaster_core::calendar::{CalendarEvent, CalendarSource, EventRange, SyncReport};
use taskmaster_core::{EntityKind, now_ms, utc_date};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tauri_specta::Event;

use crate::config::GoogleAccount;
use crate::google::{self, GoogleCalendar};
use crate::{AppState, CommandResult, internal, invalid, with_store};

const CYCLE: Duration = Duration::from_secs(5 * 60);
/// Edits within this pause make one sync.
const SETTLE: Duration = Duration::from_secs(4);
/// The first sync after start, once the window is up.
const FIRST: Duration = Duration::from_secs(10);

/// What settings and the calendar page show.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct CalendarStatus {
    /// An OAuth client is saved.
    pub configured: bool,
    pub client_id: String,
    /// Signed in (a refresh token is saved).
    pub connected: bool,
    pub syncing: bool,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub last_report: Option<SyncReport>,
    pub sources: Vec<CalendarSource>,
}

/// Sent when a sync starts and ends, so views re-read events and status.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct CalendarSynced(pub CalendarStatus);

#[derive(Default)]
struct Run {
    syncing: bool,
    last_sync_at: Option<i64>,
    last_error: Option<String>,
    last_report: Option<SyncReport>,
}

/// Sync state kept in `AppState`.
pub struct CalendarRuntime {
    run: Mutex<Run>,
    kick: Sender<()>,
}

impl CalendarRuntime {
    pub fn new() -> (Self, Receiver<()>) {
        let (kick, kicks) = std::sync::mpsc::channel();
        (
            Self {
                run: Mutex::new(Run::default()),
                kick,
            },
            kicks,
        )
    }

    /// Asks for a sync soon.
    pub fn kick(&self) {
        let _ = self.kick.send(());
    }

    /// Whether a committed batch touched what is pushed (tasks, time blocks).
    pub fn wants(entities: &[taskmaster_core::EntityRef]) -> bool {
        entities
            .iter()
            .any(|e| matches!(e.kind, EntityKind::Task | EntityKind::TimeBlock))
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub fn status(state: &AppState) -> CommandResult<CalendarStatus> {
    let account = lock(&state.config).google.clone();
    let sources = lock(&state.store)
        .calendar_sources()
        .map_err(crate::CommandError::from)?;
    let run = lock(&state.calendar.run);
    Ok(CalendarStatus {
        configured: account.is_some(),
        client_id: account
            .as_ref()
            .map(|a| a.client_id.clone())
            .unwrap_or_default(),
        connected: account.as_ref().is_some_and(|a| a.refresh_token.is_some()),
        syncing: run.syncing,
        last_sync_at: run.last_sync_at,
        last_error: run.last_error.clone(),
        last_report: run.last_report.clone(),
        sources,
    })
}

fn announce(app: &AppHandle) {
    if let Ok(status) = status(&app.state::<AppState>()) {
        let _ = CalendarSynced(status).emit(app);
    }
}

/// The background loop: waits for a kick or the cycle, then syncs if signed in.
pub fn run(app: AppHandle, kicks: Receiver<()>) {
    let mut client: Option<(GoogleAccount, GoogleCalendar)> = None;
    let mut wait = FIRST;
    loop {
        match kicks.recv_timeout(wait) {
            Ok(()) => while kicks.recv_timeout(SETTLE).is_ok() {},
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        wait = CYCLE;
        let state = app.state::<AppState>();
        let account = lock(&state.config).google.clone();
        let Some(account) = account.filter(|a| a.refresh_token.is_some()) else {
            client = None;
            continue;
        };
        // Reuse the client (and its access token) while the account is unchanged.
        if client.as_ref().is_none_or(|(a, _)| *a != account) {
            let refresh = account.refresh_token.clone().unwrap_or_default();
            let google = GoogleCalendar::new(&account.client_id, &account.client_secret, &refresh);
            client = Some((account, google));
        }
        let Some((_, google)) = client.as_mut() else {
            continue;
        };

        lock(&state.calendar.run).syncing = true;
        announce(&app);
        let now = now_ms();
        let result = taskmaster_core::calendar::sync(&state.store, google, now, &utc_date(now));
        let pulled = result.as_ref().is_ok_and(|r| r.pulled > 0);
        {
            let mut run = lock(&state.calendar.run);
            run.syncing = false;
            match result {
                Ok(report) => {
                    run.last_sync_at = Some(now);
                    run.last_report = Some(report);
                    run.last_error = None;
                }
                Err(err) => {
                    eprintln!("calendar sync failed: {err}");
                    run.last_error = Some(err.to_string());
                }
            }
        }
        // Edits pulled from the calendar committed a batch, which kicked us again: skip it.
        if pulled {
            while kicks.try_recv().is_ok() {}
        }
        announce(&app);
    }
}

/// The calendar connection and the account's calendars.
#[tauri::command]
#[specta::specta]
pub fn calendar_status(state: State<'_, AppState>) -> CommandResult<CalendarStatus> {
    status(&state)
}

/// Signs in to Google in the browser with the user's OAuth client, then syncs. An empty
/// secret keeps the stored one. Waits for the sign-in (up to 5 minutes).
#[tauri::command(async)]
#[specta::specta]
pub fn google_connect(
    app: AppHandle,
    client_id: String,
    client_secret: String,
) -> CommandResult<CalendarStatus> {
    let state = app.state::<AppState>();
    let client_id = client_id.trim().to_owned();
    if client_id.is_empty() {
        return Err(invalid("paste the client ID of your Google OAuth client"));
    }
    let client_secret = match client_secret.trim() {
        "" => lock(&state.config)
            .google
            .as_ref()
            .filter(|a| a.client_id == client_id)
            .map(|a| a.client_secret.clone())
            .ok_or_else(|| invalid("paste the client secret of your Google OAuth client"))?,
        secret => secret.to_owned(),
    };
    let opener = app.clone();
    let refresh = google::sign_in(&client_id, &client_secret, |url| {
        opener
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| format!("cannot open the browser: {e}"))
    })
    .map_err(internal)?;
    {
        let mut config = lock(&state.config);
        config.google = Some(GoogleAccount {
            client_id,
            client_secret,
            refresh_token: Some(refresh),
        });
        config
            .save(&state.config_path)
            .map_err(|e| internal(format!("cannot save settings: {e}")))?;
    }
    // Start fresh: events are matched to tasks again by their stored keys.
    with_store(&state, |s| s.clear_calendar_sync())?;
    *lock(&state.calendar.run) = Run::default();
    state.calendar.kick();
    status(&state)
}

/// Signs out: forgets the token and the synced calendars (the events stay in Google). The
/// OAuth client is kept for reconnecting.
#[tauri::command(async)]
#[specta::specta]
pub fn google_disconnect(app: AppHandle) -> CommandResult<CalendarStatus> {
    let state = app.state::<AppState>();
    let token = {
        let mut config = lock(&state.config);
        let token = config.google.as_mut().and_then(|a| a.refresh_token.take());
        config
            .save(&state.config_path)
            .map_err(|e| internal(format!("cannot save settings: {e}")))?;
        token
    };
    if let Some(token) = token {
        google::revoke(&token);
    }
    with_store(&state, |s| s.clear_calendar_sync())?;
    *lock(&state.calendar.run) = Run::default();
    status(&state)
}

/// Shows or hides one of the account's calendars, then syncs.
#[tauri::command]
#[specta::specta]
pub fn set_calendar_shown(
    state: State<'_, AppState>,
    calendar_id: String,
    shown: bool,
) -> CommandResult<CalendarStatus> {
    with_store(&state, |s| s.set_calendar_shown(&calendar_id, shown))?;
    if shown {
        state.calendar.kick();
    }
    status(&state)
}

#[tauri::command]
#[specta::specta]
pub fn calendar_sync_now(state: State<'_, AppState>) -> CommandResult<CalendarStatus> {
    state.calendar.kick();
    status(&state)
}

/// Events of the shown calendars in a range (read-only).
#[tauri::command]
#[specta::specta]
pub fn calendar_events(
    state: State<'_, AppState>,
    range: EventRange,
) -> CommandResult<Vec<CalendarEvent>> {
    with_store(&state, |s| s.calendar_events(&range))
}
