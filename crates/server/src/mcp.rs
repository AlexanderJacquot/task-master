//! Remote MCP for claude.ai and the Claude mobile apps (docs/adr/024-remote-mcp.md).
//!
//! `POST /mcp` serves the stdio server's tools (`taskmaster_mcp::TaskServer`, without a
//! session) over rmcp's Streamable HTTP transport, statelessly, on the server's own store.
//! This server is an OAuth *resource server*: the identity provider (Authelia) signs the
//! user in and issues access tokens; every request here must carry one (or a server token
//! with `api:write`). The protected resource metadata (RFC 9728) tells Claude where to sign
//! in.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use taskmaster_core::AuthMode;
use taskmaster_mcp::TaskServer;

use crate::AppState;
use crate::auth::Scope;

pub const MCP_PATH: &str = "/mcp";
pub const METADATA_PATH: &str = "/.well-known/oauth-protected-resource";

/// Scopes Claude asks Authelia for (it adds `offline_access` itself when offered).
const SCOPES: &[&str] = &["openid", "profile", "groups"];

/// Where OAuth applies: the resource URL Claude is given, and the metadata URL that
/// describes it. `None` unless the server signs in with OIDC and knows its public URL.
fn oauth(state: &AppState) -> Option<(String, String)> {
    if state.config.auth != AuthMode::Oidc || state.oidc.is_none() {
        return None;
    }
    let public = state.config.public_url.as_deref()?;
    Some((
        format!("{public}{MCP_PATH}"),
        format!("{public}{METADATA_PATH}{MCP_PATH}"),
    ))
}

/// The `/mcp` endpoint and its metadata; empty when `TM_MCP` is off.
pub fn routes(state: Arc<AppState>) -> Router {
    if !state.config.mcp {
        return Router::new();
    }
    let weak = Arc::downgrade(&state);
    let tools = TaskServer::shared(state.store.clone()).with_on_write(Arc::new(move || {
        if let Some(state) = weak.upgrade() {
            state.announce();
        }
    }));
    let mut config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true);
    // rmcp refuses other `Host`s (DNS rebinding); allow the public name and loopback.
    // Without a public URL (a LAN setup), any host.
    config = match public_host(state.config.public_url.as_deref()) {
        Some(host) => {
            config.with_allowed_hosts([host, "localhost".into(), "127.0.0.1".into(), "::1".into()])
        }
        None => config.disable_allowed_hosts(),
    };
    let service = StreamableHttpService::new(
        move || Ok(tools.clone()),
        Arc::new(NeverSessionManager::default()),
        config,
    );
    let mcp = Router::new()
        .route_service(MCP_PATH, service)
        .layer(middleware::from_fn_with_state(state.clone(), guard));
    Router::new()
        .route(METADATA_PATH, get(metadata))
        .route(&format!("{METADATA_PATH}{MCP_PATH}"), get(metadata))
        .with_state(state)
        .merge(mcp)
}

fn public_host(public_url: Option<&str>) -> Option<String> {
    let url = url::Url::parse(public_url?).ok()?;
    url.host_str().map(str::to_owned)
}

/// RFC 9728 protected resource metadata.
async fn metadata(State(state): State<Arc<AppState>>) -> Response {
    let (Some((resource, _)), Some(issuer)) = (oauth(&state), state.config.oidc_issuer.clone())
    else {
        return (
            StatusCode::NOT_FOUND,
            "this server does not use OAuth for MCP",
        )
            .into_response();
    };
    Json(serde_json::json!({
        "resource": resource,
        "authorization_servers": [issuer],
        "scopes_supported": SCOPES,
        "bearer_methods_supported": ["header"],
        "resource_name": "task-master",
    }))
    .into_response()
}

/// Lets a request through to the tools only with valid credentials.
async fn guard(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    match refusal(state, request.headers()).await {
        None => next.run(request).await,
        Some(refusal) => refusal,
    }
}

/// Why a request may not use the tools, as the answer to send; `None` lets it through.
async fn refusal(state: Arc<AppState>, headers: &HeaderMap) -> Option<Response> {
    if state.config.auth == AuthMode::None {
        return None;
    }
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned);
    let Some(token) = token else {
        return Some(challenge(&state, None, "this server needs a token"));
    };
    if token.starts_with("tm_") {
        return match state.tokens.check(&token) {
            Some(scope) if scope.allows(Scope::ApiWrite) => None,
            Some(scope) => Some(refuse(
                StatusCode::FORBIDDEN,
                &format!(
                    "a {} token cannot use MCP; it needs api:write",
                    scope.as_str()
                ),
                Some(r#"Bearer error="insufficient_scope""#.to_owned()),
            )),
            None => Some(challenge(
                &state,
                Some("invalid_token"),
                "unknown or revoked token",
            )),
        };
    }
    let Some((resource, _)) = oauth(&state) else {
        return Some(challenge(&state, Some("invalid_token"), "unknown token"));
    };
    let clients = state.config.mcp_oauth_clients.clone();
    let shared = state.clone();
    let verdict = tokio::task::spawn_blocking(move || {
        shared
            .oidc
            .as_ref()
            .map(|oidc| oidc.verify_access(&token, &resource, &clients))
    })
    .await;
    match verdict {
        Ok(Some(Ok(_))) => None,
        Ok(Some(Err(why))) => {
            // The reason only (never the token): the first thing to read when Claude
            // cannot connect (docs/mcp.md, section 5).
            eprintln!("mcp: access token refused: {why}");
            Some(challenge(&state, Some("invalid_token"), &why))
        }
        Ok(None) | Err(_) => Some(refuse(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot check the token",
            None,
        )),
    }
}

/// 401 with the `WWW-Authenticate` header that sends Claude to the metadata (RFC 9728).
fn challenge(state: &AppState, error: Option<&str>, message: &str) -> Response {
    let mut value = match oauth(state) {
        Some((_, metadata)) => format!(r#"Bearer resource_metadata="{metadata}""#),
        None => r#"Bearer realm="task-master""#.to_owned(),
    };
    if let Some(error) = error {
        value.push_str(&format!(r#", error="{error}""#));
    }
    refuse(StatusCode::UNAUTHORIZED, message, Some(value))
}

fn refuse(status: StatusCode, message: &str, www_authenticate: Option<String>) -> Response {
    let mut response = (status, Json(serde_json::json!({ "error": message }))).into_response();
    if let Some(value) = www_authenticate.and_then(|v| HeaderValue::from_str(&v).ok()) {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, value);
    }
    response
}
