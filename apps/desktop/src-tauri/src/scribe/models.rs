//! Speech models (ADR 026): never bundled, downloaded when the user asks (Settings →
//! Scribe), checked against a pinned size and SHA-256, and kept in the app's local data
//! folder (not the data folder, which may be synced by other tools).
//!
//! Downloads resume: the file grows as `<name>.part` and a new attempt asks for the rest
//! with a `Range` request, hashing what is already there first.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

/// A file to fetch: where from, how big, what hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelFile {
    pub name: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// A transcription model the user can pick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WhisperModel {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub file: ModelFile,
}

pub const WHISPER: [WhisperModel; 2] = [
    WhisperModel {
        id: "large-v3-turbo",
        label: "Accurate (large-v3-turbo)",
        description: "Best results in every language. Transcribing takes about a quarter to half \
                      of the meeting's length.",
        file: ModelFile {
            name: "ggml-large-v3-turbo.bin",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
            size: 1_624_555_275,
            sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
        },
    },
    WhisperModel {
        id: "small",
        label: "Fast (small)",
        description: "Three times faster, less accurate, especially with accents and names.",
        file: ModelFile {
            name: "ggml-small.bin",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
            size: 487_601_967,
            sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        },
    },
];

/// Downloaded with the first transcription model: speaker separation (pyannote
/// segmentation 3.0 and a WeSpeaker embedding model, for sherpa-onnx) and voice activity
/// detection (Silero, for whisper.cpp: silence is skipped, not transcribed into
/// hallucinated words).
pub const DIARIZATION: [ModelFile; 3] = [
    ModelFile {
        name: "pyannote-segmentation-3.0.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx",
        size: 5_992_913,
        sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
    },
    ModelFile {
        name: "wespeaker_en_voxceleb_resnet34_LM.onnx",
        url: "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/wespeaker_en_voxceleb_resnet34_LM.onnx",
        size: 26_530_550,
        sha256: "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012",
    },
    ModelFile {
        name: "ggml-silero-v6.2.0.bin",
        url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
        size: 885_098,
        sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
    },
];

/// Index in [`DIARIZATION`] of each support file.
pub const SEGMENTATION: usize = 0;
pub const EMBEDDING: usize = 1;
pub const VAD: usize = 2;

pub fn whisper(id: &str) -> Option<&'static WhisperModel> {
    WHISPER.iter().find(|m| m.id == id)
}

/// A complete file of the right size (its hash was checked when it was downloaded).
pub fn present(dir: &Path, file: &ModelFile) -> bool {
    std::fs::metadata(dir.join(file.name)).is_ok_and(|m| m.is_file() && m.len() == file.size)
}

#[cfg(test)]
pub fn diarization_present(dir: &Path) -> bool {
    DIARIZATION.iter().all(|f| present(dir, f))
}

/// Files still to fetch for a model: its own, and the speaker models when missing.
pub fn missing(dir: &Path, model: &WhisperModel) -> Vec<ModelFile> {
    std::iter::once(&model.file)
        .chain(DIARIZATION.iter())
        .filter(|f| !present(dir, f))
        .cloned()
        .collect()
}

/// A transcription model as Settings shows it.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub description: String,
    /// Download size, with the speaker models when they are not here yet.
    pub download_bytes: u32,
    pub installed: bool,
    pub active: bool,
    /// Bytes downloaded so far while a download runs.
    pub downloading: Option<u32>,
}

/// Why a download stopped.
#[derive(Debug, PartialEq, Eq)]
pub enum FetchError {
    Cancelled,
    Failed(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => write!(f, "the download was stopped"),
            Self::Failed(e) => write!(f, "{e}"),
        }
    }
}

fn failed(e: impl std::fmt::Display) -> FetchError {
    FetchError::Failed(e.to_string())
}

