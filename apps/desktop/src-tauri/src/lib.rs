//! Desktop shell. Commands here are thin wrappers over `taskmaster_core`; the IPC surface
//! stays small (plan, section 5): new features add `Command` variants, not endpoints.

use std::path::PathBuf;
use std::sync::Mutex;

mod agents;
mod backups;
mod calendar_sync;
mod config;
mod google;
mod server_sync;

use backups::BackupStatus;
use config::{AppConfig, ConfigView, RemoteInput, RemoteView};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use taskmaster_core::{
    Activity, Capture, Changed, Changes, Command, ExportFile, Id, ImportSummary, Snapshot, Store,
    clean_file_name, mime_for,
};
use tauri::http::{Request, Response, StatusCode, header};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tauri_specta::{Builder, Event, collect_commands, collect_events};

/// Path of the generated TypeScript bindings, relative to this crate.
#[cfg(any(debug_assertions, test))]
const BINDINGS_PATH: &str = "../src/bindings.ts";

const DB_FILE: &str = "task-master.sqlite";
const CONFIG_FILE: &str = "config.json";

/// Label of the small always-on-top window opened by the quick-capture hotkey
/// (`tauri.conf.json`). It loads the same UI, which renders only the capture box there.
const CAPTURE_WINDOW: &str = "capture";
const MAIN_WINDOW: &str = "main";

/// `Ctrl+Shift+Space` (plan section 6).
fn capture_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space)
}

/// Sent to the capture window each time it is shown, so it clears and focuses its input.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct CaptureOpened;

struct AppState {
    store: Mutex<Store>,
    /// The folder holding the database and `backups/`.
    data_dir: PathBuf,
    /// The database file (the MCP server of agent sessions opens it too).
    db_path: PathBuf,
    agents: agents::AgentRunner,
    config_path: PathBuf,
    config: Mutex<AppConfig>,
    backup: Mutex<BackupStatus>,
    calendar: calendar_sync::CalendarRuntime,
    sync: server_sync::SyncRuntime,
}

/// Error returned to the UI by every command.
#[derive(Debug, Serialize, specta::Type)]
pub struct CommandError {
    /// `invalid`, `not_found` or `internal`.
    pub kind: String,
    pub message: String,
}

impl From<taskmaster_core::Error> for CommandError {
    fn from(err: taskmaster_core::Error) -> Self {
        Self {
            kind: err.kind().to_owned(),
            message: err.to_string(),
        }
    }
}

/// Emitted after every committed batch, whoever wrote it.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct StoreChanged(Changed);

type CommandResult<T> = Result<T, CommandError>;

fn with_store<T>(
    state: &AppState,
    f: impl FnOnce(&mut Store) -> taskmaster_core::Result<T>,
) -> CommandResult<T> {
    let mut store = state
        .store
        .lock()
        .map_err(|_| internal("store lock poisoned"))?;
    f(&mut store).map_err(Into::into)
}

fn internal(message: impl Into<String>) -> CommandError {
    CommandError {
        kind: "internal".into(),
        message: message.into(),
    }
}

fn invalid(message: impl Into<String>) -> CommandError {
    CommandError {
        kind: "invalid".into(),
        message: message.into(),
    }
}

#[tauri::command]
#[specta::specta]
fn ping() -> String {
    taskmaster_core::ping()
}

/// Every live entity, to hydrate the UI store.
#[tauri::command]
#[specta::specta]
fn snapshot(state: State<'_, AppState>) -> CommandResult<Snapshot> {
    with_store(&state, |s| s.snapshot())
}

/// Runs the commands atomically as one undoable batch.
#[tauri::command]
#[specta::specta]
fn execute(state: State<'_, AppState>, commands: Vec<Command>) -> CommandResult<Changes> {
    with_store(&state, |s| s.execute_all(commands))
}

