# Sync server setup

The sync server keeps an always-on copy of your tasks. Desktops sync with it in the
background, and it can also run Google Calendar sync and a remote MCP endpoint for
claude.ai while your computers are off. You host it yourself: it ships as one Docker
image, `ghcr.io/alexanderjacquot/task-master-server`. Design: `docs/adr/015-sync-server.md`.

An HTTP API for other software (dashboards, scripts) is planned; the `api:read` and
`api:write` token scopes already exist for it, for the remote MCP endpoint and for roadmap
images (`GET /roadmap.svg`, `GET /roadmap.png`, section 6).

## 1. How it fits together

- Each desktop keeps its own database and works offline. About 2 seconds after an edit
  it pushes its new changes. When the server says something changed, it pulls.
- The server runs the same core as the desktop, with its own SQLite file in `/data`.
- Conflicts sort themselves out: the latest edit wins, field by field, and a delete wins
  over a later edit. You never pick between versions.
- Attachments upload once, by content hash, and other devices download them during their
  next sync.
- Desktop and server must run the same version (same database schema). Update them
  together.

## 2. Pick an auth mode

The desktop only asks for the server's URL, then reads the auth mode from `GET /info`
and shows what that mode needs.

| `TM_AUTH` | Desktop asks for | Use it when |
| --- | --- | --- |
| `none` | Nothing | A private network only (LAN, VPN). Anyone who can reach the URL can read and change your tasks. |
| `token` | A token you paste | Any network. Tokens are made on the server (section 6). |
| `oidc` | "Sign in" with your identity provider | You already run one (Authelia, Keycloak, Authentik, ...). Headless clients still use tokens. |

## 3. Quick start

One container and one volume. The smallest setup, for a private network:

```bash
docker run -d --name task-master --restart unless-stopped \
  -p 8080:8080 -v task-master:/data \
  -e TM_AUTH=none \
  ghcr.io/alexanderjacquot/task-master-server:latest
```

Point the desktop at `http://<host>:8080` (section 8). Check with
`curl http://<host>:8080/info`.

For anything reachable from outside your network, use `TM_AUTH=token` or `oidc`, and
put HTTPS in front of it (section 4).

## 4. A longer-lived setup with Docker Compose

Pin a version instead of `latest`, so that you update the server and the desktops
together. Image tags match app releases (`v0.22.1`, ...).

`compose.yaml`:

```yaml
services:
  task-master:
    image: ghcr.io/alexanderjacquot/task-master-server:${VERSION}
    container_name: task-master
    restart: unless-stopped
    env_file: .env
    ports:
      - "127.0.0.1:8080:8080"   # only your reverse proxy reaches it
    volumes:
      - ./data:/data            # tasks.sqlite, attachments/, tokens, backups/
    mem_limit: 256m
    healthcheck:
      test: ["CMD", "/task-master-server", "health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

`.env`:

```sh
VERSION=v0.22.1
TM_LISTEN=0.0.0.0:8080
TM_DATA_DIR=/data
TM_PUBLIC_URL=https://tasks.example.com

# Auth: none | token | oidc
TM_AUTH=token

# Optional nightly backup of the server database to any S3-compatible bucket
# TM_BACKUP_S3_ENDPOINT=https://s3.example.com
# TM_BACKUP_S3_REGION=us-east-1
# TM_BACKUP_S3_BUCKET=task-master-server
# TM_BACKUP_S3_ACCESS_KEY_ID=...
# TM_BACKUP_S3_SECRET_ACCESS_KEY=...
TM_BACKUP_KEEP_DAYS=30
```

The server has no secrets of its own beyond the optional S3 key: tokens are stored hashed
in `/data`, and the desktop's OIDC client is public (section 5).

**Reverse proxy.** Any proxy that terminates TLS works (Caddy, Traefik, nginx, ...).
Two things matter:

- Do not buffer responses: the server pushes change notifications over a long-lived
  server-sent events stream.
- Do not put forward-auth (an SSO login page in front of the whole host) on it. Desktops,
  headless clients and Claude send bearer tokens, which forward-auth would refuse. The
  server checks every request itself.

A minimal Caddyfile:

```
tasks.example.com {
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
	}
}
```

Check: `curl https://tasks.example.com/info` returns
`{"name":"task-master",...,"auth":"token",...}`. `/health` suits an uptime monitor.

