//! Sync with a task-master server (M13, ADR 015, docs/server.md). The schedule and the
//! account flow live in `taskmaster_client::engine`, shared with the phone (ADR 040);
//! this module is the desktop's side: the account in `config.json`, status events to the
//! UI, the worker threads, the loopback OIDC redirect and the commands the UI uses.
//!
//! A round runs about 2 seconds after local edits, when the server announces new ops,
//! when the window gets focus, at start and every N minutes (Settings; 5 by default, 0
//! turns the periodic round off).

use std::io::{ErrorKind, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use taskmaster_client::engine::{Engine, EngineError, Host};
pub use taskmaster_client::engine::{JoinMode, SyncStatus};
use taskmaster_client::{Client, oidc};
use taskmaster_core::{Changed, Store, TeamInfo, now_ms};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tauri_specta::Event;

use crate::config::SyncAccount;
use crate::google;
use crate::{AppState, CommandError, CommandResult, StoreChanged, internal, invalid, with_store};

/// Folder of the team space's database, next to the personal one (ADR 033).
const TEAM_DIR: &str = "team";
const TEAM_DB: &str = "task-master.sqlite";
/// Who this copy of the team space writes as, so it opens offline at the next start.
const TEAM_MEMBER: &str = "member.json";

/// Loopback ports of the OIDC redirect, tried in order (each registered with the provider,
/// docs/server.md). Windows can reserve a whole block that holds the first one: WSL's
/// mirrored networking reserves its port range (for example 44620-48715) and Hyper-V
/// excludes ranges, so a bind fails with "in use" although nothing listens there.
pub const OIDC_PORTS: [u16; 3] = [47823, 38823, 28823];
const OIDC_PATH: &str = "/oidc/callback";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// How long a new sign-in waits for an earlier one (in this or another task-master
/// instance) to let go of the callback port.
const TAKE_OVER_WAIT: Duration = Duration::from_secs(3);
/// The error of a sign-in that a newer one replaced. The UI drops results of replaced runs.
const REPLACED: &str = "replaced by a newer sign-in";
/// Numbers sign-in attempts: one that ends after a newer one started was replaced.
static SIGN_IN: AtomicU64 = AtomicU64::new(0);

/// Sent when a round starts and ends, and when the account changes.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct SyncChanged(pub SyncStatus);

/// Sync state kept in `AppState`.
pub type SyncRuntime = Engine;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl From<EngineError> for CommandError {
    fn from(e: EngineError) -> Self {
        Self {
            kind: e.kind,
            message: e.message,
        }
    }
}

/// The desktop as the engine sees it. Without `app` (callers that only hold the state)
/// status changes are not announced.
struct Desktop<'a> {
    state: &'a AppState,
    app: Option<&'a AppHandle>,
}

impl<'a> Desktop<'a> {
    fn of(app: &'a AppHandle) -> Self {
        Self {
            state: app.state::<AppState>().inner(),
            app: Some(app),
        }
    }
}

impl Host for Desktop<'_> {
    fn store(&self) -> &Mutex<Store> {
        &self.state.store
    }

    fn account(&self) -> Option<SyncAccount> {
        lock(&self.state.config).sync.clone()
    }

    fn save_account(&self, account: Option<SyncAccount>) -> Result<(), String> {
        let mut config = lock(&self.state.config);
        config.sync = account;
        config
            .save(&self.state.config_path)
            .map_err(|e| e.to_string())
    }

    fn sync_minutes(&self) -> u32 {
        lock(&self.state.config).schedule.sync_minutes
    }

    fn status_changed(&self, status: &SyncStatus) {
        if let Some(app) = self.app {
            let _ = SyncChanged(status.clone()).emit(app);
        }
    }

    fn backup_before_replace(&self, store: &mut Store) -> taskmaster_core::Result<()> {
        let backup = crate::backups::backup_dir(&self.state.data_dir)
            .join(format!("pre-replace-{}.sqlite", now_ms()));
        store.backup_to(&backup)
    }

    fn device_name(&self) -> String {
        device_name()
    }

    fn after_round(&self, client: &Client) -> Result<(), String> {
        match self.app {
            Some(app) => sync_team(app, client),
            None => Ok(()),
        }
    }

    fn pending_elsewhere(&self) -> u32 {
        lock(&self.state.team).as_ref().map_or(0, |store| {
            store
                .outbox(1000)
                .map(|p| u32::try_from(p.ops.len()).unwrap_or(u32::MAX))
                .unwrap_or(0)
        })
    }
}

