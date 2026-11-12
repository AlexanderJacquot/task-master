//! The task-master sync server (docs/adr/015-sync-server.md, setup in docs/server.md).
//!
//! One more replica of the core with its own SQLite file. Devices push their ops and pull
//! everyone else's; a server-sent-events stream tells them when there is something new.
//! Attachment content moves by hash. The API for other software comes in M14.

pub mod auth;
pub mod backup;
pub mod calendar;
pub mod config;

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::Stream;
use serde::Deserialize;
use taskmaster_core::{
    AuthMode, BlobList, IssuedToken, MAX_ATTACHMENT_BYTES, OidcExchange, PullPage, PushRequest,
    PushResult, ServerInfo, Store, is_hash, now_ms,
};
use tokio::sync::broadcast;

use crate::auth::{Oidc, Scope, Tokens};
use crate::config::Config;

/// Database file names inside the data folder.
pub const DATA_FILE: &str = "tasks.sqlite";
pub const TOKENS_FILE: &str = "server.sqlite";
/// Most ops one pull returns.
const MAX_PULL: u32 = 1_000;

pub struct AppState {
    pub config: Config,
    pub store: Mutex<Store>,
    pub tokens: Tokens,
    pub calendar: calendar::Runtime,
    oidc: Option<Oidc>,
    /// The newest op `seq`, announced to `/events` listeners after every push.
    heads: broadcast::Sender<i64>,
}

impl AppState {
    /// Opens (creating if needed) the data folder's databases.
    pub fn open(config: Config) -> Result<Arc<Self>, String> {
        std::fs::create_dir_all(&config.data_dir)
            .map_err(|e| format!("cannot create {}: {e}", config.data_dir.display()))?;
        let store = Store::open(config.data_dir.join(DATA_FILE)).map_err(|e| e.to_string())?;
        let tokens = Tokens::open(&config.data_dir.join(TOKENS_FILE)).map_err(|e| e.to_string())?;
        let state = Self::new(config, store, tokens);
        state.calendar.load(&state)?;
        Ok(state)
    }

    pub fn new(config: Config, store: Store, tokens: Tokens) -> Arc<Self> {
        let oidc = match (config.auth, &config.oidc_issuer) {
            (AuthMode::Oidc, Some(issuer)) => Some(Oidc::new(
                issuer,
                &config.oidc_client_id,
                config.oidc_allowed_groups.clone(),
            )),
            _ => None,
        };
        let (heads, _) = broadcast::channel(16);
        Arc::new(Self {
            config,
            store: Mutex::new(store),
            tokens,
            calendar: calendar::Runtime::default(),
            oidc,
            heads,
        })
    }

    pub fn store(&self) -> MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn backup_dir(&self) -> PathBuf {
        self.config.data_dir.join("backups")
    }
}

/// An error answer: `{"error": "..."}` with a status.
#[derive(Debug)]
pub struct ApiError(StatusCode, String);

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self(status, message.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

impl From<taskmaster_core::Error> for ApiError {
    fn from(e: taskmaster_core::Error) -> Self {
        let status = match e.kind() {
            "invalid" => StatusCode::BAD_REQUEST,
            "not_found" => StatusCode::NOT_FOUND,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self(status, e.to_string())
    }
}

type ApiResult<T> = Result<T, ApiError>;

/// Runs store work off the async threads.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> ApiResult<T> + Send + 'static,
) -> ApiResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
}

