-- Note folders nest (ADR 042): a folder may sit in another one; NULL is the top level.
-- Each level is ordered by rank among its siblings. Existing folders stay at the top.
ALTER TABLE note_folders ADD COLUMN parent_id TEXT REFERENCES note_folders(id);
CREATE INDEX note_folders_parent ON note_folders(parent_id);
