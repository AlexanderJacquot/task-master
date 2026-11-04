//! Desktop shell. Commands here are thin wrappers over `taskmaster_core`.

use tauri_specta::{Builder, collect_commands};

/// Path of the generated TypeScript bindings, relative to this crate.
#[cfg(any(debug_assertions, test))]
const BINDINGS_PATH: &str = "../src/bindings.ts";

#[tauri::command]
#[specta::specta]
fn ping() -> String {
    taskmaster_core::ping()
}

/// Every IPC command the UI can call. New commands are registered here only.
fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![ping])
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
