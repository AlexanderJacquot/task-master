-- Agent sessions (M16, docs/adr/017-agent-sessions.md).

-- Who a task is for: the user, or an agent tracking its own work. Agent tasks are hidden
-- from the user's views by default.
ALTER TABLE tasks ADD COLUMN owner TEXT NOT NULL DEFAULT 'me' CHECK (owner IN ('me', 'agent'));

-- A Claude Code run started from a task. Ordinary entities (ops, sync, soft delete); only
-- the device that started a session (`device_id`) updates it.
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,                    -- UUIDv7
  task_id TEXT NOT NULL REFERENCES tasks(id),
  device_id TEXT NOT NULL,
  claude_session_id TEXT NOT NULL,        -- passed to `claude --session-id`, then `--resume`
  folder TEXT NOT NULL,                   -- working directory, as the runtime sees it
  runtime TEXT NOT NULL,                  -- native | wsl
  permission_mode TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',        -- the user's extra instructions
  state TEXT NOT NULL DEFAULT 'running',  -- running | done | failed | cancelled | interrupted
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  summary TEXT,
  cost_usd_micros INTEGER,
  turns INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX agent_sessions_task ON agent_sessions(task_id);

-- Progress lines an agent writes during a session (MCP `add_note`).
CREATE TABLE agent_notes (
  id TEXT PRIMARY KEY,                    -- UUIDv7
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX agent_notes_task ON agent_notes(task_id);

-- This device's working folder per project. Device configuration like the calendar
-- tables: written directly, outside `ops`, never synced or exported. No foreign key, so
-- replacing the data with an import or the server's leaves it valid; reads skip folders
-- of projects that are gone.
CREATE TABLE project_folders (
  project_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  runtime TEXT NOT NULL,                  -- native | wsl
  updated_at INTEGER NOT NULL
);
