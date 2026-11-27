# ADR 038: How a meeting shows in calendars

Date: 2026-11-24 · Status: accepted. Follows ADR 014, ADR 025 and ADR 030.

## Context

The user asked for "calendar meeting types": private, visible, busy (occupé), tentative
(provisoire) and free, as Outlook offers them ("Afficher comme" and "Privé") when an
appointment is made. Until now the push decided alone: time blocks and meetings busy,
day plans and deadlines free, and in Outlook every pushed item private (ADR 030, the
main calendar is visible to colleagues). Events read from the user's other calendars
carried neither.

## Decision

Two independent fields, as in Outlook:

- **`show_as`**: `busy` | `tentative` | `free` (`ShowAs` in the core). Outlook's
  "out of office" reads as busy and "working elsewhere" as free; they are not offered.
- **`private`**: a boolean. "Visible" is the calendar's normal visibility, not "public".

They live on **meetings** (migration 23: `meetings.show_as`, default `busy`, and
`meetings.private`, default **1**, so existing meetings keep what the Outlook push already
made them). New meetings are busy and private unless the user picks otherwise on the
meeting page; "Make it a meeting" from a calendar event keeps the event's show-as. Time
blocks, day plans and deadlines are unchanged: they are not meetings, and the blocks'
privacy stays the provider's choice (`EventBody.private = None`).

The calendar engine carries them both ways:

- `EventBody.show_as` / `EventBody.private` go out. Google: `transparency` (free is
  transparent), `status: tentative` (Google has no tentative "show as"), `visibility`
  `private` or `default` (left out for `None`). Outlook: `BusyStatus` and `Sensitivity`
  (`olPrivate`, or `olNormal` for visible; private for `None`).
- `RemoteEvent.show_as` / `RemoteEvent.private` come back (`None` when a provider does
  not say). Like a move, a change made in the calendar to a meeting's event updates the
  meeting when the meeting did not change here; the app wins otherwise. The meeting's
  fingerprint includes both, so every linked meeting is pushed once after the upgrade
  (Google events then become private too).
- Events of shown calendars keep them in `calendar_events.show_as` / `.private`
  (refreshed by the next sync). Google reads the user's own answer first: "maybe" is
  tentative and "declined" free. The calendar draws tentative items with a broken edge,
  free ones lighter, and private ones with a padlock; `get_calendar` and
  `list_meetings` mark tentative and free items, `get_meeting` names both fields.

Schema 23: the sync server must be updated with the desktops.

## Consequences

- One more column pair per meeting, synced and exported like any field; two more COM
  property reads per Outlook item.
- CalDAV (ADR 037, on its own branch) should map `TRANSP`, `STATUS:TENTATIVE` and
  `CLASS:PRIVATE` the same way when it lands; until then it gets `None` from the
  provider and the meeting keeps its own values.
