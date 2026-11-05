//! Blocking client for the task-master sync server (docs/adr/015-sync-server.md).
//!
//! [`Client`] wraps the HTTP endpoints; [`sync`] runs one full round for a local
//! [`Store`]: correct the clock, upload new attachment content, push the outbox, pull
//! what is new, push the repairs that produced, download missing attachment content.
//! The store is locked only between network calls, so the app keeps writing meanwhile.

use std::fmt;
use std::io::{BufRead, BufReader};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use taskmaster_core::{
    IssuedToken, MAX_ATTACHMENT_BYTES, OidcExchange, PullPage, PushRequest, PushResult, ServerInfo,
    Store, now_ms,
};

/// Ops per push or pull request.
pub const PAGE: u32 = 500;
/// Below this, a clock difference is network noise and left alone.
const CLOCK_NOISE_MS: i64 = 1_000;
/// The event stream is reopened at least this often, so a connection that died silently
/// is noticed.
const STREAM_LIFETIME: Duration = Duration::from_secs(10 * 60);

#[derive(Debug)]
pub enum Error {
    /// The server could not be reached (offline, wrong address, TLS).
    Unreachable(String),
    /// The server refused the credentials (none, wrong, revoked or wrong scope).
    Unauthorized(String),
    /// Client and server run different database schemas: update the older one.
    Schema(String),
    /// Any other HTTP error status, with the server's message.
    Http(u16, String),
    /// The server answered something this client cannot read.
    Protocol(String),
    /// The local store failed.
    Core(taskmaster_core::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable(m) => write!(f, "server unreachable: {m}"),
            Self::Unauthorized(m) if m.is_empty() => write!(f, "not authorized"),
            Self::Unauthorized(m) => write!(f, "not authorized: {m}"),
            Self::Schema(m) => write!(f, "{m}"),
            Self::Http(code, m) => write!(f, "the server answered HTTP {code}: {m}"),
            Self::Protocol(m) => write!(f, "unexpected answer from the server: {m}"),
            Self::Core(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<taskmaster_core::Error> for Error {
    fn from(e: taskmaster_core::Error) -> Self {
        Self::Core(e)
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

type Response = ureq::http::Response<ureq::Body>;

/// A connection to one server. Cheap to clone.
#[derive(Clone)]
pub struct Client {
    base: String,
    token: Option<String>,
    agent: ureq::Agent,
    stream: ureq::Agent,
}

impl Client {
    /// `base_url` like `https://tasks.example.org` (a trailing slash is ignored).
    pub fn new(base_url: &str, token: Option<String>) -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_global(Some(Duration::from_secs(120)))
            .build()
            .into();
        let stream = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_global(Some(STREAM_LIFETIME))
            .build()
            .into();
        Self {
            base: base_url.trim().trim_end_matches('/').to_owned(),
            token: token.filter(|t| !t.is_empty()),
            agent,
            stream,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn auth<B>(&self, req: ureq::RequestBuilder<B>) -> ureq::RequestBuilder<B> {
        match &self.token {
            Some(token) => req.header("authorization", format!("Bearer {token}")),
            None => req,
        }
    }

    /// Turns transport failures and error statuses into [`Error`]s.
    fn check(&self, result: Result<Response, ureq::Error>) -> Result<Response> {
        let mut resp = result.map_err(|e| Error::Unreachable(format!("{}: {e}", self.base)))?;
        let status = resp.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(resp);
        }
        let text = resp.body_mut().read_to_string().unwrap_or_default();
        // Servers answer `{"error": "..."}`; anything else is shown as is.
        let message = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
            .unwrap_or(text);
        Err(match status {
            401 | 403 => Error::Unauthorized(message),
            409 => Error::Schema(message),
            _ => Error::Http(status, message),
        })
    }

    fn read_json<T: DeserializeOwned>(mut resp: Response) -> Result<T> {
        let text = resp
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_string()
            .map_err(|e| Error::Protocol(e.to_string()))?;
        serde_json::from_str(&text).map_err(|e| Error::Protocol(e.to_string()))
    }

    fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let resp = self.check(self.auth(self.agent.get(self.url(path))).call())?;
        Self::read_json(resp)
    }

    fn post_json<T: DeserializeOwned>(&self, path: &str, body: &impl Serialize) -> Result<T> {
        let body = serde_json::to_vec(body).map_err(|e| Error::Protocol(e.to_string()))?;
        let req = self
            .auth(self.agent.post(self.url(path)))
            .header("content-type", "application/json");
        Self::read_json(self.check(req.send(&body[..]))?)
    }

    /// `GET /info`: auth mode, schema and server time. Needs no credentials.
    pub fn info(&self) -> Result<ServerInfo> {
        self.get_json("/info")
    }

    pub fn push(&self, request: &PushRequest) -> Result<PushResult> {
        self.post_json("/sync/push", request)
    }

    pub fn pull(&self, after: i64, limit: u32) -> Result<PullPage> {
        self.get_json(&format!("/sync/pull?after={after}&limit={limit}"))
    }

    /// Whether the server holds attachment content with this hash.
    pub fn has_blob(&self, hash: &str) -> Result<bool> {
        let req = self.auth(self.agent.head(self.url(&format!("/blobs/{hash}"))));
        let resp = req
            .call()
            .map_err(|e| Error::Unreachable(format!("{}: {e}", self.base)))?;
        match resp.status().as_u16() {
            404 => Ok(false),
            _ => self.check(Ok(resp)).map(|_| true),
        }
    }

    pub fn put_blob(&self, hash: &str, bytes: &[u8]) -> Result<()> {
        let req = self
            .auth(self.agent.put(self.url(&format!("/blobs/{hash}"))))
            .header("content-type", "application/octet-stream");
        self.check(req.send(bytes)).map(|_| ())
    }

    pub fn get_blob(&self, hash: &str) -> Result<Vec<u8>> {
        let mut resp = self.check(
            self.auth(self.agent.get(self.url(&format!("/blobs/{hash}"))))
                .call(),
        )?;
        resp.body_mut()
            .with_config()
            .limit(u64::try_from(MAX_ATTACHMENT_BYTES).unwrap_or(u64::MAX))
            .read_to_vec()
            .map_err(|e| Error::Protocol(e.to_string()))
    }

    /// Trades an ID token from the server's OpenID provider for a device token.
    pub fn oidc_exchange(&self, id_token: &str, device_name: &str) -> Result<IssuedToken> {
        self.post_json(
            "/auth/oidc",
            &OidcExchange {
                id_token: id_token.to_owned(),
                device_name: device_name.to_owned(),
            },
        )
    }

    /// Follows `GET /events`: calls `on_head` with the server's newest op `seq` when it
    /// connects and whenever it moves. Returns `Ok` when `on_head` returns `false` or the
    /// server ends the stream, and an error when the connection fails (including the
    /// periodic reconnect after [`STREAM_LIFETIME`]); callers loop with a pause.
    pub fn watch(&self, mut on_head: impl FnMut(i64) -> bool) -> Result<()> {
        let resp = self.check(
            self.auth(self.stream.get(self.url("/events")))
                .header("accept", "text/event-stream")
                .call(),
        )?;
        let reader = BufReader::new(resp.into_body().into_reader());
        for line in reader.lines() {
            let line = line.map_err(|e| Error::Unreachable(e.to_string()))?;
            if let Some(data) = line.strip_prefix("data:")
                && let Ok(head) = data.trim().parse::<i64>()
                && !on_head(head)
            {
                return Ok(());
            }
        }
        Ok(())
    }
}

/// What one [`sync`] round did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SyncReport {
    /// Local ops sent.
    pub pushed: u32,
    /// Other replicas' ops applied here.
    pub pulled: u32,
    /// Repair ops written here after the pull (pushed in the same round).
    pub repairs: u32,
    pub files_up: u32,
    pub files_down: u32,
    /// Applied to this device's clock: the server's time minus ours.
    pub clock_offset_ms: i64,
    /// The server's newest op `seq`.
    pub head: i64,
    /// The server had less than this device last saw (restored from a backup, or a new
    /// server): this device sent all its ops again.
    pub server_reset: bool,
}

fn lock(store: &Mutex<Store>) -> MutexGuard<'_, Store> {
    store.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One full sync round. Safe to repeat: everything is idempotent on the server.
pub fn sync(client: &Client, store: &Mutex<Store>) -> Result<SyncReport> {
    let mut report = SyncReport::default();

    let before = now_ms();
    let info = client.info()?;
    let after = now_ms();
    let offset = info.server_time - (before + after) / 2;
    report.clock_offset_ms = if offset.abs() < CLOCK_NOISE_MS {
        0
    } else {
        offset
    };
    lock(store).set_clock_offset(report.clock_offset_ms);

    let schema = lock(store).schema_version()?;
    if info.schema_version != schema {
        return Err(Error::Schema(format!(
            "this app is at database version {schema} and the server at {}; update the \
             older one first",
            info.schema_version
        )));
    }

    // A server behind what this device already pulled lost data: send everything again.
    let cursor = lock(store).sync_cursor()?;
    if cursor > 0 && client.pull(cursor, 1)?.head < cursor {
        lock(store).restart_sync()?;
        report.server_reset = true;
    }

    push_all(client, store, schema, &mut report)?;
    loop {
        let cursor = lock(store).sync_cursor()?;
        let page = client.pull(cursor, PAGE)?;
        report.head = page.head;
        let more = page.page.more;
        let merged = lock(store).apply_remote(page.page.ops, Some(page.page.last_seq))?;
        report.pulled += merged.applied;
        report.repairs += merged.repairs;
        if !more {
            break;
        }
    }
    if report.repairs > 0 {
        push_all(client, store, schema, &mut report)?;
    }
    download_missing(client, store, &mut report)?;
    Ok(report)
}

fn push_all(
    client: &Client,
    store: &Mutex<Store>,
    schema: u32,
    report: &mut SyncReport,
) -> Result<()> {
    loop {
        let page = lock(store).outbox(PAGE)?;
        if page.ops.is_empty() {
            return Ok(());
        }
        // Content first: the server must hold a file before an attachment names it.
        for op in &page.ops {
            if op.entity == "attachment"
                && op.kind == "create"
                && let Some(hash) = op.patch.get("hash").and_then(|h| h.as_str())
            {
                let path = lock(store).files().and_then(|f| f.path(hash));
                if let Ok(path) = path
                    && path.exists()
                    && !client.has_blob(hash)?
                {
                    let bytes = std::fs::read(&path)
                        .map_err(|e| Error::Core(taskmaster_core::Error::Io(e)))?;
                    client.put_blob(hash, &bytes)?;
                    report.files_up += 1;
                }
            }
        }
        let count = u32::try_from(page.ops.len()).unwrap_or(u32::MAX);
        let result = client.push(&PushRequest {
            schema_version: schema,
            ops: page.ops,
        })?;
        if result.skipped > 0 {
            return Err(Error::Protocol(format!(
                "the server skipped {} operations for missing rows; changes remain pending",
                result.skipped
            )));
        }
        report.pushed += count;
        report.head = result.head;
        lock(store).mark_pushed(page.last_seq)?;
        if !page.more {
            return Ok(());
        }
    }
}

fn download_missing(client: &Client, store: &Mutex<Store>, report: &mut SyncReport) -> Result<()> {
    // A store without an attachment folder (tests, some tools) has nothing to fill.
    let Ok(missing) = lock(store).missing_files() else {
        return Ok(());
    };
    for hash in missing {
        let bytes = match client.get_blob(&hash) {
            Ok(bytes) => bytes,
            // The server never got it either (attached on a device that has not synced
            // its files yet): try again next round.
            Err(Error::Http(404, _)) => continue,
            Err(e) => return Err(e),
        };
        let stored = lock(store).files()?.put_bytes(&bytes)?;
        if stored.hash != hash {
            return Err(Error::Protocol(format!(
                "file {hash} arrived with different content"
            )));
        }
        report.files_down += 1;
    }
    Ok(())
}