/// Opens the team space when the server runs one this device belongs to, and closes it
/// when it does not (ADR 033). Returns whether there is a team to sync.
fn follow_team(app: &AppHandle, info: Option<&TeamInfo>) -> Result<bool, String> {
    let state = app.state::<AppState>();
    state
        .sync
        .set_team(info.filter(|t| t.me.is_some()).cloned());
    let Some(me) = info.and_then(|t| t.me.as_ref()) else {
        close_team(app);
        return Ok(false);
    };
    {
        let team = lock(&state.team);
        match team.as_ref() {
            Some(store) if store.author() == Some(me.id.as_str()) => return Ok(true),
            Some(_) => {
                // Another member's token now: their copy is not this one's.
                drop(team);
                close_team(app);
            }
            None => {}
        }
    }
    open_team(app, info.cloned()).map_err(|e| format!("cannot open the team space: {e}"))?;
    Ok(true)
}

/// Opens this device's copy of the team space at start, before any server is reached,
/// so team work is there offline (ADR 033). Nothing happens without a saved copy.
pub fn open_saved_team(app: &AppHandle) {
    let state = app.state::<AppState>();
    let saved = std::fs::read(state.data_dir.join(TEAM_DIR).join(TEAM_MEMBER))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<TeamInfo>(&bytes).ok())
        .filter(|t| t.me.is_some());
    if let Some(team) = saved {
        state.sync.set_team(Some(team.clone()));
        if let Err(e) = open_team(app, Some(team)) {
            eprintln!("cannot open the team space: {e}");
        }
    }
}

fn open_team(app: &AppHandle, info: Option<TeamInfo>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let Some(info) = info else {
        return Ok(());
    };
    let Some(me) = info.me.clone() else {
        return Ok(());
    };
    let dir = state.data_dir.join(TEAM_DIR);
    let mut store = Store::open(dir.join(TEAM_DB)).map_err(|e| e.to_string())?;
    let saved = serde_json::to_vec(&info).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(TEAM_MEMBER), saved).map_err(|e| e.to_string())?;
    store.set_author(Some(me.id));
    store.set_repairs(false);
    let changes = store.subscribe();
    *lock(&state.team) = Some(store);
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("team-events".into())
        .spawn(move || {
            for changed in changes {
                if let Some(state) = handle.try_state::<AppState>() {
                    state.sync.local_change();
                }
                let _ = StoreChanged(changed).emit(&handle);
            }
        });
    if let Err(e) = spawned {
        eprintln!("cannot follow team changes: {e}");
    }
    reload_ui(app);
    Ok(())
}

/// Closes the team space and deletes this device's copy: the server keeps the team's
/// data, and joining again pulls it back.
pub fn close_team(app: &AppHandle) {
    let state = app.state::<AppState>();
    let closed = {
        let mut history = lock(&state.history);
        let mut team = lock(&state.team);
        history.forget_team();
        team.take()
    };
    if closed.is_none() {
        return;
    }
    drop(closed); // closes the database before its folder goes
    let dir = state.data_dir.join(TEAM_DIR);
    if let Err(e) = std::fs::remove_dir_all(&dir)
        && e.kind() != ErrorKind::NotFound
    {
        eprintln!("cannot delete {}: {e}", dir.display());
    }
    reload_ui(app);
}

