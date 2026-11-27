# ADR 030: Outlook calendar

Date: 2026-11-20 · Status: accepted (option 1 built; to verify on a Windows PC).
Follows ADR 013 and ADR 014.

## Context

The user wants a **work** Outlook calendar in the app: read its events and
create events there (the blocks), nothing about mail. Such an account belongs to an
organization's Microsoft 365 tenant that the user does not administer, so nothing may
depend on IT creating or approving anything. They use this account on Windows, in classic Outlook and in the new Outlook.
The task asks for Windows and macOS, and whether the running Outlook app can be used
locally.

Today the calendar syncs with one Google account (ADR 014): a provider-neutral engine in
the core (`CalendarProvider`, `sync()`), the Google client in
`crates/client/src/google.rs`, run by a desktop (`calendar_sync.rs`) or by the sync
server (`crates/server/src/calendar.rs`, ADR 015).

Decided with the user: **one calendar account at a time** (Google or Outlook), and
blocks go to the **main** calendar, so colleagues see the time as busy.

## Options explored

**1. Classic Outlook on Windows, through COM (local). Proposed for now.**
Classic Outlook exposes its object model (`Outlook.Application`) to other programs over
COM. The app talks to the Outlook already set up on the machine: no sign-in, no app
registration, no tenant consent, nothing for IT to approve. Events written there reach
Exchange through Outlook, so they show in the new Outlook, on the web and on phones too.
Limits:

- Windows only, and classic Outlook must be installed with the work profile. COM starts Outlook in the background if it is not running.
- Whether COM still reaches classic Outlook while the "New Outlook" toggle is on is not
  verified: to test on a real machine first.
- Outlook's object model guard can show "a program is trying to access…" when antivirus
  is off or a company policy forces it. Reading subject, times and location of
  appointments does not normally trigger it; attendee e-mail addresses would, so they are
  not read.
- Microsoft is moving people to the new Outlook (classic supported "until at least
  2029"); the new Outlook has no COM, so option 2 is the long-term path.
- The runner must be this Windows device (the sync server cannot reach Outlook).

**2. Microsoft Graph (cloud). Later, and the macOS path.**
One client for Windows, macOS, Linux and the sync server, with no Outlook needed. It maps
onto `CalendarProvider` one to one (`/me/calendars`, `calendarView/delta`,
`calendarView`, `POST`/`PATCH`/`DELETE /me/events/{id}`, a single-value extended
property for the key), and signs in with PKCE and a loopback redirect, as `google.rs`
does. Scopes: `Calendars.ReadWrite offline_access` (no mail). **The catch for a company
account:** the first sign-in asks the user to consent for the app; many companies only
allow that after an admin approves ("Need admin approval"). The app registration itself
would be made once by the app's developer in their own Microsoft account, not in the
company's tenant. Built after option 1, when macOS needs it; the first sign-in tells
whether this company allows it.

**3. Other local routes, not chosen.**

- *New Outlook for Windows*: a web app, no local API (only Office web add-ins, which run
  inside Outlook and call Graph anyway).
- *Outlook for Mac*: legacy Outlook's AppleScript ends with its support (October 2026,
  Exchange Online); the new Outlook for Mac has no usable calendar scripting.
- *macOS Calendar (EventKit)* with the account in Internet Accounts: Apple's Exchange
  support uses EWS, disabled by default in Exchange Online since 2026-10-01 (off for all
  by April 2027) until Apple's planned move to Graph in a macOS 27 update.
- *A published ICS link*: read only, and often disabled by companies.

## Decisions (option 1, as built)

- **`crates/outlook` (`taskmaster-outlook`)** holds the COM calls: late-bound `IDispatch`
  through the `windows` crate (already in the tree through Tauri; a direct dependency
  with the `Win32_Foundation`, `Win32_Globalization`, `Win32_System_Com`,
  `Win32_System_Ole` and `Win32_System_Variant` features). Its unsafe code stays in
  `com.rs`, as the AppKit calls stay in `taskmaster-macos-panel`; the shell stays free of
  unsafe code. Outside Windows the same API fails with "Classic Outlook is only on
  Windows", so the shell has no `cfg`. The platform-neutral half (`model.rs`: OLE dates,
  ids, the change token) is tested everywhere.
