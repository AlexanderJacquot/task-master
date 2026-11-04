//! Desktop shell. Commands here are thin wrappers over `taskmaster_core`; the IPC surface
//! stays small (plan, section 5): new features add `Command` variants, not endpoints.

use std::path::PathBuf;
use std::sync::Mutex;

mod backups;
mod config;

use backups::BackupStatus;
use config::{AppConfig, ConfigView, RemoteInput, RemoteView};

use serde::{Deserialize, Serialize};
use taskmaster_core::{
    Activity, Capture, Changed, Changes, Command, ExportFile, Id, ImportSummary, Snapshot, Store,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_specta::{Builder, Event, collect_commands, collect_events};

/// Path of the generated TypeScript bindings, relative to this crate.
#[cfg(any(debug_assertions, test))]
const BINDINGS_PATH: &str = "../src/bindings.ts";

const DB_FILE: &str = "task-master.sqlite";
const CONFIG_FILE: &str = "config.json";

/// Label of the small always-on-top window opened by the quick-capture hotkey
/// (`tauri.conf.json`). It loads the same UI, which renders only the capture box there.
const CAPTURE_WINDOW: &str = "capture";

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
    config_path: PathBuf,
    config: Mutex<AppConfig>,
    backup: Mutex<BackupStatus>,
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
    state: &State<'_, AppState>,
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
    })
}

/// Where the data lives and the remote backup settings (without the secret).
#[tauri::command]
#[specta::specta]
fn get_config(state: State<'_, AppState>) -> CommandResult<ConfigView> {
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
    let (newest, device_id) = {
        let (Ok(store), Ok(mut status)) = (state.store.lock(), state.backup.lock()) else {
            return;
        };
        let newest = backups::local_cycle(&store, &state.data_dir, &mut status);
        (newest, store.device_id().to_owned())
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
        if let Ok(mut shared) = state.backup.lock() {
            *shared = status;
        }
    }
}

/// Writes every user table to a JSON file.
#[tauri::command]
#[specta::specta]
fn export_to(state: State<'_, AppState>, path: String) -> CommandResult<()> {
    let file = with_store(&state, |s| s.export())?;
    let text = serde_json::to_string_pretty(&file).map_err(|e| internal(e.to_string()))?;
    std::fs::write(&path, text).map_err(|e| internal(format!("cannot write {path}: {e}")))
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
    with_store(&state, |s| {
        s.backup_to(&backup)?;
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

fn show_capture(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(CAPTURE_WINDOW) {
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
            test_remote_backup,
            backup_status,
            backup_now,
            export_to,
            import_from,
            set_data_dir
        ])
        .events(collect_events![StoreChanged, CaptureOpened])
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
            let changes = store.subscribe();
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("store-events".into())
                .spawn(move || {
                    for changed in changes {
                        let _ = StoreChanged(changed).emit(&handle);
                    }
                })?;
            app.manage(AppState {
                store: Mutex::new(store),
                data_dir,
                config_path,
                config: Mutex::new(config),
                backup: Mutex::new(BackupStatus::default()),
            });

            // Daily backups and remote uploads, every 15 minutes from shortly after start.
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("backups".into())
                .spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(20));
                    loop {
                        backup_cycle(&handle.state::<AppState>(), false);
                        std::thread::sleep(backups::CYCLE);
                    }
                })?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running task-master");
}

#[cfg(test)]
mod tests {
    /// Regenerates `bindings.ts`. CI runs this and fails if the file changed.
    #[test]
    fn export_bindings() {
        super::export_bindings(&super::specta_builder());
    }
}
