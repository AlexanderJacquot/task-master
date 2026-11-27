//! The speech engines (ADR 026): whisper.cpp for words (with Silero voice detection, so
//! silence is skipped) and sherpa-onnx for who spoke when. Both take 16 kHz mono samples.
//!
//! They are built on Windows and macOS, where recording works, and in tests everywhere
//! (Linux has them as dev-dependencies), so a Linux release stays without them.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use super::merge::{Turn, Word};

/// What a step needs to run the engines.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub struct Models<'a> {
    pub whisper: &'a Path,
    pub vad: &'a Path,
    pub segmentation: &'a Path,
    pub embedding: &'a Path,
}

/// Threads for the engines: about one per physical core (half the logical ones), at most
/// 8. ggml's threads wait for each other at every step, so a second thread on a
/// hyper-threaded core, or one competing with the app, slows the whole run down.
/// `TM_SCRIBE_THREADS` overrides it, to measure (the count is in `scribe.log`).
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub fn threads() -> i32 {
    let logical = std::thread::available_parallelism().map_or(4, |n| n.get());
    threads_for(logical, std::env::var("TM_SCRIBE_THREADS").ok().as_deref())
}

#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
fn threads_for(logical: usize, overridden: Option<&str>) -> i32 {
    if let Some(n) = overridden.and_then(|v| v.trim().parse::<i32>().ok())
        && n > 0
    {
        return n.min(64);
    }
    (logical / 2).clamp(1, 8) as i32
}

/// What the engines were built with (CPU features, Metal), for `scribe.log`.
#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub fn system_info() -> String {
    whisper_rs::print_system_info().trim().to_owned()
}

#[cfg(not(any(target_os = "windows", target_os = "macos", test)))]
pub fn system_info() -> String {
    String::new()
}

/// Seconds, from samples at 16 kHz.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
fn secs(samples: usize) -> f64 {
    samples as f64 / 16_000.0
}

