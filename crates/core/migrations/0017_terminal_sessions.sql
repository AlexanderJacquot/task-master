-- Claude Code sessions run in a terminal, outside the app (M21, ADR 028): read from the
-- transcripts Claude Code keeps (`~/.claude/projects/<folder>/<session>.jsonl`) so their
-- cost and time count with the app's own agent sessions. One row per Claude Code session;
-- the device that read it keeps it up to date while the session goes on.
CREATE TABLE terminal_sessions (
  id TEXT PRIMARY KEY,                    -- UUIDv7
  claude_session_id TEXT NOT NULL,        -- the transcript's session id
  device_id TEXT NOT NULL,                -- the device whose transcript it is
  folder TEXT NOT NULL,                   -- working directory, as Claude Code saw it
  project_id TEXT REFERENCES projects(id),-- from the folder, or set by hand; NULL for none
  task_id TEXT REFERENCES tasks(id),      -- set by hand
  title TEXT,                             -- Claude Code's title for the conversation
  model TEXT,                             -- the model that wrote most of it
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,              -- the last message so far
  cost_usd_micros INTEGER,                -- Claude Code's own total; NULL when not recorded
  duration_ms INTEGER,                    -- time Claude worked (its turns), not idle time
  turns INTEGER,                          -- requests to the model
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX terminal_sessions_claude ON terminal_sessions(claude_session_id);
CREATE INDEX terminal_sessions_project ON terminal_sessions(project_id);
