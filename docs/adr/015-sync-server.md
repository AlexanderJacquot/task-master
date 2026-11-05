# ADR 015: Sync server and API

Date: 2026-11-05 · Status: accepted; device sync implemented in M11–M13. Plan Phase 5.

## Context

The user wants the same tasks on every device, and other software (a home dashboard, a
headless AI integration) reading and writing them through an API, with an MCP server and
a CLI on top. The desktop must stay instant and work offline: it must not write to a
remote API on every edit. Sync must be close to instant without becoming a large system.
**Conflicts are never shown to the user: the latest edit wins, always, automatically.**

Agreed with the user (2026-11-05):
- The CLI uses the local database. The MCP server uses the local database by default and
  can use the server API instead (headless and AI setups without a local database).
- Calendar sync runs on the desktop by default and can be moved to the server.
- Auth is optional: a base URL alone connects to a server that asks for none. OIDC
  (Authelia at home, any provider elsewhere) is a setting.
- Latest edit wins, per field. A delete wins over a later edit. Rules spanning several
  fields are repaired automatically after a merge.

## Decisions

**The server is one more replica of the same core.** `crates/server` (axum) embeds
`taskmaster-core` with its own SQLite file and file store. It holds no business logic of
its own. Devices replicate `ops` with it; API clients run `Command`s on it through
`core::execute`, whose ops then flow to the devices like any other edit. One write path.

**Desktops stay local-first.** Every edit writes local SQLite only. Unsynced work is the
local ops after the last pushed `seq`; nothing else is queued. A sync worker in the shell
(same pattern as `calendar_sync.rs`: background thread, `ureq`, kicks):
- pushes all unpushed ops in one request ~2 s after the last local change;
- listens to a server-sent-events stream that only carries the server's newest cursor,
  and pulls when it moves (other devices see an edit within ~2-4 s);
- also pulls at start, on window focus and every 5 minutes.

**Endpoints.** `GET /info` (auth mode, OIDC issuer and client id, server time, supported
schema versions). Sync: `POST /sync/push`, `GET /sync/pull?after=<cursor>`,
`GET /sync/snapshot` (bootstrap), `GET /events` (SSE), `PUT|GET /blobs/{sha256}`.
API: `/api/v1` with `snapshot`, views, `search`, `task_activity`, `execute` (the same
`Command` JSON as the desktop) and `capture` (quick-capture text). Pushes carry the
schema version; the server refuses ops from a schema it does not know.

**Merge: latest edit wins, per field.**
- Each op carries its HLC. "Latest" is when the edit was made, not when it arrived: an
  edit made offline at 10:00 loses to one made elsewhere at 11:00, whenever they sync.
- A new `field_clocks(entity, entity_id, field, hlc)` table holds the HLC of the last
  write to every field. The op engine updates it on every local write; an incoming op
  writes only the fields where its HLC is newer. Edits to different fields of the same
  task both survive.
- Tag links are one field per (task, tag) pair: the latest link or unlink wins.
- Receiving an op advances the local clock past it (HLC receive rule), so an edit made
  after seeing another device's edit is always later than it.
- Ops are deduplicated by `op_id`; applying the same ops in any order, any number of
  times, gives the same rows.
- Losing values are never shown as conflicts; they stay in `ops`, so the task's activity
  shows them.
- Clock skew: `/info` returns the server time; the client offsets its clock by the
  difference and warns in Settings → Sync above one minute.

**A delete wins over a later edit.** Edits never write `deleted_at`, so an edit to a
deleted row updates its fields and the row stays deleted. Only an explicit restore (undo)
brings it back, and that is itself the latest edit of `deleted_at`.

**Repairs after a merge.** Each device enforces its rules when it writes, but two valid
edits can merge into a state no single device would allow. After applying incoming ops the
core repairs it with ordinary local ops (they sync like any edit). Every rule is
deterministic, so replicas that repair the same state reach the same rows:

