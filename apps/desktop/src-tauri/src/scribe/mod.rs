//! Scribe recording (ADR 025, ADR 026, M19): the microphone and the computer's sound,
//! recorded to two aligned 16 kHz tracks under `<data dir>/scribe/<meeting id>/`, then
//! encoded to Ogg Opus. The meeting row (through the core) says it is recording; the audio
//! itself stays on this device.
//!
//! One recording at a time. Its writer thread pads tracks across gaps, meters levels
//! (`ScribeLevels` events, ten a second) and flushes every second, so a crash keeps what
//! was recorded: the next start finds the folder unfinished and the meeting page offers to
//! keep or discard it.

pub mod audio;
pub mod capture;
pub mod files;
pub mod opus;
pub mod recorder;
pub mod wav;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use taskmaster_core::{Command, Id, MeetingChange, MeetingState, Timestamp};
use tauri::http::{Request, Response, StatusCode, header};
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event as _;

use crate::{AppState, CommandResult, internal, invalid, with_store, with_store_ref};
use capture::{AudioDevice, CaptureSupport, Input, Streams};
use files::Meta;
use recorder::Recorder;

pub const MIC_WAV: &str = "mic.wav";
pub const SYSTEM_WAV: &str = "system.wav";

/// The core refuses meetings longer than a day; recording stops just before.
const MAX_RECORDING: Duration = Duration::from_secs(24 * 3600 - 5 * 60);
/// A stopped meeting lasts at least this long (the core wants an end after the start).
const MIN_MEETING_MS: i64 = 60_000;

/// Scribe settings of this device (Settings → Scribe).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ScribeSettings {
    /// Microphone id from `scribe_devices`; the system default when `None`.
    #[serde(default)]
    pub mic_device: Option<String>,
    /// Record the computer's sound too (everyone else on a call).
    #[serde(default = "yes")]
    pub capture_system: bool,
    /// Remind to tell participants they are recorded, when recording starts.
    #[serde(default = "yes")]
    pub consent_reminder: bool,
}

fn yes() -> bool {
    true
}

impl Default for ScribeSettings {
    fn default() -> Self {
        Self {
            mic_device: None,
            capture_system: true,
            consent_reminder: true,
        }
    }
}

/// Audio levels of the recording, about ten times a second.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct ScribeLevels {
    pub meeting_id: Id,
    pub elapsed_ms: u32,
    /// 0 (silent) to 1.
    pub mic: f32,
    pub system: Option<f32>,
}

/// A meeting's audio on this device changed: recording started or stopped, encoding
/// finished, audio kept, discarded or deleted. The UI reads `scribe_audio` again.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct ScribeChanged {
    pub meeting_id: Id,
}

/// The recording in progress.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LiveRecording {
    pub meeting_id: Id,
    pub started_at: Timestamp,
    pub mic: String,
    /// The output device recorded, when the computer's sound is.
    pub system: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ScribeStatus {
    pub support: CaptureSupport,
    pub live: Option<LiveRecording>,
}

/// Where a meeting's audio stands on this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AudioState {
    Recording,
    /// Recording stopped without finishing (the app or the computer stopped): keep or
    /// discard.
    Interrupted,
    /// Being compressed after recording; playable already.
    Encoding,
    Ready,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AudioTrack {
    /// `mic` or `system`.
    pub track: String,
    /// Path for the `tm:` protocol: `meeting-audio/<meeting id>/<track>`.
    pub path: String,
}

/// A meeting's audio on this device.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct MeetingAudio {
    pub state: AudioState,
    pub started_at: Timestamp,
    /// Recorded length (so far, while recording or interrupted).
    pub duration_ms: u32,
    pub bytes: u32,
    pub tracks: Vec<AudioTrack>,
    pub warnings: Vec<String>,
}

/// Size of one meeting's audio (Settings → Files).
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AudioUsage {
    pub meeting_id: Id,
    pub bytes: u32,
    pub duration_ms: u32,
}

