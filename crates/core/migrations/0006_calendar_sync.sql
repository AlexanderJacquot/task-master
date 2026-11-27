-- Calendar sync state (M10, ADR 014). These tables mirror a calendar server and are
-- written by the sync engine directly, outside `ops`: they are not user data, have no
-- undo, and are left out of exports. Edits coming back from the server still reach
-- tasks and time blocks through commands.

-- Calendars of the connected account. `is_target` marks the "task-master" calendar the
-- app pushes to; `shown` ones are read into `calendar_events`.
CREATE TABLE calendar_sources (
  id TEXT PRIMARY KEY,                 -- provider calendar id
  name TEXT NOT NULL,
  color TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  is_target INTEGER NOT NULL DEFAULT 0,
  shown INTEGER NOT NULL DEFAULT 0,
  sync_token TEXT,                     -- incremental sync of the target calendar
  synced_at INTEGER
);

-- A local item pushed as an event: `block:<time block id>` or `plan:<task id>`.
CREATE TABLE calendar_links (
  local_key TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  pushed TEXT NOT NULL,                -- fingerprint of the local item as last synced
  remote_updated INTEGER NOT NULL      -- the event's `updated` as last seen, Unix ms
);
CREATE UNIQUE INDEX calendar_links_event ON calendar_links(calendar_id, event_id);

-- Events of shown calendars (and events added by hand to the target calendar), shown
-- read-only. Timed events have start_at/end_at; all-day ones start_date/end_date
-- (end exclusive).
CREATE TABLE calendar_events (
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start_at INTEGER,
  end_at INTEGER,
  start_date TEXT,
  end_date TEXT,
  location TEXT,
  link TEXT,
  PRIMARY KEY (calendar_id, event_id)
);
CREATE INDEX calendar_events_start ON calendar_events(start_at);
CREATE INDEX calendar_events_date ON calendar_events(start_date);