/// Lets the request through when the server needs no auth, or the bearer token's scope
/// covers `needed`.
fn authorize(state: &AppState, headers: &HeaderMap, needed: Scope) -> ApiResult<()> {
    if state.config.auth == AuthMode::None {
        return Ok(());
    }
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "this server needs a token"))?;
    match state.tokens.check(token) {
        Some(scope) if scope.allows(needed) => Ok(()),
        Some(scope) => Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!("a {} token cannot do this", scope.as_str()),
        )),
        None => Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unknown or revoked token",
        )),
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    let blob_limit = usize::try_from(MAX_ATTACHMENT_BYTES).unwrap_or(usize::MAX) + 1024;
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/info", get(info))
        .route(
            "/sync/push",
            post(push).layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route("/sync/pull", get(pull))
        .route("/events", get(events))
        .route("/blobs", get(list_blobs))
        .route(
            "/blobs/{hash}",
            get(get_blob)
                .head(head_blob)
                .put(put_blob)
                .delete(delete_blob)
                .layer(DefaultBodyLimit::max(blob_limit)),
        )
        .route("/calendar/status", get(calendar::get_status))
        .route("/calendar/runner", post(calendar::transfer))
        .route("/calendar/lease", post(calendar::lease))
        .route("/calendar/sync", post(calendar::sync_now))
        .route("/calendar/shown", post(calendar::shown))
        .route("/calendar/events", get(calendar::events))
        .route("/auth/oidc", post(oidc_exchange))
        .with_state(state)
}

fn server_info(state: &AppState) -> ApiResult<ServerInfo> {
    Ok(ServerInfo {
        name: "task-master".into(),
        version: taskmaster_core::VERSION.into(),
        schema_version: state.store().schema_version()?,
        auth: state.config.auth,
        oidc_issuer: state.oidc.as_ref().and(state.config.oidc_issuer.clone()),
        oidc_client_id: state
            .oidc
            .as_ref()
            .map(|_| state.config.oidc_client_id.clone()),
        server_time: now_ms(),
        public_url: state.config.public_url.clone(),
    })
}

async fn info(State(state): State<Arc<AppState>>) -> ApiResult<Json<ServerInfo>> {
    server_info(&state).map(Json)
}

async fn push(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<PushRequest>,
) -> ApiResult<Json<PushResult>> {
    authorize(&state, &headers, Scope::Sync)?;
    let shared = state.clone();
    let result = blocking(move || {
        let mut store = shared.store();
        let schema = store.schema_version()?;
        if request.schema_version != schema {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                format!(
                    "the server is at database version {schema} and this app at {}; update \
                     the older one first",
                    request.schema_version
                ),
            ));
        }
        let merged = store.apply_remote(request.ops, None)?;
        Ok(PushResult {
            applied: merged.applied,
            duplicates: merged.duplicates,
            skipped: merged.skipped,
            repairs: merged.repairs,
            head: store.last_seq()?,
        })
    })
    .await?;
    let _ = state.heads.send(result.head);
    state.calendar.kick();
    Ok(Json(result))
}

#[derive(Deserialize)]
struct PullQuery {
    #[serde(default)]
    after: i64,
    limit: Option<u32>,
}

async fn pull(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<PullQuery>,
) -> ApiResult<Json<PullPage>> {
    authorize(&state, &headers, Scope::Sync)?;
    let limit = q.limit.unwrap_or(MAX_PULL).clamp(1, MAX_PULL);
    blocking(move || {
        let store = state.store();
        Ok(Json(PullPage {
            page: store.ops_after(q.after, limit)?,
            head: store.last_seq()?,
        }))
    })
    .await
}

async fn events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    authorize(&state, &headers, Scope::Sync)?;
    let receiver = state.heads.subscribe();
    let first = state.store().last_seq()?;
    let stream = futures_util::stream::unfold(
        (Some(first), receiver),
        |(first, mut receiver)| async move {
            if let Some(head) = first {
                return Some((Ok(head_event(head)), (None, receiver)));
            }
            loop {
                match receiver.recv().await {
                    // The server is shutting down: end the stream so it can stop.
                    Ok(head) if head < 0 => return None,
                    Ok(head) => return Some((Ok(head_event(head)), (None, receiver))),
                    // Missed a few: the next one carries the newest head anyway.
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        },
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

fn head_event(head: i64) -> Event {
    Event::default().event("head").data(head.to_string())
}

fn blob_path(state: &AppState, hash: &str) -> ApiResult<PathBuf> {
    if !is_hash(hash) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "not a SHA-256 hash"));
    }
    Ok(state.store().files()?.path(hash)?)
}

