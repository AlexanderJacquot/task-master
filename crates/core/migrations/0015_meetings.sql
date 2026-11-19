-- Scribe meetings (M18, ADR 025). Ordinary entities (ops, sync, soft delete). A meeting may
-- be linked to a project, an epic and a task; deleting those leaves the meeting.
-- Audio is never stored here (it stays in the device's `scribe/` folder); the transcript
-- tables come with transcription (M20).
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  title TEXT NOT NULL,
  started_at INTEGER NOT NULL,               -- Unix ms, UTC
  ended_at INTEGER,                          -- Unix ms, UTC, after started_at; NULL while recording
  project_id TEXT REFERENCES projects(id),
  epic_id TEXT REFERENCES epics(id),
  task_id TEXT REFERENCES tasks(id),
  state TEXT NOT NULL DEFAULT 'scheduled',   -- scheduled | held | recording | processing | review | validated | failed
  participants TEXT NOT NULL DEFAULT '[]',   -- JSON array of names
  notes TEXT NOT NULL DEFAULT '',            -- markdown
  summary TEXT,                              -- markdown
  transcribed_at INTEGER,
  validated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX meetings_start ON meetings(started_at);
CREATE INDEX meetings_project ON meetings(project_id);
CREATE INDEX meetings_epic ON meetings(epic_id);
CREATE INDEX meetings_task ON meetings(task_id);

-- An attachment belongs to exactly one task or one meeting. SQLite cannot drop NOT NULL in
-- place, so the table is rebuilt (nothing references it).
CREATE TABLE attachments_new (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  meeting_id TEXT REFERENCES meetings(id),
  hash TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK ((task_id IS NULL) <> (meeting_id IS NULL))
);
INSERT INTO attachments_new (id, task_id, hash, name, mime, size, created_at, updated_at, deleted_at)
  SELECT id, task_id, hash, name, mime, size, created_at, updated_at, deleted_at FROM attachments;
DROP TABLE attachments;
ALTER TABLE attachments_new RENAME TO attachments;
CREATE INDEX attachments_task ON attachments(task_id);
CREATE INDEX attachments_meeting ON attachments(meeting_id);
CREATE INDEX attachments_hash ON attachments(hash);
