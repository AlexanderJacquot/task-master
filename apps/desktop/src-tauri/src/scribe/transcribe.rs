//! Transcription on this device (M20): model downloads, the queue of meetings to
//! transcribe (one at a time, never while recording), and the hourly audio expiry.
//!
//! A queued or running job is a `transcript/job.json` beside the audio, so the queue
//! survives a quit; the next start resumes it from the last finished step.

use std::collections::VecDeque;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use taskmaster_core::{Command, Id, MeetingChange, MeetingState, NewSegment, Timestamp};
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event as _;

use super::engine::Models;
use super::models::{self, ModelInfo};
use super::pipeline::{self, Step};
use super::{changed, files, meeting_dir, now_ms, retention, settings_of, write_meeting};
use crate::{AppState, CommandResult, internal, invalid, with_store, with_store_ref};

const JOB: &str = "job.json";
/// One line per transcription stage, with how long it took, in the data folder: what to
/// look at when a transcription seems stuck or slow.
pub const LOG_FILE: &str = "scribe.log";
const LOG_MAX: u64 = 512 * 1024;

/// Appends a line to `scribe.log` (the previous one is kept as `scribe.log.1` past 512 KB).
fn log_line(data_dir: &Path, meeting_id: &str, now: Timestamp, text: &str) {
    let path = data_dir.join(LOG_FILE);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_MAX) {
        let _ = std::fs::rename(&path, data_dir.join(format!("{LOG_FILE}.1")));
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let _ = writeln!(file, "{}", format_line(meeting_id, now, text));
}

/// A recording's length for the log: seconds when short, else minutes.
fn recorded(ms: u64) -> String {
    let secs = (ms + 500) / 1000;
    if secs < 120 {
        format!("{secs} s")
    } else {
        format!("{} min", (secs + 30) / 60)
    }
}

/// Where the main window is. Windows runs apps in the background or minimized on slower
/// cores at lower clocks (power throttling), which a slow transcription can come from.
fn window_state(app: &AppHandle) -> &'static str {
    let Some(window) = app.get_webview_window(crate::MAIN_WINDOW) else {
        return "closed";
    };
    if !window.is_visible().unwrap_or(true) {
        "hidden"
    } else if window.is_minimized().unwrap_or(false) {
        "minimized"
    } else if window.is_focused().unwrap_or(false) {
        "in front"
    } else {
        "in the background"
    }
}

/// Writes `window: <state>` to `scribe.log` when the main window's state changes, looking
/// at most every [`WINDOW_EVERY`] (each look is a round trip to the main thread).
struct WindowWatch {
    app: AppHandle,
    data_dir: PathBuf,
    meeting_id: String,
    last: Mutex<(Option<Instant>, &'static str)>,
}

const WINDOW_EVERY: Duration = Duration::from_secs(5);

impl WindowWatch {
    fn new(app: &AppHandle, data_dir: &Path, meeting_id: &str) -> Self {
        Self {
            app: app.clone(),
            data_dir: data_dir.to_owned(),
            meeting_id: meeting_id.to_owned(),
            last: Mutex::new((None, "")),
        }
    }

    /// `now`: look even if the last look was recent.
    fn check(&self, now: bool) {
        let Ok(mut last) = self.last.lock() else {
            return;
        };
        if !now && last.0.is_some_and(|at| at.elapsed() < WINDOW_EVERY) {
            return;
        }
        let state = window_state(&self.app);
        last.0 = Some(Instant::now());
        if state != last.1 {
            last.1 = state;
            log_line(
                &self.data_dir,
                &self.meeting_id,
                now_ms(),
                &format!("window: {state}"),
            );
        }
    }
}

fn format_line(meeting_id: &str, now: Timestamp, text: &str) -> String {
    let secs = now.rem_euclid(86_400_000) / 1000;
    // The id's last characters tell meetings apart (UUIDv7 starts with the time).
    let from = meeting_id.char_indices().rev().nth(5).map_or(0, |(i, _)| i);
    let short = &meeting_id[from..];
    format!(
        "{}T{:02}:{:02}:{:02}Z {short} {text}",
        taskmaster_core::utc_date(now),
        secs / 3600,
        secs / 60 % 60,
        secs % 60
    )
}

/// A transcription's progress, a few times a second while it runs.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct ScribeProgress {
    pub meeting_id: Id,
    pub step: Step,
    /// 0 to 1, over all steps.
    pub fraction: f32,
}

