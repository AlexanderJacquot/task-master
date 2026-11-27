//! The task-master sync server (docs/adr/015-sync-server.md, setup in docs/server.md).
//!
//! One more replica of the core with its own SQLite file. Devices push their ops and pull
//! everyone else's; a server-sent-events stream tells them when there is something new.
//! Attachment content moves by hash. The API for other software comes in M14.

pub mod auth;
pub mod backup;
pub mod calendar;
pub mod config;
pub mod mcp;
pub mod raster;
pub mod roadmap;

use std::collections::HashMap;
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
    ATTACHMENTS_DIR, AuthMode, BlobList, Command, IssuedToken, MAX_ATTACHMENT_BYTES, NewMember,
    OidcExchange, PullPage, PushRequest, PushResult, ServerInfo, Space, Store, TeamInfo,
    TeamMember, is_hash, now_ms,
};
use tokio::sync::broadcast;

use crate::auth::{Grant, Oidc, Scope, Tokens, User};
use crate::config::Config;

/// Database file names inside the data folder.
pub const DATA_FILE: &str = "tasks.sqlite";
pub const TOKENS_FILE: &str = "server.sqlite";
/// Most ops one pull returns.
const MAX_PULL: u32 = 1_000;

/// One replicated database the server holds (ADR 015), and the stream that announces its
/// newest op `seq`. A personal server has one; a team server (ADR 033) one for the team
/// and one per member's personal space.
pub struct Replica {
    pub store: Arc<Mutex<Store>>,
    heads: broadcast::Sender<i64>,
}

impl Replica {
    fn new(store: Store) -> Arc<Self> {
        let (heads, _) = broadcast::channel(16);
        Arc::new(Self {
            store: Arc::new(Mutex::new(store)),
            heads,
        })
    }

    pub fn store(&self) -> MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Tells `/events` listeners about its newest op.
    pub fn announce(&self) {
        if let Ok(head) = self.store().last_seq() {
            let _ = self.heads.send(head);
        }
    }
}

pub struct AppState {
    pub config: Config,
    /// The server's own space: everything on a personal server; on a team server, the
    /// space of tokens that belong to no user. Shared with the remote MCP tools (ADR 024)
    /// and the calendar runner, which write through the same connection.
    pub store: Arc<Mutex<Store>>,
    pub tokens: Tokens,
    pub calendar: calendar::Runtime,
    oidc: Option<Oidc>,
    /// The newest op `seq` of `store`, announced to `/events` listeners after every push.
    heads: broadcast::Sender<i64>,
    main: Arc<Replica>,
    /// The team space (`TM_TEAM=on`, ADR 033).
    pub team: Option<Arc<Replica>>,
    /// Members' personal spaces, opened on first use, by user id.
    personal: Mutex<HashMap<String, Arc<Replica>>>,
}

/// Folder of the space databases on a team server: `team/` and `user-<id>/`, each with its
/// `tasks.sqlite` and `attachments/`.
pub const SPACES_DIR: &str = "spaces";

impl AppState {
    /// Opens (creating if needed) the data folder's databases.
    pub fn open(config: Config) -> Result<Arc<Self>, String> {
        std::fs::create_dir_all(&config.data_dir)
            .map_err(|e| format!("cannot create {}: {e}", config.data_dir.display()))?;
        let store = Store::open(config.data_dir.join(DATA_FILE)).map_err(|e| e.to_string())?;
        let tokens = Tokens::open(&config.data_dir.join(TOKENS_FILE)).map_err(|e| e.to_string())?;
        let team = if config.team {
            let path = config
                .data_dir
                .join(SPACES_DIR)
                .join("team")
                .join(DATA_FILE);
            Some(Store::open(path).map_err(|e| e.to_string())?)
        } else {
            None
        };
        let state = Self::with_team(config, store, tokens, team);
        state.calendar.load(&state)?;
        state.reconcile_members()?;
        Ok(state)
    }