/// Asks the UI to read everything again (a space opened or closed).
fn reload_ui(app: &AppHandle) {
    let _ = StoreChanged(Changed {
        batch_id: taskmaster_core::new_id(),
        op_seq: 0,
        entities: Vec::new(),
    })
    .emit(app);
}

/// One round for the team space, after the personal one (the engine's
/// [`Host::after_round`]). A refused token (the member was removed) closes the team space.
fn sync_team(app: &AppHandle, client: &Client) -> Result<(), String> {
    let info = client.info().map_err(|e| e.to_string())?;
    if !follow_team(app, info.team.as_ref())? {
        return Ok(());
    }
    let state = app.state::<AppState>();
    match taskmaster_client::sync(&client.team(), &state.team) {
        Ok(_) => Ok(()),
        Err(taskmaster_client::Error::Unauthorized(_)) => {
            close_team(app);
            Ok(())
        }
        Err(e) => Err(format!("team: {e}")),
    }
}

/// The background loop: waits for a kick or the cycle, then runs a round if joined.
pub fn run(app: AppHandle, kicks: Receiver<()>) {
    let host = Desktop::of(&app);
    host.state.sync.run(&host, &kicks);
}

/// Follows the server's event stream and kicks a round when it has ops this device has
/// not pulled.
pub fn watch(app: AppHandle) {
    let host = Desktop::of(&app);
    host.state.sync.watch(&host);
}

/// Follows the team space's event stream (ADR 033) while this device has one, like
/// [`watch`] for the personal space.
pub fn watch_team(app: AppHandle) {
    let host = Desktop::of(&app);
    host.state.sync.watch_team(&host, || {
        lock(&host.state.team)
            .as_ref()
            .map(|t| t.sync_cursor().unwrap_or(0))
    });
}

/// This computer's name, for the server's token list.
fn device_name() -> String {
    let from_env = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok();
    from_env
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "desktop".into())
}

#[tauri::command(async)]
#[specta::specta]
pub fn sync_status(app: AppHandle) -> SyncStatus {
    let host = Desktop::of(&app);
    host.state.sync.refresh(&host)
}

/// Saves the server address after reading its `/info` (what it needs to connect). A
/// server that needs no auth is checked right away.
#[tauri::command(async)]
#[specta::specta]
pub fn sync_connect(app: AppHandle, url: String) -> CommandResult<SyncStatus> {
    let host = Desktop::of(&app);
    let _calendar = lock(&host.state.calendar.gate);
    Ok(host.state.sync.connect(&host, &url)?)
}

/// Saves a token made on the server (`task-master-server token add`), after checking it.
#[tauri::command(async)]
#[specta::specta]
pub fn sync_set_token(app: AppHandle, token: String) -> CommandResult<SyncStatus> {
    let host = Desktop::of(&app);
    let _calendar = lock(&host.state.calendar.gate);
    Ok(host.state.sync.set_token(&host, &token)?)
}

/// Signs in with the server's OpenID provider in the browser (up to 5 minutes), then
/// trades the ID token for this device's server token. Starting again while the browser
/// step is open replaces the earlier attempt, which then fails with `REPLACED`.
#[tauri::command(async)]
#[specta::specta]
pub fn sync_sign_in(app: AppHandle) -> CommandResult<SyncStatus> {
    let host = Desktop::of(&app);
    let attempt = SIGN_IN.fetch_add(1, Ordering::SeqCst) + 1;
    let replaced = || SIGN_IN.load(Ordering::SeqCst) != attempt;
    let (url, issuer, client_id) = host.state.sync.sign_in_target(&host)?;
    // The browser step holds no lock: sync rounds and Calendar keep running meanwhile,
    // and a newer attempt can take over the callback port.
    let signed_in = oidc_sign_in(&issuer, &client_id, |url| {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| format!("cannot open the browser: {e}"))
    });
    if replaced() {
        return Err(invalid(REPLACED));
    }
    let id_token = signed_in.map_err(internal)?;

    let _calendar = lock(&host.state.calendar.gate);
    Ok(host.state.sync.finish_sign_in(&host, &url, &id_token)?)
}

