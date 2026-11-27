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
(As built, ADR 040: the meeting page's "Send to Claude" starts an agent session that reads
it through the MCP; the MCP hands a transcript only to a session on the meeting's task, or
to any agent while the user lets agents edit their tasks.)

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
  (ADR 040 adds the transcript to `get_meeting` and `set_meeting_summary`, for the
  summary's "Send to Claude".)
- No new IPC in M18: meetings go through `execute` and the snapshot like other entities.

## M19 notes (2026-11-15)

Recording, as built (ADR 026 for the libraries):

- **IPC.** `scribe_status` (what this system can record, the recording in progress),
  `scribe_devices`, `scribe_settings` / `set_scribe_settings` (microphone, record the
  computer's sound, consent reminder; per device, in `config.json`), `scribe_start(meeting)`,
  `scribe_stop`, `scribe_audio(meeting)` (this device's audio: recording, interrupted,
  encoding or ready, tracks, size, warnings), `scribe_recover(meeting, keep)`,
  `scribe_purge_audio(meeting)`, `scribe_audio_usage`. Events `ScribeLevels` (ten a second)
  and `ScribeChanged`. Start reads the saved devices instead of taking them as arguments.
- **Meeting row.** Start sets `started_at` to now, clears `ended_at` and sets `recording`;
  stop sets `ended_at` (at least a minute after the start) and `held` until M20 moves it to
  `processing`. These are the app's writes (`execute_without_undo`), not the user's undo.
  One recording at a time per device. Recording stops by itself 5 minutes short of the
  core's 24-hour limit.
- **Files.** `scribe/<meeting id>/recording.json` (start, devices, finished, length,
  warnings), `mic.wav` and `system.wav` while recording (header sizes rewritten every second,
  so a crash keeps everything but the last second), then `mic.opus` / `system.opus`
  (written aside, renamed, then the WAV removed; an interrupted encode restarts on the next
  start). A recording a crash left unfinished is repaired on start; the meeting page offers
  "Keep what was recorded" (the meeting ends where the audio does) or "Discard". A recording
  folder blocks a second recording of the same meeting until its audio is deleted.
- **Alignment.** Both tracks start at the recording's start. A track that delivers nothing
  for 250 ms (WASAPI loopback sends nothing while nothing plays) is padded with silence to
  the wall clock, and its next chunk is placed at its own time, so a sample's position is
  its time in both files.
- **Playback.** `tm://localhost/meeting-audio/<meeting id>/<track>`, with range requests
  (206, at most 4 MB a response). The meeting page plays both tracks together, each mutable.
  Settings → Scribe and Settings → Files list the audio on this device with its size.
- **Quitting** asks first while recording; the recording is finished cleanly either way.

## M20 notes (2026-11-18)

Transcription, as built:

- **Data.** Migration 16: `transcript_segments` (meeting, start/end from the recording's
  start, speaker key `me` / `s1`, `s2`…, text, `edited`; soft delete, synced, with
  `transcript_fts`) and `meetings.speakers`, a JSON object naming speaker keys (one meeting
  field, so naming a voice is one update). No `meeting_speakers` table. Segments are not in
  the snapshot: the UI reads a meeting's transcript (`meeting_transcript`) when it opens it
  and re-reads it on changes. `search_transcripts` searches live meetings' lines.
- **Commands.** `SetTranscript` replaces a meeting's transcript as one batch (one undo):
  its live segments deleted, the new ones written, speaker names cleared, `transcribed_at`
  set, state `review`. `UpdateSegment` (text marks it edited, or speaker), `SplitSegment`
  (at a character, time shared in proportion, client id for the new half),
  `DeleteSegment`, `ReassignSpeaker` (one voice found as two), `UpdateMeeting`
  `speaker_name`. Validate is `UpdateMeeting state: validated`.
- **IPC.** `scribe_models`, `scribe_download_model`, `scribe_cancel_download`,
  `scribe_delete_model`, `scribe_process` (queue, or transcribe again from scratch),
  `scribe_cancel_process`; events `ScribeProgress` (step and fraction) and
  `ScribeModelProgress`. `scribe_audio` adds the job (queued, running, failed with its
  error) and `purge_at`. Settings gain the active model, the language (detected when
  unset), "transcribe when the recording stops" (on) and the retention days (10, 1–365).
- **Jobs.** One at a time, never while recording, waiting for the compression. A job is
  `transcript/job.json` beside the audio and each step's result is cached there (mic
  words, system words, turns), so a quit or a failure resumes at the last finished step;
  "Try again" resumes, "Transcribe again" starts over (and a model change too). Cancel
  puts the meeting back in its previous state.
- **Retention.** On start and hourly: a meeting's audio is deleted `retention_days` after
  validation, or after the transcript was made when never validated, or after the meeting
  was deleted (so undo still finds it). Never-transcribed audio is kept. The meeting page
  says when, in red from two days before.
- **UI.** Meeting page: Transcribe / progress / Stop / Try again under the player, then the
  transcript (virtualized): speakers with a name field and "Same voice as…", each line's
  time plays the recording from there and the playing line follows, the speaker menu
  (or "Another voice"), click to correct, "Split here" at the cursor, delete; Validate /
  Check again. Settings → Scribe → Transcription: models (download with progress, stop,
  resume, use, delete), language, auto-transcribe, days the audio is kept. Ctrl+K lists
  meetings and transcript lines (opens the meeting on the line, `?line=`).

## Consequences

- Recording works on Windows and macOS only at first; Linux shows the meetings without
  recording.
- A transcript can outlive its audio, so corrections after the purge cannot be checked
  against the recording.
- Moving to contacts later needs a migration from free-text names to people.
