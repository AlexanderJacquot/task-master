# ADR 003: Frontend state, routing and editing

Date: 2026-11-04 · Status: accepted

## Context

M2 builds the first UI: sidebar, list view, task detail panel, optimistic writes. The plan
fixes the shape (normalized Zustand store, optimistic writes, views as pure functions) but
not the router, the editor or how writes and change events are reconciled.

## Decisions

**Libraries.** TanStack Router (typed routes and search params, used for `?task=<id>`),
CodeMirror 6 for markdown descriptions, Zustand, TanStack Virtual, Tailwind CSS 4, Radix
(`radix-ui`), `fractional-indexing`. Versions are pinned exactly.

**Hash history.** The Tauri webview serves a single file, so routes live in the hash
(`#/project/<id>?task=<id>`) and a reload never asks the asset server for `/project/...`.

**Store.** One vanilla Zustand store created with an injected `Api` (`lib/api.ts`), so
tests run against a fake core. Entities are kept in maps by id; components select maps and
derive lists with `useMemo` through the pure functions in `lib/views.ts`.

**Optimistic writes.** Actions (`store/actions.ts`) build the command *and* the entity it
will produce. New entities get a client-generated UUIDv7 and a client-computed rank, both
sent to the core, so the optimistic row and the confirmed row agree. Writes go through a
queue one at a time. On success the store applies the entities `execute` returns; on
failure it restores exactly the entities that write touched and shows the error.

**Change events.** The core emits `storeChanged` for every batch, including ours, and the
event may arrive before or after `execute` returns. The store matches events against the
batch ids it wrote; any unknown batch (a write from elsewhere) triggers a full re-read once
no write is in flight.

**Ranks.** The TS wrapper rejects out-of-order bounds like the Rust core does, although
`fractional-indexing` 4 would silently swap them. Both pass `test-vectors/rank.json`.

**IPC.** One read-only command was added: `task_activity(task_id, limit)`, reading the
task's ops for the activity feed. Writes still go through `execute` only.

**Shortcuts.** Text fields keep their native undo. Elsewhere, Ctrl+Z / Ctrl+Shift+Z (and
Ctrl+Y) undo and redo through the core, `n` focuses the capture input and Escape closes the
detail panel.

## Consequences and gaps

- No rendered markdown preview yet: CodeMirror shows highlighted markdown. A renderer
  (e.g. `marked` + `DOMPurify`, or `react-markdown`) needs a dependency decision.
- Bulk multi-select actions in the list view are deferred; `execute` already takes a list
  of commands, so they need no new IPC.
- A write from another process re-reads the whole snapshot. Fine at MVP scale; the M6 perf
  test decides whether events should carry entities instead.