/// How many seconds of audio a second of work got through.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
fn speed(audio_s: f64, started: Instant) -> String {
    let took = started.elapsed().as_secs_f64();
    format!("{took:.1} s ({:.2}× real time)", audio_s / took.max(1e-3))
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
mod native {
    use super::*;
    use std::sync::atomic::Ordering;
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    pub const AVAILABLE: bool = true;

    fn path_str(p: &Path) -> Result<&str, String> {
        p.to_str()
            .ok_or_else(|| format!("the model path is not valid text: {}", p.display()))
    }

    /// Words with their times. `language` is a code (`en`, `fr`) or `None` to detect it.
    /// `progress` gets 0 to 100, after each 30 s window whisper decodes. Long tracks go in
    /// chunks cut at quiet moments, and `cancel` is checked between them (whisper-rs 0.16's
    /// abort callback calls its closure through the wrong type, so it is not used). `log`
    /// gets a line per stage with how long it took.
    pub fn words(
        models: &Models<'_>,
        samples: &[f32],
        language: Option<&str>,
        progress: impl FnMut(i32) + 'static,
        cancel: Arc<AtomicBool>,
        log: &dyn Fn(String),
    ) -> Result<Vec<Word>, String> {
        if samples.is_empty() {
            return Ok(Vec::new());
        }
        let progress = std::rc::Rc::new(std::cell::RefCell::new(progress));
        let report = |pct: i32| (progress.borrow_mut())(pct);
        let all = Instant::now();
        let started = Instant::now();
        let ctx = WhisperContext::new_with_params(
            path_str(models.whisper)?,
            WhisperContextParameters::default(),
        )
        .map_err(|e| format!("cannot load the transcription model: {e}"))?;
        let mut state = ctx
            .create_state()
            .map_err(|e| format!("cannot start transcription: {e}"))?;
        log(format!(
            "model loaded in {:.1} s, {} threads",
            started.elapsed().as_secs_f64(),
            threads()
        ));
        // Silence is left out before transcribing (whisper invents words in long silences),
        // and each word's time is mapped back to the track. whisper.cpp's own VAD option
        // only applies in `whisper_full`, not the `whisper_full_with_state` whisper-rs calls,
        // so it is done here.
        let started = Instant::now();
        let spans = speech(models, samples)?;
        if spans.is_empty() {
            log(format!(
                "voice detection: no speech, {}",
                speed(secs(samples.len()), started)
            ));
            report(100);
            return Ok(Vec::new());
        }
        let (speech, pieces) = condense(samples, &spans);
        // The speech itself, without the short silences put between its stretches.
        let spoken: usize = pieces.iter().map(|p| p.len).sum();
        log(format!(
            "voice detection: {:.0} s of speech in {:.0} s, {}",
            secs(spoken),
            secs(samples.len()),
            speed(secs(samples.len()), started)
        ));
        let cuts = chunks(&speech);
        let n = cuts.len() as i32;
        let mut out = Vec::new();
        for (i, (from, to)) in cuts.into_iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err("stopped".into());
            }
            let base = i as i32 * 100 / n;
            report(base);
            let started = Instant::now();
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 5 });
            params.set_language(Some(language.unwrap_or("auto")));
            params.set_n_threads(threads());
            // One segment per word, with its time.
            params.set_token_timestamps(true);
            params.set_max_len(1);
            params.set_split_on_word(true);
            params.set_suppress_blank(true);
            params.set_print_special(false);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);
            // whisper reports after each 30 s window: the bar moves within a chunk too.
            let live = progress.clone();
            params.set_progress_callback_safe(move |pct: i32| {
                (live.borrow_mut())(base + pct.clamp(0, 100) / n);
            });
            state
                .full(params, &speech[from..to])
                .map_err(|e| format!("transcription failed: {e}"))?;
            log(format!(
                "chunk {}/{n}: {:.0} s of speech in {}",
                i + 1,
                secs(to - from),
                speed(secs(to - from), started)
            ));
            for segment in state.as_iter() {
                let text = segment
                    .to_str_lossy()
                    .map(|t| t.into_owned())
                    .unwrap_or_default();
                let trimmed = text.trim();
                // Non-speech markers ("[BLANK_AUDIO]", "(music)") are not words.
                if trimmed.is_empty()
                    || (trimmed.starts_with('[') && trimmed.ends_with(']'))
                    || (trimmed.starts_with('(') && trimmed.ends_with(')'))
                {
                    continue;
                }
                // Centiseconds from the chunk's start, to samples of the speech, to the track.
                let at = |cs: i64| from + (cs.max(0) as usize) * 160;
                let (start, end) = word_on_track(
                    &pieces,
                    at(segment.start_timestamp()),
                    at(segment.end_timestamp()),
                );
                out.push(Word {
                    start_ms: (start as i64) * 1000 / 16_000,
                    end_ms: (end as i64) * 1000 / 16_000,
                    text,
                });
            }
        }
        log(format!(
            "{} words; {:.0} s of audio in {}",
            out.len(),
            secs(samples.len()),
            speed(secs(samples.len()), all)
        ));
        report(100);
        Ok(out)
    }

    /// Where someone speaks on a track (Silero), as sample ranges.
    fn speech(models: &Models<'_>, samples: &[f32]) -> Result<Vec<(usize, usize)>, String> {
        use whisper_rs::{WhisperVadContext, WhisperVadContextParams, WhisperVadParams};
        let mut context_params = WhisperVadContextParams::default();
        // One thread: Silero is a tiny network run on each 32 ms window, so the threads'
        // wait for each other at every step costs more than the work they share (a
        // 13 min track took 35 s with 7 threads on an Intel Core Ultra 7 165U).
        context_params.set_n_threads(1);
        let mut vad = WhisperVadContext::new(path_str(models.vad)?, context_params)
            .map_err(|e| format!("cannot load the voice detection model: {e}"))?;
        let mut params = WhisperVadParams::new();
        // A little margin around each stretch, so first and last syllables stay in.
        params.set_speech_pad(SPEECH_PAD_MS);
        let segments = vad
            .segments_from_samples(params, samples)
            .map_err(|e| format!("voice detection failed: {e}"))?;
        // Centiseconds to samples.
        let at = |cs: f32| ((f64::from(cs.max(0.0)) * 160.0).round() as usize).min(samples.len());
        Ok(segments
            .map(|s| (at(s.start), at(s.end)))
            .filter(|(a, b)| b > a)
            .collect())
    }

    /// Who spoke when on a track with several voices.
    pub fn turns(
        models: &Models<'_>,
        samples: &[f32],
        log: &dyn Fn(String),
    ) -> Result<Vec<Turn>, String> {
        use sherpa_onnx::{
            FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
            OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
            SpeakerEmbeddingExtractorConfig,
        };
        // pyannote needs at least a window (10 s) to say anything.
        if samples.len() < 16_000 {
            return Ok(Vec::new());
        }
        let config = OfflineSpeakerDiarizationConfig {
            segmentation: OfflineSpeakerSegmentationModelConfig {
                pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                    model: Some(path_str(models.segmentation)?.to_owned()),
                    ..Default::default()
                },
                num_threads: threads(),
                ..Default::default()
            },
            embedding: SpeakerEmbeddingExtractorConfig {
                model: Some(path_str(models.embedding)?.to_owned()),
                num_threads: threads(),
                ..Default::default()
            },
            // Lower finds more voices. Two voices found as one cost the user a line-by-line
            // fix; one voice found as two costs one "same voice as" merge, so err low.
            // (0.4 found 3 of 4 voices on sherpa-onnx's four-speaker sample, 0.5 found 2,
            // 0.3 added noise clusters.)
            clustering: FastClusteringConfig {
                num_clusters: -1,
                threshold: 0.4,
                ..Default::default()
            },
            ..Default::default()
        };
        let started = Instant::now();
        let engine =
            OfflineSpeakerDiarization::create(&config).ok_or("cannot load the speaker models")?;
        let result = engine.process(samples).ok_or("speaker separation failed")?;
        let turns: Vec<Turn> = result
            .sort_by_start_time()
            .into_iter()
            .map(|s| Turn {
                start_ms: (f64::from(s.start) * 1000.0) as i64,
                end_ms: (f64::from(s.end) * 1000.0) as i64,
                speaker: s.speaker,
            })
            .collect();
        let mut voices: Vec<i32> = turns.iter().map(|t| t.speaker).collect();
        voices.sort_unstable();
        voices.dedup();
        log(format!(
            "{} voices, {} turns; {:.0} s of audio in {}",
            voices.len(),
            turns.len(),
            secs(samples.len()),
            speed(secs(samples.len()), started)
        ));
        Ok(turns)
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", test)))]
mod native {
    use super::*;