struct Live {
    info: LiveRecording,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

/// Recording and encoding on this device.
#[derive(Default)]
pub struct ScribeRuntime {
    live: Mutex<Option<Live>>,
    /// Meetings whose tracks are being encoded.
    encoding: Mutex<HashSet<Id>>,
}

impl ScribeRuntime {
    fn live_id(&self) -> Option<Id> {
        self.live
            .lock()
            .ok()
            .and_then(|l| l.as_ref().map(|l| l.info.meeting_id.clone()))
    }

    fn is_encoding(&self, id: &str) -> bool {
        self.encoding.lock().is_ok_and(|e| e.contains(id))
    }
}

fn now_ms() -> Timestamp {
    taskmaster_core::now_ms()
}

fn changed(app: &AppHandle, meeting_id: &str) {
    let _ = ScribeChanged {
        meeting_id: meeting_id.to_owned(),
    }
    .emit(app);
}

fn settings_of(state: &AppState) -> ScribeSettings {
    state
        .config
        .lock()
        .map(|c| c.scribe.clone())
        .unwrap_or_default()
}

/// A meeting write by the app itself (not the user's undo history).
fn write_meeting(
    state: &AppState,
    meeting_id: &str,
    changes: Vec<MeetingChange>,
) -> CommandResult<()> {
    with_store(state, |s| {
        s.execute_without_undo(vec![Command::UpdateMeeting {
            id: meeting_id.to_owned(),
            changes,
        }])
    })
    .map(|_| ())
}

fn meeting_dir(state: &AppState, meeting_id: &str) -> CommandResult<PathBuf> {
    files::meeting_dir(&state.data_dir, meeting_id).ok_or_else(|| invalid("not a meeting id"))
}

// ---------------------------------------------------------------------------------------
// Commands

/// What recording can do here, and the recording in progress.
#[tauri::command]
#[specta::specta]
pub fn scribe_status(state: State<'_, AppState>) -> CommandResult<ScribeStatus> {
    let live = state
        .scribe
        .live
        .lock()
        .map_err(|_| internal("scribe lock poisoned"))?
        .as_ref()
        .map(|l| l.info.clone());
    Ok(ScribeStatus {
        support: capture::support(),
        live,
    })
}

/// Microphones to choose from.
#[tauri::command]
#[specta::specta]
pub async fn scribe_devices() -> CommandResult<Vec<AudioDevice>> {
    tauri::async_runtime::spawn_blocking(capture::input_devices)
        .await
        .map_err(|e| internal(e.to_string()))?
        .map_err(internal)
}

#[tauri::command]
#[specta::specta]
pub fn scribe_settings(state: State<'_, AppState>) -> CommandResult<ScribeSettings> {
    Ok(settings_of(&state))
}

#[tauri::command]
#[specta::specta]
pub fn set_scribe_settings(
    state: State<'_, AppState>,
    settings: ScribeSettings,
) -> CommandResult<ScribeSettings> {
    let mut settings = settings;
    settings.mic_device = settings
        .mic_device
        .map(|d| d.trim().to_owned())
        .filter(|d| !d.is_empty());
    let mut config = state
        .config
        .lock()
        .map_err(|_| internal("config lock poisoned"))?;
    config.scribe = settings.clone();
    config
        .save(&state.config_path)
        .map_err(|e| internal(format!("cannot save settings: {e}")))?;
    Ok(settings)
}

/// Starts recording the meeting with the saved microphone and system-sound settings.
/// The meeting starts now and has no end until the recording stops.
#[tauri::command]
#[specta::specta]
pub async fn scribe_start(app: AppHandle, meeting_id: Id) -> CommandResult<ScribeStatus> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || start(&handle, &meeting_id))
        .await
        .map_err(|e| internal(e.to_string()))??;
    scribe_status(app.state::<AppState>())
}

