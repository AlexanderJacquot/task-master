//! The sync schedule and account flow shared by every shell (ADR 015, ADR 022): the
//! desktop's worker threads and the phone both drive an [`Engine`] and supply a [`Host`]
//! for what differs between them (where the account is saved, how status reaches the UI).
//!
//! A round runs about 2 seconds after local edits (several quick edits make one round),
//! when the server announces new ops, when the shell kicks (focus, "Sync now"), at start
//! and every N minutes. The app never waits on it: edits land in the local database first.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use taskmaster_core::{AuthMode, Store, now_ms};

use crate::{Client, Files, SyncReport};

/// Edits within this pause make one round.
const SETTLE: Duration = Duration::from_secs(2);
const FIRST: Duration = Duration::from_secs(5);
/// Settings warn when this device's clock is further off than this.
const CLOCK_WARNING_MS: i64 = 60_000;

/// The sync server this device syncs with (docs/server.md).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncAccount {
    /// e.g. `https://tasks.example.org`.
    pub url: String,
    /// The server's token for this device (pasted, or from the OIDC sign-in). `None` for
    /// a server that asks for none.
    #[serde(default)]
    pub token: Option<String>,
    /// Shown in the server's `token list`.
    #[serde(default)]
    pub device_name: String,
    /// The first sync chose how to combine this device's data with the server's; syncing
    /// runs only once this is set.
    #[serde(default)]
    pub joined: bool,
}

/// What the sync settings show.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
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

/// How a device starts syncing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum JoinMode {
    /// Keep this device's data and add the server's (also: the first device uploads).
    Merge,
    /// Back up this device's data, empty it, then take the server's.
    Replace,
}

/// A failed account step. `kind` is `invalid` (the user can fix it: wrong address, bad
/// token, schema mismatch), `not_found` or `internal`, like the core's error kinds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineError {
    pub kind: String,
    pub message: String,
}

impl EngineError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            kind: "invalid".into(),
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            kind: "internal".into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for EngineError {}

impl From<crate::Error> for EngineError {
    fn from(e: crate::Error) -> Self {
        match e {
            crate::Error::Unauthorized(_) | crate::Error::Schema(_) => Self::invalid(e.to_string()),
            _ => Self::internal(e.to_string()),
        }
    }
}

impl From<taskmaster_core::Error> for EngineError {
    fn from(e: taskmaster_core::Error) -> Self {
        Self {
            kind: e.kind().to_owned(),
            message: e.to_string(),
        }
    }
}

pub type EngineResult<T> = Result<T, EngineError>;

