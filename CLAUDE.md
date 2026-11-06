# task-master: conventions

The full plan is in docs/plan.md. Architecture decisions are in docs/adr/.

## Architecture

- All logic and data live in crates/core. The Tauri shell and the UI are thin adapters.
- Every mutation is a `Command` executed by `core::execute`, which writes rows AND
  an `ops` entry (patch + inverse) in ONE transaction. Never write tables directly.
- IDs are UUIDv7. Ordering uses fractional rank strings. Deletes are soft.
- Timestamps: Unix ms UTC. Calendar dates: ISO YYYY-MM-DD strings.
- IPC surface stays small: data edits only through execute; reads (snapshot, search,
  task_activity, parse_capture), settings/backup/export/import commands (ADR 007), and
  attachment content in/out (store_file, store_data, open/save_attachment, open_url; the
  `tm:` protocol serves files by attachment id; ADR 011), and agent sessions, which run a
  process the core cannot own (agent_start/send/cancel/open_terminal/live, agent_brief,
  agent_notes, agent settings, project folders; ADR 017).
- apps/desktop/src/bindings.ts is generated. Never edit it by hand.

## Frontend

- Normalized store; views are pure functions of store + view spec (`src/lib/views.ts`).
- Writes are optimistic and reconciled with the entities returned by execute. New writes go
  in `src/store/actions.ts`: build the command and the optimistic entity together; send
  client-generated ids and ranks.
- Virtualize any list that can exceed 100 rows.
- Backgrounds, textures and effects follow docs/rendering-performance.md: no fine
  repeating gradients on large surfaces (use an image tile); measure new ones with
  `scripts/paint-bench/run.sh` against the release AppImage.
- Tests: plain functions (not `vi.fn`) for mocks that return rejected promises; component
  tests opt into jsdom with `// @vitest-environment jsdom` (stubs in `src/test/setup.ts`).

## Workflow

- Read progress.md at the start of every session; update it at the end.
- Core changes ship with tests (in-memory SQLite). Parser changes ship with snapshot tests.
- Run `cargo clippy -- -D warnings`, `cargo test`, `pnpm biome check`, `pnpm test`
  before declaring a task done.
- New dependency or architecture change: propose it first, then record an ADR.
- Stay inside the current milestone. Note ideas for later in progress.md under "Later".
- One milestone per branch (`m0-scaffold`, `m1-data-core`, ...).

## CI

- The repo lives on Forgejo, push-mirrored to a public GitHub repo where all workflows run
  (ADR 010): `.github/workflows/ci.yml` (lint, tests, Linux Tauri build on every push) and
  `release.yml` (installers for 3 OSes and signed in-app updates on `v*` tags; docs/release.md,
  ADR 009). Keep `.forgejo/workflows/ci.yml` as the manual-only stub: removing it makes
  Forgejo run the GitHub workflows.