async fn head_blob(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(hash): Path<String>,
) -> ApiResult<StatusCode> {
    authorize(&state, &headers, Scope::Sync)?;
    let path = blob_path(&state, &hash)?;
    Ok(if path.exists() {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    })
}

async fn get_blob(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(hash): Path<String>,
) -> ApiResult<Response> {
    authorize(&state, &headers, Scope::Sync)?;
    let path = blob_path(&state, &hash)?;
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(ApiError::new(StatusCode::NOT_FOUND, "no such file"))
        }
        Err(e) => Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            e.to_string(),
        )),
    }
}

async fn put_blob(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(hash): Path<String>,
    body: Bytes,
) -> ApiResult<StatusCode> {
    authorize(&state, &headers, Scope::Sync)?;
    blob_path(&state, &hash)?;
    blocking(move || {
        let stored = state.store().files()?.put_bytes(&body)?;
        if stored.hash != hash {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("the content's hash is {}, not {hash}", stored.hash),
            ));
        }
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

/// `GET /blobs`: the content held here and the purged hashes (Settings → Files, ADR 023).
async fn list_blobs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<BlobList>> {
    authorize(&state, &headers, Scope::Sync)?;
    blocking(move || {
        let store = state.store();
        let files = store.files()?;
        Ok(Json(BlobList {
            files: files.entries()?,
            purged: files.purged()?,
        }))
    })
    .await
}

/// `DELETE /blobs/{hash}`: purges content no live attachment uses and keeps a tombstone,
/// so the other devices drop their copy. 409 while an attachment still uses it.
async fn delete_blob(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(hash): Path<String>,
) -> ApiResult<StatusCode> {
    authorize(&state, &headers, Scope::Sync)?;
    blob_path(&state, &hash)?;
    blocking(move || {
        let report = state.store().purge_files(std::slice::from_ref(&hash))?;
        if report.in_use > 0 {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "a live attachment still uses this file",
            ));
        }
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

async fn oidc_exchange(
    State(state): State<Arc<AppState>>,
    Json(request): Json<OidcExchange>,
) -> ApiResult<Json<IssuedToken>> {
    if state.oidc.is_none() {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "this server does not use OpenID Connect",
        ));
    }
    blocking(move || {
        let Some(oidc) = state.oidc.as_ref() else {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "no OpenID Connect"));
        };
        let claims = oidc
            .verify(&request.id_token)
            .map_err(|e| ApiError::new(StatusCode::UNAUTHORIZED, e))?;
        let user = claims.preferred_username.unwrap_or(claims.sub);
        let device: String = request
            .device_name
            .chars()
            .filter(|c| !c.is_control())
            .take(64)
            .collect();
        let device = if device.trim().is_empty() {
            "device".into()
        } else {
            device
        };
        let name = format!("{user}@{}", device.trim());
        let token = state
            .tokens
            .add(&name, Scope::Sync)
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        Ok(Json(IssuedToken { token, name }))
    })
    .await
}

/// Serves until Ctrl+C or SIGTERM.
pub async fn serve(state: Arc<AppState>) -> Result<(), String> {
    calendar::spawn(state.clone());
    let listener = tokio::net::TcpListener::bind(&state.config.listen)
        .await
        .map_err(|e| format!("cannot listen on {}: {e}", state.config.listen))?;
    eprintln!(
        "task-master-server {} listening on {} (auth: {:?}, data: {})",
        taskmaster_core::VERSION,
        state.config.listen,
        state.config.auth,
        state.config.data_dir.display()
    );
    let heads = state.heads.clone();
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async move {
            shutdown().await;
            let _ = heads.send(-1);
        })
        .await
        .map_err(|e| e.to_string())
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = term => {},
    }
}