#[tauri::command]
#[specta::specta]
fn undo(state: State<'_, AppState>) -> CommandResult<Option<Changes>> {
    with_store(&state, Store::undo)
}

#[tauri::command]
#[specta::specta]
fn redo(state: State<'_, AppState>) -> CommandResult<Option<Changes>> {
    with_store(&state, Store::redo)
}

/// Live task ids matching every word of `text`, best first.
#[tauri::command]
#[specta::specta]
fn search(state: State<'_, AppState>, text: String, limit: u32) -> CommandResult<Vec<Id>> {
    with_store(&state, |s| s.search(&text, limit))
}

/// A task's change history, newest first (read from the ops log).
#[tauri::command]
#[specta::specta]
fn task_activity(
    state: State<'_, AppState>,
    task_id: Id,
    limit: u32,
) -> CommandResult<Vec<Activity>> {
    with_store(&state, |s| s.task_activity(&task_id, limit))
}

/// Parses a quick-capture line and matches its names (read-only: saving goes through
/// `execute`). `today` is the user's local date, for relative due dates.
#[tauri::command]
#[specta::specta]
fn parse_capture(
    state: State<'_, AppState>,
    text: String,
    today: String,
) -> CommandResult<Capture> {
    with_store(&state, |s| s.parse_capture(&text, &today))
}

// ---------------------------------------------------------------------------------------
// Attachments (ADR 011): content goes in by hash here, then a `create_attachment` command
// through `execute` records it on a task. The UI reads files through the `tm:` protocol.

/// A file stored in the attachment folder, ready to be attached with `create_attachment`.
#[derive(Debug, Serialize, specta::Type)]
pub struct StoredUpload {
    pub hash: String,
    pub size: i64,
    /// Cleaned file name.
    pub name: String,
    pub mime: String,
}

fn files_dir(state: &AppState) -> CommandResult<taskmaster_core::FileStore> {
    with_store_ref(state, |s| s.files().cloned())
}

fn with_store_ref<T>(
    state: &AppState,
    f: impl FnOnce(&Store) -> taskmaster_core::Result<T>,
) -> CommandResult<T> {
    let store = state
        .store
        .lock()
        .map_err(|_| internal("store lock poisoned"))?;
    f(&store).map_err(Into::into)
}

/// Stores a file from disk (picked in a dialog or dropped on the window). The store lock
/// is not held while copying.
#[tauri::command]
#[specta::specta]
fn store_file(state: State<'_, AppState>, path: String) -> CommandResult<StoredUpload> {
    let files = files_dir(&state)?;
    let stored = files.put_file(&path)?;
    let name = clean_file_name(
        &std::path::Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    );
    Ok(StoredUpload {
        hash: stored.hash,
        size: stored.size,
        mime: mime_for(&name).to_owned(),
        name,
    })
}

/// Stores pasted content (base64), e.g. a screenshot from the clipboard. `mime` is what
/// the clipboard reported; empty means unknown.
#[tauri::command]
#[specta::specta]
fn store_data(
    state: State<'_, AppState>,
    name: String,
    mime: String,
    base64: String,
) -> CommandResult<StoredUpload> {
    if base64.len() as i64 > taskmaster_core::MAX_ATTACHMENT_BYTES / 3 * 4 + 4 {
        return Err(invalid(format!(
            "attachments are limited to {} MB",
            taskmaster_core::MAX_ATTACHMENT_BYTES / 1_048_576
        )));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| invalid(format!("the pasted data is not valid base64: {e}")))?;
    let files = files_dir(&state)?;
    let stored = files.put_bytes(&bytes)?;
    let name = clean_file_name(&name);
    let mime = if mime.contains('/') {
        mime
    } else {
        mime_for(&name).to_owned()
    };
    Ok(StoredUpload {
        hash: stored.hash,
        size: stored.size,
        name,
        mime,
    })
}

