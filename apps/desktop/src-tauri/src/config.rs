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

/// The sync server this device syncs with (ADR 015, docs/server.md).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncAccount {
    /// e.g. `https://tasks.example.org`.
    pub url: String,
    /// The server's token for this device (pasted, or from the OIDC sign-in). `None` for
    /// a server that asks for none.
    #[serde(default)]
    pub token: Option<String>,
    /// Shown in the server's `token list`.
    #[serde(default)]
    pub device_name: String,
    /// The first sync chose how to combine this device's data with the server's; syncing
    /// runs only once this is set.
    #[serde(default)]
    pub joined: bool,
}

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
        }
    }
}

impl AgentSettings {
    /// Trims fields and checks the permission mode.
    pub fn normalized(mut self) -> Result<Self, String> {
        let blank_to_none =
            |v: Option<String>| v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
        self.wsl_distro = blank_to_none(self.wsl_distro);
        self.terminal = blank_to_none(self.terminal);
        self.model = blank_to_none(self.model);
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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppConfig {
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
    fn config_roundtrips_through_its_file() {
        let dir = std::env::temp_dir().join(format!("tm-config-{}", taskmaster_core::new_id()));
        let path = dir.join("config.json");
        assert_eq!(AppConfig::load(&path), AppConfig::default());
        let config = AppConfig {
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
