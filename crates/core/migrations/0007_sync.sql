-- Migration 0007: sync (docs/adr/015-sync-server.md).

-- HLC of the latest write to each field: an incoming op writes only the fields where its
-- HLC is newer (latest edit wins, per field). Tag links use the tag id as the field.
CREATE TABLE field_clocks (
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  hlc TEXT NOT NULL,
  PRIMARY KEY (entity, entity_id, field)
) WITHOUT ROWID;

-- 1 for ops that came from another replica (they are not pushed back).
ALTER TABLE ops ADD COLUMN received INTEGER NOT NULL DEFAULT 0;

-- The clock reads MAX(hlc) in every write transaction (several processes, one device id).
CREATE INDEX ops_hlc ON ops(hlc);

-- Per-device sync position: `pushed_seq` (last local op the server has), `cursor` (last
-- server op applied here). Not exported; an import clears it.
CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Field clocks of the existing data, from the ops log.
INSERT INTO field_clocks (entity, entity_id, field, hlc)
  SELECT o.entity, o.entity_id, j.key, MAX(o.hlc)
  FROM ops o, json_each(o.patch) j
  WHERE o.entity <> 'task_tag'
  GROUP BY o.entity, o.entity_id, j.key;
INSERT INTO field_clocks (entity, entity_id, field, hlc)
  SELECT entity, entity_id, json_extract(patch, '$.tag_id'), MAX(hlc)
  FROM ops
  WHERE entity = 'task_tag'
  GROUP BY entity, entity_id, json_extract(patch, '$.tag_id');