    /// A server over the given stores. With `TM_TEAM=on`, an in-memory team space keeps
    /// its attachment content under the data folder.
    pub fn new(config: Config, store: Store, tokens: Tokens) -> Arc<Self> {
        let team = config.team.then(|| {
            let files = config
                .data_dir
                .join(SPACES_DIR)
                .join("team")
                .join(ATTACHMENTS_DIR);
            Store::open_in_memory()
                .expect("an in-memory database opens")
                .with_files(files)
        });
        let state = Self::with_team(config, store, tokens, team);
        let _ = state.reconcile_members();
        state
    }

    fn with_team(config: Config, store: Store, tokens: Tokens, team: Option<Store>) -> Arc<Self> {
        let oidc = match (config.auth, &config.oidc_issuer) {
            (AuthMode::Oidc, Some(issuer)) => Some(Oidc::new(
                issuer,
                &config.oidc_client_id,
                config.oidc_allowed_groups.clone(),
            )),
            _ => None,
        };
        let main = Replica::new(store);
        Arc::new(Self {
            config,
            store: main.store.clone(),
            tokens,
            calendar: calendar::Runtime::default(),
            oidc,
            heads: main.heads.clone(),
            main,
            team: team.map(Replica::new),
            personal: Mutex::new(HashMap::new()),
        })
    }

    pub fn store(&self) -> MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Tells `/events` listeners about new ops written here (not by a push), and wakes the
    /// calendar runner.
    pub fn announce(&self) {
        self.main.announce();
        self.calendar.kick();
    }

    pub fn backup_dir(&self) -> PathBuf {
        self.config.data_dir.join("backups")
    }

    /// A member's personal space on a team server, opened (or created) on first use.
    pub fn personal_space(&self, user_id: &str) -> Result<Arc<Replica>, String> {
        if !user_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return Err(format!("bad user id '{user_id}'"));
        }
        let mut open = self.personal.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(replica) = open.get(user_id) {
            return Ok(replica.clone());
        }
        let path = self
            .config
            .data_dir
            .join(SPACES_DIR)
            .join(format!("user-{user_id}"))
            .join(DATA_FILE);
        let replica = Replica::new(Store::open(path).map_err(|e| e.to_string())?);
        open.insert(user_id.to_owned(), replica.clone());
        Ok(replica)
    }

    /// Every space database besides the server's own, for backups: the team's, then each
    /// user's personal one found on disk, with their folder names.
    pub fn spaces(&self) -> Result<Vec<(String, Arc<Replica>)>, String> {
        let mut out = Vec::new();
        if let Some(team) = &self.team {
            out.push(("team".to_owned(), team.clone()));
        }
        let dir = self.config.data_dir.join(SPACES_DIR);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(out);
        };
        let mut users: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_str().map(str::to_owned))
            .filter_map(|n| n.strip_prefix("user-").map(str::to_owned))
            .collect();
        users.sort();
        for user in users {
            out.push((format!("user-{user}"), self.personal_space(&user)?));
        }
        Ok(out)
    }

    /// Makes the team space's members match the users (ADR 033): a new or renamed user is
    /// written as a member, a removed one leaves. The server is the only writer of members.
    pub fn reconcile_members(&self) -> Result<(), String> {
        let Some(team) = &self.team else {
            return Ok(());
        };
        let users = self.tokens.users()?;
        let changes = {
            let mut store = team.store();
            let members: HashMap<String, String> = store
                .members()
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|m| (m.id, m.name))
                .collect();
            let mut commands = Vec::new();
            for user in users {
                match (user.removed_at, members.get(&user.id)) {
                    (Some(_), Some(_)) => commands.push(Command::DeleteMember { id: user.id }),
                    (None, Some(name)) if *name == user.name => {}
                    (None, _) => commands.push(Command::CreateMember {
                        member: NewMember {
                            id: user.id,
                            name: user.name,
                            color: None,
                        },
                    }),
                    (Some(_), None) => {}
                }
            }
            if commands.is_empty() {
                return Ok(());
            }
            store
                .execute_without_undo(commands)
                .map_err(|e| e.to_string())?
        };
        if !changes.is_empty() {
            team.announce();
        }
        Ok(())
    }
}

