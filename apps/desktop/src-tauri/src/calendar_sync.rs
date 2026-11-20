//! Calendar sync in the desktop shell (M10, ADR 014): the Google account in settings, or
//! classic Outlook on this PC (ADR 030), a background thread running
//! `taskmaster_core::calendar::sync`, and the commands and event the UI uses.
//!
//! A sync runs every 5 minutes, a few seconds after tasks, time blocks or meetings change
//! (several quick edits make one sync), and on "Sync now".

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use taskmaster_client::Client;
use taskmaster_core::calendar::{
    CalendarEvent, CalendarProvider, CalendarRunner, CalendarSource, EventRange, GoogleCredentials,
    ProviderError, RunnerRequest, RunnerStatus, SyncReport,
};
use taskmaster_core::{EntityKind, now_ms, utc_date};
use taskmaster_outlook::OutlookCalendar;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tauri_specta::Event;

use crate::config::{GoogleAccount, OutlookAccount};
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
    pub runner: CalendarRunner,
    pub can_set_runner: bool,
    pub client_id: String,
    /// Signed in (a refresh token is saved).
    pub connected: bool,
    pub syncing: bool,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub last_report: Option<SyncReport>,
    pub sources: Vec<CalendarSource>,
    /// Classic Outlook can be connected on this device (Windows).
    pub outlook_available: bool,
    /// The connected Outlook mailbox (ADR 030); Google is then not connected.
    pub outlook: Option<String>,
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
    pub(crate) gate: Mutex<()>,
    kick: Sender<()>,
    /// The next sync may start Outlook (connecting, "Sync now"); others wait for it.
    start_outlook: AtomicBool,
}

impl CalendarRuntime {
    pub fn new() -> (Self, Receiver<()>) {
        let (kick, kicks) = std::sync::mpsc::channel();
        (
            Self {
                run: Mutex::new(Run::default()),
                gate: Mutex::new(()),
                kick,
                start_outlook: AtomicBool::new(false),
            },
            kicks,
        )
    }

    /// Asks for a sync soon.
    pub fn kick(&self) {
        let _ = self.kick.send(());
    }

