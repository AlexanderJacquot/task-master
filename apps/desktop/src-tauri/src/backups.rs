//! Daily backups (keep 14) and the optional upload of each one to an S3-compatible bucket
//! (Garage in the homelab). Uploading is one-way and best effort: when the bucket is not
//! reachable (off the LAN, server down), the next cycle tries again.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use serde::{Deserialize, Serialize};
use taskmaster_core::{Store, now_ms, utc_date};

use crate::config::RemoteBackup;

/// Daily backups kept on disk (plan section 4).
pub const KEEP_DAILY: usize = 14;
/// How often the background thread runs a cycle (and retries a failed upload).
pub const CYCLE: Duration = Duration::from_secs(15 * 60);

/// Shown in settings.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct BackupStatus {
    /// Folder holding the local backups.
    pub dir: String,
    /// Newest local backup file name, and when it was written (Unix ms).
    pub last_local: Option<String>,
    pub last_local_at: Option<i64>,
    /// Last successful upload: object key and time.
    pub last_remote: Option<String>,
    pub last_remote_at: Option<i64>,
    /// Why the last upload attempt failed (cleared on success).
    pub remote_error: Option<String>,
}

pub fn backup_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("backups")
}

/// The newest `daily-*.sqlite` in `dir`.
fn newest_daily(dir: &Path) -> Option<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("daily-") && n.ends_with(".sqlite"))
        })
        .collect();
    files.sort();
    files.pop()
}

fn modified_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    i64::try_from(ms).ok()
}

/// Makes today's local backup if missing. Returns the newest backup file.
pub fn local_cycle(store: &Store, data_dir: &Path, status: &mut BackupStatus) -> Option<PathBuf> {
    let dir = backup_dir(data_dir);
    status.dir = dir.display().to_string();
    if let Err(err) = store.daily_backup(&dir, &utc_date(now_ms()), KEEP_DAILY) {
        eprintln!("daily backup failed: {err}");
    }
    let newest = newest_daily(&dir)?;
    status.last_local = newest.file_name().map(|n| n.to_string_lossy().into_owned());
    status.last_local_at = modified_ms(&newest);
    Some(newest)
}

fn object_key(remote: &RemoteBackup, device_id: &str, file_name: &str) -> String {
    if remote.prefix.is_empty() {
        format!("{device_id}/{file_name}")
    } else {
        format!("{}/{device_id}/{file_name}", remote.prefix)
    }
}

/// Uploads `body` to `key` with a presigned PUT.
fn put(remote: &RemoteBackup, key: &str, body: &[u8]) -> Result<(), String> {
    let endpoint = remote
        .endpoint
        .parse::<url::Url>()
        .map_err(|e| format!("endpoint '{}' is not a URL: {e}", remote.endpoint))?;
    let bucket = Bucket::new(
        endpoint,
        UrlStyle::Path,
        remote.bucket.clone(),
        remote.region.clone(),
    )
    .map_err(|e| format!("bad bucket settings: {e}"))?;
    let credentials = Credentials::new(remote.access_key.clone(), remote.secret_key.clone());
    let url = bucket
        .put_object(Some(&credentials), key)
        .sign(Duration::from_secs(600));
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(Duration::from_secs(120)))
        .build()
        .into();
    agent
        .put(url.as_str())
        .header("content-type", "application/octet-stream")
        .send(body)
        .map(|_| ())
        .map_err(|e| match e {
            ureq::Error::StatusCode(code) => format!("the server answered HTTP {code}"),
            other => format!("could not reach {}: {other}", remote.endpoint),
        })
}

/// Uploads `file` unless it is the one already uploaded (or `force`).
pub fn upload(
    remote: &RemoteBackup,
    device_id: &str,
    file: &Path,
    status: &mut BackupStatus,
    force: bool,
) {
    let Some(name) = file.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return;
    };
    let key = object_key(remote, device_id, &name);
    if !force && status.last_remote.as_deref() == Some(key.as_str()) {
        return;
    }
    let result = std::fs::read(file)
        .map_err(|e| format!("cannot read {}: {e}", file.display()))
        .and_then(|body| put(remote, &key, &body));
    match result {
        Ok(()) => {
            status.last_remote = Some(key);
            status.last_remote_at = Some(now_ms());
            status.remote_error = None;
        }
        Err(err) => status.remote_error = Some(err),
    }
}

/// Checks the settings by writing a small probe object.
pub fn test_remote(remote: &RemoteBackup, device_id: &str) -> Result<(), String> {
    let key = object_key(remote, device_id, "probe.txt");
    let body = format!("task-master connection test at {}", utc_date(now_ms()));
    put(remote, &key, body.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_keys_group_by_prefix_and_device() {
        let mut remote = RemoteBackup {
            prefix: "task-master".into(),
            ..RemoteBackup::default()
        };
        assert_eq!(
            object_key(&remote, "dev1", "daily-2026-11-04.sqlite"),
            "task-master/dev1/daily-2026-11-04.sqlite"
        );
        remote.prefix.clear();
        assert_eq!(object_key(&remote, "dev1", "x"), "dev1/x");
    }

    #[test]
    fn a_failed_upload_is_reported_not_fatal() {
        let remote = RemoteBackup {
            enabled: true,
            // Refused before any network access, so the test is fast and offline.
            endpoint: "ftp://s3.example.org".into(),
            bucket: "tm".into(),
            region: "garage".into(),
            access_key: "k".into(),
            secret_key: "s".into(),
            prefix: String::new(),
        };
        let dir = std::env::temp_dir().join(format!("tm-up-{}", taskmaster_core::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("daily-2026-11-04.sqlite");
        std::fs::write(&file, b"x").unwrap();
        let mut status = BackupStatus::default();
        upload(&remote, "dev1", &file, &mut status, false);
        assert!(
            status
                .remote_error
                .as_deref()
                .unwrap()
                .contains("bad bucket settings")
        );
        assert!(status.last_remote.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