    pub const AVAILABLE: bool = false;
    const NOT_HERE: &str = "transcription works on Windows and macOS; not yet on this system";

    pub fn words(
        _models: &Models<'_>,
        _samples: &[f32],
        _language: Option<&str>,
        _progress: impl FnMut(i32) + 'static,
        _cancel: Arc<AtomicBool>,
        _log: &dyn Fn(String),
    ) -> Result<Vec<Word>, String> {
        Err(NOT_HERE.into())
    }

    pub fn turns(
        _models: &Models<'_>,
        _samples: &[f32],
        _log: &dyn Fn(String),
    ) -> Result<Vec<Turn>, String> {
        Err(NOT_HERE.into())
    }
}

pub use native::{AVAILABLE, turns, words};

/// Padding Silero adds around each stretch of speech.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
const SPEECH_PAD_MS: i32 = 200;
/// Silence put between two stretches of speech (300 ms), so they read as separate
/// sentences.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
const GAP: usize = 4_800;

/// A stretch of speech copied into the condensed audio: `len` samples at `at` there, from
/// `from` on the track.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub struct Piece {
    pub at: usize,
    pub from: usize,
    pub len: usize,
}

/// The stretches of speech (sample ranges, in order) one after the other, with a short
/// silence between them; and where each one came from.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub fn condense(samples: &[f32], spans: &[(usize, usize)]) -> (Vec<f32>, Vec<Piece>) {
    let mut out = Vec::new();
    let mut pieces = Vec::new();
    let mut last_end = 0;
    for &(from, to) in spans {
        // Padded stretches may overlap: never copy a sample twice.
        let from = from.max(last_end).min(samples.len());
        let to = to.min(samples.len());
        if to <= from {
            continue;
        }
        if !pieces.is_empty() {
            out.extend(std::iter::repeat_n(0.0, GAP));
        }
        pieces.push(Piece {
            at: out.len(),
            from,
            len: to - from,
        });
        out.extend_from_slice(&samples[from..to]);
        last_end = to;
    }
    (out, pieces)
}

