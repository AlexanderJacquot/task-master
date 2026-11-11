//! Where this device's database is, for `task-master-mcp` started without `--db` (added to
//! Claude by hand, docs/mcp.md). The desktop app passes `--db` itself; this follows the
//! app's own lookup (`apps/desktop/src-tauri/src/lib.rs`, setup): the `data_dir` chosen in
//! settings (`<app config>/config.json`), else the OS app-data folder.

use std::path::{Path, PathBuf};

/// The desktop app's identifier (`tauri.conf.json`), the name of its folders.
pub const APP_ID: &str = "space.solarnexus.taskmaster";
/// The database file in the data folder (the app's `DB_FILE`).
pub const DB_FILE: &str = "task-master.sqlite";
/// Overrides everything else (also read by debug builds of the app).
pub const DB_ENV: &str = "TASK_MASTER_DB";

/// The app's data and config folders, as Tauri resolves `app_data_dir` and
/// `app_config_dir`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppDirs {
    pub data: PathBuf,
    pub config: PathBuf,
}

impl AppDirs {
    /// From environment variables (`var` reads one), for this OS. `None` when the home
    /// folder is unknown.
    pub fn from_env(var: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let path = |key: &str| var(key).filter(|v| !v.is_empty()).map(PathBuf::from);
        if cfg!(windows) {
            // Roaming AppData for both.
            let base = path("APPDATA")
                .or_else(|| path("USERPROFILE").map(|h| h.join("AppData").join("Roaming")))?;
            let dir = base.join(APP_ID);
            Some(Self {
                data: dir.clone(),
                config: dir,
            })
        } else if cfg!(target_os = "macos") {
            let dir = path("HOME")?
                .join("Library")
                .join("Application Support")
                .join(APP_ID);
            Some(Self {
                data: dir.clone(),
                config: dir,
            })
        } else {
            let home = path("HOME");
            let data = path("XDG_DATA_HOME")
                .filter(|p| p.is_absolute())
                .or_else(|| home.as_ref().map(|h| h.join(".local").join("share")))?;
            let config = path("XDG_CONFIG_HOME")
                .filter(|p| p.is_absolute())
                .or_else(|| home.as_ref().map(|h| h.join(".config")))?;
            Some(Self {
                data: data.join(APP_ID),
                config: config.join(APP_ID),
            })
        }
    }

    /// The database the app opens: in the folder chosen in its settings, else in its data
    /// folder. An unreadable config file counts as no choice, as in the app.
    pub fn database(&self) -> PathBuf {
        chosen_data_dir(&self.config.join("config.json"))
            .unwrap_or_else(|| self.data.clone())
            .join(DB_FILE)
    }
}

/// The `data_dir` of the app's config file, when set.
fn chosen_data_dir(config: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(config).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("data_dir")?.as_str().map(PathBuf::from)
}

/// The database to open without `--db`: `TASK_MASTER_DB`, else the app's.
pub fn default_database(var: impl Fn(&str) -> Option<String>) -> Result<PathBuf, String> {
    if let Some(path) = var(DB_ENV).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    AppDirs::from_env(var)
        .map(|dirs| dirs.database())
        .ok_or_else(|| format!("cannot find the home folder; pass --db or set {DB_ENV}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_owned())
        }
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tm-locate-{}", taskmaster_core::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_variable_wins() {
        let path = default_database(env(&[(DB_ENV, "/x/tasks.sqlite"), ("HOME", "/h")]));
        assert_eq!(path.unwrap(), PathBuf::from("/x/tasks.sqlite"));
    }

    #[test]
    fn without_home_it_asks_for_a_path() {
        let err = default_database(env(&[])).unwrap_err();
        assert!(err.contains("--db"), "{err}");
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn linux_folders_follow_xdg() {
        let dirs = AppDirs::from_env(env(&[("HOME", "/h")])).unwrap();
        assert_eq!(dirs.data, PathBuf::from("/h/.local/share").join(APP_ID));
        assert_eq!(dirs.config, PathBuf::from("/h/.config").join(APP_ID));
        let dirs = AppDirs::from_env(env(&[
            ("HOME", "/h"),
            ("XDG_DATA_HOME", "/d"),
            ("XDG_CONFIG_HOME", "relative/ignored"),
        ]))
        .unwrap();
        assert_eq!(dirs.data, PathBuf::from("/d").join(APP_ID));
        assert_eq!(dirs.config, PathBuf::from("/h/.config").join(APP_ID));
    }

    #[test]
    fn the_folder_chosen_in_settings_wins_over_the_default() {
        let root = temp_dir();
        let dirs = AppDirs {
            data: root.join("data"),
            config: root.join("config"),
        };
        assert_eq!(dirs.database(), root.join("data").join(DB_FILE));

        std::fs::create_dir_all(&dirs.config).unwrap();
        let chosen = root.join("synced folder");
        let config = serde_json::json!({ "data_dir": chosen, "agents": {} });
        std::fs::write(dirs.config.join("config.json"), config.to_string()).unwrap();
        assert_eq!(dirs.database(), chosen.join(DB_FILE));

        // Unreadable: the default, as the app does.
        std::fs::write(dirs.config.join("config.json"), "{not json").unwrap();
        assert_eq!(dirs.database(), root.join("data").join(DB_FILE));
        std::fs::remove_dir_all(root).unwrap();
    }
}