/// A model download's progress; `finished` with `error: None` when it is installed.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct ScribeModelProgress {
    pub model: String,
    pub done: u32,
    pub total: u32,
    pub finished: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    /// Waiting for another transcription, a recording or the compression to finish.
    Queued,
    Running,
    Failed,
}

/// A meeting's transcription on this device, when one is queued, running or failed.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct JobView {
    pub state: JobState,
    pub step: Option<Step>,
    pub fraction: f32,
    pub error: Option<String>,
}

/// `transcript/job.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct JobFile {
    model: String,
    #[serde(default)]
    error: Option<String>,
    /// The meeting's state before, restored when the job is cancelled.
    #[serde(default)]
    previous: Option<MeetingState>,
}

fn job_path(dir: &Path) -> PathBuf {
    dir.join(pipeline::DIR).join(JOB)
}

fn read_job(dir: &Path) -> Option<JobFile> {
    serde_json::from_str(&std::fs::read_to_string(job_path(dir)).ok()?).ok()
}

fn write_job(dir: &Path, job: &JobFile) -> std::io::Result<()> {
    std::fs::create_dir_all(dir.join(pipeline::DIR))?;
    std::fs::write(job_path(dir), serde_json::to_vec_pretty(job)?)
}

struct Running {
    meeting_id: Id,
    step: Step,
    fraction: f32,
    cancel: Arc<AtomicBool>,
}

struct Download {
    model: String,
    done: u64,
    cancel: Arc<AtomicBool>,
}

/// The transcription queue and the model download in progress.
#[derive(Default)]
pub struct Jobs {
    queue: Mutex<VecDeque<Id>>,
    wake: Condvar,
    running: Mutex<Option<Running>>,
    download: Mutex<Option<Download>>,
}

impl Jobs {
    fn push(&self, meeting_id: &str) {
        if let Ok(mut q) = self.queue.lock()
            && !q.iter().any(|m| m == meeting_id)
        {
            q.push_back(meeting_id.to_owned());
            self.wake.notify_all();
        }
    }

    /// The job view of a meeting, from the queue, the running job or its file.
    pub fn view(&self, dir: &Path, meeting_id: &str) -> Option<JobView> {
        if let Ok(r) = self.running.lock()
            && let Some(r) = r.as_ref().filter(|r| r.meeting_id == meeting_id)
        {
            return Some(JobView {
                state: JobState::Running,
                step: Some(r.step),
                fraction: r.fraction,
                error: None,
            });
        }
        let job = read_job(dir)?;
        Some(JobView {
            state: if job.error.is_some() {
                JobState::Failed
            } else {
                JobState::Queued
            },
            step: None,
            fraction: 0.0,
            error: job.error,
        })
    }

    pub fn busy_with(&self, meeting_id: &str) -> bool {
        self.running
            .lock()
            .is_ok_and(|r| r.as_ref().is_some_and(|r| r.meeting_id == meeting_id))
    }
}

/// Where models are kept: the app's local data folder, never synced by the app.
pub fn models_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("scribe-models"))
        .map_err(|e| internal(format!("cannot find the app's data folder: {e}")))
}

/// The active model's files, when it is installed with its support files.
fn active_models(app: &AppHandle) -> Option<(&'static models::WhisperModel, PathBuf)> {
    let state = app.state::<AppState>();
    let dir = models_dir(app).ok()?;
    let model = models::whisper(settings_of(&state).model.as_deref()?)?;
    models::missing(&dir, model)
        .is_empty()
        .then_some((model, dir))
}

// ---------------------------------------------------------------------------------------
// Models

#[tauri::command]
#[specta::specta]
pub fn scribe_models(app: AppHandle) -> CommandResult<Vec<ModelInfo>> {
    let state = app.state::<AppState>();
    let dir = models_dir(&app)?;
    let active = settings_of(&state).model;
    let download = state
        .scribe
        .jobs
        .download
        .lock()
        .ok()
        .and_then(|d| d.as_ref().map(|d| (d.model.clone(), d.done)));
    Ok(models::WHISPER
        .iter()
        .map(|m| {
            let missing = models::missing(&dir, m);
            let download_bytes: u64 = missing.iter().map(|f| f.size).sum();
            let downloading = match &download {
                Some((id, done)) if id == m.id => Some(*done),
                _ => None,
            };
            ModelInfo {
                id: m.id.into(),
                label: m.label.into(),
                description: m.description.into(),
                download_bytes: download_bytes.min(u64::from(u32::MAX)) as u32,
                installed: missing.is_empty(),
                active: active.as_deref() == Some(m.id) && missing.is_empty(),
                downloading: downloading.map(|d| d.min(u64::from(u32::MAX)) as u32),
            }
        })
        .collect())
}

