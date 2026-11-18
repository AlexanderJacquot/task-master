//! Where a meeting's audio lives on this device (`<data dir>/scribe/<meeting id>/`) and
//! what is known about it (`recording.json`). Audio is never synced (ADR 025).
//!
//! A folder goes: `mic.wav` (+ `system.wav`) while recording → `finished` → encoded to
//! `mic.opus` (+ `system.opus`), the WAV files removed. A folder that is not finished and
//! not being recorded was interrupted (crash, power cut): the user keeps or discards it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use taskmaster_core::{Id, Timestamp};

use super::audio::PER_MS;
use super::{MIC_WAV, SYSTEM_WAV};

pub const META: &str = "recording.json";
pub const MIC_OPUS: &str = "mic.opus";
pub const SYSTEM_OPUS: &str = "system.opus";

/// What `recording.json` holds.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Meta {
    pub meeting_id: Id,
    /// When the first sample was taken, Unix ms.
    pub started_at: Timestamp,
    pub mic: String,
    #[serde(default)]
    pub system: Option<String>,
    /// Recording ended cleanly (or was kept after an interruption).
    #[serde(default)]
    pub finished: bool,
    /// Length of each track, 16 kHz samples (set when finished).
    #[serde(default)]
    pub samples: u64,
    #[serde(default)]
    pub warnings: Vec<String>,
}

impl Meta {
    pub fn duration_ms(&self) -> u64 {
        self.samples / PER_MS
    }
}

/// Meeting ids are UUIDs: anything else never names a folder (no path tricks).
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

pub fn root(data_dir: &Path) -> PathBuf {
    data_dir.join("scribe")
}

pub fn meeting_dir(data_dir: &Path, meeting_id: &str) -> Option<PathBuf> {
    valid_id(meeting_id).then(|| root(data_dir).join(meeting_id))
}

pub fn read_meta(dir: &Path) -> Option<Meta> {
    let text = std::fs::read_to_string(dir.join(META)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Written through a temporary file, so a crash leaves the old or the new one.
pub fn write_meta(dir: &Path, meta: &Meta) -> std::io::Result<()> {
    let tmp = dir.join("recording.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(meta)?)?;
    std::fs::rename(tmp, dir.join(META))
}

/// Every meeting folder with a readable `recording.json`.
pub fn all(data_dir: &Path) -> Vec<(PathBuf, Meta)> {
    let Ok(entries) = std::fs::read_dir(root(data_dir)) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter_map(|p| read_meta(&p).map(|m| (p, m)))
        .collect()
}

/// Total size of the files in a folder.
pub fn size(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter_map(|e| e.metadata().ok())
                .filter(|m| m.is_file())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0)
}

/// The file to play for a track: the Opus file once encoded, else the WAV.
pub fn track_file(dir: &Path, track: &str) -> Option<(PathBuf, &'static str)> {
    let (opus, wav) = match track {
        "mic" => (MIC_OPUS, MIC_WAV),
        "system" => (SYSTEM_OPUS, SYSTEM_WAV),
        _ => return None,
    };
    let opus = dir.join(opus);
    if opus.is_file() {
        return Some((opus, "audio/ogg"));
    }
    let wav = dir.join(wav);
    wav.is_file().then_some((wav, "audio/wav"))
}

/// Tracks that still have to be encoded (WAV without its Opus file).
pub fn unencoded(dir: &Path) -> Vec<(PathBuf, PathBuf)> {
    [(MIC_WAV, MIC_OPUS), (SYSTEM_WAV, SYSTEM_OPUS)]
        .into_iter()
        .map(|(w, o)| (dir.join(w), dir.join(o)))
        .filter(|(w, _)| w.is_file())
        .collect()
}

/// A byte range from a `Range: bytes=a-b` header, clamped to `len`. `None` for a missing
/// or unusable header (the whole file is sent).
pub fn byte_range(header: Option<&str>, len: u64) -> Option<(u64, u64)> {
    let spec = header?.trim().strip_prefix("bytes=")?;
    // One range only; players ask for one.
    let spec = spec.split(',').next()?.trim();
    let (start, end) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = match (start.trim(), end.trim()) {
        ("", "") => return None,
        // The last N bytes.
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (len.saturating_sub(n), len - 1)
        }
        (s, "") => (s.parse().ok()?, len - 1),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(len - 1)),
    };
    (start <= end && start < len).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_uuid_like_ids_name_a_folder() {
        let data = Path::new("/data");
        assert!(meeting_dir(data, "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b").is_some());
        assert!(meeting_dir(data, "../etc").is_none());
        assert!(meeting_dir(data, "a/b").is_none());
        assert!(meeting_dir(data, "").is_none());
    }

    #[test]
    fn ranges_follow_the_header() {
        assert_eq!(byte_range(Some("bytes=0-99"), 1000), Some((0, 99)));
        assert_eq!(byte_range(Some("bytes=500-"), 1000), Some((500, 999)));
        assert_eq!(byte_range(Some("bytes=-100"), 1000), Some((900, 999)));
        assert_eq!(byte_range(Some("bytes=900-5000"), 1000), Some((900, 999)));
        assert_eq!(byte_range(Some("bytes=1000-"), 1000), None);
        assert_eq!(byte_range(Some("bytes=5-2"), 1000), None);
        assert_eq!(byte_range(Some("items=0-1"), 1000), None);
        assert_eq!(byte_range(None, 1000), None);
        assert_eq!(byte_range(Some("bytes=0-"), 0), None);
    }

    #[test]
    fn meta_round_trips_and_lists() {
        let data = std::env::temp_dir().join(format!("tm-files-{}", std::process::id()));
        let id = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
        let dir = meeting_dir(&data, id).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let meta = Meta {
            meeting_id: id.into(),
            started_at: 1_700_000_000_000,
            mic: "Built-in".into(),
            samples: 32_000,
            ..Meta::default()
        };
        write_meta(&dir, &meta).unwrap();
        std::fs::write(dir.join(MIC_WAV), [0u8; 44]).unwrap();
        assert_eq!(read_meta(&dir), Some(meta.clone()));
        assert_eq!(meta.duration_ms(), 2_000);
        assert_eq!(all(&data).len(), 1);
        assert_eq!(track_file(&dir, "mic").unwrap().1, "audio/wav");
        assert!(track_file(&dir, "system").is_none());
        assert!(track_file(&dir, "../x").is_none());
        assert_eq!(unencoded(&dir).len(), 1);
        std::fs::write(dir.join(MIC_OPUS), b"x").unwrap();
        assert_eq!(track_file(&dir, "mic").unwrap().1, "audio/ogg");
        assert!(size(&dir) > 44);
        let _ = std::fs::remove_dir_all(&data);
    }
}