/// Starts syncing. `Replace` first backs up this device's data (in `backups/`), then
/// empties it so the server's data comes in alone.
#[tauri::command(async)]
#[specta::specta]
pub fn sync_join(app: AppHandle, mode: JoinMode) -> CommandResult<SyncStatus> {
    let host = Desktop::of(&app);
    let _calendar = lock(&host.state.calendar.gate);
    Ok(host.state.sync.join(&host, mode)?)
}

#[tauri::command]
#[specta::specta]
pub fn sync_now(app: AppHandle) -> SyncStatus {
    let host = Desktop::of(&app);
    host.state.sync.kick();
    host.state.sync.status(&host)
}

/// Stops syncing and forgets the server and its token. Local data stays; joining again
/// later sends everything again (the server ignores what it has).
#[tauri::command(async)]
#[specta::specta]
pub fn sync_disconnect(app: AppHandle) -> CommandResult<SyncStatus> {
    let host = Desktop::of(&app);
    let _calendar = lock(&host.state.calendar.gate);
    // A detached desktop must not become an unleased Calendar runner.
    {
        let mut config = lock(&host.state.config);
        if let Some(google) = &mut config.google {
            google.runner = taskmaster_core::calendar::CalendarRunner::Server;
        }
        config
            .save(&host.state.config_path)
            .map_err(|e| internal(e.to_string()))?;
    }
    close_team(&app);
    Ok(host.state.sync.disconnect(&host)?)
}

// ---------------------------------------------------------------------------------------
// OpenID Connect sign-in: the loopback redirect (RFC 8252) around `taskmaster_client::oidc`

/// Signs in through the browser and returns the provider's ID token.
pub fn oidc_sign_in(
    issuer: &str,
    client_id: &str,
    open: impl FnOnce(&str) -> Result<(), String>,
) -> Result<String, String> {
    let (listener, port) = bind_callback(&OIDC_PORTS, TAKE_OVER_WAIT)?;
    let flow = oidc::begin(
        issuer,
        client_id,
        &format!("http://127.0.0.1:{port}{OIDC_PATH}"),
    )?;
    open(&flow.auth_url)?;
    let code = google::receive_code(
        &listener,
        flow.state(),
        Instant::now() + SIGN_IN_TIMEOUT,
        "your task-master server",
    )?;
    flow.finish(&code)
}

/// Binds the first usable callback port. A port where an earlier sign-in still waits (in
/// this instance or another one) is taken over: it is asked to stop, and the bind is
/// retried until `wait` runs out. A port that is busy while nothing answers on it
/// (reserved by Windows) or that cannot be bound at all is skipped at once.
fn bind_callback(ports: &[u16], wait: Duration) -> Result<(TcpListener, u16), String> {
    let mut problems = Vec::new();
    for &port in ports {
        match take_port(port, wait) {
            Ok(listener) => return Ok((listener, port)),
            Err(e) => problems.push(format!("{port}: {e}")),
        }
    }
    Err(format!(
        "no sign-in callback port is free ({}); close the program using one and try again",
        problems.join("; ")
    ))
}