/// Downloads a model (and the speaker models the first time) in the background; progress
/// comes as `ScribeModelProgress`. The first model installed becomes the active one.
#[tauri::command]
#[specta::specta]
pub fn scribe_download_model(app: AppHandle, model: String) -> CommandResult<()> {
    let state = app.state::<AppState>();
    let spec = models::whisper(&model).ok_or_else(|| invalid("no such model"))?;
    let dir = models_dir(&app)?;
    let files = models::missing(&dir, spec);
    let total: u64 = files.iter().map(|f| f.size).sum();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut download = state
            .scribe
            .jobs
            .download
            .lock()
            .map_err(|_| internal("scribe lock poisoned"))?;
        if download.is_some() {
            return Err(invalid("a model is downloading already"));
        }
        *download = Some(Download {
            model: model.clone(),
            done: models::partial_bytes(&dir, &files),
            cancel: cancel.clone(),
        });
    }
    let app2 = app.clone();
    std::thread::Builder::new()
        .name("scribe-download".into())
        .spawn(move || {
            let state = app2.state::<AppState>();
            let report = |done: u64, finished: bool, error: Option<String>| {
                if let Ok(mut d) = state.scribe.jobs.download.lock()
                    && let Some(d) = d.as_mut()
                {
                    d.done = done;
                }
                let _ = ScribeModelProgress {
                    model: model.clone(),
                    done: done.min(u64::from(u32::MAX)) as u32,
                    total: total.min(u64::from(u32::MAX)) as u32,
                    finished,
                    error,
                }
                .emit(&app2);
            };
            let mut before = 0u64;
            let mut result = Ok(());
            for f in &files {
                let from = before;
                match models::fetch(&dir, f.url, f.name, f.size, f.sha256, &cancel, |n| {
                    report(from + n, false, None)
                }) {
                    Ok(_) => before += f.size,
                    Err(e) => {
                        result = Err(e);
                        break;
                    }
                }
            }
            if let Ok(mut d) = state.scribe.jobs.download.lock() {
                *d = None;
            }
            match result {
                Ok(()) => {
                    // The first model installed is the one used.
                    let mut settings = settings_of(&state);
                    let active_ok = settings
                        .model
                        .as_deref()
                        .and_then(models::whisper)
                        .is_some_and(|m| models::missing(&dir, m).is_empty());
                    if !active_ok {
                        settings.model = Some(model.clone());
                        if let Ok(mut config) = state.config.lock() {
                            config.scribe = settings;
                            let _ = config.save(&state.config_path);
                        }
                    }
                    report(total, true, None);
                }
                Err(models::FetchError::Cancelled) => report(before, true, None),
                Err(e) => report(before, true, Some(e.to_string())),
            }
        })
        .map_err(|e| internal(format!("cannot start the download: {e}")))?;
    Ok(())
}

