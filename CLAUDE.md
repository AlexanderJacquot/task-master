# task-master: conventions

The full plan is in docs/plan.md. Architecture decisions are in docs/adr/.

## Architecture

- All logic and data live in crates/core. The Tauri shell and the UI are thin adapters.
- Every mutation is a `Command` executed by `core::execute`, which writes rows AND
  an `ops` entry (patch + inverse) in ONE transaction. Never write tables directly.
- IDs are UUIDv7. Ordering uses fractional rank strings. Deletes are soft.
- Timestamps: Unix ms UTC. Calendar dates: ISO YYYY-MM-DD strings.
- IPC surface stays small: snapshot, execute, undo, redo, search, export, import.
- apps/desktop/src/bindings.ts is generated. Never edit it by hand.

## Frontend

- Normalized store; views are pure functions of store + view spec.
- Writes are optimistic and reconciled with the entities returned by execute.
- Virtualize any list that can exceed 100 rows.

## Workflow

- Read progress.md at the start of every session; update it at the end.
- Core changes ship with tests (in-memory SQLite). Parser changes ship with snapshot tests.
- Run `cargo clippy -- -D warnings`, `cargo test`, `pnpm biome check`, `pnpm test`
  before declaring a task done.
- New dependency or architecture change: propose it first, then record an ADR.
- Stay inside the current milestone. Note ideas for later in progress.md under "Later".
- One milestone per branch (`m0-scaffold`, `m1-data-core`, ...).

## CI

- The repo lives on Forgejo. `.forgejo/workflows/ci.yml` runs lint, tests and a
  Linux Tauri build. A 3-OS release matrix (GitHub mirror) is deferred to M6, see ADR 001.
