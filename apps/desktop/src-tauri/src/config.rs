//! Per-device configuration kept outside the database (`<app config>/config.json`): where
//! the data lives, and the optional remote backup target. Readable by the user only.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// An S3-compatible bucket (Garage in the homelab) that receives the daily backups.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteBackup {
    pub enabled: bool,
    /// e.g. `https://s3.solarnexus.space` (path-style requests).
    pub endpoint: String,
    pub bucket: String,
    /// Garage's default region is `garage`.
    pub region: String,
    pub access_key: String,
    pub secret_key: String,
    /// Object key prefix, e.g. `task-master`. Objects land at `<prefix>/<device>/<file>`.
    pub prefix: String,
}

/// The Google account the calendar syncs with (ADR 014): the user's own OAuth client and,
/// once signed in, a refresh token.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoogleAccount {
    pub client_id: String,
    pub client_secret: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub runner: taskmaster_core::calendar::CalendarRunner,
}

pub use taskmaster_client::engine::SyncAccount;

/// How this device runs Claude Code for agent sessions (ADR 017).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct AgentSettings {
    #[serde(default)]
    pub runtime: taskmaster_core::AgentRuntime,
    /// WSL distribution (`wsl.exe -d`); the default one when `None`.
    #[serde(default)]
    pub wsl_distro: Option<String>,
    /// `claude`, or an absolute path (as the runtime sees it) when it is not on the PATH
    /// a GUI app or `wsl.exe --exec` gets.
    #[serde(default = "default_claude")]
    pub claude_path: String,
    /// Linux only: the terminal command that runs what follows it, e.g. `kitty` or
    /// `gnome-terminal --`. `$TERMINAL -e`, else `x-terminal-emulator -e`, when `None`.
    #[serde(default)]
    pub terminal: Option<String>,
    /// Default `--permission-mode` for new sessions.
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    /// `--model` for sessions; Claude Code's default when `None`.
    #[serde(default)]
    pub model: Option<String>,
    /// Where a task goes when it is sent to an agent; In progress when `None`.
    #[serde(default)]
    pub started_status_id: Option<taskmaster_core::Id>,
    /// Where a task goes when the agent reports it done; Review when `None`.
    #[serde(default)]
    pub done_status_id: Option<taskmaster_core::Id>,
}

fn default_claude() -> String {
    "claude".into()
}

fn default_permission_mode() -> String {
    "acceptEdits".into()
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            runtime: taskmaster_core::AgentRuntime::Native,
            wsl_distro: None,
            claude_path: default_claude(),
            terminal: None,
            permission_mode: default_permission_mode(),
            model: None,
            started_status_id: None,
            done_status_id: None,
        }
    }
}

impl AgentSettings {
    /// The statuses a user's task moves to as an agent works on it (ADR 017).
    pub fn workflow(&self) -> taskmaster_core::AgentWorkflow {
        taskmaster_core::AgentWorkflow {
            started_status_id: self.started_status_id.clone(),
            done_status_id: self.done_status_id.clone(),
        }
    }

    /// Trims fields and checks the permission mode.
    pub fn normalized(mut self) -> Result<Self, String> {
        let blank_to_none =
            |v: Option<String>| v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
        self.wsl_distro = blank_to_none(self.wsl_distro);
        self.terminal = blank_to_none(self.terminal);
        self.model = blank_to_none(self.model);
        self.started_status_id = blank_to_none(self.started_status_id);
        self.done_status_id = blank_to_none(self.done_status_id);
        self.claude_path = self.claude_path.trim().to_owned();
        if self.claude_path.is_empty() {
            self.claude_path = default_claude();
        }
        if !taskmaster_core::PERMISSION_MODES.contains(&self.permission_mode.as_str()) {
            return Err(format!(
                "unknown permission mode '{}'",
                self.permission_mode
            ));
        }
        Ok(self)
    }
}

