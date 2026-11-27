//! A meeting's transcription (M20): words of each track, then speakers of the computer's
//! sound, then the merge. Each finished step is kept in `scribe/<meeting>/transcript/`,
//! so a run cut short (quit, crash, cancel) resumes from the step it was in.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::engine::{self, Models};
use super::merge::{self, Segment, Turn, Word};
use super::{files, opus, wav};

pub const DIR: &str = "transcript";

/// Where a run is, for the progress bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    /// Your microphone.
    Mic,
    /// The computer's sound.
    System,
    Speakers,
    Merge,
}

/// The samples of a track, from its Opus file once encoded or its WAV before.
pub fn load_track(dir: &Path, track: &str) -> Result<Option<Vec<f32>>, String> {
    let Some((path, mime)) = files::track_file(dir, track) else {
        return Ok(None);
    };
    let samples = if mime == "audio/ogg" {
        opus::decode(&path)
    } else {
        wav::WavReader::open(&path).and_then(wav::WavReader::read_all)
    }
    .map_err(|e| format!("cannot read the {track} recording: {e}"))?;
    Ok(Some(engine::to_f32(&samples)))
}

fn cache<T: Serialize + DeserializeOwned>(
    path: &Path,
    compute: impl FnOnce() -> Result<T, String>,
    kept: impl FnOnce(),
) -> Result<T, String> {
    if let Ok(text) = std::fs::read_to_string(path)
        && let Ok(value) = serde_json::from_str(&text)
    {
        kept();
        return Ok(value);
    }
    let value = compute()?;
    let tmp = path.with_extension("tmp");
    let text = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text)
        .and_then(|()| std::fs::rename(&tmp, path))
        .map_err(|e| format!("cannot save the transcription step: {e}"))?;
    Ok(value)
}

/// Runs (or resumes) the transcription of the recording in `dir`. `progress` gets the
/// step and the overall fraction done; `log` a line per stage with how long it took
/// (`scribe.log`).
pub fn run(
    dir: &Path,
    models: &Models<'_>,
    language: Option<&str>,
    cancel: &Arc<AtomicBool>,
    progress: impl Fn(Step, f32) + Clone + Send + 'static,
    log: &dyn Fn(String),
) -> Result<Vec<Segment>, String> {
    let out: PathBuf = dir.join(DIR);
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let has_system = files::track_file(dir, "system").is_some();
    // Shares of the bar: the system track also gets speaker separation.
    let (mic_share, system_share, speakers_share) = if has_system {
        (0.42, 0.42, 0.12)
    } else {
        (0.96, 0.0, 0.0)
    };
    let stopped = || cancel.load(std::sync::atomic::Ordering::Relaxed);
    let load = |track: &str| {
        let started = std::time::Instant::now();
        let samples = load_track(dir, track)?.unwrap_or_default();
        log(format!(
            "{track}: {:.0} s of audio read in {:.1} s",
            samples.len() as f64 / 16_000.0,
            started.elapsed().as_secs_f64()
        ));
        Ok::<_, String>(samples)
    };
    let words_of = |track: &str, step: Step, from: f32, share: f32| {
        let samples = load(track)?;
        let report = progress.clone();
        report(step, from);
        engine::words(
            models,
            &samples,
            language,
            move |pct| report(step, from + share * pct.clamp(0, 100) as f32 / 100.0),
            cancel.clone(),
            &|line| log(format!("{track}: {line}")),
        )
    };
    let resumed = |what: &str| log(format!("{what}: kept from the run before"));

    let mic: Vec<Word> = cache(
        &out.join("mic.words.json"),
        || words_of("mic", Step::Mic, 0.0, mic_share),
        || resumed("mic"),
    )?;
    if stopped() {
        return Err("stopped".into());
    }
    let (system, turns): (Vec<Word>, Vec<Turn>) = if has_system {
        let system: Vec<Word> = cache(
            &out.join("system.words.json"),
            || words_of("system", Step::System, mic_share, system_share),
            || resumed("system"),
        )?;
        if stopped() {
            return Err("stopped".into());
        }
        let turns: Vec<Turn> = cache(
            &out.join("system.turns.json"),
            || {
                progress(Step::Speakers, mic_share + system_share);
                if system.is_empty() {
                    return Ok(Vec::new());
                }
                let samples = load("system")?;
                engine::turns(models, &samples, &|line| log(format!("speakers: {line}")))
            },
            || resumed("speakers"),
        )?;
        (system, turns)
    } else {
        (Vec::new(), Vec::new())
    };
    progress(Step::Merge, mic_share + system_share + speakers_share);
    Ok(merge::merge(&mic, &system, &turns))
}

