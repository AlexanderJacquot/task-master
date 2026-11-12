//! Attachment content: a content-addressed folder (ADR 011).
//!
//! Each file is stored once as `<dir>/<sha256 hex>`, whatever its name or how many tasks
//! use it. Files never change once written, so copying the folder to a backup only needs
//! the names it lacks. Rows in `attachments` (written through commands) name the files;
//! deleting a row leaves the file, so undo always finds it again. Only a purge (Settings →
//! Files, ADR 023) removes content: it leaves a marker in `.purged/` (on a device: "tell
//! the server"; on the server: a tombstone telling the other devices to drop their copy).

use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::clock::new_id;
use crate::error::{Error, Result};

/// Largest file that can be attached: 50 MiB.
pub const MAX_ATTACHMENT_BYTES: i64 = 50 * 1024 * 1024;

/// What [`FileStore::put_bytes`] and [`FileStore::put_file`] stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct StoredFile {
    pub hash: String,
    pub size: i64,
}

/// One file in the store, for Settings → Files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct FileEntry {
    pub hash: String,
    pub size: i64,
    /// When it was written here (Unix ms; 0 when the system does not say).
    pub stored_at: i64,
}

/// Marker folder of purged content, inside the store folder.
const PURGED_DIR: &str = ".purged";

/// The folder holding attachment content.
#[derive(Debug, Clone)]
pub struct FileStore {
    dir: PathBuf,
}

/// `true` for a lowercase hex SHA-256, the only names the store reads or writes.
pub fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::with_capacity(64), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

fn too_large(size: u64) -> Error {
    Error::invalid(format!(
        "the file is {:.1} MB; attachments are limited to {} MB",
        size as f64 / 1_048_576.0,
        MAX_ATTACHMENT_BYTES / 1_048_576
    ))
}