/// How often the background workers run on this device, in minutes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct Schedule {
    /// Local backup check and remote upload retry (5 to 1440).
    #[serde(default = "default_backup_minutes")]
    pub backup_minutes: u32,
    /// Periodic sync round with the server (1 to 1440); 0 syncs only after edits, server
    /// announcements, focus and "Sync now".
    #[serde(default = "default_sync_minutes")]
    pub sync_minutes: u32,
}

fn default_backup_minutes() -> u32 {
    15
}

fn default_sync_minutes() -> u32 {
    5
}

impl Default for Schedule {
    fn default() -> Self {
        Self {
            backup_minutes: default_backup_minutes(),
            sync_minutes: default_sync_minutes(),
        }
    }
}

impl Schedule {
    pub fn validated(self) -> Result<Self, String> {
        if !(5..=1440).contains(&self.backup_minutes) {
            return Err("backup interval must be between 5 minutes and 24 hours".into());
        }
        if self.sync_minutes > 1440 {
            return Err("sync interval must be at most 24 hours".into());
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub schedule: Schedule,
    #[serde(default)]
    pub agents: AgentSettings,
    /// A data folder chosen in settings; the OS app-data folder when `None`.
    #[serde(default)]
    pub data_dir: Option<PathBuf>,
    #[serde(default)]
    pub remote: Option<RemoteBackup>,
    #[serde(default)]
    pub google: Option<GoogleAccount>,
    #[serde(default)]
    pub sync: Option<SyncAccount>,
}

impl AppConfig {
    /// A missing or unreadable file gives the defaults (and is reported on stderr).
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|err| {
                eprintln!("ignoring unreadable {}: {err}", path.display());
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    /// Written atomically, and only readable by the user (it holds secrets and tokens).
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(tmp, path)
    }
}

/// What the settings screen shows: never the secret itself.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ConfigView {
    /// The folder in use now.
    pub data_dir: String,
    /// Whether it was chosen in settings (vs the OS default).
    pub custom_data_dir: bool,
    pub remote: Option<RemoteView>,
    pub schedule: Schedule,
    /// Set when a system package manager owns this install (ADR 018): the in-app updater
    /// then stays off and the text names where updates come from.
    pub managed_by: Option<String>,
}

/// The package manager that owns this install, from the marker a distribution package
/// puts at `<prefix>/share/task-master/managed-by` next to `<prefix>/bin/<exe>` (the AUR
/// package, ADR 018). Release bundles (AppImage, .deb, .rpm) ship no marker.
pub fn managed_by(exe: &Path) -> Option<String> {
    let prefix = exe.parent()?.parent()?;
    let text = std::fs::read_to_string(prefix.join("share/task-master/managed-by")).ok()?;
    let line = text.lines().next()?.trim();
    (!line.is_empty()).then(|| line.chars().take(200).collect())
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RemoteView {
    pub enabled: bool,
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key: String,
    pub prefix: String,
    pub has_secret: bool,
}

/// What the settings screen sends. An empty `secret_key` keeps the stored one.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RemoteInput {
    pub enabled: bool,
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key: String,
    pub secret_key: String,
    pub prefix: String,
}

impl RemoteInput {
    /// Merges with the stored settings (keeping the secret when none was typed).
    pub fn into_remote(self, previous: Option<&RemoteBackup>) -> RemoteBackup {
        let secret_key = if self.secret_key.is_empty() {
            previous.map(|p| p.secret_key.clone()).unwrap_or_default()
        } else {
            self.secret_key
        };
        RemoteBackup {
            enabled: self.enabled,
            endpoint: self.endpoint.trim().trim_end_matches('/').to_owned(),
            bucket: self.bucket.trim().to_owned(),
            region: if self.region.trim().is_empty() {
                "garage".into()
            } else {
                self.region.trim().to_owned()
            },
            access_key: self.access_key.trim().to_owned(),
            secret_key,
            prefix: self.prefix.trim().trim_matches('/').to_owned(),
        }
    }
}

impl From<&RemoteBackup> for RemoteView {
    fn from(r: &RemoteBackup) -> Self {
        Self {
            enabled: r.enabled,
            endpoint: r.endpoint.clone(),
            bucket: r.bucket.clone(),
            region: r.region.clone(),
            access_key: r.access_key.clone(),
            prefix: r.prefix.clone(),
            has_secret: !r.secret_key.is_empty(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_secret_keeps_the_stored_one_and_fields_are_normalized() {
        let stored = RemoteBackup {
            secret_key: "s3cret".into(),
            ..RemoteBackup::default()
        };
        let input = RemoteInput {
            enabled: true,
            endpoint: " https://s3.example.org/ ".into(),
            bucket: "tm".into(),
            region: String::new(),
            access_key: "key".into(),
            secret_key: String::new(),
            prefix: "/task-master/".into(),
        };
        let merged = input.into_remote(Some(&stored));
        assert_eq!(merged.secret_key, "s3cret");
        assert_eq!(merged.endpoint, "https://s3.example.org");
        assert_eq!(merged.region, "garage");
        assert_eq!(merged.prefix, "task-master");
        assert!(RemoteView::from(&merged).has_secret);
    }

    #[test]
    fn schedule_defaults_and_limits() {
        assert_eq!(Schedule::default().validated().unwrap().backup_minutes, 15);
        let cfg: AppConfig = serde_json::from_str(r#"{"schedule":{"sync_minutes":1}}"#).unwrap();
        assert_eq!(cfg.schedule.backup_minutes, 15);
        assert_eq!(cfg.schedule.sync_minutes, 1);
        let bad = |b, s| {
            Schedule {
                backup_minutes: b,
                sync_minutes: s,
            }
            .validated()
            .is_err()
        };
        assert!(bad(1, 5) && bad(15, 2000));
        assert!(!bad(5, 0));
    }

    #[test]
    fn the_package_marker_names_who_manages_updates() {
        let prefix = std::env::temp_dir().join(format!("tm-prefix-{}", taskmaster_core::new_id()));
        let exe = prefix.join("bin/taskmaster-desktop");
        assert_eq!(managed_by(&exe), None);

        let marker = prefix.join("share/task-master/managed-by");
        std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
        std::fs::write(&marker, "  the AUR package task-master-bin \nignored\n").unwrap();
        assert_eq!(
            managed_by(&exe).as_deref(),
            Some("the AUR package task-master-bin")
        );

        std::fs::write(&marker, "\n").unwrap();
        assert_eq!(managed_by(&exe), None);
        std::fs::remove_dir_all(prefix).unwrap();
    }

    #[test]
    fn config_roundtrips_through_its_file() {
        let dir = std::env::temp_dir().join(format!("tm-config-{}", taskmaster_core::new_id()));
        let path = dir.join("config.json");
        assert_eq!(AppConfig::load(&path), AppConfig::default());
        let config = AppConfig {
            schedule: Schedule {
                backup_minutes: 60,
                sync_minutes: 0,
            },
            agents: AgentSettings {
                runtime: taskmaster_core::AgentRuntime::Wsl,
                wsl_distro: Some("Ubuntu".into()),
                ..AgentSettings::default()
            },
            data_dir: Some(dir.join("data")),
            remote: Some(RemoteBackup {
                enabled: true,
                ..RemoteBackup::default()
            }),
            google: Some(GoogleAccount {
                client_id: "id.apps.googleusercontent.com".into(),
                client_secret: "secret".into(),
                refresh_token: Some("1//token".into()),
                runner: Default::default(),
            }),
            sync: Some(SyncAccount {
                url: "https://tasks.example.org".into(),
                token: Some("tm_abc".into()),
                device_name: "Laptop".into(),
                joined: true,
            }),
        };
        config.save(&path).unwrap();
        assert_eq!(AppConfig::load(&path), config);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