| Merged state | Repair |
| --- | --- |
| Live task under a deleted parent | Deleted too (the delete wins, as a local subtree delete) |
| Parent cycle (A moved under B, B under A) | The latest move wins: the task in the cycle whose `parent_id` was written earliest goes to the top level |
| Live task, epic or child project in a deleted project | Moved out (Inbox, no project, top level): a project is only deleted empty, so nothing is lost |
| Live task in a deleted epic | Detached (as a local epic delete does) |
| Live task on a deleted status | Moved to the first live status of the same category, else the first live status |
| Status and `completed_at` disagree | `completed_at` follows the status: set when the status is in the `done` category, cleared otherwise |
| Two live tags with the same name | Merged into the tag with the smaller id (created first): links move to it, the other is deleted |
| Link to a deleted tag | Moved to the live tag of the same name, else removed |

Equal ranks from two devices are ordered by id.

**Bootstrap.** The first device pushes its whole ops log (every write since M1 is an op;
exports include `ops`). A later device chooses "replace local with the server" (after a
backup) or "merge" (both logs; UUIDs never collide). Op-log compaction comes with the
30-day purge; a device that falls behind it re-bootstraps from the snapshot.

**What stays per device.** `config.json`, the `settings` table and the calendar sync
tables (ADR 014). Attachment content syncs by hash: uploaded once, downloaded when opened.

**Calendar sync** runs on one place at a time: "This device" (default) or "Server". Moving
it sends the Google client and refresh token to the server, which relinks the events
already pushed by their stored key (ADR 014), so nothing is duplicated. A
`calendar_runner` lease on the server stops a second runner.

