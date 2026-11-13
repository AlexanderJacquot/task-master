//! Persistent Calendar runner ownership, credentials and the server's Google worker.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::auth::Scope;
use crate::{ApiError, ApiResult, AppState, authorize, blocking};
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use taskmaster_client::google::GoogleCalendar;
use taskmaster_core::calendar::*;
use taskmaster_core::{now_ms, utc_date};

const LEASE_MS: i64 = 300_000;
#[derive(Default, Serialize, Deserialize)]
struct Saved {
    runner: CalendarRunner,
    credentials: Option<GoogleCredentials>,
    device_id: Option<String>,
    expires_at: i64,
}
#[derive(Default)]
pub struct Runtime {
    /// Held across a complete Google round and every ownership change.
    gate: Mutex<()>,
    saved: Mutex<Saved>,
    report: Mutex<RunnerStatus>,
    kick: AtomicBool,
}
impl Runtime {
    fn path(state: &AppState) -> PathBuf {
        state.config.data_dir.join("calendar.json")
    }
    pub fn load(&self, state: &AppState) -> Result<(), String> {
        match std::fs::read(Self::path(state)) {
            Ok(bytes) => {
                *self.saved.lock().unwrap() = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("cannot read calendar settings: {e}"))?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        Ok(())
    }
    fn save(state: &AppState, saved: &Saved) -> ApiResult<()> {
        let path = Self::path(state);
        let tmp = path.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&tmp).map_err(io_error)?;
        serde_json::to_writer(&file, saved).map_err(|e| io_error(e.into()))?;
        file.sync_all().map_err(io_error)?;
        std::fs::rename(tmp, path).map_err(io_error)?;
        Ok(())
    }
    pub fn kick(&self) {
        self.kick.store(true, Ordering::Relaxed);
    }
}
fn io_error(e: std::io::Error) -> ApiError {
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}
fn status(state: &AppState) -> ApiResult<RunnerStatus> {
    let mut report = state.calendar.report.lock().unwrap().clone();
    let saved = state.calendar.saved.lock().unwrap();
    report.runner = saved.runner;
    report.connected = saved.credentials.is_some();
    drop(saved);
    report.sources = state.store().calendar_sources()?;
    Ok(report)
}
pub async fn get_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<RunnerStatus>> {
    authorize(&state, &headers, Scope::Sync)?;
    blocking(move || status(&state).map(Json)).await
}
pub async fn transfer(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<RunnerRequest>,
) -> ApiResult<Json<RunnerTransfer>> {
    authorize(&state, &headers, Scope::Sync)?;
    blocking(move || {
        let _gate = state.calendar.gate.lock().unwrap();
        if request.device_id.trim().is_empty() {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "device id is required",
            ));
        }
        let mut saved = state.calendar.saved.lock().unwrap();
        if saved.expires_at > now_ms()
            && saved
                .device_id
                .as_ref()
                .is_some_and(|id| *id != request.device_id)
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "another device is syncing Calendar; try again after it finishes",
            ));
        }
        let credentials = if request.runner == CalendarRunner::ThisDevice {
            saved.credentials.clone().or(request.credentials)
        } else {
            request.credentials.or_else(|| saved.credentials.clone())
        };
        if credentials.as_ref().is_none_or(|c| {
            c.client_id.is_empty() || c.client_secret.is_empty() || c.refresh_token.is_empty()
        }) {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "connect Google Calendar on this device first",
            ));
        }
        let next = Saved {
            runner: request.runner,
            credentials: credentials.clone(),
            device_id: if request.runner == CalendarRunner::ThisDevice {
                Some(request.device_id)
            } else {
                None
            },
            expires_at: if request.runner == CalendarRunner::ThisDevice {
                now_ms() + LEASE_MS
            } else {
                0
            },
        };
        Runtime::save(&state, &next)?;
        *saved = next;
        drop(saved);
        // Relink by the private event key before creating any events on the new runner.
        state.store().clear_calendar_sync()?;
        state.calendar.kick();
        Ok(Json(RunnerTransfer {
            status: status(&state)?,
            credentials: if request.runner == CalendarRunner::ThisDevice {
                credentials
            } else {
                None
            },
        }))
    })
    .await
}
pub async fn lease(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CalendarLease>,
) -> ApiResult<Json<bool>> {
    authorize(&state, &headers, Scope::Sync)?;
    blocking(move || {
        let _gate = state.calendar.gate.lock().unwrap();
        let mut saved = state.calendar.saved.lock().unwrap();
        if request.device_id.trim().is_empty() {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "device id is required",
            ));
        }
        if saved.runner == CalendarRunner::Server {
            return Ok(Json(false));
        }
        if saved.expires_at > now_ms()
            && saved
                .device_id
                .as_ref()
                .is_some_and(|id| *id != request.device_id)
        {
            return Ok(Json(false));
        }
        let next = Saved {
            runner: saved.runner,
            credentials: saved.credentials.clone(),
            device_id: if request.release {
                None
            } else {
                Some(request.device_id)
            },
            expires_at: if request.release {
                0
            } else {
                now_ms() + LEASE_MS
            },
        };
        Runtime::save(&state, &next)?;
        *saved = next;
        Ok(Json(true))
    })
    .await
}
pub async fn sync_now(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<RunnerStatus>> {
    authorize(&state, &headers, Scope::Sync)?;
    state.calendar.kick();
    blocking(move || status(&state).map(Json)).await
}
pub async fn shown(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CalendarShown>,
) -> ApiResult<Json<RunnerStatus>> {
    authorize(&state, &headers, Scope::Sync)?;
    blocking(move || {
        state
            .store()
            .set_calendar_shown(&request.calendar_id, request.shown)?;
        state.calendar.kick();
        status(&state).map(Json)
    })
    .await
}
pub async fn events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(range): Query<EventRange>,
) -> ApiResult<Json<Vec<CalendarEvent>>> {
    authorize(&state, &headers, Scope::Sync)?;
    blocking(move || {
        state
            .store()
            .calendar_events(&range)
            .map(Json)
            .map_err(Into::into)
    })
    .await
}
/// The gate makes handoffs wait for the in-flight Google request to finish.
pub fn cycle_with(state: &AppState, provider: &mut impl CalendarProvider) -> ApiResult<()> {
    let _gate = state.calendar.gate.lock().unwrap();
    cycle_locked(state, provider)
}
fn cycle_locked(state: &AppState, provider: &mut impl CalendarProvider) -> ApiResult<()> {
    if state.calendar.saved.lock().unwrap().runner != CalendarRunner::Server {
        return Ok(());
    }
    state.calendar.report.lock().unwrap().syncing = true;
    let now = now_ms();
    let result = taskmaster_core::calendar::sync(&*state.store, provider, now, &utc_date(now));
    let mut report = state.calendar.report.lock().unwrap();
    report.syncing = false;
    match result {
        Ok(result) => {
            report.last_sync_at = Some(now);
            report.last_report = Some(result);
            report.last_error = None;
        }
        Err(e) => {
            report.last_error = Some(e.to_string());
            return Err(e.into());
        }
    }
    let _ = state.heads.send(state.store().last_seq()?);
    Ok(())
}
pub fn spawn(state: Arc<AppState>) {
    std::thread::spawn(move || {
        let mut last = Instant::now() - Duration::from_secs(300);
        loop {
            std::thread::sleep(Duration::from_secs(2));
            if !state.calendar.kick.swap(false, Ordering::Relaxed)
                && last.elapsed() < Duration::from_secs(300)
            {
                continue;
            }
            last = Instant::now();
            let _gate = state.calendar.gate.lock().unwrap();
            let credentials = {
                let saved = state.calendar.saved.lock().unwrap();
                if saved.runner == CalendarRunner::Server {
                    saved.credentials.clone()
                } else {
                    None
                }
            };
            if let Some(c) = credentials {
                let mut provider =
                    GoogleCalendar::new(&c.client_id, &c.client_secret, &c.refresh_token);
                if let Err(e) = cycle_locked(&state, &mut provider) {
                    eprintln!("server Calendar sync failed: {}", e.1);
                }
            }
        }
    });
}
