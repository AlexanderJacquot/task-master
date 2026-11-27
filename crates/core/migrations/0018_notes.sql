-- Notes (ADR 032): markdown pages in the sidebar, in simple folders (one level). A note may
-- be attached to a task; its body links tasks and projects with `task:<id>` and
-- `project:<id>` URLs. Ordinary entities (ops, sync, soft delete, undo).
CREATE TABLE note_folders (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  name TEXT NOT NULL,
  rank TEXT NOT NULL,                        -- fractional rank among folders
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  title TEXT NOT NULL DEFAULT '',            -- may be blank ("Untitled")
  body TEXT NOT NULL DEFAULT '',             -- markdown
  folder_id TEXT REFERENCES note_folders(id),-- NULL: at the top level
  task_id TEXT REFERENCES tasks(id),         -- the task it is attached to; NULL for none
  rank TEXT NOT NULL,                        -- fractional rank within its folder
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX notes_folder ON notes(folder_id);
CREATE INDEX notes_task ON notes(task_id);