fn start(app: &AppHandle, meeting_id: &str) -> CommandResult<()> {
    let state = app.state::<AppState>();
    if !capture::support().recording {
        return Err(invalid(
            "recording works on Windows and macOS; not yet on this system",
        ));
    }
    let meeting = with_store_ref(&state, |s| s.meeting(meeting_id))?;
    let dir = meeting_dir(&state, meeting_id)?;
    {
        let live = state
            .scribe
            .live
            .lock()
            .map_err(|_| internal("scribe lock poisoned"))?;
        if let Some(live) = live.as_ref() {
            return Err(invalid(if live.info.meeting_id == meeting_id {
                "this meeting is being recorded already".to_owned()
            } else {
                "another meeting is being recorded; stop it first".to_owned()
            }));
        }
    }
    if dir.join(files::META).exists() {
        return Err(invalid(
            "this meeting has a recording already; delete its audio to record it again",
        ));
    }
    let settings = settings_of(&state);
    let (sink, source) = std::sync::mpsc::channel::<Input>();
    let (streams, opened) =
        Streams::open(settings.mic_device.clone(), settings.capture_system, sink)
            .map_err(invalid)?;
    let started_at = now_ms();
    let mut recorder = Recorder::create(&dir, opened.system.is_some())
        .map_err(|e| internal(format!("cannot write the recording: {e}")))?;
    let mut meta = Meta {
        meeting_id: meeting_id.to_owned(),
        started_at,
        mic: opened.mic.clone(),
        system: opened.system.clone(),
        ..Meta::default()
    };
    files::write_meta(&dir, &meta).map_err(|e| internal(format!("cannot write: {e}")))?;
    // The meeting is now: it starts with the recording and has no end until it stops.
    let mut changes = vec![
        MeetingChange::StartedAt(started_at),
        MeetingChange::EndedAt(None),
        MeetingChange::State(MeetingState::Recording),
    ];
    if meeting.ended_at.is_none() {
        changes.remove(1);
    }
    if let Err(e) = write_meeting(&state, meeting_id, changes) {
        streams.stop();
        // Its files are open (Windows refuses to delete open files).
        drop(recorder);
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }

    let stop = Arc::new(AtomicBool::new(false));
    let info = LiveRecording {
        meeting_id: meeting_id.to_owned(),
        started_at,
        mic: opened.mic,
        system: opened.system,
    };
    let thread = {
        let (app, stop, id) = (app.clone(), stop.clone(), meeting_id.to_owned());
        std::thread::Builder::new()
            .name("scribe-recorder".into())
            .spawn(move || {
                let clock = Instant::now();
                let elapsed = || clock.elapsed().as_millis() as u64;
                let (mut last_tick, mut last_flush) = (0u64, 0u64);
                let mut failure = None;
                loop {
                    if stop.load(Ordering::Relaxed) || clock.elapsed() >= MAX_RECORDING {
                        break;
                    }
                    let result = match source.recv_timeout(Duration::from_millis(50)) {
                        Ok(Input::Audio {
                            track,
                            rate,
                            samples,
                        }) => recorder.push(track, rate, &samples, elapsed()),
                        Ok(Input::Error { track, message }) => {
                            recorder.warn(track, message);
                            Ok(())
                        }
                        Err(RecvTimeoutError::Timeout) => Ok(()),
                        Err(RecvTimeoutError::Disconnected) => break,
                    };
                    let now = elapsed();
                    let result = result.and_then(|()| {
                        if now - last_tick >= 100 {
                            last_tick = now;
                            let levels = recorder.tick(now)?;
                            let _ = ScribeLevels {
                                meeting_id: id.clone(),
                                elapsed_ms: now as u32,
                                mic: levels.mic,
                                system: levels.system,
                            }
                            .emit(&app);
                        }
                        if now - last_flush >= 1_000 {
                            last_flush = now;
                            recorder.flush()?;
                        }
                        Ok(())
                    });
                    if let Err(e) = result {
                        failure = Some(format!("Recording stopped: {e}"));
                        break;
                    }
                }
                streams.stop();
                // What the callbacks sent before the streams closed.
                while let Ok(input) = source.try_recv() {
                    if let Input::Audio {
                        track,
                        rate,
                        samples,
                    } = input
                    {
                        let _ = recorder.push(track, rate, &samples, elapsed());
                    }
                }
                let mut warnings = std::mem::take(&mut recorder.warnings);
                warnings.extend(failure);
                let end = elapsed();
                match recorder.finish(end) {
                    Ok(samples) => meta.samples = samples,
                    Err(e) => warnings.push(format!("The end of the recording was lost: {e}")),
                }
                meta.finished = true;
                meta.warnings = warnings;
                finish_recording(&app, &dir, &meta);
            })
            .map_err(|e| internal(format!("cannot start recording: {e}")))?
    };
    let mut live = state
        .scribe
        .live
        .lock()
        .map_err(|_| internal("scribe lock poisoned"))?;
    *live = Some(Live {
        info,
        stop,
        thread: Some(thread),
    });
    drop(live);
    changed(app, meeting_id);
    Ok(())
}

