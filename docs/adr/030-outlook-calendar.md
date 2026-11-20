# ADR 030: Outlook calendar

Date: 2026-11-20 · Status: **proposed** (to confirm with the user before building).
Follows ADR 013 and ADR 014.

## Context

The user wants to add an Outlook account to the calendar as easily as possible, on
Windows and macOS, and asked whether this can work locally through the running Outlook
app. Today the calendar syncs with one Google account (ADR 014): a provider-neutral
engine in the core (`CalendarProvider`, `sync()`), the Google client in
`crates/client/src/google.rs`, run either by a desktop (`calendar_sync.rs`) or by the
sync server (`crates/server/src/calendar.rs`, ADR 015).

## Options explored

**1. Through the Outlook app on the machine (local).**

- *Classic Outlook for Windows*: COM automation (`Outlook.Application`, MAPI) can read
  and write calendar items without any sign-in. But it is Windows only, works only while
  classic Outlook is installed and set up, triggers Outlook's "a program is trying to
  access" guard on some machines, and Microsoft is moving everyone to the new Outlook,
  which has no COM or local store at all (classic is supported "until at least 2029").
- *New Outlook for Windows*: a web app; no local API. Only Office web add-ins, which run
  inside Outlook and call the same cloud API as option 2.
- *Outlook for Mac*: legacy Outlook's AppleScript ends with its support (October 2026,
  Exchange Online); the new Outlook for Mac has no usable calendar scripting.
- *macOS Calendar (EventKit)*: if the account is added in System Settings → Internet
  Accounts, the app could read and write it through EventKit with no sign-in of its own.
  But Apple's Exchange support uses EWS, which Microsoft has disabled by default in
  Exchange Online since 2026-10-01 (off for everyone by April 2027); Apple plans a move
  to Graph in a macOS 27 update. Mac only, and needs a Swift/ObjC bridge in the shell.

None of these covers both systems, and each is tied to a client Microsoft or Apple is
retiring. Not chosen.

**2. Microsoft Graph (cloud), like Google. Recommended.**
One client for Windows, macOS and Linux, and for the sync server, that does not need
Outlook running. It covers personal accounts (Outlook.com, Hotmail, Live) and work or
school Microsoft 365 accounts, i.e. exactly what Outlook shows on every platform. It maps
onto `CalendarProvider` one to one:

| Trait | Graph |
| --- | --- |
| `calendars` | `GET /me/calendars` (`isDefaultCalendar`, `hexColor`, `canEdit`) |
| `create_calendar` | `POST /me/calendars` ("task-master") |
| `changes` (token) | `GET /me/calendars/{id}/calendarView/delta` (deltaLink as token; `@removed` = deleted) |
| `events_between` | `GET /me/calendars/{id}/calendarView?startDateTime&endDateTime` (recurrences expanded) |
| `insert` / `update` / `delete` | `POST` / `PATCH` / `DELETE /me/events/{id}` |
| local key | a `singleValueExtendedProperty` (private string property, like Google's) |

Sign-in: Microsoft identity platform, authorization code + PKCE with a loopback redirect
(`http://localhost`, any port), the same flow `google.rs` already runs. Scopes:
`Calendars.ReadWrite offline_access User.Read` (Graph has no "only calendars the app
created" scope like Google's `calendar.app.created`). Authority `common`, so both account
kinds sign in.

**3. A published ICS link (read only).** Outlook can publish a calendar as an ICS URL;
the app could show it. No push, no setup in Azure, but it is not an integration: kept as
a possible fallback, not built now.

## Proposed decisions

- **Graph provider in `crates/client/src/microsoft.rs`**, behind the existing trait;
  tested against the in-memory server the engine tests use, plus unit tests of the JSON
  mapping (time zones: request `Prefer: outlook.timezone="UTC"`; all-day events carry
  dates with an exclusive end, as in Google).
- **Account kind on the credentials**: `GoogleCredentials` / `GoogleAccount` become a
  `CalendarAccount { provider: google | microsoft, ... }` (serde default `google`, so
  existing `config.json` and server `calendar.json` files keep working); the runner
  handoff (ADR 015) carries it unchanged.
- **One connected account at a time** (Google *or* Outlook), so the sync tables and the
  single target calendar stay as they are; switching provider disconnects the other and
  clears the tables (events stay on the provider side, as today).
- **Settings → Calendar**: "Connect Google" and "Connect Outlook"; "Open in Outlook" on
  shown events (`webLink`).
- **App registration**: see the open questions.

## Open questions (for the user)

1. **App registration.** (a) Ship one multi-tenant public-client registration's client
   id in the app (a public client has no secret, so the public repo is fine; one click
   to connect; work tenants that block user consent to unverified apps will need their
   admin or a verified publisher), or (b) like Google, each user registers their own app
   in Entra (portal.azure.com) and pastes its client id (works everywhere, ~5 minutes of
   setup). Proposed: (a) with (b) as an "Advanced: your own client id" field.
2. **One account or several at once?** Proposed: one (above). Google and Outlook at the
   same time needs an `account` column on the sync tables (a migration and a schema
   bump) and a choice of which one receives the pushed blocks.
3. **Local on macOS later?** EventKit could still be added as a third provider (any
   account in macOS Calendar, iCloud included) once Apple moves Exchange to Graph; out of
   scope here.

## Rejected

- Classic Outlook COM: Windows only, being retired, and no help on macOS.
- Office web add-in inside Outlook: runs only while Outlook is open and still calls
  Graph; a second app to ship.
- EWS: retired in Exchange Online.