/// A copy of the attachment under its own name in a temporary folder, so other apps
/// recognize the type and edits there never touch the stored content.
fn named_copy(state: &AppState, id: &str) -> CommandResult<PathBuf> {
    let (source, name) = with_store_ref(state, |s| {
        Ok((s.attachment_path(id)?, s.attachment(id)?.name))
    })?;
    let dir = std::env::temp_dir().join("task-master").join(id);
    std::fs::create_dir_all(&dir).map_err(|e| internal(e.to_string()))?;
    let target = dir.join(clean_file_name(&name));
    std::fs::copy(&source, &target).map_err(|e| internal(format!("cannot copy: {e}")))?;
    Ok(target)
}

/// Opens the attachment with the system's default app for its type.
#[tauri::command]
#[specta::specta]
fn open_attachment(app: AppHandle, state: State<'_, AppState>, id: Id) -> CommandResult<()> {
    let path = named_copy(&state, &id)?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| internal(format!("cannot open the file: {e}")))
}

/// Opens a link from a task description in the default browser or mail app. Only
/// `http`, `https` and `mailto` links: the description is user text, not trusted code.
#[tauri::command]
#[specta::specta]
fn open_url(app: AppHandle, url: String) -> CommandResult<()> {
    let parsed = url::Url::parse(&url).map_err(|e| invalid(format!("not a link: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(invalid(format!(
            "{}: links are not opened",
            parsed.scheme()
        )));
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| internal(format!("cannot open the link: {e}")))
}

/// Saves a copy of the attachment to `path` (chosen in a save dialog).
#[tauri::command]
#[specta::specta]
fn save_attachment(state: State<'_, AppState>, id: Id, path: String) -> CommandResult<()> {
    let source = with_store_ref(&state, |s| s.attachment_path(&id))?;
    std::fs::copy(&source, &path)
        .map(|_| ())
        .map_err(|e| internal(format!("cannot write {path}: {e}")))
}

