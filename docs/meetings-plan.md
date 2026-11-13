# Scribe: meetings, recording and local transcription (draft plan)

Status: **accepted** 2026-11-14, not started. Decisions recorded in ADR 025 (data, IPC,
calendar, retention) and ADR 026 (audio and ML dependencies).

## 1. Goal

A sidebar tab, **Scribe**, where you start a meeting, record your microphone and the
computer's sound (so every remote participant is captured), transcribe it on this device,
see who said what, and keep the result linked to a project, an epic or a task. Meetings
show on the calendar. Audio is deleted some days after the transcript is validated; the
transcript stays.

Decided (2026-11-14):

| Topic | Decision |
|---|---|
| Platforms, v1 | Windows and macOS. Linux builds and runs without recording (CI still builds it). |
| Transcription | Local only, after the meeting stops. No live captions. |
| Speakers | Automatic local diarization (Speaker 1, 2, …), then named by hand. |
| Summary | Opt-in "Summarize" button using Claude; the transcript leaves the device only then. Proposed action items become tasks after confirmation. |
| Name | Scribe. |
| People | Free-text names per meeting, suggested from names used before. A synced contacts list is a later improvement (logged as a task). |
| Audio | Never leaves the device, never synced. Transcript, notes, summary sync. |
| Retention | All audio expires: 10 days after validation, or 10 days after the transcript is ready if never validated (warning 2 days before). Setting in Settings → Scribe. |
| Calendar | Meetings are pushed to Google Calendar when Google sync is on. |
| Models | Settings → Scribe lists `large-v3-turbo` and `small`; either or both can be downloaded, one is active. Nothing is downloaded until asked. |

## 2. Architecture

The core owns the data. Capture and ML are processes the core cannot own, so they live in
the shell like agent sessions (ADR 017).

```
apps/desktop/src-tauri/src/scribe/
  capture/        mic + system loopback -> two 16 kHz mono tracks on disk
    windows.rs    WASAPI (cpal; loopback on the default output device)
    macos.rs      ScreenCaptureKit audio (macOS 13+), mic via cpal
    other.rs      "recording not supported on this OS"
  models.rs       download, verify (SHA-256) and locate model files
  transcribe.rs   whisper.cpp (whisper-rs), per track
  diarize.rs      sherpa-onnx speaker diarization (segmentation + embeddings)
  merge.rs        tracks + speaker turns -> transcript segments  (pure, unit tested)
  summary.rs      claude -p with the transcript, via the agent runtime setting
  retention.rs    deletes audio whose purge date has passed
crates/core       meetings, segments, commands, FTS, calendar read
```

Pipeline after Stop:

1. Each track is transcribed with whisper (word timestamps on).
2. The **system** track is diarized into anonymous speakers. The **mic** track is you
   (a "Me" speaker), so diarization only has to separate the remote side. Echo from
   speakers leaking into the mic is dropped when a mic segment overlaps a louder system
   segment with the same words (headphones recommended in the UI).
3. `merge.rs` aligns words to speaker turns and emits segments; one `SetTranscript`
   command stores them.
4. Progress is reported as events (`scribe://progress`), and the job resumes from the
   last finished step after a crash or app restart.

Audio files: `<data dir>/scribe/<meeting id>/{mic,system}.wav` while recording (written
in chunks so a crash keeps what was recorded), then encoded to Opus in place. About
30 MB per hour for both tracks. **Audio stays on the device and is not synced**; the
transcript and everything else sync like other rows.

Models (Settings → Scribe: download, delete, pick the active one; the first Process with
no model installed opens that page): whisper `large-v3-turbo` (≈1.6 GB, more accurate)
and `small` (≈0.5 GB, faster); pyannote segmentation + a speaker embedding model for
sherpa-onnx (≈40 MB, downloaded with whichever whisper model comes first). GPU: Metal
on macOS; CPU on Windows in v1 (Vulkan/CUDA later).

## 3. Data model (core, migration 15)

```
meetings             id, title, started_at, ended_at?, project_id?, epic_id?, task_id?,
                     state (scheduled|recording|processing|review|validated|failed),
                     participants (JSON array of names), notes_md, summary_md?,
                     transcribed_at?, validated_at?, created/updated/deleted_at
meeting_speakers     meeting_id, speaker_key ("me", "s1", ...), name?
transcript_segments  id, meeting_id, start_ms, end_ms, speaker_key, text, edited,
                     created/updated/deleted_at                  (+ FTS5 on text)
attachments          + meeting_id (task_id becomes nullable; exactly one is set)
```

Audio state is per device and not in the synced tables: the shell keeps
`scribe/<meeting id>/` and computes the purge date from `transcribed_at` / `validated_at`
plus the retention setting.