    /// Whether a committed batch touched what is pushed (tasks, time blocks, meetings).
    pub fn wants(entities: &[taskmaster_core::EntityRef]) -> bool {
        entities.iter().any(|e| {
            matches!(
                e.kind,
                EntityKind::Task | EntityKind::TimeBlock | EntityKind::Meeting
            )
        })
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub fn status(state: &AppState) -> CommandResult<CalendarStatus> {
    let (account, outlook) = {
        let config = lock(&state.config);
        (config.google.clone(), config.outlook.clone())
    };
    let sources = lock(&state.store)
        .calendar_sources()
        .map_err(crate::CommandError::from)?;
    let run = lock(&state.calendar.run);
    Ok(CalendarStatus {
        configured: account.is_some() || outlook.is_some(),
        runner: account
            .as_ref()
            .filter(|_| outlook.is_none())
            .map(|a| a.runner)
            .unwrap_or_default(),
        can_set_runner: server_client(state).is_some() && outlook.is_none(),
        client_id: account
            .as_ref()
            .map(|a| a.client_id.clone())
            .unwrap_or_default(),
        connected: outlook.is_some() || account.as_ref().is_some_and(|a| a.refresh_token.is_some()),
        syncing: run.syncing,
        last_sync_at: run.last_sync_at,
        last_error: run.last_error.clone(),
        last_report: run.last_report.clone(),
        sources,
        outlook_available: taskmaster_outlook::available(),
        outlook: outlook.map(|o| o.mailbox),
    })
}

fn announce(app: &AppHandle) {
    if let Ok(status) = remote_status(&app.state::<AppState>()) {
        let _ = CalendarSynced(status).emit(app);
    }
}

/// The background loop: waits for a kick or the cycle, then syncs if signed in.
pub fn run(app: AppHandle, kicks: Receiver<()>) {
    let mut client: Option<(GoogleAccount, GoogleCalendar)> = None;
    // Made on this thread and kept on it: COM objects stay where they were made.
    let mut outlook: Option<OutlookCalendar> = None;
    let mut wait = FIRST;
    loop {
        match kicks.recv_timeout(wait) {
            Ok(()) => while kicks.recv_timeout(SETTLE).is_ok() {},
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        wait = CYCLE;
        let state = app.state::<AppState>();
        let _gate = lock(&state.calendar.gate);
        if lock(&state.config).outlook.is_some() {
            client = None;
            let provider = outlook.get_or_insert_with(OutlookCalendar::new);
            provider.set_may_start(state.calendar.start_outlook.swap(false, Ordering::SeqCst));
            sync_outlook(&app, provider, &kicks);
            continue;
        }
        outlook = None;
        let account = lock(&state.config).google.clone();
        if account
            .as_ref()
            .is_some_and(|a| a.runner == CalendarRunner::Server)
            || (account.as_ref().is_none_or(|a| a.refresh_token.is_none())
                && server_client(&state).is_some())
        {
            announce(&app);
            continue;
        }
        let Some(account) =
            account.filter(|a| a.refresh_token.is_some() && a.runner == CalendarRunner::ThisDevice)
        else {
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

        let server = server_client(&state);
        let device_id = lock(&state.store).device_id().to_owned();
        if let Some(server) = server.clone() {
            let device = device_id.clone();
            google.set_guard(move || match server.calendar_lease(&device, false) {
                Ok(true) => Ok(()),
                Ok(false) => Err(ProviderError::Other(
                    "Calendar runs on the server or another device".into(),
                )),
                Err(e) => Err(ProviderError::Other(format!(
                    "cannot acquire Calendar lease: {e}"
                ))),
            });
        } else {
            // A client reused after disconnect must not retain its old lease guard.
            google.set_guard(|| Ok(()));
        }
        sync_once(&app, google, &kicks);
        if let Some(server) = server {
            let _ = server.calendar_lease(&device_id, true);
        }
    }
}

/// One sync with classic Outlook, under the server's Calendar lease when a server is
/// joined (one runner at a time, ADR 015).
fn sync_outlook(app: &AppHandle, provider: &mut OutlookCalendar, kicks: &Receiver<()>) {
    let state = app.state::<AppState>();
    let server = server_client(&state);
    let device_id = lock(&state.store).device_id().to_owned();
    if let Some(server) = &server {
        let refused = match server.calendar_lease(&device_id, false) {
            Ok(true) => None,
            Ok(false) => Some("Calendar runs on the server or another device".to_owned()),
            Err(e) => Some(format!("cannot acquire Calendar lease: {e}")),
        };
        if let Some(error) = refused {
            lock(&state.calendar.run).last_error = Some(error);
            announce(app);
            return;
        }
    }
    sync_once(app, provider, kicks);
    if let Some(server) = server {
        let _ = server.calendar_lease(&device_id, true);
    }
}

/// Runs the engine once and reports it to the UI.
fn sync_once<P: CalendarProvider>(app: &AppHandle, provider: &mut P, kicks: &Receiver<()>) {
    let state = app.state::<AppState>();
    lock(&state.calendar.run).syncing = true;
    announce(app);
    let now = now_ms();
    let result = taskmaster_core::calendar::sync(&state.store, provider, now, &utc_date(now));
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
    announce(app);
}

/// The calendar connection and the account's calendars.
#[tauri::command(async)]
#[specta::specta]
pub fn calendar_status(app: AppHandle) -> CommandResult<CalendarStatus> {
    let state = app.state::<AppState>();
    remote_status(&state)
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
    let _gate = lock(&state.calendar.gate);
    if remote_status(&state)?.runner == CalendarRunner::Server {
        return Err(invalid("move Calendar to this device before reconnecting"));
    }
    if lock(&state.config).outlook.is_some() {
        return Err(invalid(
            "disconnect Outlook first: one calendar account at a time",
        ));
    }
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
    .map_err(|e| internal(e.to_string()))?;
    {
        let mut config = lock(&state.config);
        config.google = Some(GoogleAccount {
            client_id,
            client_secret,
            refresh_token: Some(refresh),
            runner: CalendarRunner::ThisDevice,
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
    let _gate = lock(&state.calendar.gate);
    if remote_status(&state)?.runner == CalendarRunner::Server {
        return Err(invalid("move Calendar to this device before disconnecting"));
    }
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

/// Connects classic Outlook on this PC (ADR 030): reaches it (starting it if needed),
/// then syncs with its main calendar. Google must be disconnected first.
#[tauri::command(async)]
#[specta::specta]
pub fn outlook_connect(app: AppHandle) -> CommandResult<CalendarStatus> {
    let state = app.state::<AppState>();
    let _gate = lock(&state.calendar.gate);
    if !taskmaster_outlook::available() {
        return Err(invalid(taskmaster_outlook::UNAVAILABLE));
    }
    if remote_status(&state)?.runner == CalendarRunner::Server {
        return Err(invalid(
            "move Calendar to this device before connecting Outlook",
        ));
    }
    if lock(&state.config)
        .google
        .as_ref()
        .is_some_and(|a| a.refresh_token.is_some())
    {
        return Err(invalid(
            "disconnect Google first: one calendar account at a time",
        ));
    }
    let mailbox = taskmaster_outlook::check().map_err(internal)?;
    {
        let mut config = lock(&state.config);
        config.outlook = Some(OutlookAccount { mailbox });
        config
            .save(&state.config_path)
            .map_err(|e| internal(format!("cannot save settings: {e}")))?;
    }
    // Start fresh: events already pushed are matched again by their stored keys.
    with_store(&state, |s| s.clear_calendar_sync())?;
    *lock(&state.calendar.run) = Run::default();
    state.calendar.start_outlook.store(true, Ordering::SeqCst);
    state.calendar.kick();
    status(&state)
}

/// Stops syncing with Outlook and forgets the synced calendars. The events stay in
/// Outlook.
#[tauri::command(async)]
#[specta::specta]
pub fn outlook_disconnect(app: AppHandle) -> CommandResult<CalendarStatus> {
    let state = app.state::<AppState>();
    let _gate = lock(&state.calendar.gate);
    {
        let mut config = lock(&state.config);
        config.outlook = None;
        config
            .save(&state.config_path)
            .map_err(|e| internal(format!("cannot save settings: {e}")))?;
    }
    with_store(&state, |s| s.clear_calendar_sync())?;
    *lock(&state.calendar.run) = Run::default();
    status(&state)
}

/// Opens an event of the Outlook calendar in Outlook.
#[tauri::command(async)]
#[specta::specta]
pub fn outlook_open_event(event_id: String) -> CommandResult<()> {
    taskmaster_outlook::open_event(event_id).map_err(internal)
}

/// Shows or hides one of the account's calendars, then syncs.
#[tauri::command(async)]
#[specta::specta]
pub fn set_calendar_shown(
    state: State<'_, AppState>,
    calendar_id: String,
    shown: bool,
) -> CommandResult<CalendarStatus> {
    if let Some(server) = server_client(&state)
        && server
            .calendar_status()
            .map_err(|e| internal(e.to_string()))?
            .runner
            == CalendarRunner::Server
    {
        return Ok(from_remote(
            &state,
            server
                .calendar_shown(&calendar_id, shown)
                .map_err(|e| internal(e.to_string()))?,
        ));
    }
    with_store(&state, |s| s.set_calendar_shown(&calendar_id, shown))?;
    if shown {
        state.calendar.kick();
    }
    status(&state)
}

#[tauri::command(async)]
#[specta::specta]
pub fn calendar_sync_now(state: State<'_, AppState>) -> CommandResult<CalendarStatus> {
    if let Some(server) = server_client(&state)
        && server
            .calendar_status()
            .map_err(|e| internal(e.to_string()))?
            .runner
            == CalendarRunner::Server
    {
        return Ok(from_remote(
            &state,
            server
                .calendar_sync()
                .map_err(|e| internal(e.to_string()))?,
        ));
    }
    state.calendar.start_outlook.store(true, Ordering::SeqCst);
    state.calendar.kick();
    status(&state)
}

/// Events of the shown calendars in a range (read-only).
#[tauri::command(async)]
#[specta::specta]
pub fn calendar_events(
    state: State<'_, AppState>,
    range: EventRange,
) -> CommandResult<Vec<CalendarEvent>> {
    if let Some(server) = server_client(&state)
        && server
            .calendar_status()
            .map_err(|e| internal(e.to_string()))?
            .runner
            == CalendarRunner::Server
    {
        return server
            .calendar_events(&range)
            .map_err(|e| internal(e.to_string()));
    }
    with_store(&state, |s| s.calendar_events(&range))
}

fn server_client(state: &AppState) -> Option<Client> {
    lock(&state.config)
        .sync
        .as_ref()
        .filter(|a| a.joined)
        .map(|a| Client::new(&a.url, a.token.clone()))
}
fn from_remote(state: &AppState, remote: RunnerStatus) -> CalendarStatus {
    CalendarStatus {
        configured: remote.connected,
        client_id: lock(&state.config)
            .google
            .as_ref()
            .map(|a| a.client_id.clone())
            .unwrap_or_default(),
        runner: remote.runner,
        can_set_runner: true,
        connected: remote.connected,
        syncing: remote.syncing,
        last_sync_at: remote.last_sync_at,
        last_error: remote.last_error,
        last_report: remote.last_report,
        sources: remote.sources,
        outlook_available: taskmaster_outlook::available(),
        outlook: None,
    }
}
fn remote_status(state: &AppState) -> CommandResult<CalendarStatus> {
    if let Some(server) = server_client(state) {
        let remote = server
            .calendar_status()
            .map_err(|e| internal(e.to_string()))?;
        if remote.runner == CalendarRunner::Server {
            return Ok(from_remote(state, remote));
        }
    }
    status(state)
}

/// Moves runner ownership while both workers are stopped. Credentials never enter ops.
#[tauri::command(async)]
#[specta::specta]
pub fn set_calendar_runner(
    app: AppHandle,
    runner: CalendarRunner,
) -> CommandResult<CalendarStatus> {
    let state = app.state::<AppState>();
    let _gate = lock(&state.calendar.gate);
    let server = server_client(&state).ok_or_else(|| invalid("join a sync server first"))?;
    if lock(&state.config).outlook.is_some() {
        return Err(invalid("Outlook syncs only on the PC it runs on"));
    }
    let device_id = lock(&state.store).device_id().to_owned();
    let account = lock(&state.config).google.clone();
    let credentials = account.as_ref().and_then(|a| {
        a.refresh_token.as_ref().map(|refresh| GoogleCredentials {
            client_id: a.client_id.clone(),
            client_secret: a.client_secret.clone(),
            refresh_token: refresh.clone(),
        })
    });
    if runner == CalendarRunner::Server {
        // Persist the pause before sending credentials, even if the HTTP answer is lost.
        let mut config = lock(&state.config);
        if let Some(account) = &mut config.google {
            account.runner = CalendarRunner::Server;
        }
        config
            .save(&state.config_path)
            .map_err(|e| internal(e.to_string()))?;
        drop(config);
        crate::server_sync::sync_before_calendar(&state)?;
    }
    let transfer = server
        .calendar_runner(&RunnerRequest {
            runner,
            device_id,
            credentials,
        })
        .map_err(|e| internal(e.to_string()))?;
    if runner == CalendarRunner::ThisDevice {
        let c = transfer
            .credentials
            .ok_or_else(|| internal("the server returned no Calendar credentials"))?;
        let mut config = lock(&state.config);
        config.google = Some(GoogleAccount {
            client_id: c.client_id,
            client_secret: c.client_secret,
            refresh_token: Some(c.refresh_token),
            runner,
        });
        config
            .save(&state.config_path)
            .map_err(|e| internal(e.to_string()))?;
        drop(config);
        with_store(&state, |s| s.clear_calendar_sync())?;
        state.calendar.kick();
    }
    let status = remote_status(&state)?;
    let _ = CalendarSynced(status.clone()).emit(&app);
    Ok(status)
}