- **`OutlookCalendar` implements `CalendarProvider`**, on the calendar sync thread (COM
  objects stay on the thread that made them; multithreaded apartment):
  - `calendars`: the default calendar folder (`GetDefaultFolder(9)`, named with its
    mailbox) and the calendars inside it. The default one is the target.
  - `create_calendar`: never called (`target_is_primary`, below).
  - `changes`: COM has no sync token. Items carrying the key are listed with a DASL
    filter on it (every item is read when Outlook refuses the filter); the token is the
    set listed last time (EntryID → change time, in UTC through
    `PropertyAccessor.LocalTimeToUTC`), so edits and deletions show up. An item missing
    from the listing is reported deleted only if `GetItemFromID` cannot find it in that
    calendar either (deleted items move to Deleted Items with their EntryID), so a
    listing that misses items never deletes blocks.
  - `events_between`: `Items` sorted by `[Start]` with `IncludeRecurrences`, restricted
    by a Jet filter written in the user's short date format (`GetDateFormatEx`), a day
    of margin each side, then cut exactly. An occurrence of a series gets the id
    `<EntryID>|<start ms>`.
  - `insert` / `update` / `delete`: an `AppointmentItem` with subject, times (`StartUTC`
    / `EndUTC`, or `AllDayEvent` with local dates), `BusyStatus` busy for timed events and
    free for all-day ones, `Sensitivity` private, no reminder, then `Save()`. The body is
    not written (Outlook's object model guard watches body access).
  - Key: the named property `taskMasterKey` in `PS_PUBLIC_STRINGS` through
    `PropertyAccessor`; Graph reads the same property as
    `String {00020329-0000-0000-C000-000000000046} Name taskMasterKey`, so a later switch
    to Graph re-links the events instead of duplicating them.
- **Engine: `CalendarProvider::target_is_primary`** (default false). When true the
  target is the account's primary calendar, nothing is created, and after the push the
  target's own events are read through `events_between` like a shown calendar's, without
  the keyed ones (those are the blocks, plans and deadlines). The engine already left
  unkeyed events of the target alone and deletes only keyed events whose key names
  nothing here. Test: `the_main_calendar_can_be_the_target_and_its_own_events_are_left_alone`.
- **When it syncs.** Background syncs use Outlook only while it is open
  (`GetActiveObject`); otherwise the status says so. Connecting and "Sync now" may start
  it (`CoCreateInstance`). A broken connection (Outlook closed) is dropped and made
  again on the next call.
- **Config, not credentials.** `config.json` gets `outlook: { mailbox }` next to
  `google`; the sync server and its runner handoff are unchanged. Outlook runs on this
  device only (`set_calendar_runner` refuses), under the server's Calendar lease when a
  server is joined. One account at a time: connecting either refuses while the other is
  connected.
- **IPC.** `outlook_connect` (reaches Outlook, names its mailbox, clears the sync tables
  and syncs), `outlook_disconnect` (the events stay in Outlook), `outlook_open_event`
  (`Display()`); `CalendarStatus` gains `outlook_available` and `outlook`. In the UI they
  are optional members of `Api.calendar`.
- **UI.** Settings → Calendar shows "Connect Outlook" above the Google steps on Windows,
  the mailbox once connected, and notes that the main calendar's events are never
  changed. The calendar header names Outlook; Outlook events offer "Open in Outlook".
- **Checks.** The COM layer compiles and passes clippy for `x86_64-pc-windows-msvc`
  (checked from macOS with a stand-in C compiler for SQLite); it has not run against
  Outlook. To check on a Windows PC with classic Outlook: connect, a block appears as a private busy event in
  the main calendar, moving it in Outlook moves the block, deleting it there removes the
  block, meetings show in the app and stay untouched, and all of it with the "New
  Outlook" toggle on too.

## Rejected

- EWS: retired in Exchange Online.
- An Office web add-in inside Outlook: runs only while Outlook is open, still calls
  Graph, and is a second app to ship.
- PowerShell scripts driving Outlook's COM: no Rust COM code, but companies often run
  PowerShell in Constrained Language Mode, which blocks COM objects; slow to start.
