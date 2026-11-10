//! Sync with a task-master server (M13, ADR 015, docs/server.md). The schedule and the
//! account flow live in `taskmaster_client::engine`, shared with the phone (ADR 022);
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
use taskmaster_client::oidc;
use taskmaster_core::{Store, now_ms};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_specta::Event;

use crate::config::SyncAccount;
use crate::google;
use crate::{AppState, CommandError, CommandResult, internal, invalid};

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
