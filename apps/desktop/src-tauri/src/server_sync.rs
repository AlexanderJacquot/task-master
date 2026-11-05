//! Sync with a task-master server (M13, ADR 015, docs/server.md): the account in
//! settings, a background worker running `taskmaster_client::sync`, a watcher on the
//! server's event stream, and the commands the UI uses.
//!
//! A round runs about 2 seconds after local edits (several quick edits make one round),
//! when the server announces new ops, when the window gets focus, at start and every
//! 5 minutes. The app never waits on it: edits always land in the local database first.

use std::net::TcpListener;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use taskmaster_client::{Client, SyncReport};
use taskmaster_core::{AuthMode, now_ms};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tauri_specta::Event;

use crate::config::SyncAccount;
use crate::google;
use crate::{AppState, CommandError, CommandResult, internal, invalid, with_store};

const CYCLE: Duration = Duration::from_secs(5 * 60);
/// Edits within this pause make one round.
const SETTLE: Duration = Duration::from_secs(2);
const FIRST: Duration = Duration::from_secs(5);
/// Fixed loopback port of the OIDC redirect (registered with the provider, docs/server.md).
pub const OIDC_PORT: u16 = 47823;
const OIDC_PATH: &str = "/oidc/callback";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// Settings warn when this device's clock is further off than this.
const CLOCK_WARNING_MS: i64 = 60_000;

/// What Settings → Sync shows.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct SyncStatus {
    /// A server address is saved.
    pub configured: bool,
    pub url: String,
    pub device_name: String,
    /// What the server asked for when last contacted.
    pub auth: Option<AuthMode>,
    /// A token is saved.
    pub signed_in: bool,
    /// Whether the server held no data when this device connected (first device).
    pub server_empty: Option<bool>,
    /// This device chose how to start (merge or replace) and syncs.
    pub joined: bool,
    pub syncing: bool,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub last_pushed: u32,
    pub last_pulled: u32,
    pub clock_offset_ms: i64,
    /// The device clock is more than a minute off (sync corrects for it).
    pub clock_warning: bool,
    /// Local changes not on the server yet (counted up to 1000).
    pub pending: u32,
}

/// Sent when a round starts and ends, and when the account changes.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct SyncChanged(pub SyncStatus);

/// How a device starts syncing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum JoinMode {
    /// Keep this device's data and add the server's (also: the first device uploads).
    Merge,
    /// Back up this device's data, empty it, then take the server's.
    Replace,
}

#[derive(Default)]
struct Run {
    syncing: bool,
    last_sync_at: Option<i64>,
    last_error: Option<String>,
    last_report: Option<SyncReport>,
    auth: Option<AuthMode>,
    server_empty: Option<bool>,
}

/// Sync state kept in `AppState`.
pub struct SyncRuntime {
    run: Mutex<Run>,
    /// Serializes account changes with network rounds and their cursor updates.
    round: Mutex<()>,
    kick: Sender<()>,
    /// Bumped when the account changes, so the event watcher reconnects.
    generation: AtomicU64,
}

impl SyncRuntime {
    pub fn new() -> (Self, Receiver<()>) {
        let (kick, kicks) = std::sync::mpsc::channel();
        (
            Self {
                run: Mutex::new(Run::default()),
                round: Mutex::new(()),
                kick,
                generation: AtomicU64::new(0),
            },
            kicks,
        )
    }

    /// Asks for a round soon.
    pub fn kick(&self) {
        let _ = self.kick.send(());
    }