/// Downloads one file into `dir`, resuming a `.part` left by an earlier attempt.
/// `progress` gets the bytes this file has so far.
pub fn fetch(
    dir: &Path,
    url: &str,
    file_name: &str,
    size: u64,
    sha256: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<PathBuf, FetchError> {
    std::fs::create_dir_all(dir).map_err(failed)?;
    let target = dir.join(file_name);
    let part = dir.join(format!("{file_name}.part"));
    let mut hasher = Sha256::new();
    let mut have = 0u64;
    if let Ok(mut existing) = File::open(&part) {
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = existing.read(&mut buf).map_err(failed)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            have += n as u64;
        }
    }
    if have > size {
        // Not this file: start over.
        let _ = std::fs::remove_file(&part);
        hasher = Sha256::new();
        have = 0;
    }
    if have < size {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(15)))
            .timeout_recv_response(Some(Duration::from_secs(60)))
            .http_status_as_error(false)
            .build()
            .into();
        let mut request = agent.get(url).header("user-agent", "task-master");
        if have > 0 {
            request = request.header("range", &format!("bytes={have}-"));
        }
        let response = request
            .call()
            .map_err(|e| failed(format!("cannot download {file_name}: {e}")))?;
        let status = response.status().as_u16();
        let resumed = status == 206;
        if !(status == 200 || resumed) {
            return Err(failed(format!(
                "cannot download {file_name}: the server answered HTTP {status}"
            )));
        }
        if !resumed && have > 0 {
            // The server sent the whole file again.
            hasher = Sha256::new();
            have = 0;
        }
        let mut out = OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&part)
            .map_err(failed)?;
        let mut body = response.into_body().into_reader();
        let mut buf = vec![0u8; 256 * 1024];
        let mut last_report = 0u64;
        loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = out.flush();
                return Err(FetchError::Cancelled);
            }
            let n = body
                .read(&mut buf)
                .map_err(|e| failed(format!("the download of {file_name} broke off: {e}")))?;
            if n == 0 {
                break;
            }
            if have + n as u64 > size {
                let _ = std::fs::remove_file(&part);
                return Err(failed(format!(
                    "{file_name} is larger than expected; the download was discarded"
                )));
            }
            out.write_all(&buf[..n]).map_err(failed)?;
            hasher.update(&buf[..n]);
            have += n as u64;
            if have - last_report >= 4 * 1024 * 1024 || have == size {
                last_report = have;
                progress(have);
            }
        }
        out.sync_all().map_err(failed)?;
    }
    if have != size {
        return Err(failed(format!(
            "the download of {file_name} ended early ({have} of {size} bytes); try again to resume"
        )));
    }
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    if hex != sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(failed(format!(
            "{file_name} does not match its checksum; the download was discarded"
        )));
    }
    std::fs::rename(&part, &target).map_err(failed)?;
    progress(size);
    Ok(target)
}

/// Bytes of the `.part` files of these files (a paused download).
pub fn partial_bytes(dir: &Path, files: &[ModelFile]) -> u64 {
    files
        .iter()
        .filter_map(|f| std::fs::metadata(dir.join(format!("{}.part", f.name))).ok())
        .map(|m| m.len())
        .sum()
}