/// An error answer: `{"error": "..."}` with a status.
#[derive(Debug)]
pub struct ApiError(StatusCode, String);

impl ApiError {
    pub(crate) fn new(status: StatusCode, message: impl Into<String>) -> Self {
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

pub(crate) type ApiResult<T> = Result<T, ApiError>;

/// Runs store work off the async threads.
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> ApiResult<T> + Send + 'static,
) -> ApiResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
}

/// Lets the request through when the server needs no auth, or the bearer token's scope
/// covers `needed`. Returns what the token grants (`None` without auth).
fn authorize(state: &AppState, headers: &HeaderMap, needed: Scope) -> ApiResult<Option<Grant>> {
    authorize_any(state, headers, &[needed])
}

/// As [`authorize`], for a request any of `allowed` may make (a read open to devices and
/// to API tokens).
pub(crate) fn authorize_any(
    state: &AppState,
    headers: &HeaderMap,
    allowed: &[Scope],
) -> ApiResult<Option<Grant>> {
    if state.config.auth == AuthMode::None {
        return Ok(None);
    }
    let token = bearer(headers)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "this server needs a token"))?;
    match state.tokens.grant(token) {
        Some(grant) if allowed.iter().any(|&needed| grant.scope.allows(needed)) => Ok(Some(grant)),
        Some(grant) => Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!("a {} token cannot do this", grant.scope.as_str()),
        )),
        None => Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unknown or revoked token",
        )),
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
}

/// The replica a device's request reads and writes, and the member making it (ADR 033).
/// `/team/…` routes serve the team space, to members only. The others serve the caller's
/// personal space: on a team server, a member's own; else the server's.
fn replica(
    state: &AppState,
    headers: &HeaderMap,
    space: Space,
) -> ApiResult<(Arc<Replica>, Option<User>)> {
    let user = authorize(state, headers, Scope::Sync)?.and_then(|g| g.user);
    match space {
        Space::Team => {
            let team = state
                .team
                .clone()
                .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "this server runs no team"))?;
            let user = user.ok_or_else(|| {
                ApiError::new(
                    StatusCode::FORBIDDEN,
                    "this token belongs to no team member",
                )
            })?;
            Ok((team, Some(user)))
        }
        Space::Personal => match (&state.team, user) {
            (Some(_), Some(user)) => {
                let personal = state
                    .personal_space(&user.id)
                    .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
                Ok((personal, Some(user)))
            }
            _ => Ok((state.main.clone(), None)),
        },
    }
}

/// The routes a device uses for one space, under `prefix` ("" or "/team").
fn space_routes(state: &Arc<AppState>, prefix: &str, space: Space) -> Router<Arc<AppState>> {
    let blob_limit = usize::try_from(MAX_ATTACHMENT_BYTES).unwrap_or(usize::MAX) + 1024;
    Router::new()
        .route(
            &format!("{prefix}/sync/push"),
            post(
                move |State(s): State<Arc<AppState>>, h: HeaderMap, Json(r): Json<PushRequest>| {
                    push(s, h, r, space)
                },
            )
            .layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route(
            &format!("{prefix}/sync/pull"),
            get(
                move |State(s): State<Arc<AppState>>, h: HeaderMap, Query(q): Query<PullQuery>| {
                    pull(s, h, q, space)
                },
            ),
        )
        .route(
            &format!("{prefix}/events"),
            get(move |State(s): State<Arc<AppState>>, h: HeaderMap| events(s, h, space)),
        )
        .route(
            &format!("{prefix}/blobs"),
            get(move |State(s): State<Arc<AppState>>, h: HeaderMap| list_blobs(s, h, space)),
        )
        .route(
            &format!("{prefix}/blobs/{{hash}}"),
            get(
                move |State(s): State<Arc<AppState>>, h: HeaderMap, Path(hash): Path<String>| {
                    get_blob(s, h, hash, space)
                },
            )
            .head(
                move |State(s): State<Arc<AppState>>, h: HeaderMap, Path(hash): Path<String>| {
                    head_blob(s, h, hash, space)
                },
            )
            .put(
                move |State(s): State<Arc<AppState>>,
                      h: HeaderMap,
                      Path(hash): Path<String>,
                      body: Bytes| put_blob(s, h, hash, body, space),
            )
            .delete(
                move |State(s): State<Arc<AppState>>, h: HeaderMap, Path(hash): Path<String>| {
                    delete_blob(s, h, hash, space)
                },
            )
            .layer(DefaultBodyLimit::max(blob_limit)),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_sync,
        ))
}

