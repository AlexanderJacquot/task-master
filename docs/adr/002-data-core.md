# ADR 002: Data core design

Date: 2026-11-04 · Status: accepted

## Context

M1 implements the data core from plan sections 3 to 5. The plan fixes the schema, the
`ops` log and the command model. This ADR records the choices it left open and where the
implementation differs from it.

## Decisions

**One op engine for every write.** Commands compile to row-level changes
(`ops::Change { entity, entity_id, kind, patch }`). The engine reads the current values of
the patched columns (the inverse), writes the row, and appends the op, all in the caller's
transaction. Undo applies the stored inverses of a batch, newest first, as a *new* batch;
redo inverts that undo batch the same way. The `ops` log is never rewritten.

**Patches are column-level JSON.** Keys are checked against a per-entity column allow-list
before any SQL is built. JSON values are bound through a small `ToSql` wrapper:
rusqlite's own `serde_json` impl stores strings JSON-encoded (quotes included), which broke
foreign keys.

**Op kinds.** `create` inserts the full row; its inverse is `{deleted_at: now}`.
`update`, `delete` and `restore` update columns. Tag links use `link`/`unlink` on the
`task_tag` entity (`entity_id` = task, patch `{tag_id}`); a link that already exists writes
no op.

**HLC encoding.** `{wall_ms:013}-{counter:05}-{device_id}`, so string order is clock order.
The clock resumes from `MAX(ops.hlc)` at startup.

**Default statuses have fixed ids** (`00000000-0000-7000-8000-00000000000N`), so every
device seeds identical rows and later sync never sees duplicates.

**Domain rules made explicit:**
- New subtasks default to the parent's project and epic. When a task changes project or
  epic, or moves under a new parent, subtasks whose value matched the old one follow.
- Deleting a task soft-deletes its whole subtree in one batch.
- Deleting a project is refused while it holds live tasks, epics or child projects
  (archive it instead). Deleting an epic detaches its tasks. Deleting a tag unlinks it.
- Projects nest one level (area → project).
- Tag names are stored without `#`, contain no whitespace, and are unique among live tags,
  case-insensitively.
- Moving into a `done` category sets `completed_at`; moving out clears it.

**IPC.** `execute` takes a list of commands that runs as one atomic, undoable batch, so
bulk actions (M2) need no new endpoint. New entities may carry a client-generated UUID so
the UI can write optimistically. Timestamps cross IPC as TS `number`
(`dangerously_cast_bigints_to_number`: Unix ms and op sequence numbers are far below 2^53).

## Deviations from the plan

- `tags` gained `created_at`, `updated_at` and `deleted_at`: the plan requires soft
  deletes everywhere, and sync will need tag tombstones. `UNIQUE(name)` became a partial
  unique index on live tags.
- `rusqlite` is pinned to 0.40.x: `rusqlite_migration` 2.6.0 does not support 0.41 yet.
- One `Store` (one connection) behind a mutex in the shell, instead of a writer thread plus
  a reader pool. Every operation takes well under a millisecond at MVP scale; revisit if
  the M6 perf test says otherwise.
- The undo history is per session and in memory. `ops` keeps everything, so undo across
  restarts can be added later without a schema change.
- No commands yet for statuses (settings screen, M6) or views (M4).

## Consequences

- Undo, redo, activity history and sync all read from the same `ops` rows.
- Undo of an old batch after later edits applies field values last-writer-wins. Undoing a
  tag deletion fails if a live tag has taken its name meanwhile; acceptable for now.
