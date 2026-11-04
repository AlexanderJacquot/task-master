//! Desktop shell. Commands here are thin wrappers over `taskmaster_core`; the IPC surface
//! stays small (plan, section 5): new features add `Command` variants, not endpoints.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use taskmaster_core::{Activity, Capture, Changed, Changes, Command, Id, Snapshot, Store};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_specta::{Builder, Event, collect_commands, collect_events};

/// Path of the generated TypeScript bindings, relative to this crate.
#[cfg(any(debug_assertions, test))]
const BINDINGS_PATH: &str = "../src/bindings.ts";

const DB_FILE: &str = "task-master.sqlite";

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

struct AppState(Mutex<Store>);

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
    let mut store = state.0.lock().map_err(|_| CommandError {
        kind: "internal".into(),
        message: "store lock poisoned".into(),
    })?;
    f(&mut store).map_err(Into::into)
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
            parse_capture
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

            let path = app.path().app_data_dir()?.join(DB_FILE);
            // Debug builds can open another database, e.g. one filled by the core's `seed`
            // example for performance checks.
            #[cfg(debug_assertions)]
            let path = std::env::var_os("TASK_MASTER_DB").map_or(path, Into::into);
            let mut store = Store::open(path)?;
            let changes = store.subscribe();
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("store-events".into())
                .spawn(move || {
                    for changed in changes {
                        let _ = StoreChanged(changed).emit(&handle);
                    }
                })?;
            app.manage(AppState(Mutex::new(store)));
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
