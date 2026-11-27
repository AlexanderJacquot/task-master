-- Migration 0001: initial schema (docs/plan.md, section 4).
-- Timestamps are Unix ms UTC; calendar dates are ISO YYYY-MM-DD strings.
-- Deviation from the plan: tags carry created/updated/deleted timestamps so they can be
-- soft-deleted like everything else (see docs/adr/002-data-core.md).

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL,
  color TEXT,
  icon TEXT,
  rank TEXT NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE epics (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL,
  description TEXT,
  target_date TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'done', 'dropped')),
  rank TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE statuses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL
    CHECK (category IN ('backlog', 'todo', 'in_progress', 'done', 'cancelled')),
  color TEXT,
  rank TEXT NOT NULL,
  wip_limit INTEGER
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  epic_id TEXT REFERENCES epics(id),
  parent_id TEXT REFERENCES tasks(id),
  status_id TEXT NOT NULL REFERENCES statuses(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  due_date TEXT,
  today_on TEXT,
  estimate_min INTEGER,
  rank TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  deleted_at INTEGER
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (task_id, tag_id)
);

CREATE TABLE views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  spec TEXT NOT NULL,
  rank TEXT NOT NULL
);

-- Append-only change log: the basis for undo, history and sync.
CREATE TABLE ops (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('create', 'update', 'delete', 'restore', 'link', 'unlink')),
  patch TEXT NOT NULL,
  inverse TEXT NOT NULL,
  batch_id TEXT
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE INDEX tasks_project ON tasks(project_id);
CREATE INDEX tasks_epic ON tasks(epic_id);
CREATE INDEX tasks_parent ON tasks(parent_id);
CREATE INDEX tasks_status_rank ON tasks(status_id, rank);
CREATE INDEX tasks_today ON tasks(today_on);
CREATE INDEX task_tags_tag ON task_tags(tag_id);
CREATE INDEX ops_entity ON ops(entity, entity_id);
CREATE INDEX ops_batch ON ops(batch_id);
CREATE UNIQUE INDEX tags_live_name ON tags(name COLLATE NOCASE) WHERE deleted_at IS NULL;

-- Full-text search over tasks (external content table kept in sync by triggers).
CREATE VIRTUAL TABLE tasks_fts USING fts5(title, description, content='tasks', content_rowid='rowid');

CREATE TRIGGER tasks_fts_insert AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
END;

CREATE TRIGGER tasks_fts_delete AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
    VALUES ('delete', old.rowid, old.title, old.description);
END;

CREATE TRIGGER tasks_fts_update AFTER UPDATE OF title, description ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
    VALUES ('delete', old.rowid, old.title, old.description);
  INSERT INTO tasks_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
END;

-- Default workflow. Fixed ids so every device seeds identical rows (safe to sync later).
INSERT INTO statuses (id, name, category, color, rank, wip_limit) VALUES
  ('00000000-0000-7000-8000-000000000001', 'Backlog', 'backlog', '#94a3b8', 'a0', NULL),
  ('00000000-0000-7000-8000-000000000002', 'To do', 'todo', '#3b82f6', 'a1', NULL),
  ('00000000-0000-7000-8000-000000000003', 'In progress', 'in_progress', '#f59e0b', 'a2', NULL),
  ('00000000-0000-7000-8000-000000000004', 'Waiting', 'in_progress', '#a855f7', 'a3', NULL),
  ('00000000-0000-7000-8000-000000000005', 'Done', 'done', '#22c55e', 'a4', NULL),
  ('00000000-0000-7000-8000-000000000006', 'Cancelled', 'cancelled', '#6b7280', 'a5', NULL);
