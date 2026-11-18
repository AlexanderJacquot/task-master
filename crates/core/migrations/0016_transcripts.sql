-- Scribe transcripts (M20, ADR 025). A transcript is a meeting's segments: who spoke
-- (`speaker`: "me" for this device's microphone, "s1", "s2", … for the voices found on the
-- computer's sound) from when to when, and what they said. Segments are ordinary synced
-- entities (ops, soft delete); writing a transcript is one batch, so one undo.
CREATE TABLE transcript_segments (
  id TEXT PRIMARY KEY,                          -- UUIDv7
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  start_ms INTEGER NOT NULL,                    -- from the start of the recording
  end_ms INTEGER NOT NULL,                      -- after start_ms
  speaker TEXT NOT NULL,                        -- "me", "s1", "s2", …
  text TEXT NOT NULL,
  edited INTEGER NOT NULL DEFAULT 0,            -- 1 once the user corrected the text
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX transcript_segments_meeting ON transcript_segments(meeting_id, start_ms);

CREATE VIRTUAL TABLE transcript_fts USING fts5(text, content='transcript_segments', content_rowid='rowid');

CREATE TRIGGER transcript_fts_insert AFTER INSERT ON transcript_segments BEGIN
  INSERT INTO transcript_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER transcript_fts_delete AFTER DELETE ON transcript_segments BEGIN
  INSERT INTO transcript_fts(transcript_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER transcript_fts_update AFTER UPDATE OF text ON transcript_segments BEGIN
  INSERT INTO transcript_fts(transcript_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO transcript_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- Names given to the speaker keys of a meeting: a JSON object, e.g. {"s1": "Ada"}. One
-- field like `participants`, so renaming a voice is a single meeting update.
ALTER TABLE meetings ADD COLUMN speakers TEXT NOT NULL DEFAULT '{}';