/// Serves attachment content to the UI: `tm://localhost/<attachment id>` (on Windows
/// `http://tm.localhost/<id>`). Only ids of attachments resolve, never paths.
fn serve_attachment(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let empty = |status: StatusCode| {
        Response::builder()
            .status(status)
            .body(Vec::new())
            .unwrap_or_default()
    };
    let id = request.uri().path().trim_start_matches('/');
    let Some(state) = app.try_state::<AppState>() else {
        return empty(StatusCode::SERVICE_UNAVAILABLE);
    };
    let found = with_store_ref(&state, |s| Ok((s.attachment(id)?, s.attachment_path(id)?)));
    let Ok((attachment, path)) = found else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(body) = std::fs::read(&path) else {
        return empty(StatusCode::NOT_FOUND);
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, attachment.mime)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        // An id always names the same content.
        .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
        .body(body)
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

// ---------------------------------------------------------------------------------------
// Settings: data folder, backups, export and import

fn config_view(state: &AppState) -> CommandResult<ConfigView> {
    let config = state
        .config
        .lock()
        .map_err(|_| internal("config lock poisoned"))?;
    Ok(ConfigView {
        data_dir: state.data_dir.display().to_string(),
        custom_data_dir: config.data_dir.is_some(),
        remote: config.remote.as_ref().map(RemoteView::from),
        schedule: config.schedule,
        managed_by: std::env::current_exe()
            .ok()
            .and_then(|exe| config::managed_by(&exe)),
    })
}

/// Where the data lives and the remote backup settings (without the secret).
#[tauri::command]
#[specta::specta]
fn get_config(state: State<'_, AppState>) -> CommandResult<ConfigView> {
    config_view(&state)
}

/// Saves how often backups and sync rounds run; they apply right away.
#[tauri::command]
#[specta::specta]
fn set_schedule(
    state: State<'_, AppState>,
    schedule: config::Schedule,
) -> CommandResult<ConfigView> {
    let schedule = schedule.validated().map_err(invalid)?;
    {
        let mut config = state
            .config
            .lock()
            .map_err(|_| internal("config lock poisoned"))?;
        config.schedule = schedule;
        config
            .save(&state.config_path)
            .map_err(|e| internal(format!("cannot save settings: {e}")))?;
    }
    // Wakes the sync loop so it re-reads its interval.
    state.sync.kick();
    config_view(&state)
}

/// Saves the remote backup settings. An empty secret keeps the stored one.
#[tauri::command]
#[specta::specta]
fn set_remote_backup(state: State<'_, AppState>, input: RemoteInput) -> CommandResult<ConfigView> {
    {
        let mut config = state
            .config
            .lock()
            .map_err(|_| internal("config lock poisoned"))?;
        let remote = input.into_remote(config.remote.as_ref());
        config.remote = Some(remote);
        config
            .save(&state.config_path)
            .map_err(|e| internal(format!("cannot save settings: {e}")))?;
    }
    config_view(&state)
}

/// Writes a small probe object with these settings, without saving them.
#[tauri::command]
#[specta::specta]
fn test_remote_backup(state: State<'_, AppState>, input: RemoteInput) -> CommandResult<()> {
    let (remote, device_id) = {
        let config = state
            .config
            .lock()
            .map_err(|_| internal("config lock poisoned"))?;
        let store = state
            .store
            .lock()
            .map_err(|_| internal("store lock poisoned"))?;
        (
            input.into_remote(config.remote.as_ref()),
            store.device_id().to_owned(),
        )
    };
    backups::test_remote(&remote, &device_id).map_err(invalid)
}

#[tauri::command]
#[specta::specta]
fn backup_status(state: State<'_, AppState>) -> CommandResult<BackupStatus> {
    Ok(state
        .backup
        .lock()
        .map_err(|_| internal("backup lock poisoned"))?
        .clone())
}

/// Runs a backup cycle now (today's backup if missing) and uploads the newest backup.
#[tauri::command]
#[specta::specta]
fn backup_now(state: State<'_, AppState>) -> CommandResult<BackupStatus> {
    backup_cycle(&state, true);
    backup_status(state)
}

/// One cycle: local daily backup, then (if enabled) upload of the newest one. The store
/// lock is released before the network call.
fn backup_cycle(state: &AppState, force_upload: bool) {
    let (newest, device_id, files) = {
        let (Ok(store), Ok(mut status)) = (state.store.lock(), state.backup.lock()) else {
            return;
        };
        let newest = backups::local_cycle(&store, &state.data_dir, &mut status);
        (
            newest,
            store.device_id().to_owned(),
            store.files().ok().cloned(),
        )
    };
    let remote = state
        .config
        .lock()
        .ok()
        .and_then(|c| c.remote.clone())
        .filter(|r| r.enabled);
    if let (Some(remote), Some(file)) = (remote, newest) {
        let mut status = state.backup.lock().map(|s| s.clone()).unwrap_or_default();
        backups::upload(&remote, &device_id, &file, &mut status, force_upload);
        if let (Some(files), None) = (&files, &status.remote_error) {
            let dir = backups::backup_dir(&state.data_dir);
            backups::upload_files(&remote, files, &dir, &mut status);
        }
        if let Ok(mut shared) = state.backup.lock() {
            *shared = status;
        }
    }
}

/// The attachment folder that goes with an export file: `tasks.json` → `tasks-attachments/`.
fn export_files_dir(path: &str) -> PathBuf {
    let path = std::path::Path::new(path);
    let stem = path
        .file_stem()
        .map_or_else(|| "export".into(), |s| s.to_string_lossy());
    path.with_file_name(format!("{stem}-attachments"))
}

/// Writes every user table to a JSON file, and the attachment files to a folder beside it.
#[tauri::command]
#[specta::specta]
fn export_to(state: State<'_, AppState>, path: String) -> CommandResult<()> {
    let file = with_store(&state, |s| s.export())?;
    let text = serde_json::to_string_pretty(&file).map_err(|e| internal(e.to_string()))?;
    std::fs::write(&path, text).map_err(|e| internal(format!("cannot write {path}: {e}")))?;
    let has_files = file
        .tables
        .get("attachments")
        .and_then(|t| t.as_array())
        .is_some_and(|rows| !rows.is_empty());
    if has_files {
        with_store(&state, |s| s.export_files_to(export_files_dir(&path)))?;
    }
    Ok(())
}

/// Replaces all data with an export file, after saving a backup of the current data.
#[tauri::command]
#[specta::specta]
fn import_from(state: State<'_, AppState>, path: String) -> CommandResult<ImportSummary> {
    let text =
        std::fs::read_to_string(&path).map_err(|e| invalid(format!("cannot read {path}: {e}")))?;
    let file: ExportFile = serde_json::from_str(&text)
        .map_err(|e| invalid(format!("not a task-master export file: {e}")))?;
    let backup = backups::backup_dir(&state.data_dir)
        .join(format!("pre-import-{}.sqlite", taskmaster_core::now_ms()));
    let files_dir = export_files_dir(&path);
    with_store(&state, |s| {
        s.backup_to(&backup)?;
        if files_dir.is_dir() {
            s.import_files_from(&files_dir)?;
        }
        s.import(&file)
    })
}

/// Moves the data to `path` (or back to the OS default when `None`) and restarts. An
/// existing database there is used as is; otherwise the current one is copied over.
#[tauri::command]
#[specta::specta]
fn set_data_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    path: Option<String>,
) -> CommandResult<()> {
    let target_dir = match &path {
        Some(p) => PathBuf::from(p),
        None => default_data_dir(&app).map_err(|e| internal(e.to_string()))?,
    };
    if target_dir == state.data_dir {
        return Ok(());
    }
    let target = target_dir.join(DB_FILE);
    if !target.exists() {
        with_store(&state, |s| s.backup_to(&target))?;
    }
    {
        let mut config = state
            .config
            .lock()
            .map_err(|_| internal("config lock poisoned"))?;
        config.data_dir = path.map(PathBuf::from);
        config
            .save(&state.config_path)
            .map_err(|e| internal(format!("cannot save settings: {e}")))?;
    }
    app.restart();
}

