-- Statuses become editable entities (M6 settings): timestamps and soft delete, so
-- creating, editing, reordering and deleting a column goes through ops and undo.
ALTER TABLE statuses ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE statuses ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE statuses ADD COLUMN deleted_at INTEGER;
