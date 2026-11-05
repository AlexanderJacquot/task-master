//! Nightly backups: a daily SQLite copy in `<data>/backups` (keep `TM_BACKUP_KEEP_DAYS`),
//! uploaded with the attachment content to an S3-compatible bucket when one is set. Best
//! effort, like the desktop's remote backup: a failed upload is retried next hour.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use taskmaster_core::{now_ms, utc_date};

use crate::AppState;
use crate::config::S3Backup;

/// How often the backup thread wakes up.
const CYCLE: Duration = Duration::from_secs(60 * 60);
/// Local record of what is already in the bucket, one object key per line.
const UPLOADED: &str = "uploaded.txt";

fn put(remote: &S3Backup, key: &str, body: &[u8]) -> Result<(), String> {
    let endpoint = remote.endpoint.parse::<url::Url>().map_err(|e| {
        format!(
            "TM_BACKUP_S3_ENDPOINT '{}' is not a URL: {e}",
            remote.endpoint
        )
    })?;
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
        .timeout_global(Some(Duration::from_secs(300)))
        .build()
        .into();
    agent
        .put(url.as_str())
        .header("content-type", "application/octet-stream")
        .send(body)
        .map(|_| ())
        .map_err(|e| format!("upload of {key} failed: {e}"))
}

fn key(remote: &S3Backup, name: &str) -> String {
    if remote.prefix.is_empty() {
        name.to_owned()
    } else {
        format!("{}/{name}", remote.prefix)
    }
}

/// One backup cycle: today's local copy, then any upload not done yet. Returns what was
/// uploaded (object keys).
pub fn cycle(state: &AppState) -> Result<Vec<String>, String> {
    let dir = state.backup_dir();
    let keep = state.config.backup_keep_days;
    let today = utc_date(now_ms());
    {
        let store = state.store();
        store
            .daily_backup(&dir, &today, keep)
            .map_err(|e| format!("daily backup failed: {e}"))?;
    }
    let Some(remote) = &state.config.backup else {
        return Ok(Vec::new());
    };
    let record = dir.join(UPLOADED);
    let done: HashSet<String> = std::fs::read_to_string(&record)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect();

    let mut todo: Vec<(String, PathBuf)> = Vec::new();
    if let Some(newest) = newest_daily(&dir) {
        let name = newest
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        todo.push((key(remote, &format!("server/{name}")), newest));
    }
    let files = {
        let store = state.store();
        let files = store.files().map_err(|e| e.to_string())?;
        files
            .hashes()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter_map(|h| files.path(&h).ok().map(|p| (h, p)))
            .collect::<Vec<_>>()
    };
    for (hash, path) in files {
        todo.push((key(remote, &format!("attachments/{hash}")), path));
    }

    let mut uploaded = Vec::new();
    for (object, path) in todo.into_iter().filter(|(k, _)| !done.contains(k)) {
        let body =
            std::fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        put(remote, &object, &body)?;
        record_upload(&record, &object)?;
        uploaded.push(object);
    }
    Ok(uploaded)
}

fn record_upload(record: &Path, object: &str) -> Result<(), String> {
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(record)
        .map_err(|e| format!("cannot write {}: {e}", record.display()))?;
    writeln!(f, "{object}").map_err(|e| e.to_string())
}

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

/// Runs [`cycle`] at start and every hour on its own thread.
pub fn spawn(state: Arc<AppState>) {
    std::thread::spawn(move || {
        loop {
            match cycle(&state) {
                Ok(uploaded) if !uploaded.is_empty() => {
                    eprintln!("backup: uploaded {}", uploaded.join(", "));
                }
                Ok(_) => {}
                Err(e) => eprintln!("backup: {e}"),
            }
            std::thread::sleep(CYCLE);
        }
    });
}