fn default_data_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    app.path().app_data_dir()
}

/// Logical size of the capture window when it opens (as in `tauri.conf.json`). Shift+Enter
/// there grows it into a task editor (`CaptureWindow.tsx`), so each opening starts small.
const CAPTURE_SIZE: (f64, f64) = (660.0, 230.0);

fn show_capture(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(CAPTURE_WINDOW) {
        let _ = window.set_resizable(false);
        let _ = window.set_size(tauri::LogicalSize::new(CAPTURE_SIZE.0, CAPTURE_SIZE.1));
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = CaptureOpened.emit_to(app, CAPTURE_WINDOW);
    }
}

/// Every IPC command and event the UI can use. New ones are registered here only.
fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            ping,
            snapshot,
            execute,
            undo,
            redo,
            search,
            task_activity,
            parse_capture,
            get_config,
            set_remote_backup,
            set_schedule,
            test_remote_backup,
            backup_status,
            backup_now,
            export_to,
            import_from,
            set_data_dir,
            store_file,
            store_data,
            open_attachment,
            save_attachment,
            open_url,
            calendar_sync::calendar_status,
            calendar_sync::set_calendar_runner,
            calendar_sync::google_connect,
            calendar_sync::google_disconnect,
            calendar_sync::set_calendar_shown,
            calendar_sync::calendar_sync_now,
            calendar_sync::calendar_events,
            server_sync::sync_status,
            server_sync::sync_connect,
            server_sync::sync_set_token,
            server_sync::sync_sign_in,
            server_sync::sync_join,
            server_sync::sync_now,
            server_sync::sync_disconnect,
            agents::agent_start,
            agents::agent_send,
            agents::agent_cancel,
            agents::agent_open_terminal,
            agents::agent_live,
            agents::agent_brief,
            agents::agent_notes,
            agents::agent_settings,
            agents::set_agent_settings,
            agents::detect_claude,
            agents::list_wsl_distros,
            agents::project_folders,
            agents::set_project_folder
        ])
        .events(collect_events![
            StoreChanged,
            CaptureOpened,
            calendar_sync::CalendarSynced,
            server_sync::SyncChanged,
            agents::AgentActivity
        ])
        // Timestamps (Unix ms) and op sequence numbers stay far below 2^53.
        .dangerously_cast_bigints_to_number()
}