pub fn router(state: Arc<AppState>) -> Router {
    // Everything a device does. The token is checked before the body is read, so an
    // anonymous caller cannot make the server buffer a 64 MB push or an attachment.
    let calendar = Router::new()
        .route("/calendar/status", get(calendar::get_status))
        .route("/calendar/runner", post(calendar::transfer))
        .route("/calendar/lease", post(calendar::lease))
        .route("/calendar/sync", post(calendar::sync_now))
        .route("/calendar/shown", post(calendar::shown))
        .route("/calendar/events", get(calendar::events))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_sync,
        ));
    let mut app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/info", get(info))
        .route("/auth/oidc", post(oidc_exchange))
        // A read for integrations as well as devices (ADR 035): checked in the handler.
        .route("/roadmap.svg", get(roadmap::svg))
        .route("/roadmap.png", get(roadmap::png))
        .merge(space_routes(&state, "", Space::Personal))
        .merge(calendar);
    if state.team.is_some() {
        app = app.merge(space_routes(&state, "/team", Space::Team));
    }
    app.with_state(state.clone()).merge(mcp::routes(state))
}

/// Refuses a request without a `sync` token before its body is read. The handlers check
/// again (cheap), so a route moved out of this group stays protected.
async fn require_sync(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    match authorize(&state, request.headers(), Scope::Sync) {
        Ok(_) => next.run(request).await,
        Err(refusal) => refusal.into_response(),
    }
}

fn server_info(state: &AppState, headers: &HeaderMap) -> ApiResult<ServerInfo> {
    let team = state.config.team.then(|| TeamInfo {
        name: state.config.team_name.clone(),
        me: bearer(headers)
            .and_then(|t| state.tokens.grant(t))
            .and_then(|g| g.user)
            .map(|u| TeamMember {
                id: u.id,
                name: u.name,
            }),
    });
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
        team,
    })
}

async fn info(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<ServerInfo>> {
    blocking(move || server_info(&state, &headers).map(Json)).await
}

async fn push(
    state: Arc<AppState>,
    headers: HeaderMap,
    mut request: PushRequest,
    space: Space,
) -> ApiResult<Json<PushResult>> {
    let (replica, user) = replica(&state, &headers, space)?;
    let shared = state.clone();
    let target = replica.clone();
    let result = blocking(move || {
        if space == Space::Team {
            shared
                .reconcile_members()
                .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        }
        let mut store = target.store();
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
        if space == Space::Team {
            let user = user.as_ref().map(|u| u.id.as_str());
            request.ops = team_ops(&store, request.ops, user)?;
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
    let _ = replica.heads.send(result.head);
    if space == Space::Personal && Arc::ptr_eq(&replica, &state.main) {
        state.calendar.kick();
    }
    Ok(Json(result))
}

/// The ops a member may push to the team space (ADR 033): their own, never a member (the
/// server writes those). Ops of others the server already has are dropped as duplicates
/// (a device resending everything after a server reset); any other is refused, so nobody
/// writes in someone else's name.
fn team_ops(
    store: &Store,
    ops: Vec<taskmaster_core::SyncOp>,
    user: Option<&str>,
) -> ApiResult<Vec<taskmaster_core::SyncOp>> {
    let mut mine = Vec::with_capacity(ops.len());
    for op in ops {
        if op.entity == "member" {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "members are written by the server",
            ));
        }
        if op.author_id.as_deref() == user && user.is_some() {
            mine.push(op);
        } else if !store.has_op(&op.op_id)? {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                format!("op {} names another author", op.op_id),
            ));
        }
    }
    Ok(mine)
}

