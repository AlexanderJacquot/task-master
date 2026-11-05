# ADR 013: Calendar views and time blocks

Date: 2026-11-05 · Status: accepted (M9); sync decisions are for M10

## Context

Plan Phase 4 starts early at the user's request: a calendar with day, week and month
views, dragging tasks onto it, and later a two-way link with the user's own calendar
(tasks scheduled in the app pushed out; the user's events shown in the app to plan
around). Decided with the user before building:

- Provider: **Google Calendar first**, behind a provider trait so CalDAV (iCloud) can follow.
- Pushed blocks go to a **dedicated "task-master" calendar** the app creates, not the
  primary one.
- The calendar grid is **built on dnd-kit** (no calendar library), for one drag system
  and exact theming.
- **Two milestones**: M9 local calendar (this ADR), M10 the Google connection.

## Decisions (M9)

**Time blocks, not a date-time on the task.** Migration 0005 adds `time_blocks(task,
start_at, end_at, outcome, timestamps, soft delete)` as in plan section 7. A task may have
several blocks. `outcome` is `planned | done | worked | cancelled`; logged time is the sum
of `done` and `worked` blocks. Rows go through `CreateTimeBlock` / `UpdateTimeBlock` /
`DeleteTimeBlock` with ops and undo, so every calendar edit is one undoable step. A block
ends after it starts and lasts at most 24 hours. Each change bumps the task's
`updated_at` (as attachments do) so its activity feed refreshes. The feed shows
`schedule`, `unschedule`, `reschedule` and `block_outcome` entries. A deleted task hides
its blocks in the snapshot without extra ops, so undoing the delete brings them back.
Export and import carry the table.

**Days without a time use `today_on`.** The all-day lane (day and week views) and the
month cells show tasks planned for that day (`today_on`) and tasks due that day. Dropping
a task on a day sets `today_on`, so the task shows in Today when that day comes. No
second "planned date" field.

**Marking a block done completes the task** in the same batch (one undo). Worked and
cancelled leave the task's status alone.

**Pure model, thin components.** `lib/calendar.ts` holds the date math (local wall time,
so DST days stay right; weeks start on Monday), the side-by-side overlap layout, and
`resolveDrop`, which turns "dragged X onto Y at minute M" into a schedule, move or plan
action. The page only measures the pointer: it tracks `pointermove` itself, because
dnd-kit's delta also counts container scrolling. Collision uses `pointerWithin`, so a
pointer over a day's grid means a time, not the whole day. Drops and resizes snap to
15 minutes. A new block lasts for the task's estimate, or one hour without one.

**Views.** `/calendar` (sidebar, `g c`, palette): a tray of today's tasks and other open
tasks (search, at most 50 rows, so no virtualizer), with a Schedule button for keyboard
use. Day and week views have a 48 px hour grid, a now line, block menus (outcome, open
task, remove) and resizing from the bottom edge. The month view shows blocks by start
time and the day's tasks, with "+N more" opening that day. The range is remembered per
machine (`localStorage`).

## Planned for M10 (to confirm when building)

- OAuth 2.0 for installed apps: loopback redirect + PKCE in the shell, with the user's own
  OAuth client (Google Cloud project set to "In production", so refresh tokens do not
  expire after 7 days). Refresh token stored like the remote backup secret (or the OS
  keychain).
- Push: each live block is an event in the dedicated calendar; ids and etags in a new
  link table. Calendar-side moves and resizes come back as `UpdateTimeBlock` commands;
  deleting the event there removes the block.
- Pull: events from the user's other calendars into a local **cache table written outside
  `ops`**. It mirrors server state, is not user data, and has no undo. This is the one
  exception to "every write is a command", and it will be recorded here. Shown read-only
  in the grid through the same `Span` layout.
- Provider trait in the core (`CalendarProvider`) so CalDAV can be added later.

## Rejected

- A calendar library (FullCalendar, react-big-calendar): a second drag system next to
  the board's dnd-kit, and styling to override for both themes.
- A `scheduled_at` / `duration` pair on the task: one slot per task, no time log, and no
  room for the plan's outcomes.