    /// A committed batch: sync it, unless it came from a round in progress (the round
    /// pushes its own repairs, and its pulls are not new local work).
    pub fn local_change(&self) {
        if !lock(&self.run).syncing {
            self.kick();
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn account(state: &AppState) -> Option<SyncAccount> {
    lock(&state.config).sync.clone()
}

fn client_for(account: &SyncAccount) -> Client {
    Client::new(&account.url, account.token.clone())
}

fn pending(state: &AppState) -> u32 {
    lock(&state.store)
        .outbox(1000)
        .map(|p| u32::try_from(p.ops.len()).unwrap_or(u32::MAX))
        .unwrap_or(0)
}

pub fn status(state: &AppState) -> SyncStatus {
    let account = account(state);
    let pending = pending(state);
    let run = lock(&state.sync.run);
    let report = run.last_report.clone().unwrap_or_default();
    SyncStatus {
        configured: account.is_some(),
        url: account.as_ref().map(|a| a.url.clone()).unwrap_or_default(),
        device_name: account
            .as_ref()
            .map(|a| a.device_name.clone())
            .unwrap_or_default(),
        auth: run.auth,
        signed_in: account.as_ref().is_some_and(|a| a.token.is_some()),
        server_empty: run.server_empty,
        joined: account.as_ref().is_some_and(|a| a.joined),
        syncing: run.syncing,
        last_sync_at: run.last_sync_at,
        last_error: run.last_error.clone(),
        last_pushed: report.pushed,
        last_pulled: report.pulled,
        clock_offset_ms: report.clock_offset_ms,
        clock_warning: report.clock_offset_ms.abs() > CLOCK_WARNING_MS,
        pending,
    }
}

fn announce(app: &AppHandle) {
    let _ = SyncChanged(status(&app.state::<AppState>())).emit(app);
}

fn save(state: &AppState, update: impl FnOnce(&mut Option<SyncAccount>)) -> CommandResult<()> {
    let mut config = lock(&state.config);
    update(&mut config.sync);
    config
        .save(&state.config_path)
        .map_err(|e| internal(format!("cannot save settings: {e}")))?;
    drop(config);
    state.sync.generation.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

fn sync_error(e: &taskmaster_client::Error) -> CommandError {
    match e {
        taskmaster_client::Error::Unauthorized(_) | taskmaster_client::Error::Schema(_) => {
            invalid(e.to_string())
        }
        _ => internal(e.to_string()),
    }
}

/// The background loop: waits for a kick or the cycle, then runs a round if joined.
pub fn run(app: AppHandle, kicks: Receiver<()>) {
    let mut wait = FIRST;
    loop {
        match kicks.recv_timeout(wait) {
            Ok(()) => while kicks.recv_timeout(SETTLE).is_ok() {},
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        wait = CYCLE;
        // Edits made during a round are not kicked (see `local_change`): go again while
        // a round ends with local work left.
        loop {
            let state = app.state::<AppState>();
            let _round = lock(&state.sync.round);
            let Some(account) = account(&state).filter(|a| a.joined) else {
                break;
            };
            lock(&state.sync.run).syncing = true;
            announce(&app);
            let result = taskmaster_client::sync(&client_for(&account), &state.store);
            let again = {
                let mut run = lock(&state.sync.run);
                run.syncing = false;
                match result {
                    Ok(report) => {
                        run.last_sync_at = Some(now_ms());
                        run.last_error = None;
                        run.last_report = Some(report);
                        true
                    }
                    Err(e) => {
                        run.last_error = Some(e.to_string());
                        false
                    }
                }
            };
            announce(&app);
            if !(again && pending(&state) > 0) {
                break;
            }
        }
    }
}

/// Follows the server's event stream and kicks a round when it has ops this device has
/// not pulled. Reconnects with a growing pause after failures.
pub fn watch(app: AppHandle) {
    let mut pause = Duration::from_secs(5);
    loop {
        let state = app.state::<AppState>();
        let Some(account) = account(&state).filter(|a| a.joined) else {
            std::thread::sleep(Duration::from_secs(5));
            continue;
        };
        let generation = state.sync.generation.load(Ordering::SeqCst);
        let result = client_for(&account).watch(|head| {
            let state = app.state::<AppState>();
            if state.sync.generation.load(Ordering::SeqCst) != generation {
                return false;
            }
            let cursor = lock(&state.store).sync_cursor().unwrap_or(0);
            if head > cursor && !lock(&state.sync.run).syncing {
                state.sync.kick();
            }
            true
        });
        match result {
            Ok(()) => pause = Duration::from_secs(5),
            Err(_) => {
                std::thread::sleep(pause);
                pause = (pause * 2).min(Duration::from_secs(60));
            }
        }
    }
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

/// `https://host` from what was typed: scheme added when missing, trailing slash dropped.
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.trim_end_matches('/').is_empty() {
        return Err("type the server's address".into());
    }
    // Decide on the scheme before trimming slashes ("https://" alone is not an address).
    let with_scheme = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("https://{raw}")
    };
    let url =
        url::Url::parse(&with_scheme).map_err(|e| format!("'{raw}' is not an address: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err(format!("'{raw}' is not an http(s) address"));
    }
    Ok(with_scheme.trim_end_matches('/').to_owned())
}

/// Checks the saved credentials against the server and records whether it is empty.
fn probe(state: &AppState, account: &SyncAccount) -> CommandResult<()> {
    let page = client_for(account).pull(0, 1).map_err(|e| sync_error(&e))?;
    lock(&state.sync.run).server_empty = Some(page.head == 0);
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn sync_status(app: AppHandle) -> SyncStatus {
    let state = app.state::<AppState>();
    let _round = lock(&state.sync.round);
    if let Some(account) = account(&state)
        && lock(&state.sync.run).auth.is_none()
    {
        match client_for(&account).info() {
            Ok(info) => {
                lock(&state.sync.run).auth = Some(info.auth);
                if let Err(e) = probe(&state, &account) {
                    lock(&state.sync.run).last_error = Some(e.message);
                }
            }
            Err(e) => lock(&state.sync.run).last_error = Some(e.to_string()),
        }
    }
    status(&state)
}

/// Saves the server address after reading its `/info` (what it needs to connect). A
/// server that needs no auth is checked right away.
#[tauri::command(async)]
#[specta::specta]
pub fn sync_connect(app: AppHandle, url: String) -> CommandResult<SyncStatus> {
    let state = app.state::<AppState>();
    let _calendar = lock(&state.calendar.gate);
    let _round = lock(&state.sync.round);
    let url = normalize_url(&url).map_err(invalid)?;
    let info = Client::new(&url, None).info().map_err(|e| sync_error(&e))?;
    let previous = account(&state);
    let account = SyncAccount {
        // Same server: keep the token and the join choice.
        token: previous
            .as_ref()
            .filter(|p| p.url == url)
            .and_then(|p| p.token.clone()),
        joined: previous.as_ref().is_some_and(|p| p.url == url && p.joined),
        device_name: previous
            .as_ref()
            .map(|p| p.device_name.clone())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(device_name),
        url,
    };
    {
        let mut run = lock(&state.sync.run);
        *run = Run {
            auth: Some(info.auth),
            ..Run::default()
        };
    }
    if info.auth == AuthMode::None || account.token.is_some() {
        probe(&state, &account)?;
    }
    if previous.as_ref().is_none_or(|p| p.url != account.url) {
        with_store(&state, |s| s.restart_sync())?;
    }
    save(&state, |s| *s = Some(account))?;
    announce(&app);
    Ok(status(&state))
}

/// Saves a token made on the server (`task-master-server token add`), after checking it.
#[tauri::command(async)]
#[specta::specta]
pub fn sync_set_token(app: AppHandle, token: String) -> CommandResult<SyncStatus> {
    let state = app.state::<AppState>();
    let _calendar = lock(&state.calendar.gate);
    let _round = lock(&state.sync.round);
    let mut account = account(&state).ok_or_else(|| invalid("connect to a server first"))?;
    let token = token.trim().to_owned();
    if token.is_empty() {
        return Err(invalid("paste the token"));
    }
    account.token = Some(token);
    probe(&state, &account)?;
    save(&state, |s| *s = Some(account))?;
    announce(&app);
    Ok(status(&state))
}

/// Signs in with the server's OpenID provider in the browser (up to 5 minutes), then
/// trades the ID token for this device's server token.
#[tauri::command(async)]
#[specta::specta]
pub fn sync_sign_in(app: AppHandle) -> CommandResult<SyncStatus> {
    let state = app.state::<AppState>();
    let _calendar = lock(&state.calendar.gate);
    let _round = lock(&state.sync.round);
    let mut account = account(&state).ok_or_else(|| invalid("connect to a server first"))?;
    let client = Client::new(&account.url, None);
    let info = client.info().map_err(|e| sync_error(&e))?;
    let (Some(issuer), Some(client_id)) = (info.oidc_issuer, info.oidc_client_id) else {
        return Err(invalid(
            "this server does not use sign-in; it needs a token or none",
        ));
    };
    let opener = app.clone();
    let id_token = oidc_sign_in(&issuer, &client_id, |url| {
        opener
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| format!("cannot open the browser: {e}"))
    })
    .map_err(internal)?;
    let issued = client
        .oidc_exchange(&id_token, &account.device_name)
        .map_err(|e| sync_error(&e))?;
    account.token = Some(issued.token);
    probe(&state, &account)?;
    save(&state, |s| *s = Some(account))?;
    announce(&app);
    Ok(status(&state))
}

/// Starts syncing. `Replace` first backs up this device's data (in `backups/`), then
/// empties it so the server's data comes in alone.
#[tauri::command(async)]
#[specta::specta]
pub fn sync_join(app: AppHandle, mode: JoinMode) -> CommandResult<SyncStatus> {
    let state = app.state::<AppState>();
    let _calendar = lock(&state.calendar.gate);
    let _round = lock(&state.sync.round);
    let account = account(&state).ok_or_else(|| invalid("connect to a server first"))?;
    if lock(&state.sync.run).auth != Some(AuthMode::None) && account.token.is_none() {
        return Err(invalid("sign in or paste a token first"));
    }
    probe(&state, &account)?;
    if mode == JoinMode::Replace {
        let backup = crate::backups::backup_dir(&state.data_dir)
            .join(format!("pre-replace-{}.sqlite", now_ms()));
        with_store(&state, |s| {
            s.backup_to(&backup)?;
            s.clear_for_replace()
        })?;
    }
    save(&state, |s| {
        if let Some(a) = s {
            a.joined = true;
        }
    })?;
    state.sync.kick();
    announce(&app);
    Ok(status(&state))
}

#[tauri::command]
#[specta::specta]
pub fn sync_now(state: State<'_, AppState>) -> SyncStatus {
    state.sync.kick();
    status(&state)
}

/// Stops syncing and forgets the server and its token. Local data stays; joining again
/// later sends everything again (the server ignores what it has).
#[tauri::command(async)]
#[specta::specta]
pub fn sync_disconnect(app: AppHandle) -> CommandResult<SyncStatus> {
    let state = app.state::<AppState>();
    let _calendar = lock(&state.calendar.gate);
    let _round = lock(&state.sync.round);
    // A detached desktop must not become an unleased Calendar runner.
    {
        let mut config = lock(&state.config);
        if let Some(google) = &mut config.google {
            google.runner = taskmaster_core::calendar::CalendarRunner::Server;
        }
        config
            .save(&state.config_path)
            .map_err(|e| internal(e.to_string()))?;
    }
    save(&state, |s| *s = None)?;
    with_store(&state, |s| s.restart_sync())?;
    *lock(&state.sync.run) = Run::default();
    announce(&app);
    Ok(status(&state))
}

// ---------------------------------------------------------------------------------------
// OpenID Connect sign-in (authorization code + PKCE, loopback redirect, RFC 8252)

/// The provider's sign-in page URL.
pub fn oidc_auth_url(
    authorization_endpoint: &str,
    client_id: &str,
    redirect: &str,
    challenge: &str,
    state: &str,
) -> Result<String, String> {
    let mut url = url::Url::parse(authorization_endpoint)
        .map_err(|e| format!("the provider's sign-in address is invalid: {e}"))?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", "openid profile groups")
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state);
    Ok(url.into())
}

fn get_json(agent: &ureq::Agent, url: &str) -> Result<Value, String> {
    let mut resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("cannot reach {url}: {e}"))?;
    let text = resp
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("{url} did not answer JSON: {e}"))
}

/// Signs in through the browser and returns the provider's ID token.
pub fn oidc_sign_in(
    issuer: &str,
    client_id: &str,
    open: impl FnOnce(&str) -> Result<(), String>,
) -> Result<String, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        .build()
        .into();
    let discovery = get_json(
        &agent,
        &format!(
            "{}/.well-known/openid-configuration",
            issuer.trim_end_matches('/')
        ),
    )?;
    let endpoint = |name: &str| {
        discovery[name]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("the provider's discovery document has no {name}"))
    };
    let (authorize, token_url) = (
        endpoint("authorization_endpoint")?,
        endpoint("token_endpoint")?,
    );

