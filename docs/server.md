# Sync server setup

The sync server keeps a copy of your tasks that is always on. Desktops sync with it in the
background. Other software (a home dashboard, the MCP server in remote mode, a headless
AI integration) reads and writes tasks through its API. Design: `docs/adr/015-sync-server.md`.

> **Status.** The server is built (M12): image, auth modes, sync, backups and tokens as
> described here. The desktop's Settings → Sync arrives in **M13**; until then nothing
> syncs with it. The API for other software (`/api/v1`) is M14.

## 1. How it fits together

- Each desktop keeps its own database and works offline. About 2 seconds after an edit
  it pushes its new changes. When the server says something changed, it pulls.
- The server runs the same core as the desktop, with its own SQLite file in `/data`.
- Conflicts sort themselves out: the latest edit wins, field by field, and a delete wins
  over a later edit. You never pick between versions.
- Attachments upload once, by content hash, and other devices download them during their
  next sync.

## 2. Pick an auth mode

The desktop only asks for the server's URL, then reads the auth mode from `GET /info`
and shows what that mode needs.

| `TM_AUTH` | Desktop asks for | Use it when |
| --- | --- | --- |
| `none` | Nothing | A private network only (LAN, VPN). Anyone who can reach the URL can read and change your tasks. |
| `token` | A token you paste | Any network. Tokens are made on the server (section 5). |
| `oidc` | "Sign in" with your identity provider | You already run one (Authelia, Keycloak, Authentik, ...). Headless clients still use tokens. |

## 3. Homelab setup (solarnexus.space)

This follows the usual new-service path of the homelab repo. The steps below are file
changes there, deployed by a merge to its `main`. Stack name: `task-master`, host
`gitche-gumee`, domain `tasks.solarnexus.space`.

### Step 1: registry entry

`inventory/services.yml`:

```yaml
task-master:
  host: gitche-gumee
  domain: tasks.solarnexus.space
  # renovate: datasource=docker depName=harbor.solarnexus.space/knowledgesystem/task-master-server
  version: v0.5.0
  exposure: private        # LAN/VPN, like s3.solarnexus.space
  port: 8080
  # OIDC, not forward-auth: desktops, the dashboard and MCP send bearer tokens, which
  # Authelia's forward-auth would refuse. The server checks every request itself.
  auth: oidc
  buckets: [task-master-server]
  dashboard: { group: Tools, name: Tasks, icon: mdi-checkbox-marked-outline, description: "task-master sync server" }
```

`version` is the first release that ships the server image (section 9). Keep the renovate
comment directly above it.

### Step 2: the stack

`services/task-master/compose.yaml`:

```yaml
name: task-master

networks:
  traefik-private:
    external: true

services:
  server:
    image: harbor.solarnexus.space/knowledgesystem/task-master-server:${VERSION}
    container_name: task-master
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/data          # tasks.sqlite, attachments/, tokens
    mem_limit: 256m
    healthcheck:
      test: ["CMD", "/task-master-server", "health"]
      interval: 30s
      timeout: 5s
      retries: 3
    networks:
      - traefik-private
```

`services/task-master/.env.j2`:

```sh
VERSION={{ docker_compose_service_config.version }}
TM_LISTEN=0.0.0.0:{{ docker_compose_service_config.port }}
TM_DATA_DIR=/data
TM_PUBLIC_URL=https://{{ services['task-master'].domain }}

# --- Auth: none | token | oidc --------------------------------------------------------
TM_AUTH=oidc
TM_OIDC_ISSUER=https://{{ services.authelia.domain }}
TM_OIDC_CLIENT_ID=task-master
# Optional: only these groups may sign in (comma-separated). Empty = anyone the issuer accepts.
TM_OIDC_ALLOWED_GROUPS=

# --- Nightly backup of the server database to Garage ------------------------------------
# Key: services/task-master/s3.sops.yaml (`just s3-key task-master`), bucket and grant from
# `just tofu-apply storage`.
TM_BACKUP_S3_ENDPOINT=http://{{ hostvars[services.garage.host].ansible_host }}:{{ services.garage.port }}
TM_BACKUP_S3_REGION=garage
TM_BACKUP_S3_BUCKET={{ services['task-master'].buckets[0] }}
TM_BACKUP_S3_ACCESS_KEY_ID={{ stack_s3.S3_ACCESS_KEY_ID }}
TM_BACKUP_S3_SECRET_ACCESS_KEY={{ stack_s3.S3_SECRET_ACCESS_KEY }}
TM_BACKUP_KEEP_DAYS=30
```

The server has no secrets of its own. The desktop's OIDC client is public (step 3), and
the server's tokens live hashed in `/data`. So there is no `env.sops.yaml`, only the S3 key.

### Step 3: Authelia client