## 5. Sign-in with your identity provider (OIDC)

Set:

```sh
TM_AUTH=oidc
TM_OIDC_ISSUER=https://auth.example.com
TM_OIDC_CLIENT_ID=task-master
# Optional: only these groups may sign in (comma-separated). Empty = anyone the issuer accepts.
TM_OIDC_ALLOWED_GROUPS=
```

The server reads the issuer's discovery document and keys at startup, then verifies ID
tokens offline.

Register the desktop with your provider as a **public** client (a native app: no
secret, PKCE with S256 required). It signs in through a loopback redirect on the first
free of three fixed ports, so register all three redirect URIs exactly:

- `http://127.0.0.1:47823/oidc/callback`
- `http://127.0.0.1:38823/oidc/callback`
- `http://127.0.0.1:28823/oidc/callback`

Scopes: `openid profile groups offline_access`; grant types `authorization_code` and
`refresh_token`. The server reads `preferred_username` (it names the device token) and,
when `TM_OIDC_ALLOWED_GROUPS` is set, `groups` from the **ID token**. Some providers
leave those claims out of the ID token by default; add them.

Example for Authelia, under `identity_providers.oidc`:

```yaml
clients:
  # task-master desktop: native app, public client, loopback redirect (RFC 8252).
  - client_id: task-master
    client_name: task-master
    public: true
    token_endpoint_auth_method: none
    authorization_policy: two_factor
    require_pkce: true
    pkce_challenge_method: S256
    redirect_uris:
      - "http://127.0.0.1:47823/oidc/callback"
      - "http://127.0.0.1:38823/oidc/callback"
      - "http://127.0.0.1:28823/oidc/callback"
    scopes: [openid, profile, groups, offline_access]
    response_types: [code]
    grant_types: [authorization_code, refresh_token]
    claims_policy: task-master
claims_policies:
  task-master:
    id_token: [preferred_username, groups]
```

Keycloak, Authentik and others have the same settings under their own names (public
client / "client authentication off", PKCE, redirect URIs, claim mappers).

## 6. Tokens for headless clients

```bash
docker exec task-master /task-master-server token add my-script --scope api:read
docker exec task-master /task-master-server token add laptop --scope sync
docker exec task-master /task-master-server token list
docker exec task-master /task-master-server token revoke my-script
```

A token is shown once, at creation. Keep it in the client's own secret store, never in a
repository.

Scopes: `sync` (desktops; desktops signed in with OIDC get one automatically),
`api:read`, `api:write` (also opens the remote MCP endpoint, docs/mcp.md section 5).

### Roadmap images

`GET /roadmap.svg` and `GET /roadmap.png` draw a roadmap from the server's copy, the same
picture as the desktop's "Export image" (ADR 034, ADR 035). The PNG uses the Inter font
built into the server (no system fonts needed). Send an `api:read`, `api:write` or `sync`
token as `Authorization: Bearer …` (none needed with `TM_AUTH=none`).

```bash
# A saved roadmap view: its filters, timescale, bar starts and folded groups
curl -H "Authorization: Bearer $TOKEN" "$URL/roadmap.svg?view=<view id>" -o roadmap.svg
# The roadmap of epics of two projects, by quarter, dark
curl -H "Authorization: Bearer $TOKEN" "$URL/roadmap.svg?projects=<id>,<id>&zoom=quarter&theme=dark" -o roadmap.svg
# The same as a PNG for a chat message, at the default twice the size
curl -H "Authorization: Bearer $TOKEN" "$URL/roadmap.png?view=<view id>" -o roadmap.png
```

