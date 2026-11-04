//! Desktop shell. Commands here are thin wrappers over `taskmaster_core`; the IPC surface
//! stays small (plan, section 5): new features add `Command` variants, not endpoints.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use taskmaster_core::{Activity, Changed, Changes, Command, Id, Snapshot, Store};
use tauri::{Manager, State};
use tauri_specta::{Builder, Event, collect_commands, collect_events};

/// Path of the generated TypeScript bindings, relative to this crate.
#[cfg(any(debug_assertions, test))]
const BINDINGS_PATH: &str = "../src/bindings.ts";

const DB_FILE: &str = "task-master.sqlite";

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
            task_activity
        ])
        .events(collect_events![StoreChanged])
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
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);

            let mut store = Store::open(app.path().app_data_dir()?.join(DB_FILE))?;
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
