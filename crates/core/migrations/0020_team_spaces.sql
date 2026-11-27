-- Team spaces, T1 (ADR 033). A personal row may point at a row of the team space, which
-- lives in another database: the personal tables that reference tasks, projects or epics
-- lose those foreign keys. A reference to a row that is missing or deleted hides the row,
-- as a deleted task already hides its blocks. Each table is rebuilt (SQLite cannot drop a
-- constraint in place) with its columns, rows (rowids kept) and indexes. db.rs runs
-- migrations with foreign keys off, as SQLite's procedure for schema changes requires, and
-- checks them before this one commits.

-- One person's marks on a task of the team space (`id` is the task's id): their Today pick.
-- Ordinary entities (ops, sync, soft delete, undo). Personal tasks keep `tasks.today_on`.
CREATE TABLE task_marks (
  id TEXT PRIMARY KEY,                       -- the task's id
  today_on TEXT,                             -- YYYY-MM-DD, or NULL
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE time_blocks_new (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'planned',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
INSERT INTO time_blocks_new (rowid, id, task_id, start_at, end_at, outcome, created_at,
                             updated_at, deleted_at)
  SELECT rowid, id, task_id, start_at, end_at, outcome, created_at, updated_at, deleted_at
  FROM time_blocks;
DROP TABLE time_blocks;
ALTER TABLE time_blocks_new RENAME TO time_blocks;
CREATE INDEX time_blocks_task ON time_blocks(task_id);
CREATE INDEX time_blocks_start ON time_blocks(start_at);

CREATE TABLE agent_sessions_new (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  claude_session_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  runtime TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  summary TEXT,
  cost_usd_micros INTEGER,
  turns INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  model TEXT,
  duration_ms INTEGER
);
INSERT INTO agent_sessions_new (rowid, id, task_id, device_id, claude_session_id, folder,
                                runtime, permission_mode, prompt, state, started_at, ended_at,
                                summary, cost_usd_micros, turns, error, created_at, updated_at,
                                deleted_at, model, duration_ms)
  SELECT rowid, id, task_id, device_id, claude_session_id, folder, runtime, permission_mode,
         prompt, state, started_at, ended_at, summary, cost_usd_micros, turns, error,
         created_at, updated_at, deleted_at, model, duration_ms
  FROM agent_sessions;
DROP TABLE agent_sessions;
ALTER TABLE agent_sessions_new RENAME TO agent_sessions;
CREATE INDEX agent_sessions_task ON agent_sessions(task_id);

CREATE TABLE agent_notes_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  task_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
INSERT INTO agent_notes_new (rowid, id, session_id, task_id, body, created_at, updated_at,
                             deleted_at)
  SELECT rowid, id, session_id, task_id, body, created_at, updated_at, deleted_at
  FROM agent_notes;
DROP TABLE agent_notes;
ALTER TABLE agent_notes_new RENAME TO agent_notes;
CREATE INDEX agent_notes_task ON agent_notes(task_id);

CREATE TABLE meetings_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  project_id TEXT,
  epic_id TEXT,
  task_id TEXT,
  state TEXT NOT NULL DEFAULT 'scheduled',
  participants TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  summary TEXT,
  transcribed_at INTEGER,
  validated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  speakers TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO meetings_new (rowid, id, title, started_at, ended_at, project_id, epic_id, task_id,
                          state, participants, notes, summary, transcribed_at, validated_at,
                          created_at, updated_at, deleted_at, speakers)
  SELECT rowid, id, title, started_at, ended_at, project_id, epic_id, task_id, state,
         participants, notes, summary, transcribed_at, validated_at, created_at, updated_at,
         deleted_at, speakers
  FROM meetings;
DROP TABLE meetings;
ALTER TABLE meetings_new RENAME TO meetings;
CREATE INDEX meetings_start ON meetings(started_at);
CREATE INDEX meetings_project ON meetings(project_id);
CREATE INDEX meetings_epic ON meetings(epic_id);
CREATE INDEX meetings_task ON meetings(task_id);

-- notes_fts reads `notes` by rowid, so rowids are kept; its triggers go with the old table.
CREATE TABLE notes_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  folder_id TEXT REFERENCES note_folders(id),
  task_id TEXT,
  rank TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
INSERT INTO notes_new (rowid, id, title, body, folder_id, task_id, rank, created_at,
                       updated_at, deleted_at)
  SELECT rowid, id, title, body, folder_id, task_id, rank, created_at, updated_at, deleted_at
  FROM notes;
DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;
CREATE INDEX notes_folder ON notes(folder_id);
CREATE INDEX notes_task ON notes(task_id);

CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER notes_fts_update AFTER UPDATE OF title, body ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TABLE terminal_sessions_new (
  id TEXT PRIMARY KEY,
  claude_session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  title TEXT,
  model TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  cost_usd_micros INTEGER,
  duration_ms INTEGER,
  turns INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
INSERT INTO terminal_sessions_new (rowid, id, claude_session_id, device_id, folder, project_id,
                                   task_id, title, model, started_at, ended_at, cost_usd_micros,
                                   duration_ms, turns, created_at, updated_at, deleted_at)
  SELECT rowid, id, claude_session_id, device_id, folder, project_id, task_id, title, model,
         started_at, ended_at, cost_usd_micros, duration_ms, turns, created_at, updated_at,
         deleted_at
  FROM terminal_sessions;
DROP TABLE terminal_sessions;
ALTER TABLE terminal_sessions_new RENAME TO terminal_sessions;
CREATE INDEX terminal_sessions_claude ON terminal_sessions(claude_session_id);
CREATE INDEX terminal_sessions_project ON terminal_sessions(project_id);