/// Stops the download in progress; what was fetched is kept for the next attempt.
#[tauri::command]
#[specta::specta]
pub fn scribe_cancel_download(state: State<'_, AppState>) -> CommandResult<()> {
    if let Ok(d) = state.scribe.jobs.download.lock()
        && let Some(d) = d.as_ref()
    {
        d.cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn scribe_delete_model(app: AppHandle, model: String) -> CommandResult<Vec<ModelInfo>> {
    let state = app.state::<AppState>();
    let spec = models::whisper(&model).ok_or_else(|| invalid("no such model"))?;
    if state
        .scribe
        .jobs
        .download
        .lock()
        .is_ok_and(|d| d.as_ref().is_some_and(|d| d.model == model))
    {
        return Err(invalid("stop the download first"));
    }
    if state.scribe.jobs.running.lock().is_ok_and(|r| r.is_some()) {
        return Err(invalid(
            "a meeting is being transcribed; try again when it is done",
        ));
    }
    let dir = models_dir(&app)?;
    models::remove(&dir, spec).map_err(|e| internal(format!("cannot delete the model: {e}")))?;
    // Another installed model takes over.
    let mut settings = settings_of(&state);
    if settings.model.as_deref() == Some(spec.id) {
        settings.model = models::WHISPER
            .iter()
            .find(|m| models::missing(&dir, m).is_empty())
            .map(|m| m.id.to_owned());
        let mut config = state
            .config
            .lock()
            .map_err(|_| internal("config lock poisoned"))?;
        config.scribe = settings;
        config
            .save(&state.config_path)
            .map_err(|e| internal(format!("cannot save settings: {e}")))?;
    }
    scribe_models(app)
}

// ---------------------------------------------------------------------------------------
// Jobs

/// Queues a meeting's transcription (or a new one, replacing the transcript). Needs a
/// finished recording on this device and an installed model.
#[tauri::command]
#[specta::specta]
pub fn scribe_process(app: AppHandle, meeting_id: Id) -> CommandResult<()> {
    // A failed run resumes from its last finished step; a meeting with a transcript is
    // transcribed again from scratch.
    let state = app.state::<AppState>();
    let fresh = with_store_ref(&state, |s| s.meeting(&meeting_id))?
        .transcribed_at
        .is_some();
    queue(&app, &meeting_id, fresh)
}

pub fn queue(app: &AppHandle, meeting_id: &str, fresh: bool) -> CommandResult<()> {
    let state = app.state::<AppState>();
    let dir = meeting_dir(&state, meeting_id)?;
    let meta =
        files::read_meta(&dir).ok_or_else(|| invalid("this meeting has no recording here"))?;
    if !meta.finished {
        return Err(invalid("the recording is not finished"));
    }
    let Some((model, _)) = active_models(app) else {
        return Err(invalid(
            "no transcription model is installed; download one in Settings → Scribe",
        ));
    };
    if state.scribe.jobs.busy_with(meeting_id) {
        return Err(invalid("this meeting is being transcribed"));
    }
    let meeting = with_store_ref(&state, |s| s.meeting(meeting_id))?;
    let previous = read_job(&dir).and_then(|j| j.previous);
    // A new run with another model, or after a failure, starts from scratch.
    let restart = fresh || read_job(&dir).is_some_and(|j| j.model != model.id);
    if restart {
        pipeline::clear(&dir);
    }
    write_job(
        &dir,
        &JobFile {
            model: model.id.into(),
            error: None,
            previous: previous.or(Some(meeting.state)),
        },
    )
    .map_err(|e| internal(format!("cannot queue the transcription: {e}")))?;
    if meeting.state != MeetingState::Processing {
        write_meeting(
            &state,
            meeting_id,
            vec![MeetingChange::State(MeetingState::Processing)],
        )?;
    }
    state.scribe.jobs.push(meeting_id);
    changed(app, meeting_id);
    Ok(())
}

/// Stops a queued or running transcription; the meeting goes back to where it was.
#[tauri::command]
#[specta::specta]
pub fn scribe_cancel_process(app: AppHandle, meeting_id: Id) -> CommandResult<()> {
    let state = app.state::<AppState>();
    let dir = meeting_dir(&state, &meeting_id)?;
    if let Ok(mut q) = state.scribe.jobs.queue.lock() {
        q.retain(|m| m != &meeting_id);
    }
    if let Ok(r) = state.scribe.jobs.running.lock()
        && let Some(r) = r.as_ref().filter(|r| r.meeting_id == meeting_id)
    {
        // The worker restores the meeting when it sees the stop.
        r.cancel.store(true, Ordering::Relaxed);
        return Ok(());
    }
    let job = read_job(&dir);
    let _ = std::fs::remove_file(job_path(&dir));
    restore(&state, &meeting_id, job.and_then(|j| j.previous));
    changed(&app, &meeting_id);
    Ok(())
}

fn restore(state: &AppState, meeting_id: &str, previous: Option<MeetingState>) {
    let back = match previous {
        Some(MeetingState::Processing | MeetingState::Recording) | None => MeetingState::Held,
        Some(s) => s,
    };
    let _ = write_meeting(state, meeting_id, vec![MeetingChange::State(back)]);
}

/// The worker: takes queued meetings one at a time, never while a meeting is being
/// recorded (transcription would compete with it for the processor).
pub fn worker(app: AppHandle) {
    loop {
        let state = app.state::<AppState>();
        let next = {
            let Ok(mut q) = state.scribe.jobs.queue.lock() else {
                return;
            };
            while q.is_empty() {
                q = match state.scribe.jobs.wake.wait(q) {
                    Ok(q) => q,
                    Err(_) => return,
                };
            }
            q.pop_front()
        };
        let Some(meeting_id) = next else { continue };
        let Some(dir) = files::meeting_dir(&state.data_dir, &meeting_id) else {
            continue;
        };
        while state.scribe.live_id().is_some() || state.scribe.is_encoding(&meeting_id) {
            std::thread::sleep(Duration::from_secs(2));
        }
        if read_job(&dir).is_none_or(|j| j.error.is_some()) {
            // Cancelled or failed while it waited.
            continue;
        }
        run_job(&app, &meeting_id, &dir);
    }
}

fn run_job(app: &AppHandle, meeting_id: &str, dir: &Path) {
    let state = app.state::<AppState>();
    let Some(mut job) = read_job(dir) else {
        return;
    };
    let fail = |job: &mut JobFile, error: String| {
        job.error = Some(error);
        let _ = write_job(dir, job);
        let _ = write_meeting(
            &state,
            meeting_id,
            vec![MeetingChange::State(MeetingState::Failed)],
        );
        changed(app, meeting_id);
    };
    let Some((model, models_dir)) = active_models(app) else {
        fail(
            &mut job,
            "No transcription model is installed; download one in Settings → Scribe.".into(),
        );
        return;
    };
    let whisper = models_dir.join(model.file.name);
    let support = |i: usize| models_dir.join(models::DIARIZATION[i].name);
    let (vad, segmentation, embedding) = (
        support(models::VAD),
        support(models::SEGMENTATION),
        support(models::EMBEDDING),
    );
    let paths = Models {
        whisper: &whisper,
        vad: &vad,
        segmentation: &segmentation,
        embedding: &embedding,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut r) = state.scribe.jobs.running.lock() {
        *r = Some(Running {
            meeting_id: meeting_id.to_owned(),
            step: Step::Mic,
            fraction: 0.0,
            cancel: cancel.clone(),
        });
    }
    changed(app, meeting_id);
    let language = settings_of(&state).language;
    let data_dir = state.data_dir.clone();
    let watch = Arc::new(WindowWatch::new(app, &data_dir, meeting_id));
    let log = |text: String| {
        log_line(&data_dir, meeting_id, now_ms(), &text);
        watch.check(false);
    };
    let started = Instant::now();
    log_line(
        &data_dir,
        meeting_id,
        now_ms(),
        &format!(
            "start: model {}, language {}, {} threads, {} recorded; {}",
            model.id,
            language.as_deref().unwrap_or("auto"),
            super::engine::threads(),
            recorded(files::read_meta(dir).map_or(0, |m| m.duration_ms())),
            super::engine::system_info()
        ),
    );
    let machine = super::machine::describe();
    if !machine.is_empty() {
        log_line(
            &data_dir,
            meeting_id,
            now_ms(),
            &format!("machine: {machine}"),
        );
    }
    watch.check(true);
    let progress = {
        let app = app.clone();
        let id = meeting_id.to_owned();
        let watch = watch.clone();
        move |step: Step, fraction: f32| {
            watch.check(false);
            let state = app.state::<AppState>();
            if let Ok(mut r) = state.scribe.jobs.running.lock()
                && let Some(r) = r.as_mut()
            {
                r.step = step;
                r.fraction = fraction;
            }
            let _ = ScribeProgress {
                meeting_id: id.clone(),
                step,
                fraction,
            }
            .emit(&app);
        }
    };
    let result = pipeline::run(dir, &paths, language.as_deref(), &cancel, progress, &log);
    let took = started.elapsed().as_secs_f64();
    log(match &result {
        _ if cancel.load(Ordering::Relaxed) => format!("stopped after {took:.0} s"),
        Ok(segments) => format!("done in {took:.0} s, {} lines", segments.len()),
        Err(e) => format!("failed after {took:.0} s: {e}"),
    });
    if let Ok(mut r) = state.scribe.jobs.running.lock() {
        *r = None;
    }
    if cancel.load(Ordering::Relaxed) {
        let _ = std::fs::remove_file(job_path(dir));
        restore(&state, meeting_id, job.previous);
        changed(app, meeting_id);
        return;
    }
    match result {
        Ok(segments) => {
            let segments = segments
                .into_iter()
                .map(|s| NewSegment {
                    id: None,
                    start_ms: s.start_ms,
                    end_ms: s.end_ms,
                    speaker: s.speaker,
                    text: s.text,
                })
                .collect();
            let written = with_store(&state, |s| {
                s.execute_without_undo(vec![Command::SetTranscript {
                    meeting_id: meeting_id.to_owned(),
                    segments,
                }])
            });
            match written {
                Ok(_) => {
                    let _ = std::fs::remove_file(job_path(dir));
                    changed(app, meeting_id);
                }
                Err(e) => fail(
                    &mut job,
                    format!("The transcript could not be saved: {}", e.message),
                ),
            }
        }
        Err(e) => fail(&mut job, e),
    }
}

/// At start: queues the transcriptions a quit cut short (failed ones wait for a retry).
pub fn resume(app: &AppHandle) {
    let state = app.state::<AppState>();
    for (dir, meta) in files::all(&state.data_dir) {
        if let Some(job) = read_job(&dir)
            && job.error.is_none()
            && meta.finished
        {
            state.scribe.jobs.push(&meta.meeting_id);
        }
    }
}

/// After a recording stops: transcribe it when that is on and a model is installed.
pub fn after_recording(app: &AppHandle, meeting_id: &str) {
    let state = app.state::<AppState>();
    if settings_of(&state).auto_transcribe
        && active_models(app).is_some()
        && let Err(e) = queue(app, meeting_id, true)
    {
        eprintln!("cannot queue the transcription: {}", e.message);
    }
}

// ---------------------------------------------------------------------------------------
// Audio expiry

/// Deletes audio whose time has come; on start and every hour.
pub fn expire_audio(app: &AppHandle, now: Timestamp) {
    let state = app.state::<AppState>();
    let days = settings_of(&state).retention_days;
    for (dir, meta) in files::all(&state.data_dir) {
        let id = &meta.meeting_id;
        if state.scribe.live_id().as_deref() == Some(id.as_str())
            || state.scribe.is_encoding(id)
            || state.scribe.jobs.busy_with(id)
            || read_job(&dir).is_some()
        {
            continue;
        }
        let Ok(meeting) = with_store_ref(&state, |s| s.meeting(id)) else {
            continue;
        };
        if retention::purge_at(&meeting, days).is_some_and(|at| at <= now) {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => changed(app, id),
                Err(e) => eprintln!("cannot delete expired audio {}: {e}", dir.display()),
            }
        }
    }
}

pub fn expiry_loop(app: AppHandle) {
    std::thread::sleep(Duration::from_secs(60));
    loop {
        expire_audio(&app, now_ms());
        std::thread::sleep(Duration::from_secs(3600));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_recordings_are_logged_in_seconds() {
        assert_eq!(recorded(0), "0 s");
        assert_eq!(recorded(32_400), "32 s");
        assert_eq!(recorded(119_000), "119 s");
        assert_eq!(recorded(120_000), "2 min");
        assert_eq!(recorded(3_600_000), "60 min");
    }

    #[test]
    fn log_lines_carry_the_time_and_the_meeting() {
        // 2026-11-25 09:05:07 UTC.
        let at = 1_795_597_507_000;
        assert_eq!(
            format_line("0193abcd-0000-7000-8000-00000012ab34", at, "mic: chunk 1/3"),
            "2026-11-25T09:05:07Z 12ab34 mic: chunk 1/3"
        );
        assert_eq!(
            format_line("x", at, "start"),
            "2026-11-25T09:05:07Z x start"
        );
    }

    #[test]
    fn the_log_is_appended_and_rolled_over() {
        let dir = std::env::temp_dir().join(format!("tm-scribe-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        log_line(&dir, "m1", 0, "one");
        log_line(&dir, "m1", 0, "two");
        let text = std::fs::read_to_string(dir.join(LOG_FILE)).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text.ends_with("m1 two\n"));
        std::fs::write(dir.join(LOG_FILE), vec![b'x'; LOG_MAX as usize + 1]).unwrap();
        log_line(&dir, "m1", 0, "three");
        assert!(dir.join(format!("{LOG_FILE}.1")).exists());
        let text = std::fs::read_to_string(dir.join(LOG_FILE)).unwrap();
        assert_eq!(text.lines().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
