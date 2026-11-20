# ADR 030: Outlook calendar

Date: 2026-11-20 · Status: **proposed** (to confirm with the user before building).
Follows ADR 013 and ADR 014.

## Context

The user wants their **company** Outlook calendar in the app: read its events and
create events there (the blocks), nothing about mail. They do not administer the
company's Microsoft 365 tenant, so nothing may depend on IT creating or approving
anything. They use this account on Windows, in classic Outlook and in the new Outlook.
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

- Windows only, and classic Outlook must be installed with the company profile (the user
  has it). COM starts Outlook in the background if it is not running.
- Whether COM still reaches classic Outlook while the "New Outlook" toggle is on is not
  verified: to test on the user's machine first.
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

## Proposed decisions (option 1)

- **A Windows-only crate `crates/outlook-com`** holds the COM calls (late-bound
  `IDispatch` through the `windows` crate, already in the tree through Tauri; a direct
  dependency with the `Win32_System_Com`, `Win32_System_Ole` and `Win32_System_Variant`
  features). The unsafe code stays there, as the AppKit calls stay in
  `taskmaster-macos-panel`; the shell stays free of unsafe code. It runs on its own
  thread (COM apartment).
- **`OutlookCalendar` implements `CalendarProvider`**:
  - `calendars`: the default calendar folder (`GetDefaultFolder(9)`) and the other
    calendar folders of the profile; the default one is the target and is shown.
  - `create_calendar`: not used (the target is the main calendar).
  - `events_between`: `Items` with `IncludeRecurrences`, sorted by `[Start]`, restricted
    to the window (recurring meetings come expanded).
  - `changes`: COM has no sync token. The token is the set of keyed items seen last time
    (EntryID → last modification time), so edits and deletions of pushed events show up;
    unkeyed events of the main calendar are read through `events_between` instead.
  - `insert` / `update` / `delete`: `AppointmentItem` with subject, start, end, all-day,
    `BusyStatus` (busy for blocks, free for plans and due dates), saved with `Save()`.
  - Local key: the MAPI named property `taskMasterKey` in `PS_PUBLIC_STRINGS`, through
    `PropertyAccessor`. Graph reads the same property as
    `String {00020329-0000-0000-C000-000000000046} Name taskMasterKey`, so a later switch
    to Graph re-links the events instead of duplicating them.
- **Main calendar as target.** The engine already leaves unkeyed events alone (shown,
  never edited or deleted) and deletes only keyed events whose key names nothing here.
  Because colleagues can see the main calendar, pushed events are marked **private**
  (`Sensitivity = 2`) by default.
- **Credentials and config.** `GoogleAccount` / `GoogleCredentials` become a
  `CalendarAccount` with a `provider` (serde default `google`, so existing `config.json`
  and server `calendar.json` files keep working). Outlook (COM) has no credentials and
  only the "this device" runner.
- **UI.** Settings → Calendar: "Connect Outlook (classic, on this PC)" next to Google,
  shown only on Windows; disconnecting removes nothing from Outlook. Shown events get
  "Open in Outlook" (`AppointmentItem.Display()` through a shell command).
- **Tests.** The engine tests (`crates/core/tests/calendar_sync.rs`) gain cases for a
  main-calendar target with foreign events and for token-less change detection. The COM
  layer can only be checked on Windows with Outlook: a manual check on the user's
  machine, listed in progress.md.

## Rejected

- EWS: retired in Exchange Online.
- An Office web add-in inside Outlook: runs only while Outlook is open, still calls
  Graph, and is a second app to ship.
- PowerShell scripts driving Outlook's COM: no Rust COM code, but companies often run
  PowerShell in Constrained Language Mode, which blocks COM objects; slow to start.