| Parameter | Goes with | Values |
| --- | --- | --- |
| `view` | | A saved roadmap view's id. Nothing below but `zoom`, `theme`, `today`. |
| `epic` | | An epic's id: its task timeline instead of the roadmap of epics |
| `projects` | epics | Comma-separated project ids; `none` = epics without a home project. Empty: all |
| `group` | epics | `project` (default) or `none` |
| `tags` | `epic` | Comma-separated tag ids; `none` = tasks without tags. Empty: all |
| `subtasks` | `epic` | `false` leaves subtasks out |
| `completion` | | `open` (default: active epics, open tasks), `all`, `ready` (tasks not blocked) |
| `zoom` | any | `day`, `week`, `month` (default for epics), `quarter`; `week` for an epic's tasks |
| `theme` | any | `clean` (default), `light`, `dark` |
| `today` | any | `YYYY-MM-DD` for the today line; the server's UTC date by default |
| `scale` | PNG only | Pixels per SVG pixel, `1` to `3` (default `2`). A PNG is at most 8,192 px a side and 16 Mpx: a larger roadmap comes out at a smaller scale |

Only scheduled epics (with a target date) and tasks (with a due date) are drawn. **Bar
starts come from saved views only**: the plain Roadmap page keeps the starts you drag on
the desktop, never synced, so without `view` bars start by the default rules (a task's
estimate at 8 hours a day, an epic's earliest task, else two working weeks before its
target date). Save the roadmap as a view to publish it as you see it.

Errors are JSON (`{"error": "…"}`): `400` for a parameter that is unknown, malformed or
does not go with the others, a view that is not a roadmap, or nothing scheduled to draw;
`404` for an unknown view or epic; `401`/`403` for the token. The answer is never cached
(`Cache-Control: private, no-store`). Share links for `<img>` embeds, which cannot send a
token, are a proposal (ADR 035), not built.

## 7. Configuration reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `TM_LISTEN` | `0.0.0.0:8080` | Address and port to listen on |
| `TM_DATA_DIR` | `/data` | Database, attachments, tokens |
| `TM_PUBLIC_URL` | (none) | The URL clients use; reported by `/info` |
| `TM_AUTH` | `none` | `none`, `token` or `oidc` |
| `TM_OIDC_ISSUER` | (none) | Issuer URL. The server reads its discovery document and keys. |
| `TM_OIDC_CLIENT_ID` | `task-master` | Expected audience of ID tokens |
| `TM_OIDC_ALLOWED_GROUPS` | (empty) | Comma-separated groups allowed to sign in |
| `TM_BACKUP_S3_*` | (unset: no remote backup) | `ENDPOINT`, `REGION`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, optional `PREFIX` |
| `TM_BACKUP_KEEP_DAYS` | `30` | Local daily copies kept in `/data/backups` |
| `TM_MCP` | `off` | `on` serves the remote MCP endpoint `/mcp` for claude.ai and the mobile apps (docs/mcp.md, section 5; ADR 024). With `oidc` it needs `TM_PUBLIC_URL`. |
| `TM_MCP_OAUTH_CLIENTS` | `task-master-claude` | Comma-separated OAuth clients whose access tokens `/mcp` accepts |

## 8. Connect the desktop

Open Settings → Sync and enter the server's URL, e.g. `https://tasks.example.com`. Then:

- With `token`, paste a token. With `oidc`, click **Sign in**: a browser opens on your
  identity provider and the app gets its device token.
- On the first device, choose **Upload this device's tasks**.
- On every other device, choose **Replace with the server's tasks** (a backup is taken
  first) or **Merge**. Merging keeps both sets.

### Google Calendar on the server

Calendar starts on the desktop. To keep syncing while the desktop is closed:

1. Join the sync server, then connect Google in Settings → Calendar as usual.
2. Choose **Runs on → Server**. The desktop pushes pending edits, stops its local
   Calendar worker, and transfers the OAuth client and refresh token to the server.
3. The server reuses the existing task-master calendar and relinks events by their
   stored keys. It syncs every five minutes, shortly after a device push, or on **Sync now**.