#[derive(Deserialize)]
struct PullQuery {
    #[serde(default)]
    after: i64,
    limit: Option<u32>,
}

async fn pull(
    state: Arc<AppState>,
    headers: HeaderMap,
    q: PullQuery,
    space: Space,
) -> ApiResult<Json<PullPage>> {
    let (replica, _) = replica(&state, &headers, space)?;
    let limit = q.limit.unwrap_or(MAX_PULL).clamp(1, MAX_PULL);
    blocking(move || {
        if space == Space::Team {
            state
                .reconcile_members()
                .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        }
        let store = replica.store();
        Ok(Json(PullPage {
            page: store.ops_after(q.after, limit)?,
            head: store.last_seq()?,
        }))
    })
    .await
}

async fn events(
    state: Arc<AppState>,
    headers: HeaderMap,
    space: Space,
) -> ApiResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let (replica, _) = replica(&state, &headers, space)?;
    let receiver = replica.heads.subscribe();
    let first = replica.store().last_seq()?;
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

fn blob_path(replica: &Replica, hash: &str) -> ApiResult<PathBuf> {
    if !is_hash(hash) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "not a SHA-256 hash"));
    }
    Ok(replica.store().files()?.path(hash)?)
}

async fn head_blob(
    state: Arc<AppState>,
    headers: HeaderMap,
    hash: String,
    space: Space,
) -> ApiResult<StatusCode> {
    let (replica, _) = replica(&state, &headers, space)?;
    let path = blob_path(&replica, &hash)?;
    Ok(if path.exists() {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    })
}

async fn get_blob(
    state: Arc<AppState>,
    headers: HeaderMap,
    hash: String,
    space: Space,
) -> ApiResult<Response> {
    let (replica, _) = replica(&state, &headers, space)?;
    let path = blob_path(&replica, &hash)?;
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
    state: Arc<AppState>,
    headers: HeaderMap,
    hash: String,
    body: Bytes,
    space: Space,
) -> ApiResult<StatusCode> {
    let (replica, _) = replica(&state, &headers, space)?;
    blob_path(&replica, &hash)?;
    blocking(move || {
        let stored = replica.store().files()?.put_bytes(&body)?;
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
    state: Arc<AppState>,
    headers: HeaderMap,
    space: Space,
) -> ApiResult<Json<BlobList>> {
    let (replica, _) = replica(&state, &headers, space)?;
    blocking(move || {
        let store = replica.store();
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
    state: Arc<AppState>,
    headers: HeaderMap,
    hash: String,
    space: Space,
) -> ApiResult<StatusCode> {
    let (replica, _) = replica(&state, &headers, space)?;
    blob_path(&replica, &hash)?;
    blocking(move || {
        let report = replica.store().purge_files(std::slice::from_ref(&hash))?;
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
    let stopping = state.clone();
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async move {
            shutdown().await;
            // End every open event stream, so the server can stop.
            let _ = stopping.heads.send(-1);
            if let Some(team) = &stopping.team {
                let _ = team.heads.send(-1);
            }
            for replica in stopping
                .personal
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .values()
            {
                let _ = replica.heads.send(-1);
            }
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
