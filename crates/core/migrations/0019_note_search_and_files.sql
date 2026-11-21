-- Notes, follow-ups (ADR 032): full-text search over notes, and files attached to notes.

-- Search over a note's title and body, kept up to date by triggers like tasks_fts.
CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, content='notes', content_rowid='rowid');
INSERT INTO notes_fts(rowid, title, body) SELECT rowid, title, body FROM notes;

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

-- An attachment belongs to exactly one task, meeting or note. The CHECK cannot change in
-- place, so the table is rebuilt (nothing references it), as in 0015.
CREATE TABLE attachments_new (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  meeting_id TEXT REFERENCES meetings(id),
  note_id TEXT REFERENCES notes(id),
  hash TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK ((task_id IS NOT NULL) + (meeting_id IS NOT NULL) + (note_id IS NOT NULL) = 1)
);
INSERT INTO attachments_new
    (id, task_id, meeting_id, hash, name, mime, size, created_at, updated_at, deleted_at)
  SELECT id, task_id, meeting_id, hash, name, mime, size, created_at, updated_at, deleted_at
  FROM attachments;
DROP TABLE attachments;
ALTER TABLE attachments_new RENAME TO attachments;
CREATE INDEX attachments_task ON attachments(task_id);
CREATE INDEX attachments_meeting ON attachments(meeting_id);
CREATE INDEX attachments_note ON attachments(note_id);
CREATE INDEX attachments_hash ON attachments(hash);