/// What a shell supplies to the engine.
pub trait Host {
    fn store(&self) -> &Mutex<Store>;
    /// The saved account, if any.
    fn account(&self) -> Option<SyncAccount>;
    /// Saves (or forgets) the account durably.
    fn save_account(&self, account: Option<SyncAccount>) -> Result<(), String>;
    /// Minutes between periodic rounds; 0 turns them off.
    fn sync_minutes(&self) -> u32;
    /// Called when a round starts and ends, and when the account changes.
    fn status_changed(&self, status: &SyncStatus);
    /// Keeps a copy of the local data before [`JoinMode::Replace`] empties it.
    fn backup_before_replace(&self, store: &mut Store) -> taskmaster_core::Result<()>;
    /// This device's name for the server's token list, when the account has none yet.
    fn device_name(&self) -> String;
    /// Whether rounds download every attachment or leave them to [`Engine::fetch_file`].
    fn files(&self) -> Files {
        Files::All
    }
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

/// Sync state of one device: what the last round did, and the locks that order rounds
/// and account changes.
pub struct Engine {
    run: Mutex<Run>,
    /// Serializes account changes with network rounds and their cursor updates.
    round: Mutex<()>,
    kick: Sender<()>,
    /// Bumped when the account changes, so the event watcher reconnects.
    generation: AtomicU64,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn client_for(account: &SyncAccount) -> Client {
    Client::new(&account.url, account.token.clone())
}

fn pending(host: &impl Host) -> u32 {
    lock(host.store())
        .outbox(1000)
        .map(|p| u32::try_from(p.ops.len()).unwrap_or(u32::MAX))
        .unwrap_or(0)
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

impl Engine {
    /// The engine and the receiving end of its kicks, to hand to [`Engine::run`].
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

    pub fn status(&self, host: &impl Host) -> SyncStatus {
        let account = host.account();
        let pending = pending(host);
        let run = lock(&self.run);
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

    fn announce(&self, host: &impl Host) {
        host.status_changed(&self.status(host));
    }

    fn save(&self, host: &impl Host, account: Option<SyncAccount>) -> EngineResult<()> {
        host.save_account(account)
            .map_err(|e| EngineError::internal(format!("cannot save settings: {e}")))?;
        self.generation.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    /// Checks the saved credentials against the server and records whether it is empty.
    fn probe(&self, account: &SyncAccount) -> EngineResult<()> {
        let page = client_for(account).pull(0, 1)?;
        lock(&self.run).server_empty = Some(page.head == 0);
        Ok(())
    }

    /// Runs rounds until one ends with nothing left to push (edits made during a round
    /// are not kicked, see [`Engine::local_change`]) or fails. Does nothing before the
    /// device has joined. For shells without the [`Engine::run`] loop, and for a round
    /// the app waits on (the phone's background refresh).
    pub fn sync_now(&self, host: &impl Host) -> SyncStatus {
        loop {
            let _round = lock(&self.round);
            let Some(account) = host.account().filter(|a| a.joined) else {
                break;
            };
            lock(&self.run).syncing = true;
            self.announce(host);
            let result = crate::sync_with(&client_for(&account), host.store(), host.files());
            let again = {
                let mut run = lock(&self.run);
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
            self.announce(host);
            if !(again && pending(host) > 0) {
                break;
            }
        }
        self.status(host)
    }

    /// The background loop: waits for a kick or the cycle, then syncs. Returns when the
    /// engine is dropped.
    pub fn run(&self, host: &impl Host, kicks: &Receiver<()>) {
        let mut wait = FIRST;
        loop {
            match kicks.recv_timeout(wait) {
                Ok(()) => while kicks.recv_timeout(SETTLE).is_ok() {},
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            wait = match host.sync_minutes() {
                // No periodic round: only edits, announcements and the shell wake us.
                0 => Duration::from_secs(365 * 24 * 3600),
                m => Duration::from_secs(60 * u64::from(m)),
            };
            self.sync_now(host);
        }
    }

    /// Follows the server's event stream and kicks a round when it has ops this device
    /// has not pulled. Reconnects with a growing pause after failures. Never returns.
    pub fn watch(&self, host: &impl Host) {
        let mut pause = Duration::from_secs(5);
        loop {
            let Some(account) = host.account().filter(|a| a.joined) else {
                std::thread::sleep(Duration::from_secs(5));
                continue;
            };
            let generation = self.generation.load(Ordering::SeqCst);
            let result = client_for(&account).watch(|head| {
                if self.generation.load(Ordering::SeqCst) != generation {
                    return false;
                }
                let cursor = lock(host.store()).sync_cursor().unwrap_or(0);
                if head > cursor && !lock(&self.run).syncing {
                    self.kick();
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

    /// The status, after asking the server what it needs when that is not known yet
    /// (after a restart).
    pub fn refresh(&self, host: &impl Host) -> SyncStatus {
        let _round = lock(&self.round);
        if let Some(account) = host.account()
            && lock(&self.run).auth.is_none()
        {
            match client_for(&account).info() {
                Ok(info) => {
                    lock(&self.run).auth = Some(info.auth);
                    if let Err(e) = self.probe(&account) {
                        lock(&self.run).last_error = Some(e.message);
                    }
                }
                Err(e) => lock(&self.run).last_error = Some(e.to_string()),
            }
        }
        self.status(host)
    }

    /// Saves the server address after reading its `/info` (what it needs to connect). A
    /// server that needs no auth is checked right away.
    pub fn connect(&self, host: &impl Host, url: &str) -> EngineResult<SyncStatus> {
        let _round = lock(&self.round);
        let url = normalize_url(url).map_err(EngineError::invalid)?;
        let info = Client::new(&url, None).info()?;
        let previous = host.account();
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
                .unwrap_or_else(|| host.device_name()),
            url,
        };
        *lock(&self.run) = Run {
            auth: Some(info.auth),
            ..Run::default()
        };
        if info.auth == AuthMode::None || account.token.is_some() {
            self.probe(&account)?;
        }
        if previous.as_ref().is_none_or(|p| p.url != account.url) {
            lock(host.store()).restart_sync()?;
        }
        self.save(host, Some(account))?;
        self.announce(host);
        Ok(self.status(host))
    }

    /// Saves a token made on the server (`task-master-server token add`), after checking it.
    pub fn set_token(&self, host: &impl Host, token: &str) -> EngineResult<SyncStatus> {
        let _round = lock(&self.round);
        let mut account = host
            .account()
            .ok_or_else(|| EngineError::invalid("connect to a server first"))?;
        let token = token.trim().to_owned();
        if token.is_empty() {
            return Err(EngineError::invalid("paste the token"));
        }
        account.token = Some(token);
        self.probe(&account)?;
        self.save(host, Some(account))?;
        self.announce(host);
        Ok(self.status(host))
    }

    /// What a sign-in needs from the saved server: its address, the OpenID issuer and
    /// the client id (see [`crate::oidc`]).
    pub fn sign_in_target(&self, host: &impl Host) -> EngineResult<(String, String, String)> {
        let url = host
            .account()
            .ok_or_else(|| EngineError::invalid("connect to a server first"))?
            .url;
        let info = Client::new(&url, None).info()?;
        match (info.oidc_issuer, info.oidc_client_id) {
            (Some(issuer), Some(client_id)) => Ok((url, issuer, client_id)),
            _ => Err(EngineError::invalid(
                "this server does not use sign-in; it needs a token or none",
            )),
        }
    }

    /// Ends a sign-in started for the server at `url`: trades the provider's ID token
    /// for this device's server token and saves it.
    pub fn finish_sign_in(
        &self,
        host: &impl Host,
        url: &str,
        id_token: &str,
    ) -> EngineResult<SyncStatus> {
        let _round = lock(&self.round);
        let mut account = host.account().filter(|a| a.url == url).ok_or_else(|| {
            EngineError::invalid("the server changed during sign-in; sign in again")
        })?;
        let issued = Client::new(url, None).oidc_exchange(id_token, &account.device_name)?;
        account.token = Some(issued.token);
        self.probe(&account)?;
        self.save(host, Some(account))?;
        self.announce(host);
        Ok(self.status(host))
    }

    /// Starts syncing. `Replace` first backs up this device's data, then empties it so
    /// the server's data comes in alone.
    pub fn join(&self, host: &impl Host, mode: JoinMode) -> EngineResult<SyncStatus> {
        let _round = lock(&self.round);
        let mut account = host
            .account()
            .ok_or_else(|| EngineError::invalid("connect to a server first"))?;
        if lock(&self.run).auth != Some(AuthMode::None) && account.token.is_none() {
            return Err(EngineError::invalid("sign in or paste a token first"));
        }
        self.probe(&account)?;
        if mode == JoinMode::Replace {
            let mut store = lock(host.store());
            host.backup_before_replace(&mut store)?;
            store.clear_for_replace()?;
        }
        account.joined = true;
        self.save(host, Some(account))?;
        self.kick();
        self.announce(host);
        Ok(self.status(host))
    }

    /// Stops syncing and forgets the server and its token. Local data stays; joining
    /// again later sends everything again (the server ignores what it has).
    pub fn disconnect(&self, host: &impl Host) -> EngineResult<SyncStatus> {
        let _round = lock(&self.round);
        self.save(host, None)?;
        lock(host.store()).restart_sync()?;
        *lock(&self.run) = Run::default();
        self.announce(host);
        Ok(self.status(host))
    }

    /// Makes sure an attachment's content is on this device before it is opened. False
    /// when the server does not have it yet. Does not wait for a round in progress.
    pub fn fetch_file(&self, host: &impl Host, hash: &str) -> EngineResult<bool> {
        let account = host
            .account()
            .filter(|a| a.joined)
            .ok_or_else(|| EngineError::invalid("join a sync server first"))?;
        Ok(crate::fetch_file(
            &client_for(&account),
            host.store(),
            hash,
        )?)
    }

    /// One round the caller waits on and whose failure it handles itself; the status is
    /// left alone. Fails before the device has joined.
    pub fn sync_blocking(&self, host: &impl Host) -> EngineResult<SyncReport> {
        let _round = lock(&self.round);
        let account = host
            .account()
            .filter(|a| a.joined)
            .ok_or_else(|| EngineError::invalid("join a sync server first"))?;
        Ok(crate::sync_with(
            &client_for(&account),
            host.store(),
            host.files(),
        )?)
    }
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
}