#[cfg(any(debug_assertions, test))]
fn export_bindings(builder: &Builder<tauri::Wry>) {
    builder
        .export(specta_typescript::Typescript::default(), BINDINGS_PATH)
        .expect("failed to export TypeScript bindings");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = specta_builder();

    #[cfg(debug_assertions)]
    export_bindings(&builder);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Opens attachments in their default app (from Rust only; no JS permission).
        .plugin(tauri_plugin_opener::init())
        // File reads happen off the main thread so a large image never stalls the UI.
        .register_asynchronous_uri_scheme_protocol("tm", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || responder.respond(serve_attachment(&app, &request)));
        })
        // In-app updates (ADR 009): signed releases from GitHub, then a relaunch.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed && *shortcut == capture_shortcut() {
                        show_capture(app);
                    }
                })
                .build(),
        )
        .invoke_handler(builder.invoke_handler())
        // Closing the main window quits, even though the hidden capture window still
        // exists (otherwise the app would linger without a window or a way to quit).
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
            // Coming back to the app: pick up what other devices did meanwhile.
            if window.label() == MAIN_WINDOW
                && matches!(event, tauri::WindowEvent::Focused(true))
                && let Some(state) = window.app_handle().try_state::<AppState>()
            {
                state.sync.kick();
                state.calendar.kick();
            }
        })
        .setup(move |app| {
            builder.mount_events(app);

            // Not fatal: some desktops (Wayland sessions, locked-down machines) refuse
            // global hotkeys. `n` inside the app still captures.
            if let Err(err) = app.global_shortcut().register(capture_shortcut()) {
                eprintln!("quick capture hotkey unavailable: {err}");
            }

            let config_path = app.path().app_config_dir()?.join(CONFIG_FILE);
            let config = AppConfig::load(&config_path);
            let data_dir = match &config.data_dir {
                Some(dir) => dir.clone(),
                None => default_data_dir(app.handle())?,
            };
            let path = data_dir.join(DB_FILE);
            // Debug builds can open another database, e.g. one filled by the core's `seed`
            // example for performance checks.
            #[cfg(debug_assertions)]
            let path: PathBuf = std::env::var_os("TASK_MASTER_DB").map_or(path, Into::into);
            let data_dir = path.parent().map_or(data_dir, PathBuf::from);
            let mut store = Store::open(&path)?;
            // No run of a previous start survives it (ADR 017).
            if let Err(e) = store.interrupt_running_sessions() {
                eprintln!("cannot mark old agent sessions interrupted: {e}");
            }
            let changes = store.subscribe();
            let handle = app.handle().clone();
            let (calendar, kicks) = calendar_sync::CalendarRuntime::new();
            let (sync, sync_kicks) = server_sync::SyncRuntime::new();
            std::thread::Builder::new()
                .name("store-events".into())
                .spawn(move || {
                    for changed in changes {
                        // Local edits go to the sync server soon (ADR 015).
                        if let Some(state) = handle.try_state::<AppState>() {
                            state.sync.local_change();
                        }
                        // Pushed items changed: sync the calendar soon.
                        if calendar_sync::CalendarRuntime::wants(&changed.entities)
                            && let Some(state) = handle.try_state::<AppState>()
                        {
                            state.calendar.kick();
                        }
                        let _ = StoreChanged(changed).emit(&handle);
                    }
                })?;
            app.manage(AppState {
                store: Mutex::new(store),
                data_dir,
                db_path: path,
                agents: agents::AgentRunner::default(),
                config_path,
                config: Mutex::new(config),
                backup: Mutex::new(BackupStatus::default()),
                calendar,
                sync,
            });

            // Finished terminal sessions close even across a restart (ADR 017).
            agents::watch_terminals(app.handle());

            // Local tools share this database but have their own SQLite connection.
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("external-writes".into())
                .spawn(move || {
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        let state = handle.state::<AppState>();
                        if let Err(e) = with_store(&state, |s| s.refresh_external_changes()) {
                            eprintln!("cannot check external writes: {}", e.message);
                        }
                    }
                })?;

            // Server sync (ADR 015): idle until a server is joined in settings.
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("server-sync".into())
                .spawn(move || server_sync::run(handle, sync_kicks))?;
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("server-events".into())
                .spawn(move || server_sync::watch(handle))?;

            // Calendar sync (ADR 014): idle until a Google account is connected.
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("calendar-sync".into())
                .spawn(move || calendar_sync::run(handle, kicks))?;

            // Daily backups and remote uploads, every 15 minutes from shortly after start.
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("backups".into())
                .spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(20));
                    loop {
                        backup_cycle(&handle.state::<AppState>(), false);
                        // Wake every 30 s so a changed interval applies soon.
                        let started = std::time::Instant::now();
                        loop {
                            std::thread::sleep(std::time::Duration::from_secs(30));
                            let minutes = handle
                                .state::<AppState>()
                                .config
                                .lock()
                                .map_or(backups::DEFAULT_MINUTES, |c| c.schedule.backup_minutes);
                            let due = std::time::Duration::from_secs(60 * u64::from(minutes));
                            if started.elapsed() >= due {
                                break;
                            }
                        }
                    }
                })?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building task-master")
        .run(|app, event| {
            // Agent runs are children of the app: stop them, marked interrupted.
            if let tauri::RunEvent::Exit = event {
                agents::shutdown(app);
            }
        });
}