Commands (each with its inverse in `ops`, tests on in-memory SQLite):
`CreateMeeting/UpdateMeeting/DeleteMeeting` (participants are a field of the update),
`SetTranscript` (replaces all segments and sets `transcribed_at`; one op), `EditSegment`,
`SplitSegment`, `NameSpeaker` (speaker key → name, or one segment's speaker),
`ValidateTranscript` (sets `validated_at`). Participant suggestions: a read of distinct
names used in past meetings.

Snapshot gets meetings (not segments; they load per meeting through a new read
`meeting_transcript`). Search covers transcripts.

## 4. IPC additions (ADR 025)

`scribe_devices`, `scribe_start(meeting_id, mic_device, capture_system)`, `scribe_stop`,
`scribe_status` (+ level meter events), `scribe_process(meeting_id)` (retry too),
`scribe_models` / `scribe_download_model`, `scribe_summarize(meeting_id)`,
`scribe_purge_audio(meeting_id)`; audio playback through the `tm:` protocol
(`tm://meeting-audio/<id>/<track>`, range requests for seeking).

## 5. UI

- **Sidebar tab Scribe**: list of meetings (virtualized), filters by project/epic/participant,
  a big "Start meeting" button, and a recording bar that stays visible on every page while
  recording (timer, levels, Stop).
- **Meeting page**: title, links (project / epic / task pickers), participants (free-text
  chips with suggestions from earlier meetings), notes (markdown, editable during the call),
  attachments, then the transcript: speaker chips, click a line to play from there,
  inline edit, name a speaker cluster once for the whole meeting,
  "Validate transcript". Summary panel with "Summarize with Claude" and the proposed
  action items as checkboxes → "Create tasks".
- **Calendar**: meetings drawn as their own kind of item (not time blocks, which belong to
  tasks), with the project's color, and pushed to Google Calendar as `meeting:<id>`
  events (title, time, participants and links in the description; moving the event in
  Google moves the meeting, like blocks). Starting a meeting from an existing Google
  event pre-fills title and time.
- **Task / project / epic pages**: a "Meetings" section listing linked meetings.
- Settings → Scribe: models (download / delete / active), default mic, capture system
  audio on/off, audio retention days (default 10), "remind me to tell participants
  they're being recorded".

## 6. Milestones and subtasks

Each milestone is one branch and ends with something usable.

### M18 Meetings without audio (`m18-meetings`)
1. Migration 15: meetings, meeting_speakers, transcript_segments (+FTS),
   attachments.meeting_id. Migration test on an existing DB.
2. Core commands + inverses + tests; snapshot and `meeting_transcript` read; sync of
   the new tables (server too); export/import and backups include them.
3. Bindings; store slices and optimistic actions in `src/store/actions.ts`.
4. Scribe tab, meeting page (title, links, participants with suggestions, notes,
   attachments).
5. Meetings on the calendar and pushed to Google (`meeting:<id>` keys in the calendar
   sync, both directions); "Meetings" sections on task/project/epic pages.
6. MCP: `list_meetings`, `get_meeting` (read-only).

### M19 Recording on Windows and macOS (`m19-scribe-capture`)
1. ADR 026 (cpal, screencapturekit, Opus encoder) proposed and accepted.
2. Capture trait + Windows WASAPI loopback + mic; macOS ScreenCaptureKit + mic and the
   permission flow; stub elsewhere.
3. Chunked WAV writer, crash recovery (a meeting left in `recording` offers "Keep what was
   recorded"), Opus encoding after stop.
4. Recording bar, device picker, level meters, consent reminder.
5. Playback via `tm:`; audio size shown in Settings → Files.
6. Release builds: macOS entitlements (microphone, screen capture) and usage strings.

### M20 Transcription and speakers (`m20-scribe-transcribe`)
1. Model manager and Settings → Scribe: list both models, download with progress,
   resume, SHA-256 check, delete, pick the active one.
2. whisper-rs per track with word timestamps; Metal on macOS.
3. sherpa-onnx diarization on the system track; echo removal; `merge.rs` with fixture
   tests (synthetic word lists + turns → expected segments).
4. Resumable background job, progress events, retry on failure.
5. Transcript review UI: edit, split, speaker assignment, click-to-play, Validate.
6. Retention runner (on start and hourly): deletes audio 10 days (setting) after
   validation, or after transcription when never validated; warning on the meeting page
   2 days before.
7. Transcript search in the palette and FTS.
8. CI: cmake/clang for whisper.cpp; bundling and signing onnxruntime on macOS.

### M21 Summary and action items (`m21-scribe-summary`)
1. `scribe_summarize`: `claude -p` (respecting the native/WSL runtime setting) with the
   transcript, participants and links; returns markdown summary + action items JSON.
2. Summary panel; confirm action items → `CreateTask` in the meeting's project/epic,
   assignee noted in the description; link back to the meeting.
3. MCP: transcript search tool for agents.

### Later
Live captions; Linux capture (PipeWire monitor); GPU on Windows; synced contacts list
replacing free-text names (task logged 2026-11-14); voice profiles so a person is
recognized across meetings; auto-detect a call starting (Teams/Zoom/Meet) and offer to
record; speaker-labelled export (Markdown,
SRT).

## 7. Risks

- **Native dependencies in three release builds.** whisper.cpp (C++, cmake) and
  onnxruntime (prebuilt dylib) must build and be signed on Windows and macOS runners; the
  macOS notarization of a bundled dylib is the likeliest snag. Spike this first in M19/M20.
- **macOS system audio** needs the screen recording permission, which users find
  alarming; the UI must explain it.
- **Diarization quality** on a single mixed system track with overlapping speech is
  mediocre; manual reassignment must be fast.
- **CPU time**: `large-v3-turbo` on CPU runs roughly at 0.2–0.5× real time on a recent
  laptop (a 1 h meeting ≈ 15–30 min). `small` is the fallback.
- **Testing**: development happens in WSL, which has no audio. Capture is only testable
  on a real Windows or macOS install; everything after capture is tested with recorded
  WAV fixtures.
- **Recording consent** laws differ by country; the app reminds, it does not enforce.