**Auth modes** (server setting): `none` (base URL only; for a LAN), `token` (bearer
tokens made with `task-master-server token add <name> --scope sync|api:read|api:write`, stored
hashed, revocable) and `oidc` (the desktop signs in with authorization code + PKCE over a
loopback redirect, like `google.rs`; the server checks the ID token against the
provider's JWKS and issues its own device token). Headless clients use server tokens in
every mode. The client asks only for the URL and reads the mode from `/info`. The
desktop is a public OIDC client (no secret, PKCE) with the fixed redirect
`http://127.0.0.1:47823/oidc/callback`. Configuration, image name and token commands:
`docs/server.md`.

**Adapters.**
- CLI (`tk`): local database only.
- MCP: a `Backend` trait over the small surface (`execute`, `snapshot`, `search`,
  `parse_capture`, `task_activity`) with `Local(Store)` (default) and `Remote(ApiClient)`.
- A process sharing the database with the desktop (CLI, local MCP) writes under the same
  device id, so the clock reads `MAX(ops.hlc)` inside every write transaction; the
  desktop notices outside writes with `PRAGMA data_version` and reloads.

**Backups.** Local daily backups stay. The S3 remote backup stays during the rollout; then
the server backs up its database to Garage nightly and the desktop's remote backup becomes
optional.

## Implementation notes (M12)

- `crates/client` (blocking, `ureq`) holds the client side: one `Client` per server and
  `sync()`, one full round. It runs the clock offset, a server-reset check, attachment
  uploads, pushes, pulls, the repairs' push and the downloads. The desktop worker (M13)
  and the MCP server in remote mode (M15) use it; the server's tests run devices through it.
- Wire types (`ServerInfo`, `AuthMode`, `PushRequest`/`PushResult`, `PullPage`,
  `OidcExchange`, `IssuedToken`) live in the core's `sync` module, so the two sides cannot drift.
- No `/sync/snapshot`: a new device pulls from 0. The ops log is complete, and a snapshot
  would be a second path to keep correct until compaction needs one.
- `/events` sends `event: head` with the newest `seq` on connect and after each push, plus
  a keep-alive every 15 s. Clients reopen it at least every 10 minutes.
- A server behind a device's cursor (restored, or new) makes the device forget its sync
  position and send everything again.
- Tokens: `tm_` + 32 random bytes, stored as SHA-256 in `server.sqlite`, apart from the
  replicated data. An OIDC sign-in makes a `sync` token named `<user>@<device>`, so
  signing in again from the same device replaces its token. ID tokens: asymmetric
  algorithms only; issuer, audience, expiry and `sub` are required.
- Image: distroless, built by `.forgejo/workflows/server-image.yml` on the homelab runner
  (only it can push to the registry). Pushed as `alex/task-master-server`: hosts pull
  anonymously, and the KnowledgeSystem org is private.

## Implementation notes (M13 release review)

- Settings → Sync supports none/token/OIDC auth, merge or backed-up replacement,
  status and manual sync. The worker pushes after edits, pulls on SSE/focus/start and
  polls every five minutes. Attachment files are fetched during sync.
- Account changes and sync rounds are serialized so an old server cannot update a
  new account's cursors or pull data after a replacement. Authentication mode and join
  information are refreshed when Settings opens after restarting the app.
- Restarting sync requeues every retained op, including received ops, so a surviving
  replica can refill an empty server without the original authoring device. Skipped
  pushes are not acknowledged; skipped pulls roll back and retain their cursor.
- Replacement uses a fresh replica's default statuses before replaying the server log.
- The desktop polls `PRAGMA data_version` every two seconds for outside writers.
- The Google provider and installed-app OAuth helpers live in `crates/client::google`,
  reused by the shell and server (existing dependencies only). Calendar commands,
  event mapping, repair and relinking stay in the core.
- Authenticated `/calendar/status`, `/calendar/runner`, `/calendar/lease`,
  `/calendar/sync`, `/calendar/shown` and `/calendar/events` manage the runner and its
  local cache. Sync-token scope is required. Status responses never contain credentials;
  an explicit transfer to a desktop returns the Google credentials.
- The server persists selection, credentials and desktop leases in `calendar.json`
  (0600, atomic write, outside ops). Credentials remain there after a transfer back so
  a lost HTTP reply can be retried. It is not part of daily DB/S3 backups.
- A server round holds a handoff mutex across Google requests. A desktop holds its own
  mutex during a round/transfer and renews an exclusive five-minute lease before every
  Google request (request timeout is at most 60 seconds, including token refresh).
  Offline/denied lease fails closed. Handoffs refuse an active lease of another device;
  this prevents an already-connected second desktop from running concurrently.
- Moving to Server durably pauses the desktop first, flushes task ops, then transfers
  credentials. Moving back waits for the server round, claims the desktop lease, saves
  credentials and relinks. A failed transfer leaves workers paused rather than duplicated.
- Server Calendar runs after startup, shortly after pushes, every five minutes and on
  demand. Pulled changes announce the new ops head over SSE. Shown calendars/events
  remain on their runner; the shell proxies reads and preferences while Server is chosen.
- Disconnecting task sync pauses its local Calendar worker. Reconnecting Google explicitly
  enables standalone sync again. Server day-boundary calculations use UTC.
- Op compaction and the 30-day purge remain deferred together.

## Rejected

- Server as the source of truth with thin clients: no offline use, every edit waits on
  the network.
- cr-sqlite, PowerSync, Electric, Turso replicas, Automerge: new dependencies that
  duplicate the ops log we have, some need Postgres, CRDT text merge is not wanted.
- Exchanging op files through the S3 bucket without a server: no API for the dashboard.
- Record-level last-writer-wins: an edit to one field would erase a concurrent edit to
  another.
- Postgres, multiple users, sharing, two-way websockets, per-keystroke sync, a conflict UI.

## Milestones

- **M11 sync core** (this ADR's core part): `field_clocks`, applying incoming ops, HLC
  receive, repairs, push/pull cursors, clock offset. No new dependency.
- **M12 server**: `crates/server` (axum, tokio, `jsonwebtoken`; server only), auth modes,
  sync endpoints, SSE, blobs, nightly backup, image on Harbor, homelab stack.
- **M13 desktop sync**: worker, Settings → Sync, join flow, blobs, calendar runner choice.
- **M14 API**: `/api/v1` (needs ViewSpec compiled to SQL), dashboard integration.
- **M15 CLI and MCP** (local, and remote for MCP).