/// After the recorder finished (stopped, at the length limit, or on a write error):
/// records the meeting's end, frees the slot and starts encoding.
fn finish_recording(app: &AppHandle, dir: &Path, meta: &Meta) {
    let state = app.state::<AppState>();
    if let Err(e) = files::write_meta(dir, meta) {
        eprintln!("cannot write {}: {e}", dir.join(files::META).display());
    }
    let ended_at = meta.started_at + (meta.duration_ms() as i64).max(MIN_MEETING_MS);
    if let Err(e) = write_meeting(
        &state,
        &meta.meeting_id,
        vec![
            MeetingChange::EndedAt(Some(ended_at)),
            MeetingChange::State(MeetingState::Held),
        ],
    ) {
        eprintln!("cannot end the meeting: {}", e.message);
    }
    if let Ok(mut live) = state.scribe.live.lock()
        && live
            .as_ref()
            .is_some_and(|l| l.info.meeting_id == meta.meeting_id)
    {
        *live = None;
    }
    encode_later(app, &meta.meeting_id);
    changed(app, &meta.meeting_id);
}

/// Stops the recording in progress and waits until its files are complete.
#[tauri::command]
#[specta::specta]
pub async fn scribe_stop(app: AppHandle) -> CommandResult<ScribeStatus> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let thread = {
            let mut live = state
                .scribe
                .live
                .lock()
                .map_err(|_| internal("scribe lock poisoned"))?;
            match live.as_mut() {
                Some(l) => {
                    l.stop.store(true, Ordering::Relaxed);
                    l.thread.take()
                }
                None => None,
            }
        };
        if let Some(thread) = thread {
            let _ = thread.join();
        }
        Ok::<_, crate::CommandError>(())
    })
    .await
    .map_err(|e| internal(e.to_string()))??;
    scribe_status(app.state::<AppState>())
}

/// The meeting's audio on this device; `None` when it has none here.
#[tauri::command]
#[specta::specta]
pub fn scribe_audio(
    state: State<'_, AppState>,
    meeting_id: Id,
) -> CommandResult<Option<MeetingAudio>> {
    let dir = meeting_dir(&state, &meeting_id)?;
    let Some(meta) = files::read_meta(&dir) else {
        return Ok(None);
    };
    let live = state.scribe.live_id().as_deref() == Some(meeting_id.as_str());
    let audio_state = if live {
        AudioState::Recording
    } else if !meta.finished {
        AudioState::Interrupted
    } else if state.scribe.is_encoding(&meeting_id) || !files::unencoded(&dir).is_empty() {
        AudioState::Encoding
    } else {
        AudioState::Ready
    };
    let duration_ms = match audio_state {
        AudioState::Recording => (now_ms() - meta.started_at).max(0) as u64,
        AudioState::Interrupted => {
            wav::sample_count(&dir.join(MIC_WAV)).unwrap_or(0) / audio::PER_MS
        }
        _ => meta.duration_ms(),
    };
    let tracks = ["mic", "system"]
        .into_iter()
        .filter(|t| files::track_file(&dir, t).is_some())
        .map(|t| AudioTrack {
            track: t.to_owned(),
            path: format!("meeting-audio/{meeting_id}/{t}"),
        })
        .collect();
    Ok(Some(MeetingAudio {
        state: audio_state,
        started_at: meta.started_at,
        duration_ms: duration_ms.min(u64::from(u32::MAX)) as u32,
        bytes: files::size(&dir).min(u64::from(u32::MAX)) as u32,
        tracks,
        warnings: meta.warnings,
    }))
}