impl FileStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Where the file with `hash` is (or would be) stored.
    pub fn path(&self, hash: &str) -> Result<PathBuf> {
        if !is_hash(hash) {
            return Err(Error::invalid(format!("'{hash}' is not a file hash")));
        }
        Ok(self.dir.join(hash))
    }

    pub fn contains(&self, hash: &str) -> bool {
        self.path(hash).is_ok_and(|p| p.is_file())
    }

    /// Stores `bytes`, returning its hash. Storing the same content again is a no-op.
    pub fn put_bytes(&self, bytes: &[u8]) -> Result<StoredFile> {
        self.put_reader(bytes)
    }

    /// Copies the file at `source` into the store (streamed, never fully in memory).
    pub fn put_file(&self, source: impl AsRef<Path>) -> Result<StoredFile> {
        let source = source.as_ref();
        let meta = std::fs::metadata(source)?;
        if !meta.is_file() {
            return Err(Error::invalid(format!(
                "{} is not a file",
                source.display()
            )));
        }
        if meta.len() > MAX_ATTACHMENT_BYTES as u64 {
            return Err(too_large(meta.len()));
        }
        self.put_reader(File::open(source)?)
    }

    /// Hashes while writing to a temporary file, then renames it to its hash.
    fn put_reader(&self, mut reader: impl Read) -> Result<StoredFile> {
        std::fs::create_dir_all(&self.dir)?;
        let tmp = self.dir.join(format!(".incoming-{}", new_id()));
        let result = (|| {
            let mut out = File::create(&tmp)?;
            let mut hasher = Sha256::new();
            let mut size: u64 = 0;
            let mut buf = vec![0; 64 * 1024];
            loop {
                let n = reader.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                size += n as u64;
                if size > MAX_ATTACHMENT_BYTES as u64 {
                    return Err(too_large(size));
                }
                hasher.update(&buf[..n]);
                out.write_all(&buf[..n])?;
            }
            out.sync_all()?;
            let hash = hex(&hasher.finalize());
            let target = self.dir.join(&hash);
            if target.is_file() {
                std::fs::remove_file(&tmp)?;
            } else {
                std::fs::rename(&tmp, &target)?;
            }
            // The content is back (attached again): it is no longer purged.
            self.unmark_purged(&hash)?;
            Ok(StoredFile {
                hash,
                size: size as i64,
            })
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result
    }

    /// Hashes of every stored file.
    pub fn hashes(&self) -> Result<Vec<String>> {
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut out: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .filter_map(|e| e.file_name().to_str().map(str::to_owned))
            .filter(|n| is_hash(n))
            .collect();
        out.sort();
        Ok(out)
    }

    /// Every stored file with its size and age.
    pub fn entries(&self) -> Result<Vec<FileEntry>> {
        let mut out = Vec::new();
        for hash in self.hashes()? {
            let Ok(meta) = std::fs::metadata(self.dir.join(&hash)) else {
                continue;
            };
            let stored_at = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
            out.push(FileEntry {
                hash,
                size: i64::try_from(meta.len()).unwrap_or(i64::MAX),
                stored_at,
            });
        }
        Ok(out)
    }

    /// Deletes the content with `hash`. Returns its size, or `None` when it was not here.
    pub fn remove(&self, hash: &str) -> Result<Option<i64>> {
        let path = self.path(hash)?;
        let size = match std::fs::metadata(&path) {
            Ok(meta) => i64::try_from(meta.len()).unwrap_or(i64::MAX),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(Some(size)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Records that the content with `hash` was purged.
    pub fn mark_purged(&self, hash: &str) -> Result<()> {
        self.path(hash)?;
        let dir = self.dir.join(PURGED_DIR);
        std::fs::create_dir_all(&dir)?;
        File::create(dir.join(hash))?;
        Ok(())
    }

    /// Forgets the purge of `hash` (sent to the server, or the content came back).
    pub fn unmark_purged(&self, hash: &str) -> Result<()> {
        self.path(hash)?;
        match std::fs::remove_file(self.dir.join(PURGED_DIR).join(hash)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }

    /// Hashes marked purged.
    pub fn purged(&self) -> Result<Vec<String>> {
        FileStore::new(self.dir.join(PURGED_DIR)).hashes()
    }

    /// Copies the files `target` lacks into it (a backup or export folder). Returns how
    /// many were copied.
    pub fn copy_missing_to(&self, target: impl AsRef<Path>) -> Result<u32> {
        let target = target.as_ref();
        let mut copied = 0;
        for hash in self.hashes()? {
            let dest = target.join(&hash);
            if dest.is_file() {
                continue;
            }
            std::fs::create_dir_all(target)?;
            let tmp = target.join(format!(".incoming-{hash}"));
            std::fs::copy(self.dir.join(&hash), &tmp)?;
            std::fs::rename(&tmp, &dest)?;
            copied += 1;
        }
        Ok(copied)
    }

    /// Takes in the files of another store folder (an export), checking each one's
    /// content against its name. Returns how many were added; a file whose content
    /// does not match its name is refused.
    pub fn import_from(&self, source: impl AsRef<Path>) -> Result<u32> {
        let source = FileStore::new(source.as_ref());
        let mut added = 0;
        for hash in source.hashes()? {
            if self.contains(&hash) {
                continue;
            }
            let stored = self.put_file(source.dir.join(&hash))?;
            if stored.hash != hash {
                let _ = std::fs::remove_file(self.dir.join(&stored.hash));
                return Err(Error::invalid(format!(
                    "attachment {hash} in {} is damaged (its content does not match)",
                    source.dir.display()
                )));
            }
            added += 1;
        }
        Ok(added)
    }
}

/// A file name safe to show and save: no folders, no control characters, not empty.
pub fn clean_file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let name: String = base
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_owned();
    let name: String = name.chars().take(200).collect();
    if name.is_empty() {
        "file".to_owned()
    } else {
        name
    }
}

/// MIME type from a file name's extension (common types only; the rest are binary).
pub fn mime_for(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "7z" => "application/x-7z-compressed",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tm-files-{name}-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn stores_content_once_under_its_hash() {
        let store = FileStore::new(temp_dir("put"));
        let a = store.put_bytes(b"hello").unwrap();
        assert_eq!(
            a.hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(a.size, 5);
        assert_eq!(store.put_bytes(b"hello").unwrap(), a);
        assert_eq!(store.hashes().unwrap(), std::slice::from_ref(&a.hash));
        assert_eq!(
            std::fs::read(store.path(&a.hash).unwrap()).unwrap(),
            b"hello"
        );
    }

    #[test]
    fn put_file_streams_and_checks_the_size() {
        let dir = temp_dir("file");
        let source = dir.join("report.pdf");
        std::fs::write(&source, b"%PDF").unwrap();
        let store = FileStore::new(dir.join("attachments"));
        let stored = store.put_file(&source).unwrap();
        assert!(store.contains(&stored.hash));
        assert!(store.put_file(&dir).is_err(), "a folder is refused");

        let big = dir.join("big.bin");
        let f = File::create(&big).unwrap();
        f.set_len(MAX_ATTACHMENT_BYTES as u64 + 1).unwrap();
        let err = store.put_file(&big).unwrap_err();
        assert!(err.to_string().contains("limited to 50 MB"), "{err}");
    }

    #[test]
    fn path_refuses_anything_but_a_hash() {
        let store = FileStore::new(temp_dir("path"));
        assert!(store.path("../secrets").is_err());
        assert!(store.path(&"A".repeat(64)).is_err());
        assert!(!store.contains("nope"));
    }

    #[test]
    fn copies_missing_files_and_imports_checked_ones() {
        let store = FileStore::new(temp_dir("copy"));
        let a = store.put_bytes(b"a").unwrap();
        let backup = temp_dir("backup");
        assert_eq!(store.copy_missing_to(&backup).unwrap(), 1);
        assert_eq!(store.copy_missing_to(&backup).unwrap(), 0);

        let other = FileStore::new(temp_dir("import"));
        assert_eq!(other.import_from(&backup).unwrap(), 1);
        assert!(other.contains(&a.hash));

        // A file renamed to someone else's hash is refused.
        let bad = temp_dir("bad");
        std::fs::write(bad.join("0".repeat(64)), b"not that").unwrap();
        assert!(other.import_from(&bad).is_err());
        assert!(!other.contains(&"0".repeat(64)));
    }

    #[test]
    fn names_are_cleaned_and_typed() {
        assert_eq!(clean_file_name("C:\\Users\\me\\shot.png"), "shot.png");
        assert_eq!(clean_file_name("../../etc/passwd"), "passwd");
        assert_eq!(clean_file_name("  \u{7}  "), "file");
        assert_eq!(mime_for("Shot.PNG"), "image/png");
        assert_eq!(mime_for("notes"), "application/octet-stream");
    }
}
