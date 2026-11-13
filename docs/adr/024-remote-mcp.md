# ADR 024: Remote MCP on the sync server (claude.ai and the mobile apps)

Date: 2026-11-13 · Status: accepted (M17, branch `m17-remote-mcp`)

## Context

`task-master-mcp` (ADR 017) is a stdio server over a local database: Claude Code and
Claude Desktop start it as a child process. claude.ai and the Claude mobile apps cannot
start a program. Their custom connectors call an MCP server **from Anthropic's cloud**,
over HTTPS, so the server must be reachable from the internet, speak the Streamable HTTP
transport, and sign the user in with OAuth as the MCP authorization spec describes.

The sync server (ADR 015) is the always-on replica and already checks Authelia tokens, so
it is the natural host. Requirements checked against the docs (2026-11-13):

- Claude: 401 with `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728), the
  protected resource metadata names the authorization server, which must serve RFC 8414
  or OpenID discovery. PKCE S256 always. Redirect `https://claude.ai/api/mcp/auth_callback`
  for web, desktop and mobile. A user-entered client ID with no secret makes Claude a
  public client. Refresh on 401 and before expiry. Egress from `160.79.104.0/21`.
- Authelia 4.39: no Dynamic Client Registration (planned for 4.40) and no Client ID
  Metadata Documents, so the connector uses "Use your own OAuth client" with a static
  client. RFC 9068 JWT access tokens per client (`access_token_signed_response_alg`), the
  access token audience from the client's `audience` list (`requested_audience_mode:
  implicit` grants it without an explicit request).

## Decisions

**Endpoint.** `POST /mcp` on the sync server, rmcp's Streamable HTTP server
(`transport-streamable-http-server`), stateless (`NeverSessionManager`, JSON responses):
no session to lose on a restart or behind the proxy. Off unless `TM_MCP=on`. The tools are
`taskmaster_mcp::TaskServer` without a session (the "added by hand" mode of docs/mcp.md):
reads everything, creates agent tasks, changes only agent tasks and plans time.

**One store.** `TaskServer::shared` serves the server's own `Arc<Mutex<Store>>`, so MCP
writes and sync pushes are serialized on one connection. Every MCP write runs a hook that
announces the new head on `/events` and kicks the calendar runner, as a push does, so
desktops pull the change within seconds.

**Auth: the server is an OAuth resource server; Authelia is the authorization server.**
The server never sees a password and issues nothing for MCP. A request to `/mcp` passes
only with:

- `TM_AUTH=none`: anything (private networks only, as for sync).
- A server token (`tm_…`) with scope `api:write` (`token add … --scope api:write`): for
  Claude Code or tests. A `sync` or `api:read` token gets 403.
- With `TM_AUTH=oidc`: an Authelia **access token** in RFC 9068 form: header
  `typ: at+jwt` (an ID token is refused even when well signed), signature from Authelia's
  JWKS (asymmetric algorithms only), `iss` = `TM_OIDC_ISSUER`, `aud` containing
  `<TM_PUBLIC_URL>/mcp`, `exp` in the future, `sub` present, `client_id` in
  `TM_MCP_OAUTH_CLIENTS` (default `task-master-claude`), and one of
  `TM_OIDC_ALLOWED_GROUPS` when that is set (add `groups` to the access token's claims
  policy).

Anything else gets 401 with `WWW-Authenticate: Bearer resource_metadata=
"<public>/.well-known/oauth-protected-resource/mcp"` (plus `error="invalid_token"` when a
token was sent). The metadata (`/.well-known/oauth-protected-resource` and `…/mcp`) names
`TM_OIDC_ISSUER` as the only authorization server, scopes `openid profile groups`, and is
served only with `TM_AUTH=oidc` and `TM_PUBLIC_URL`. `TM_MCP=on` with `oidc` requires
`TM_PUBLIC_URL`. rmcp's `Host` check allows the public URL's host and loopback.

**Exposure (homelab).** The whole host is public (next decision): the registry makes one
router per host, and a hand-written second router for the same host is refused by the
edge playbook. Public routes carry `geoblock-fr`, which would block Claude's US egress
(`160.79.104.0/21`) on `/mcp` and on Authelia's discovery and token endpoints, so that
range is in the middleware's `allowedIPAddresses` (checked before the country lookup).
Authelia is already public (the phone signs in there). The Authelia client is public
(PKCE, no secret), redirect `https://claude.ai/api/mcp/auth_callback`, `two_factor`,
`audience: [<public>/mcp]`, `requested_audience_mode: implicit`,
`access_token_signed_response_alg: RS256`, refresh tokens. Setup: docs/mcp.md, section 5.

**The sync server may be public too** (no VPN needed for desktops). It was already safe
to expose by design: every data route needs a server token (256-bit random, stored
hashed, revocable), and the only way to get one besides the CLI is an Authelia sign-in
(`/auth/oidc`). One gap is closed here: the token was checked inside the handlers, after
axum had read the body, so an anonymous caller could make the server buffer a 64 MB push.
Sync routes now sit behind a `route_layer` that checks the token first. Unauthenticated
routes left: `/health`, `/info` (name, version, auth mode, issuer), `/auth/oidc`, and the
MCP metadata. Homelab: `exposure: public` (rate limit, `geoblock-fr`, security
headers) and the desktop client at `two_factor`.

## Consequences

- New dependency edges: the server depends on `taskmaster-mcp` and on rmcp's HTTP server
  feature (rmcp is already in the tree). The server image builds the MCP crate.
- `AppState::store` is an `Arc<Mutex<Store>>`.
- Revoking access: remove the connector in Claude, or end the Authelia session/consent;
  tokens die at their expiry (Authelia default access token: 1 hour). The server keeps no
  MCP state to revoke.
- To verify on the first real connection: whether Claude sends RFC 8707 `resource` and
  Authelia accepts it, refresh token lifetime (Authelia default 1 h 30 min of idleness,
  then reconnect) and rotation.

## Alternatives

- Forward-auth in front of `/mcp`: Claude's backend has no Authelia cookie. Refused.
- Our server as an OAuth authorization server (DCR shim in front of Authelia): more code
  and a token store to secure; kept as the fallback if Authelia's flow fails, or wait for
  Authelia 4.40's DCR.
- A secret URL with no auth: anyone holding the URL can change tasks. Refused.
- Static request headers in the connector: in beta for a few organizations only.