/// Removes a model's file (and its partial download). The speaker models stay while
/// another transcription model is installed.
pub fn remove(dir: &Path, model: &WhisperModel) -> std::io::Result<()> {
    for name in [
        model.file.name.to_owned(),
        format!("{}.part", model.file.name),
    ] {
        let path = dir.join(name);
        if path.exists() {
            std::fs::remove_file(path)?;
        }
    }
    let others = WHISPER
        .iter()
        .any(|m| m.id != model.id && present(dir, &m.file));
    if !others {
        for f in &DIARIZATION {
            for name in [f.name.to_owned(), format!("{}.part", f.name)] {
                let path = dir.join(name);
                if path.exists() {
                    std::fs::remove_file(path)?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// Serves `body` (honouring `Range: bytes=N-`) to `requests` connections, cutting the
    /// first answer after `cut` bytes when set. Returns the URL and the ranges asked for.
    fn serve(
        body: Vec<u8>,
        requests: usize,
        cut: Option<usize>,
    ) -> (String, std::sync::mpsc::Receiver<Option<u64>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/model.bin", listener.local_addr().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for (i, stream) in listener.incoming().take(requests).enumerate() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut from = None;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line.trim().is_empty() {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        from = v.trim().trim_end_matches('-').parse::<u64>().ok();
                    }
                }
                let _ = tx.send(from);
                let start = from.unwrap_or(0) as usize;
                let rest = &body[start..];
                let head = if from.is_some() {
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{}/{}\r\nConnection: close\r\n\r\n",
                        rest.len(),
                        body.len() - 1,
                        body.len()
                    )
                } else {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        rest.len()
                    )
                };
                stream.write_all(head.as_bytes()).unwrap();
                let send = match (i, cut) {
                    (0, Some(n)) => &rest[..n],
                    _ => rest,
                };
                let _ = stream.write_all(send);
            }
        });
        (url, rx)
    }

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tm-models-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn blob() -> Vec<u8> {
        (0..600_000u32).map(|i| (i * 7 % 251) as u8).collect()
    }

    #[test]
    fn a_download_is_checked_and_put_in_place() {
        let body = blob();
        let (url, ranges) = serve(body.clone(), 1, None);
        let d = dir("full");
        let stop = AtomicBool::new(false);
        let mut seen = Vec::new();
        let path = fetch(
            &d,
            &url,
            "m.bin",
            body.len() as u64,
            &sha(&body),
            &stop,
            |n| seen.push(n),
        )
        .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), body);
        assert_eq!(seen.last(), Some(&(body.len() as u64)));
        assert_eq!(ranges.recv().unwrap(), None);
        assert!(!d.join("m.bin.part").exists());
    }

    #[test]
    fn a_broken_download_resumes_where_it_stopped() {
        let body = blob();
        let (url, ranges) = serve(body.clone(), 2, Some(250_000));
        let d = dir("resume");
        let stop = AtomicBool::new(false);
        let first = fetch(
            &d,
            &url,
            "m.bin",
            body.len() as u64,
            &sha(&body),
            &stop,
            |_| {},
        );
        assert!(
            matches!(first, Err(FetchError::Failed(ref e)) if e.contains("ended early") || e.contains("broke off")),
            "{first:?}"
        );
        let kept = std::fs::metadata(d.join("m.bin.part")).unwrap().len();
        assert_eq!(kept, 250_000);
        assert_eq!(
            partial_bytes(
                &d,
                &[ModelFile {
                    name: "m.bin",
                    url: "",
                    size: 0,
                    sha256: ""
                }]
            ),
            250_000
        );
        let path = fetch(
            &d,
            &url,
            "m.bin",
            body.len() as u64,
            &sha(&body),
            &stop,
            |_| {},
        )
        .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), body);
        assert_eq!(ranges.recv().unwrap(), None);
        assert_eq!(ranges.recv().unwrap(), Some(250_000));
    }

    #[test]
    fn a_wrong_checksum_discards_the_file() {
        let body = blob();
        let (url, _) = serve(body.clone(), 1, None);
        let d = dir("bad");
        let stop = AtomicBool::new(false);
        let err = fetch(
            &d,
            &url,
            "m.bin",
            body.len() as u64,
            &sha(b"other"),
            &stop,
            |_| {},
        )
        .unwrap_err();
        assert!(err.to_string().contains("checksum"));
        assert!(!d.join("m.bin").exists());
        assert!(!d.join("m.bin.part").exists());
    }

    #[test]
    fn a_stopped_download_keeps_its_part() {
        let body = blob();
        let (url, _) = serve(body.clone(), 1, None);
        let d = dir("stop");
        let stop = AtomicBool::new(true);
        let err = fetch(
            &d,
            &url,
            "m.bin",
            body.len() as u64,
            &sha(&body),
            &stop,
            |_| {},
        )
        .unwrap_err();
        assert_eq!(err, FetchError::Cancelled);
        assert!(d.join("m.bin.part").exists());
    }

    #[test]
    fn removing_the_last_model_takes_the_speaker_models_too() {
        let d = dir("remove");
        std::fs::create_dir_all(&d).unwrap();
        let small = whisper("small").unwrap();
        let turbo = whisper("large-v3-turbo").unwrap();
        // Fake installs: files of the pinned sizes (sparse via set_len).
        for f in [&small.file, &turbo.file]
            .into_iter()
            .chain(DIARIZATION.iter())
        {
            File::create(d.join(f.name))
                .unwrap()
                .set_len(f.size)
                .unwrap();
        }
        assert!(missing(&d, small).is_empty());
        remove(&d, small).unwrap();
        assert!(!present(&d, &small.file));
        assert!(diarization_present(&d));
        remove(&d, turbo).unwrap();
        assert!(!diarization_present(&d));
        assert_eq!(missing(&d, turbo).len(), 4);
    }

    /// Checks the pinned URLs, sizes and hashes of the support files against the real
    /// servers: `TM_SCRIBE_MODELS=<dir> cargo test -p taskmaster-desktop -- --ignored
    /// real_support_models`.
    #[test]
    #[ignore = "downloads about 33 MB"]
    fn real_support_models_download_and_verify() {
        let dir = PathBuf::from(std::env::var("TM_SCRIBE_MODELS").expect("TM_SCRIBE_MODELS"));
        let stop = AtomicBool::new(false);
        for f in &DIARIZATION {
            fetch(&dir, f.url, f.name, f.size, f.sha256, &stop, |_| {}).unwrap();
            assert!(present(&dir, f));
        }
    }
}
