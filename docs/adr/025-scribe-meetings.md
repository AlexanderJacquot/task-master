# ADR 025: Scribe, meetings with local transcription

Date: 2026-11-14 · Status: accepted (M18–M21, plan in docs/meetings-plan.md)

## Context

The user wants a meetings feature: record the microphone and the computer's sound, transcribe
on the device, attribute speakers, link the meeting to a project, epic or task, show it on
the calendar, and delete the audio after a while. Recording and speech models run outside
the core (like agent sessions, ADR 017); the meeting data belongs in the core and syncs.

## Decisions

**Name and place.** A sidebar tab **Scribe**, with a meeting page.

**Data (migration 15, synced).** `meetings` (title, start/end, optional project/epic/task,
state, free-text `participants`, notes, summary, `transcribed_at`, `validated_at`),
`meeting_speakers` (speaker key → free-text name), `transcript_segments` (+FTS5), and
`attachments.meeting_id` (an attachment belongs to exactly one task or meeting). Every
change is a `Command` with its inverse. `SetTranscript` replaces a meeting's segments in one
op. Segments are left out of the snapshot and are read per meeting (`meeting_transcript`).

**People are free text for now.** Names come with suggestions from earlier meetings. A
synced contacts list comes later (task `01a1d747…`).

**Audio never leaves the device.** It is not synced or uploaded, and is not in backups or
exports. It lives in `<data dir>/scribe/<meeting id>/`. Transcript, notes and summary sync.

**All audio expires.** Audio is deleted 10 days (the Settings → Scribe retention setting)
after validation. If the transcript is never validated, it is deleted 10 days after the
transcript is ready, with a warning 2 days before. A runner in the shell checks on start
and every hour. The purge date is computed per device from the synced timestamps.

**Transcription is local, after the meeting.** No live captions. The summary is the only
step that sends the transcript off the device, to Claude, and only on an explicit click.

**Calendar.** Meetings are their own calendar item, not time blocks, which belong to tasks.
When Google sync is on (ADR 014), they are pushed as `meeting:<id>` events, and a move made
in Google moves the meeting, like blocks.

**IPC.** These are added to the shell's process-owning commands (CLAUDE.md IPC list):
`scribe_devices`, `scribe_start`, `scribe_stop`, `scribe_status`, `scribe_process`,
`scribe_models`, `scribe_download_model`, `scribe_delete_model`, `scribe_summarize`,
`scribe_purge_audio`. Playback goes through `tm://meeting-audio/<id>/<track>` with range
requests.

## M18 notes (2026-11-14)

What M18 built, where it differs from or adds to the decisions above:

- **Migration 15 holds `meetings` and `attachments.meeting_id` only.** `meeting_speakers`
  and `transcript_segments` (with their FTS) come with transcription in M20, as
  migration 16. How `SetTranscript` writes a whole transcript as one op (the op engine
  writes one row per op) is decided there, with the pipeline that produces it.
- **States.** `scheduled | held | recording | processing | review | validated | failed`.
  `held` is new: the meeting took place, with notes but no recording. The UI shows
  "Upcoming", "In progress" or "Held" for the first two from the times. Entering
  `validated` sets `validated_at`; leaving it clears it.
- **Attachments.** The table was rebuilt (SQLite cannot drop NOT NULL): `task_id` is now
  nullable, `meeting_id` added, and a CHECK keeps exactly one of them. A deleted meeting
  hides its attachments like a deleted task does, and their files become purgeable.
- **Calendar.** A meeting is pushed when it has an end (not while recording), with its
  participants and links in the description; notes stay out. Moving the event in Google
  moves the meeting. **Deleting the event in Google does not delete the meeting** (it
  holds notes): the next sync creates the event again. A Google event's popover has
  "Make it a meeting". The planner treats meetings as busy time.
- **Links** are checked when set but do not follow deletions: a meeting linked to a task,
  epic or project that is deleted keeps its link and shows nothing for it.
- **MCP:** `list_meetings`, `get_meeting`, and meetings in `get_calendar`; read-only.
- No new IPC in M18: meetings go through `execute` and the snapshot like other entities.

## Consequences

- Recording works on Windows and macOS only at first; Linux shows the meetings without
  recording.
- A transcript can outlive its audio, so corrections after the purge cannot be checked
  against the recording.
- Moving to contacts later needs a migration from free-text names to people.