The desktop is a native app, so it uses a **public** client: no secret, PKCE required. It
signs in through a loopback redirect on a fixed port, like the Google sign-in. In
`services/authelia/config/configuration.yml.j2`, under `identity_providers.oidc.clients`:

```yaml
      # task-master desktop: native app, public client, loopback redirect (RFC 8252).
      - client_id: task-master
        client_name: task-master
        public: true
        authorization_policy: one_factor   # two_factor if you prefer
        require_pkce: true
        pkce_challenge_method: S256
        consent_mode: pre-configured
        pre_configured_consent_duration: 1M
        redirect_uris:
          - "http://127.0.0.1:47823/oidc/callback"
        scopes: [openid, profile, groups, offline_access]
        response_types: [code]
        grant_types: [authorization_code, refresh_token]
        token_endpoint_auth_method: none
```

Add `task-master` to the client list in the template's header comment. Nothing goes into
`services/authelia/env.sops.yaml`, since a public client has no digest.

### Step 4: backup key and bucket

```bash
just s3-key task-master            # writes services/task-master/s3.sops.yaml
just tofu-plan storage && just tofu-apply storage   # bucket task-master-server + grant
```

### Step 5: roll out

```bash
just ansible-validate
just ansible-plan gitche-gumee task-master    # check the generated route, no forward-auth
just ansible-apply gitche-gumee task-master   # or merge to main: deploy.yml does it
just tofu-plan dns && just tofu-apply dns     # tasks.solarnexus.space in Pi-hole
```

Check from the LAN: `curl https://tasks.solarnexus.space/info` returns
`{"name":"task-master",...,"auth":"oidc","oidc_issuer":"https://auth.solarnexus.space",...}`.
Then add an Uptime Kuma
monitor on `/health`.

### Step 6: tokens for headless clients

```bash
ssh gitche-gumee
docker exec task-master /task-master-server token add dashboard --scope api:read
docker exec task-master /task-master-server token add claude-headless --scope api:write
docker exec task-master /task-master-server token list
docker exec task-master /task-master-server token revoke dashboard
```

A token is shown once, at creation. Put it in the client's own secrets (for example the
dashboard's `env.sops.yaml`), never in a repo.

## 4. Anywhere else (no homelab)

One container and one volume. The smallest setup, for a private network:

```bash
docker run -d --name task-master --restart unless-stopped \
  -p 8080:8080 -v task-master:/data \
  -e TM_AUTH=none \
  harbor.solarnexus.space/knowledgesystem/task-master-server:latest
```

Point the desktop at `http://<host>:8080`. For any address reachable from outside your
network, use `TM_AUTH=token` (and HTTPS through your reverse proxy), or `oidc` with your
own provider. Register the same public client as in step 3; its redirect URI is always
`http://127.0.0.1:47823/oidc/callback`.

## 5. Configuration reference

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

Token scopes: `sync` (desktops; desktops signed in with OIDC get one automatically),
`api:read`, `api:write`.

## 6. Connect the desktop (M13)

Open Settings → Sync and enter the URL, `https://tasks.solarnexus.space`. Then:

- With `oidc`, click Sign in: a browser opens on Authelia and the app gets its device
  token.
- On the first device, choose **Upload this device's tasks**.
- On every other device, choose **Replace with the server's tasks** (a backup is taken
  first) or **Merge**. Merging keeps both sets.

Calendar sync keeps running on the desktop. Settings → Calendar → "Runs on: Server"
moves it to the server, which picks up the existing events without duplicating them.

## 7. Backups and restore

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

## 8. Troubleshooting

| Symptom | Check |
| --- | --- |
| Desktop says "unreachable" | `curl <url>/info` from that machine; on the homelab, LAN or VPN only |
| Sign-in loops or fails | The redirect URI is exactly `http://127.0.0.1:47823/oidc/callback`, the client is `public: true`, and nothing else listens on port 47823 |
| `401` for the dashboard | Token revoked or wrong scope (`token list`) |
| Settings → Sync warns about the clock | The device clock is more than a minute off. Sync corrects for it, but fix the clock (NTP). |
| Server refuses pushes after an update | The device runs an older app with a different schema. Update the app. |

## 9. Publishing the image

`.forgejo/workflows/server-image.yml` builds `crates/server/Dockerfile` on the homelab's
Forgejo runner. The registry is private, so the GitHub mirror cannot push to it. Each `v*`
tag pushes `harbor.solarnexus.space/knowledgesystem/task-master-server:<tag>` and `:latest`.
Renovate in the homelab repo then opens the version bump.

Once, on the Forgejo repo (Settings → Actions → Secrets): add `REGISTRY_TOKEN`, a Forgejo
token with package write. You can also run the workflow by hand (Actions →
server-image → Run workflow) to push `latest` from `main`.

To build locally: `docker build -f crates/server/Dockerfile -t task-master-server .` from
the repo root.
