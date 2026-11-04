-- Saved views become ordinary entities: timestamps and soft delete, like every other
-- table, so creating, editing and deleting a view goes through ops and undo.
-- `spec` holds a versioned JSON `ViewSpec` (see `model.rs`).
ALTER TABLE views ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE views ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE views ADD COLUMN deleted_at INTEGER;