/// Drops the saved steps (a new run with another model starts over).
pub fn clear(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir.join(DIR));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scribe::models;

    /// The whole pipeline on real speech, with real models; also a benchmark (each stage's
    /// time and speed is printed, as in `scribe.log`):
    /// `TM_SCRIBE_MODELS=<dir with ggml-tiny.bin and the support files>
    ///  TM_SCRIBE_MIC=<16 kHz mono wav> TM_SCRIBE_SYSTEM=<16 kHz mono wav>
    ///  cargo test -p taskmaster-desktop --release -- --ignored --nocapture real_models`.
    /// `TM_SCRIBE_WHISPER=ggml-large-v3-turbo.bin` picks another model in that folder,
    /// `TM_SCRIBE_THREADS` the thread count.
    #[test]
    #[ignore = "needs models and recordings on disk"]
    fn real_models_transcribe_a_recording() {
        let models_dir = PathBuf::from(std::env::var("TM_SCRIBE_MODELS").unwrap());
        let read = |var: &str| {
            let path = PathBuf::from(std::env::var(var).unwrap());
            wav::WavReader::open(&path).unwrap().read_all().unwrap()
        };
        let dir = std::env::temp_dir().join(format!("tm-pipeline-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // The microphone as WAV (before compression), the computer's sound as Opus.
        let mut mic = wav::WavWriter::create(&dir.join(super::super::MIC_WAV)).unwrap();
        mic.write(&read("TM_SCRIBE_MIC")).unwrap();
        mic.finish().unwrap();
        let system_wav = dir.join("system-source.wav");
        let mut system = wav::WavWriter::create(&system_wav).unwrap();
        system.write(&read("TM_SCRIBE_SYSTEM")).unwrap();
        system.finish().unwrap();
        opus::encode_wav(&system_wav, &dir.join(files::SYSTEM_OPUS), |_| {}).unwrap();
        std::fs::remove_file(&system_wav).unwrap();

        let support = |i: usize| models_dir.join(models::DIARIZATION[i].name);
        let whisper = models_dir
            .join(std::env::var("TM_SCRIBE_WHISPER").unwrap_or_else(|_| "ggml-tiny.bin".into()));
        let (vad, seg, emb) = (
            support(models::VAD),
            support(models::SEGMENTATION),
            support(models::EMBEDDING),
        );
        let paths = Models {
            whisper: &whisper,
            vad: &vad,
            segmentation: &seg,
            embedding: &emb,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let steps = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = steps.clone();
        let started = std::time::Instant::now();
        let segments = run(
            &dir,
            &paths,
            None,
            &cancel,
            move |step, f| {
                seen.lock().unwrap().push((step, f));
            },
            &|line| eprintln!("{:>6.1} s  {line}", started.elapsed().as_secs_f64()),
        )
        .unwrap();
        eprintln!("transcribed in {:?}", started.elapsed());
        for s in &segments {
            eprintln!(
                "[{:>6} – {:>6}] {:>3}: {}",
                s.start_ms, s.end_ms, s.speaker, s.text
            );
        }
        assert!(segments.iter().any(|s| s.speaker == "me"));
        assert!(segments.iter().any(|s| s.speaker.starts_with('s')));
        let steps = steps.lock().unwrap();
        eprintln!("{} progress updates", steps.len());
        assert!(steps.iter().any(|(s, _)| *s == Step::Speakers));
        assert!(steps.windows(2).all(|w| w[1].1 >= w[0].1 - 1e-6));
        // A second run reads the saved steps and gives the same transcript at once.
        let again = run(&dir, &paths, None, &cancel, |_, _| {}, &|_| {}).unwrap();
        assert_eq!(again, segments);
    }
}
