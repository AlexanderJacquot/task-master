# ADR 037: CalDAV calendar (iCloud, Fastmail, Nextcloud)

Date: 2026-11-24 · Status: accepted (built; to check once against iCloud).
Follows ADR 014 (Google), ADR 015 (sync server) and ADR 030 (Outlook).

## Context

The user wants a third calendar account beside Google and Outlook, mainly to get blocks,
plans and deadlines onto an iPhone through iCloud. iCloud, Fastmail and Nextcloud all
speak CalDAV (RFC 4791) with HTTP Basic auth over HTTPS; iCloud needs an app-specific
password made at appleid.apple.com. The engine (`calendar::sync`, `CalendarProvider`)
is already provider-neutral and stays unchanged: one account at a time, now Google,
Outlook or CalDAV.

The .ics feed task (read-only feeds) was not built yet. Its parser and recurrence code is
what CalDAV needs for `events_between`, so this work brings it; the feed subscription
itself (settings, fetching feeds) stays that task's.

Agreed with the user before any code: the `rrule` crate for recurrence, the password in
the OS keychain (`keyring`), the parser built here.

## Decisions

**Where the code lives.** `crates/client` (already used by the desktop and the server):
`ical/` (content lines, `VEVENT`/`VTIMEZONE`, recurrence expansion, a writer for the one
`VEVENT` the app pushes) and `caldav.rs` (the provider). The core gets no new dependency;
only the runner types (`CaldavCredentials`, `CaldavAccount`) are added to it.

**Discovery.** `PROPFIND current-user-principal` on the given URL, else on
`/.well-known/caldav`; then `calendar-home-set`; then a `Depth: 1` listing of the home
(`resourcetype` calendar, `displayname`, Apple's `calendar-color`,
`supported-calendar-component-set`, `current-user-privilege-set`, `sync-token`).
Reminders lists (no VEVENT) are left out; calendars without write privilege are not
"owned". CalDAV has no main calendar: the first writable one is marked primary, so it is
shown on the first sync. The home is saved in settings after connecting; a 404 on it
looks for it again. Redirects are followed by the provider itself, with the same method
and body (ureq's own redirects turn a PROPFIND into a GET). The password goes only to the
configured host and hosts under the same domain over HTTPS (iCloud answers from
`pNN-caldav.icloud.com`). `create_calendar` is `MKCALENDAR` under the home.

**Changes.** `sync-collection` (RFC 6578), multi-round on a 507, with changed resources
fetched by `calendar-multiget` in batches of 100. A `valid-sync-token` error (403/409)
or 410 is `TokenExpired`. A calendar that announces no sync token, or refuses the report,
is followed by ETags instead: the stored token is then `etags:` plus the JSON map
`href → ETag` (no schema change), and the next listing is diffed against it. Tokens are
prefixed `sync:` or `etags:`.

**`updated`.** CalDAV has no reliable change time (`LAST-MODIFIED` is optional and set
by clients). Everything a change listing returns did change, or is the echo of a push,
so it gets a stamp from a strictly increasing clock in the provider; the engine compares
the times themselves before following an edit.

**Shown calendars.** `calendar-query` with a `time-range` filter, expanded locally (not
with the server's `<expand>`, which iCloud handles unevenly): `RRULE` (through `rrule`;
`UNTIL` is read by our code, as feeds often write it in a zone the crate refuses),
`RDATE`, `EXDATE`, `RECURRENCE-ID` overrides (also moved into the window from outside),
cancelled instances, all-day events, `DURATION`. Each occurrence is its own event
(`href#20261105T090000Z`). Time zones: IANA names, Windows names (CLDR table, for
Outlook/Exchange), IANA names inside vendor prefixes, the IANA name a `VTIMEZONE` gives
(`X-LIC-LOCATION`), else the `VTIMEZONE`'s standard offset as a fixed offset; floating
times in the runner's own zone.

**Writes.** One VEVENT per resource, `PUT {calendar}/{uuid}.ics` with
`If-None-Match: *`; updates with `If-Match` on the last ETag seen (read with a `PROPFIND`
when unknown). A 412 reads the ETag again and retries once: the app wins, as in ADR 014.
A 404 is `NotFound` (the engine then creates it again). `DELETE` takes 404 as done. The
event id is the resource URL. The key is an `X-TASKMASTER-KEY` property; blocks are
`TRANSP:OPAQUE`, all-day items `TRANSPARENT`, all `CLASS:PRIVATE`.

**Sign-in and secrets.** Settings → Calendar → "iCloud & CalDAV": presets for iCloud
(`https://caldav.icloud.com`), Fastmail (`https://caldav.fastmail.com`), Nextcloud (the
user's `…/remote.php/dav`) and any URL, a user name and an app password. Connecting runs
discovery and lists the calendars before saving anything, so a wrong password fails
there. `config.json` keeps the URL, the user name, the home and the runner; **the password
is in the OS keychain** (`keyring` 4, service `task-master`, entry
`caldav:<user>@<host>`). Without a keychain (Linux with no Secret Service), connecting
says so and stops: no plain-text fallback.

**Sync server (ADR 015).** Runs on → Server works as for Google: `RunnerRequest` and
`RunnerTransfer` gain an optional `caldav` (old clients and servers ignore it), the server
keeps it in its `calendar.json` (0600) and runs a fresh provider each cycle, saving a
home found again. A request carrying an account replaces the saved one (Google or
CalDAV); handing back returns the server's copy. A server has no keychain.

## Dependencies

| Crate | For | Note |
|---|---|---|
| `rrule` 0.14 | RRULE expansion, RFC-tested | brings `chrono-tz` and `regex`; `chrono` was in the tree |
| `roxmltree` 0.21 | reading `multistatus` replies | was in the tree (server, via resvg) |
| `keyring` 4.2 | the password in the OS keychain (desktop only) | pure Rust on Linux (zbus), no system library |

No ICS crate: the reader is small, and the app writes one VEVENT shape. `ureq` 3 sends
`PROPFIND`, `REPORT` and `MKCALENDAR` with `allow_non_standard_methods`.

## Tests

`crates/client/tests/caldav.rs` runs the provider against an in-memory CalDAV server
(`tests/support/fake_dav.rs`: well-known redirect, Basic auth, sync tokens that expire,
multiget, time-range queries, ETags, MKCALENDAR, a concurrent edit), alone and under the
real engine with an in-memory store: push, moves and deletions on the "phone", an expired
token, a server without sync tokens and without ETag headers, recurring events in a shown
calendar. The ICS code has unit tests and snapshot tests on iCloud-, Google- and
Outlook-shaped exports (`tests/fixtures/ical`). The server test moves an account to the
server and back. Settings has component tests. **Not yet done:** a round against iCloud
itself (and Fastmail, Nextcloud) from the desktop and from the server.

## Rejected

- *The server's `<expand>`*: uneven on iCloud, and the .ics feeds need local expansion
  anyway.
- *Our own RRULE code on `jiff`*: no new crate, but BYSETPOS, DST and negative
  BYMONTHDAY edge cases to own.
- *The password in `config.json`*, like Google's refresh token: an app password opens the
  whole calendar account (and, for iCloud, more than the calendar).
