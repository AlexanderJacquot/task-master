-- Team spaces, T2 (ADR 033): who made each edit, who a task is for, and the team's members.

-- The user who wrote an op. NULL: the space's owner (a personal space, and every op older
-- than this migration).
ALTER TABLE ops ADD COLUMN author_id TEXT;

-- Who a team task is assigned to, and who created it (member ids; NULL on personal tasks).
-- No foreign key: a member removed from the team keeps their tasks' history.
ALTER TABLE tasks ADD COLUMN assignee_id TEXT;
ALTER TABLE tasks ADD COLUMN reporter_id TEXT;
CREATE INDEX tasks_assignee ON tasks(assignee_id);

-- The people of a team space, written by the server when a user is added, renamed or
-- removed, so names show offline. Ordinary entities (ops, sync, soft delete). Empty in a
-- personal space.
CREATE TABLE members (
  id TEXT PRIMARY KEY,                       -- the server's user id
  name TEXT NOT NULL,
  color TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
