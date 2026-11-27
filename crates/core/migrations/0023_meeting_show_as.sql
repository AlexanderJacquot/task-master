-- How a meeting shows in calendars, as Outlook's "Show as" and "Private" (ADR 038):
-- `show_as` is busy | tentative | free; a private meeting shows to people who can see the
-- calendar only as taken time. Existing meetings keep what the Outlook push already set
-- (busy, private).
ALTER TABLE meetings ADD COLUMN show_as TEXT NOT NULL DEFAULT 'busy';
ALTER TABLE meetings ADD COLUMN private INTEGER NOT NULL DEFAULT 1;

-- The same for events of the account's calendars, read-only in the app. Rows already
-- cached are refreshed by the next sync.
ALTER TABLE calendar_events ADD COLUMN show_as TEXT NOT NULL DEFAULT 'busy';
ALTER TABLE calendar_events ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