/// After an interrupted recording: `keep` finishes it with what reached the disk (the
/// meeting ends where the audio ends); otherwise the audio is deleted.
#[tauri::command]
#[specta::specta]
pub fn scribe_recover(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: Id,
    keep: bool,
) -> CommandResult<()> {
    let dir = meeting_dir(&state, &meeting_id)?;
    if state.scribe.live_id().as_deref() == Some(meeting_id.as_str()) {
        return Err(invalid("this meeting is being recorded"));
    }
    let Some(mut meta) = files::read_meta(&dir).filter(|m| !m.finished) else {
        return Err(invalid("this meeting has no interrupted recording"));
    };
    if !keep {
        std::fs::remove_dir_all(&dir).map_err(|e| internal(format!("cannot delete: {e}")))?;
        let meeting = with_store_ref(&state, |s| s.meeting(&meeting_id))?;
        let mut changes = vec![MeetingChange::State(MeetingState::Held)];
        if meeting.ended_at.is_none() {
            changes.push(MeetingChange::EndedAt(Some(
                meeting.started_at + MIN_MEETING_MS,
            )));
        }
        write_meeting(&state, &meeting_id, changes)?;
        changed(&app, &meeting_id);
        return Ok(());
    }
    // Both tracks end at the shorter one's length (the longer may hold a partial second).
    let mut samples = u64::MAX;
    for name in [MIC_WAV, SYSTEM_WAV] {
        let path = dir.join(name);
        if path.is_file() {
            let n = wav::repair(&path).map_err(|e| internal(format!("cannot repair: {e}")))?;
            samples = samples.min(n);
        }
    }
    meta.samples = if samples == u64::MAX { 0 } else { samples };
    meta.finished = true;
    meta.warnings
        .push("The recording was interrupted; what reached the disk was kept.".into());
    finish_recording(&app, &dir, &meta);
    Ok(())
}

/// Deletes the meeting's audio from this device (the transcript, when any, stays).
#[tauri::command]
#[specta::specta]
pub fn scribe_purge_audio(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: Id,
) -> CommandResult<()> {
    let dir = meeting_dir(&state, &meeting_id)?;
    if state.scribe.live_id().as_deref() == Some(meeting_id.as_str()) {
        return Err(invalid("stop the recording first"));
    }
    if state.scribe.is_encoding(&meeting_id) {
        return Err(invalid(
            "the audio is being compressed; try again in a moment",
        ));
    }
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| internal(format!("cannot delete: {e}")))?;
    }
    changed(&app, &meeting_id);
    Ok(())
}

/// Meeting audio kept on this device, largest first.
#[tauri::command]
#[specta::specta]
pub fn scribe_audio_usage(state: State<'_, AppState>) -> CommandResult<Vec<AudioUsage>> {
    let mut usage: Vec<AudioUsage> = files::all(&state.data_dir)
        .into_iter()
        .map(|(dir, meta)| AudioUsage {
            bytes: files::size(&dir).min(u64::from(u32::MAX)) as u32,
            duration_ms: meta.duration_ms().min(u64::from(u32::MAX)) as u32,
            meeting_id: meta.meeting_id,
        })
        .collect();
    usage.sort_by_key(|u| std::cmp::Reverse(u.bytes));
    Ok(usage)
}

// ---------------------------------------------------------------------------------------
// Encoding