/// A position in the condensed audio, back on the track. A position in an inserted
/// silence goes to the nearer of the two stretches around it.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub fn to_track(pieces: &[Piece], at: usize) -> usize {
    let i = pieces.partition_point(|p| p.at <= at);
    let Some(piece) = i.checked_sub(1).and_then(|i| pieces.get(i)) else {
        return pieces.first().map_or(at, |p| p.from);
    };
    let into = at - piece.at;
    if into <= piece.len {
        return piece.from + into;
    }
    match pieces.get(i) {
        Some(next) if at - (piece.at + piece.len) > (next.at - (piece.at + piece.len)) / 2 => {
            next.from
        }
        _ => piece.from + piece.len,
    }
}

/// A word's start and end on the track, from its place in the condensed audio. Whisper
/// stretches a word across a pause (the last before it ends where the next one starts, or
/// the first after it starts where the previous one ended): a word over several stretches
/// is kept to the one it overlaps most.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub fn word_on_track(pieces: &[Piece], start: usize, end: usize) -> (usize, usize) {
    let end = end.max(start);
    let best = pieces
        .iter()
        .map(|p| {
            let overlap = (p.at + p.len).min(end).saturating_sub(p.at.max(start));
            (overlap, p)
        })
        .filter(|(o, _)| *o > 0)
        .max_by_key(|(o, _)| *o)
        .map(|(_, p)| p);
    let (start, end) = match best {
        Some(p) => (start.max(p.at), end.min(p.at + p.len)),
        None => (start, end),
    };
    let s = to_track(pieces, start);
    (s, to_track(pieces, end).max(s))
}

/// A chunk this long (in 16 kHz samples) is transcribed at once: 5 minutes.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
const CHUNK: usize = 5 * 60 * 16_000;
/// Cuts are made at the quietest moment this close to each chunk's end.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
const SEARCH: usize = 20 * 16_000;
/// Loudness is compared over windows this long (200 ms).
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
const WINDOW: usize = 3_200;

/// Sample ranges to transcribe one by one, cut at quiet moments so no word is split.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub fn chunks(samples: &[f32]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut from = 0;
    while samples.len() - from > CHUNK + SEARCH {
        let target = from + CHUNK;
        let (lo, hi) = (target - SEARCH, target + SEARCH);
        let quietest = (lo..hi - WINDOW)
            .step_by(WINDOW / 4)
            .min_by(|a, b| {
                let energy =
                    |at: usize| samples[at..at + WINDOW].iter().map(|s| s * s).sum::<f32>();
                energy(*a).total_cmp(&energy(*b))
            })
            .unwrap_or(target);
        let cut = quietest + WINDOW / 2;
        out.push((from, cut));
        from = cut;
    }
    out.push((from, samples.len()));
    out
}

