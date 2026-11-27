-- Files attached to tasks (M8, ADR 011). The content lives outside the database, in
-- `attachments/<hash>` next to it; a row only names it. Rows are ordinary entities
-- (ops, undo, soft delete). The same file attached twice is stored once.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  task_id TEXT NOT NULL REFERENCES tasks(id),
  hash TEXT NOT NULL,                        -- SHA-256 of the content, lowercase hex
  name TEXT NOT NULL,                        -- file name shown and used when saving
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,                     -- bytes
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX attachments_task ON attachments(task_id);
CREATE INDEX attachments_hash ON attachments(hash);