4. To move back, choose **This device**. The server finishes its active round before
   returning the credentials and giving this desktop the exclusive lease.

The server stores credentials and ownership in `/data/calendar.json` (0600), outside
replicated ops, exports, API status and logs. Keep the `/data` volume persistent. The
file is not included in the daily database or S3 backups; back it up separately with
restricted access, or reconnect Google after losing the volume.

A desktop joined to a sync server renews a five-minute exclusive lease before every
Google request and releases it after its round. An unreachable server or denied lease
stops Google requests; local task editing still works offline. A transfer waits for a
server round, and refuses while another desktop holds a live lease. If a device crashes,
wait five minutes and retry. After disconnecting task sync, Google is paused on that
desktop; explicitly reconnect Google to run it standalone again.

Shown calendars and their cached events live on the chosen runner. While the server runs
Calendar, the desktop reads them from the server; Google edits to blocks and day plans
are ordinary commands and reach all devices through task sync. Calendar preferences
are refreshed when changing runners. Server day-boundary calculations use UTC.

## 9. Backups and restore

- The server writes `/data/backups/daily-YYYY-MM-DD.sqlite` and uploads it to the bucket
  when `TM_BACKUP_S3_*` is set.
- Desktops keep their own local daily backups. The desktop's S3 remote backup
  (`docs/backups.md`) can stay on until the server's backups have run for a while.
- **Restore the server:** stop the container, copy a backup over
  `/data/tasks.sqlite`, then start it. Devices that synced past that point push their
  newer ops again, so the server catches up by itself.
- **Lose the server entirely:** start an empty one. Each desktop notices on its next sync
  that the server is behind it and sends all its changes again. The server ignores what
  it already has.

## 10. Updating

Change `VERSION` (or pull `latest`) and recreate the container
(`docker compose pull && docker compose up -d`). After a release with database
migrations, update the desktops at the same time: the server refuses pushes from an app
with a different schema.

## 11. Troubleshooting

| Symptom | Check |
| --- | --- |
| Desktop says "unreachable" | `curl <url>/info` from that machine. A server on a private network is only reachable from that network or over VPN. |
| Sign-in loops or fails | All three redirect URIs are registered exactly (`http://127.0.0.1:47823/oidc/callback`, `:38823`, `:28823`) and the client is public. A "redirect_uri" error in the browser means the port the desktop picked is missing |
| "No sign-in callback port is free" | A sign-in still waiting in task-master (this window or another instance) is replaced automatically, and **Start over** restarts one. A port Windows reserves (WSL mirrored networking reserves its port range, e.g. 44620-48715, which holds 47823; Hyper-V: `netsh interface ipv4 show excludedportrange protocol=tcp`) is skipped. The error lists each port's reason; "used by another program" means something listens there: `netstat -ano \| findstr 47823` (Windows) or `lsof -i :47823` shows which |
| `401` for a headless client | Token revoked or wrong scope (`token list`) |
| Changes reach other devices late | Your reverse proxy buffers the server-sent events stream; turn buffering off for this host |
| Settings → Sync warns about the clock | The device clock is more than a minute off. Sync corrects for it, but fix the clock (NTP). |
| Server refuses pushes after an update | The device runs an older app with a different schema. Update the app. |

## 12. Building the image (maintainers)

`.github/workflows/server-image.yml` builds `crates/server/Dockerfile` on GitHub, next
to the installers (`release.yml`), and publishes it to GitHub's container registry
(ADR 016). Each `v*` tag pushes `ghcr.io/alexanderjacquot/task-master-server:<tag>` and
`:latest`. The package is public, so hosts pull it without logging in. The workflow
needs no secret: it pushes with `GITHUB_TOKEN`. It can also be run by hand
(`gh workflow run server-image.yml`) to push `latest` from `main`, or with
`-f version=v0.22.1` to rebuild that release and push only `:<version>`.

To build locally: `docker build -f crates/server/Dockerfile -t task-master-server .` from
the repo root.
