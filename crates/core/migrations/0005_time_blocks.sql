-- Time blocks (M9, ADR 013): a task planned, or worked on, from one time to another.
-- Rows are ordinary entities (ops, undo, soft delete). A task can have several blocks;
-- a deleted task hides its blocks without extra ops, so undoing the delete restores them.
CREATE TABLE time_blocks (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  task_id TEXT NOT NULL REFERENCES tasks(id),
  start_at INTEGER NOT NULL,                 -- Unix ms, UTC
  end_at INTEGER NOT NULL,                   -- Unix ms, UTC, after start_at
  outcome TEXT NOT NULL DEFAULT 'planned',   -- planned | done | worked | cancelled
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX time_blocks_task ON time_blocks(task_id);
CREATE INDEX time_blocks_start ON time_blocks(start_at);