/// 16-bit samples to the engines' floats.
pub fn to_f32(samples: &[i16]) -> Vec<f32> {
    samples.iter().map(|s| f32::from(*s) / 32768.0).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_is_condensed_and_times_map_back_to_the_track() {
        let samples: Vec<f32> = (0..100_000).map(|i| i as f32).collect();
        // Two stretches; the second overlaps the first's padding.
        let (out, pieces) = condense(
            &samples,
            &[(16_000, 32_000), (30_000, 48_000), (90_000, 200_000)],
        );
        assert_eq!(
            pieces,
            vec![
                Piece {
                    at: 0,
                    from: 16_000,
                    len: 16_000
                },
                Piece {
                    at: 16_000 + GAP,
                    from: 32_000,
                    len: 16_000
                },
                Piece {
                    at: 32_000 + 2 * GAP,
                    from: 90_000,
                    len: 10_000
                },
            ]
        );
        assert_eq!(out.len(), 42_000 + 2 * GAP);
        assert_eq!(out[0], 16_000.0);
        assert_eq!(out[16_000], 0.0);
        assert_eq!(out[16_000 + GAP], 32_000.0);
        // Inside a stretch: exact.
        assert_eq!(to_track(&pieces, 100), 16_100);
        assert_eq!(to_track(&pieces, 16_000 + GAP + 5), 32_005);
        // In a silence: the nearer stretch.
        assert_eq!(to_track(&pieces, 16_000 + 10), 32_000);
        assert_eq!(to_track(&pieces, 16_000 + GAP - 10), 32_000);
        assert_eq!(to_track(&pieces, 32_000 + GAP + 10), 48_000);
        assert_eq!(to_track(&pieces, 32_000 + 2 * GAP - 10), 90_000);
        // Past the end: the end of the last stretch.
        assert_eq!(to_track(&pieces, 1_000_000), 100_000);
        assert_eq!(condense(&samples, &[]), (Vec::new(), Vec::new()));
        // A word across a pause is kept to the stretch it overlaps most.
        assert_eq!(
            word_on_track(&pieces, 15_800, 16_000 + GAP + 800),
            (32_000, 32_800)
        );
        assert_eq!(
            word_on_track(&pieces, 14_000, 16_000 + GAP + 100),
            (30_000, 32_000)
        );
        assert_eq!(word_on_track(&pieces, 100, 900), (16_100, 16_900));
    }

    #[test]
    fn threads_are_about_one_per_physical_core() {
        assert_eq!(threads_for(1, None), 1);
        assert_eq!(threads_for(4, None), 2);
        assert_eq!(threads_for(8, None), 4);
        assert_eq!(threads_for(12, None), 6);
        assert_eq!(threads_for(32, None), 8);
        assert_eq!(threads_for(8, Some("6")), 6);
        assert_eq!(threads_for(8, Some(" 12 ")), 12);
        // Nonsense falls back to the default.
        assert_eq!(threads_for(8, Some("0")), 4);
        assert_eq!(threads_for(8, Some("many")), 4);
    }

    #[test]
    fn long_tracks_are_cut_at_quiet_moments() {
        assert_eq!(chunks(&[0.5; 1000]), vec![(0, 1000)]);
        // 12 minutes of noise with a silent second at 4:50 and at 9:55.
        let mut s: Vec<f32> = (0..12 * 60 * 16_000)
            .map(|i| if i % 2 == 0 { 0.3 } else { -0.3 })
            .collect();
        for quiet in [290 * 16_000, 595 * 16_000] {
            for x in &mut s[quiet..quiet + 16_000] {
                *x = 0.0;
            }
        }
        let cuts = chunks(&s);
        assert_eq!(cuts.len(), 3);
        assert_eq!(cuts[0].0, 0);
        assert_eq!(cuts[2].1, s.len());
        for w in cuts.windows(2) {
            assert_eq!(w[0].1, w[1].0);
        }
        // Both cuts fall inside the silences.
        assert!(
            (290 * 16_000..291 * 16_000).contains(&cuts[0].1),
            "{}",
            cuts[0].1
        );
        assert!(
            (595 * 16_000..596 * 16_000).contains(&cuts[1].1),
            "{}",
            cuts[1].1
        );
    }
}
