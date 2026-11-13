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

## Consequences

- Recording works on Windows and macOS only at first; Linux shows the meetings without
  recording.
- A transcript can outlive its audio, so corrections after the purge cannot be checked
  against the recording.
- Moving to contacts later needs a migration from free-text names to people.
