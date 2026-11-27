-- Time blocks gain the `missed` outcome (planned but not worked on; ADR 013). The column
-- is free text, so no data changes: the version bump keeps apps and sync servers that do
-- not know `missed` from syncing blocks they could not read.
UPDATE time_blocks SET outcome = outcome WHERE 0;