    let listener = TcpListener::bind(("127.0.0.1", OIDC_PORT))
        .map_err(|e| format!("port {OIDC_PORT} is busy ({e}); close what uses it and try again"))?;
    let redirect = format!("http://127.0.0.1:{OIDC_PORT}{OIDC_PATH}");
    let verifier = google::random_token(48)?;
    let state = google::random_token(16)?;
    open(&oidc_auth_url(
        &authorize,
        client_id,
        &redirect,
        &google::challenge(&verifier),
        &state,
    )?)?;
    let code = google::receive_code(
        &listener,
        &state,
        Instant::now() + SIGN_IN_TIMEOUT,
        "your task-master server",
    )?;

    let mut resp = agent
        .post(&token_url)
        .send_form([
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("client_id", client_id),
            ("redirect_uri", redirect.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .map_err(|e| format!("cannot reach the provider: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status != 200 {
        let mut message = format!("the provider refused the sign-in (HTTP {status})");
        if let Some(e) = body["error_description"]
            .as_str()
            .or(body["error"].as_str())
        {
            message.push_str(": ");
            message.push_str(e);
        }
        return Err(message);
    }
    body["id_token"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "the provider sent no ID token (is the `openid` scope allowed?)".into())
}

pub fn sync_before_calendar(state: &AppState) -> CommandResult<()> {
    let _round = lock(&state.sync.round);
    let account = account(state)
        .filter(|a| a.joined)
        .ok_or_else(|| invalid("join a sync server first"))?;
    taskmaster_client::sync(&client_for(&account), &state.store).map_err(|e| sync_error(&e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_normalized() {
        assert_eq!(
            normalize_url(" tasks.example.org/ ").unwrap(),
            "https://tasks.example.org"
        );
        assert_eq!(
            normalize_url("http://192.168.1.5:8080").unwrap(),
            "http://192.168.1.5:8080"
        );
        assert!(normalize_url("").is_err());
        assert!(normalize_url("ftp://x.org").is_err());
        assert!(normalize_url("https://").is_err());
    }

    #[test]
    fn sign_in_url_uses_pkce_and_the_fixed_redirect() {
        let url = oidc_auth_url(
            "https://auth.example.org/api/oidc/authorization",
            "task-master",
            "http://127.0.0.1:47823/oidc/callback",
            "chal",
            "st",
        )
        .unwrap();
        let url = url::Url::parse(&url).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "task-master");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:47823/oidc/callback");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["code_challenge_method"], "S256");
        assert!(q["scope"].split(' ').any(|s| s == "openid"));
        assert_eq!(url.path(), "/api/oidc/authorization");
    }

    #[test]
    fn the_redirect_path_is_read() {
        assert_eq!(
            google::parse_callback("GET /oidc/callback?code=abc&state=st HTTP/1.1", "st"),
            Ok(google::Callback::Code("abc".into()))
        );
    }
}