/// Encodes the meeting's WAV tracks to Opus on a background thread (once at a time per
/// meeting). Each file is written aside and renamed, then its WAV removed, so an
/// interrupted encode starts over on the next run.
fn encode_later(app: &AppHandle, meeting_id: &str) {
    let state = app.state::<AppState>();
    let Some(dir) = files::meeting_dir(&state.data_dir, meeting_id) else {
        return;
    };
    if files::unencoded(&dir).is_empty() {
        return;
    }
    {
        let Ok(mut encoding) = state.scribe.encoding.lock() else {
            return;
        };
        if !encoding.insert(meeting_id.to_owned()) {
            return;
        }
    }
    let (app, id) = (app.clone(), meeting_id.to_owned());
    let spawned = std::thread::Builder::new()
        .name("scribe-encode".into())
        .spawn(move || {
            for (wav, opus) in files::unencoded(&dir) {
                let part = opus.with_extension("opus.part");
                let result = opus::encode_wav(&wav, &part, |_| {})
                    .and_then(|()| std::fs::rename(&part, &opus))
                    .and_then(|()| std::fs::remove_file(&wav));
                if let Err(e) = result {
                    eprintln!("cannot compress {}: {e}", wav.display());
                    let _ = std::fs::remove_file(&part);
                }
            }
            let state = app.state::<AppState>();
            if let Ok(mut encoding) = state.scribe.encoding.lock() {
                encoding.remove(&id);
            }
            changed(&app, &id);
        });
    if spawned.is_err()
        && let Ok(mut encoding) = state.scribe.encoding.lock()
    {
        encoding.remove(meeting_id);
    }
}

/// At start: repairs the files of interrupted recordings (the meeting page offers to keep
/// them) and finishes encodings a quit cut short.
pub fn resume(app: &AppHandle) {
    let state = app.state::<AppState>();
    for (dir, meta) in files::all(&state.data_dir) {
        if meta.finished {
            encode_later(app, &meta.meeting_id);
        } else {
            for name in [MIC_WAV, SYSTEM_WAV] {
                let path = dir.join(name);
                if path.is_file()
                    && let Err(e) = wav::repair(&path)
                {
                    eprintln!("cannot repair {}: {e}", path.display());
                }
            }
        }
    }
}

/// Quitting: a recording in progress is finished cleanly.
pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let thread = state.scribe.live.lock().ok().and_then(|mut l| {
        l.as_mut().and_then(|l| {
            l.stop.store(true, Ordering::Relaxed);
            l.thread.take()
        })
    });
    if let Some(thread) = thread {
        let _ = thread.join();
    }
}

// ---------------------------------------------------------------------------------------
// Playback: `tm://localhost/meeting-audio/<meeting id>/<track>`, with range requests so
// the player can seek.

pub fn serve(app: &AppHandle, request: &Request<Vec<u8>>, rest: &str) -> Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let empty = |status: StatusCode| {
        Response::builder()
            .status(status)
            .body(Vec::new())
            .unwrap_or_default()
    };
    let Some((meeting_id, track)) = rest.split_once('/') else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Some(state) = app.try_state::<AppState>() else {
        return empty(StatusCode::SERVICE_UNAVAILABLE);
    };
    let Some(dir) = files::meeting_dir(&state.data_dir, meeting_id) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Some((path, mime)) = files::track_file(&dir, track) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(mut file) = std::fs::File::open(&path) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());
    let (status, start, end) = match files::byte_range(range, len) {
        Some((s, e)) => (StatusCode::PARTIAL_CONTENT, s, e),
        None if range.is_some() && len > 0 => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Vec::new())
                .unwrap_or_default();
        }
        None => (StatusCode::OK, 0, len.saturating_sub(1)),
    };
    // Players ask for open ranges; answer in pieces so a long file is never read whole.
    let end = end.min(start + 4 * 1024 * 1024 - 1);
    let mut body = vec![
        0u8;
        if len == 0 {
            0
        } else {
            (end - start + 1) as usize
        }
    ];
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut body).is_err() {
        return empty(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store");
    if status == StatusCode::PARTIAL_CONTENT || len > body.len() as u64 {
        response = response
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    response
        .body(body)
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}
