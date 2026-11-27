-- Team spaces, T5 (ADR 033): comments on tasks. Ordinary entities (ops, sync, soft delete,
-- undo); a comment lives in its task's space. `author_id` is the member who wrote it (NULL
-- in a personal space).
CREATE TABLE comments (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  task_id TEXT NOT NULL REFERENCES tasks(id),
  body TEXT NOT NULL,                        -- markdown; `@Name` mentions a member
  author_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX comments_task ON comments(task_id);
