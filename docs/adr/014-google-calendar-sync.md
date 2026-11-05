# ADR 014: Google Calendar sync

Date: 2026-11-05 · Status: accepted (M10). Follows ADR 013, "Planned for M10".

## Context

Time blocks and day plans made in the app should appear in the user's Google Calendar,
and the user's own events should appear in the app to plan around. Decided with the user:
Google first (CalDAV later), a dedicated calendar, the login stored in `config.json`
(user-only, like the backup secret), and **day plans pushed as all-day events** too.

## Decisions

**Provider-neutral engine in the core.** `taskmaster_core::calendar` holds the
`CalendarProvider` trait (calendars, create calendar, incremental changes, events in a
window, insert / update / delete) and `sync()`. The Google client lives in the shell
(`google.rs`). Tests run the engine against an in-memory server
(`crates/core/tests/calendar_sync.rs`). `StoreAccess` locks the store only between
network calls, so the UI keeps writing during a sync.

**Sync state outside `ops`.** Migration 0006 adds `calendar_sources` (the account's
calendars, the target, `shown`, the target's sync token), `calendar_links` (local key →
event id, the fingerprint last pushed, the event's `updated`) and `calendar_events` (a
read-only copy of the shown calendars). The sync engine writes them directly: they mirror
the server, have no undo, and stay out of exports. This is the one exception to "every
write is a command". Edits coming back from Google still change tasks and blocks through
`execute` (one undoable batch per sync).

**What is pushed.** Every block that isn't cancelled is a timed event: "opaque", with "✓ "
before the title when done. Every day plan (`today_on`) is an all-day "transparent"
event, so it does not mark the day busy. Each event stores its local key
(`block:<id>` / `plan:<task id>`) in a private extended property. New events are made for
items from the last 30 days on. Items already linked stay in sync whatever their date.
Cancelling or deleting a block, or clearing a plan, deletes the event.

**What comes back (the target calendar only).** It uses incremental sync with Google's
sync token. HTTP 410 means a full listing. Moving or resizing a block event, or moving a
plan event to another day, updates the local item. Deleting the event deletes the block
or clears the plan. Title edits and timed ↔ all-day changes there are overwritten by the
next push. **Conflicts: the app wins** (both sides changed since the last sync → the
event is pushed again). Events found with a key but no link (after an import, a
reconnect, or a lost token) are linked again by key, never duplicated. Events whose key
names nothing here are deleted. Events added by hand to the task-master calendar are
shown like other events.

**Other calendars.** The shown ones (the primary one at first; checkboxes in Settings) are
read each sync over a window from 14 days back to 180 days ahead (`singleEvents=true`, so
recurring events come expanded) and replace their cached copy. A window plus a full
refresh avoids sync-token rules that conflict with time filters. The calendar view
reads them with `calendar_events(range)` and draws them outlined in the calendar's color,
read-only, with "Open in Google Calendar".

**Sign-in.** OAuth 2.0 for installed apps: a loopback listener on `127.0.0.1:<random>`,
PKCE S256, `access_type=offline` and `prompt=consent` (a refresh token every time). Idle
browser preconnect sockets are ignored. Scopes, least privilege:
`calendar.app.created` (create the task-master calendar and manage its events),
`calendar.calendarlist.readonly`, `calendar.events.readonly`. The user creates their own
"Desktop app" OAuth client and sets the consent screen to "In production". In "Testing",
refresh tokens expire after 7 days. Using the Calendar API costs nothing. Disconnecting
revokes the token and clears the sync tables; the events stay in Google.

**When it runs.** A `calendar-sync` thread runs 10 s after start, every 5 minutes, 4 s
after tasks or blocks change (edits in quick succession share one sync), and on "Sync now".
`CalendarSynced` events carry the status (syncing, last sync, last report, last error,
calendars).

**IPC.** New commands: `calendar_status`, `google_connect`, `google_disconnect`,
`set_calendar_shown`, `calendar_sync_now`, `calendar_events`, plus the `CalendarSynced`
event. In the UI they are the optional `Api.calendar`, so tests fake them.

**Dependencies.** No new crate in the tree. `sha2` and `getrandom` (already there through
other crates) become direct dependencies of the shell. RFC 3339 times are parsed and
formatted in the core.

## Rejected

- The full `calendar` scope: more access than the app needs.
- Pushing into the primary calendar: the user chose a dedicated one (ADR 013).
- An OAuth client shipped with the app: the repo is public, and a shared client would
  need Google's app verification. A personal client avoids both.
- Sync tokens for the other calendars: they don't combine with the time window.