#[cfg(test)]
mod tests {
    /// `tauri.windows.conf.json` replaces the whole window list (JSON merge patch), so it
    /// must match `tauri.conf.json` except for the frameless main window (ADR 012).
    #[test]
    fn windows_config_only_drops_the_main_frame() {
        let read = |name: &str| -> serde_json::Value {
            let path = concat!(env!("CARGO_MANIFEST_DIR"), "/").to_owned() + name;
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
        };
        let base = read("tauri.conf.json")["app"]["windows"].clone();
        let mut windows = read("tauri.windows.conf.json")["app"]["windows"].clone();
        let main = windows[0].as_object_mut().unwrap();
        assert_eq!(main.remove("decorations"), Some(serde_json::json!(false)));
        assert_eq!(main.remove("shadow"), Some(serde_json::json!(true)));
        assert_eq!(windows, base);
    }

    /// Same for `tauri.linux.conf.json`: only the main window's frame goes (no shadow
    /// setting there, Tauri ignores it on Linux).
    #[test]
    fn linux_config_only_drops_the_main_frame() {
        let read = |name: &str| -> serde_json::Value {
            let path = concat!(env!("CARGO_MANIFEST_DIR"), "/").to_owned() + name;
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
        };
        let base = read("tauri.conf.json")["app"]["windows"].clone();
        let mut windows = read("tauri.linux.conf.json")["app"]["windows"].clone();
        let main = windows[0].as_object_mut().unwrap();
        assert_eq!(main.remove("decorations"), Some(serde_json::json!(false)));
        assert_eq!(windows, base);
    }

    /// Regenerates `bindings.ts`. CI runs this and fails if the file changed.
    #[test]
    fn export_bindings() {
        super::export_bindings(&super::specta_builder());
    }
}