fn take_port(port: u16, wait: Duration) -> Result<TcpListener, String> {
    let deadline = Instant::now() + wait;
    let mut asked: Option<Instant> = None;
    loop {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => return Ok(listener),
            Err(e) if e.kind() == ErrorKind::AddrInUse => {
                if asked.is_none_or(|at| at.elapsed() >= Duration::from_secs(1)) {
                    if !ask_to_stop(port) {
                        return Err(format!("reserved by the system ({e})"));
                    }
                    asked = Some(Instant::now());
                }
                if Instant::now() >= deadline {
                    return Err(format!("used by another program ({e})"));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Sends a waiting sign-in the answer of a cancelled one: every sign-in accepts an
/// `error` callback (`google::parse_callback`), stops and frees the port. False when
/// nothing listens on the port.
fn ask_to_stop(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.write_all(
        format!("GET {OIDC_PATH}?error=replaced HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n").as_bytes(),
    );
    true
}

pub fn sync_before_calendar(state: &AppState) -> CommandResult<()> {
    let host = Desktop { state, app: None };
    state.sync.sync_blocking(&host)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_sign_in_takes_over_the_callback_port() {
        let earlier = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = earlier.local_addr().unwrap().port();
        let waiting = std::thread::spawn(move || {
            google::receive_code(
                &earlier,
                "state",
                Instant::now() + Duration::from_secs(10),
                "your task-master server",
            )
        });
        let (listener, bound) = bind_callback(&[port], Duration::from_secs(3)).unwrap();
        assert_eq!((listener.local_addr().unwrap().port(), bound), (port, port));
        let err = waiting.join().unwrap().unwrap_err();
        assert!(err.contains("replaced"), "{err}");
    }

    #[test]
    fn a_port_held_by_another_program_is_reported() {
        // Bound but never answering, like an unrelated program.
        let other = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = other.local_addr().unwrap().port();
        let err = bind_callback(&[port], Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("used by another program"), "{err}");
    }

    #[test]
    // The stand-in for a reserved port (a connected socket's own port) only refuses a
    // listener on Linux; macOS and Windows let one bind there (ADR 027).
    #[cfg_attr(
        not(target_os = "linux"),
        ignore = "a connected socket's port is not busy here"
    )]
    fn a_busy_port_nobody_answers_on_is_skipped_at_once() {
        // A connected socket's own port: bound, but nothing listens there, like a port
        // Windows reserved for WSL.
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(server.local_addr().unwrap()).unwrap();
        let reserved = client.local_addr().unwrap().port();
        let free = TcpListener::bind("127.0.0.1:0").unwrap();
        let next = free.local_addr().unwrap().port();
        drop(free);

        let started = Instant::now();
        let (_listener, bound) = bind_callback(&[reserved, next], Duration::from_secs(3)).unwrap();
        assert_eq!(bound, next);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn the_redirect_path_is_read() {
        assert_eq!(
            google::parse_callback("GET /oidc/callback?code=abc&state=st HTTP/1.1", "st"),
            Ok(google::Callback::Code("abc".into()))
        );
    }
}

/// What Settings → Files shows (ADR 023): the files on this device and, when this device
/// syncs, the ones on the server.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FilesOverview {
    pub local: Vec<taskmaster_core::StoredFileInfo>,
    /// `None` without a sync server, or when it could not be read (see `server_error`).
    pub server: Option<taskmaster_core::BlobList>,
    pub server_error: Option<String>,
}

#[tauri::command(async)]
#[specta::specta]
pub fn files_overview(state: State<'_, AppState>) -> CommandResult<FilesOverview> {
    let local = with_store(&state, |s| s.stored_files())?;
    let host = Desktop {
        state: &state,
        app: None,
    };
    let (server, server_error) = match host.account().filter(|a| a.joined) {
        None => (None, None),
        Some(account) => match Client::new(&account.url, account.token).list_blobs() {
            Ok(Some(list)) => (Some(list), None),
            Ok(None) => (
                None,
                Some("the server is older than this app: update it to see its files".into()),
            ),
            Err(e) => (None, Some(e.to_string())),
        },
    };
    Ok(FilesOverview {
        local,
        server,
        server_error,
    })
}

/// Permanently deletes the content of `hashes` here (the UI deletes their attachments
/// first), then syncs so the server and the other devices drop it too.
#[tauri::command(async)]
#[specta::specta]
pub fn purge_files(
    state: State<'_, AppState>,
    hashes: Vec<String>,
) -> CommandResult<taskmaster_core::PurgeReport> {
    let report = with_store(&state, |s| s.purge_files(&hashes))?;
    state.sync.kick();
    Ok(report)
}
