//! Turns captured chunks into two aligned 16 kHz tracks on disk (pure apart from the
//! files; time is passed in, so tests drive it).
//!
//! Alignment: both tracks start at the moment recording started. A track that delivers
//! nothing for a while (Windows sends no loopback data while nothing plays) is padded with
//! silence up to the wall clock, so a sample's position is its time in both files.

use std::io;
use std::path::Path;

use super::audio::{self, PER_MS, Resampler};
use super::capture::Track;
use super::wav::WavWriter;

/// A track this far behind the clock is padded with silence.
const GAP_MS: u64 = 250;
/// Padding stops this far behind the clock, leaving room for buffered samples.
const SLACK_MS: u64 = 40;

pub struct TrackWriter {
    wav: WavWriter,
    resampler: Option<(u32, Resampler)>,
    /// Samples written since the last level reading.
    meter: Vec<f32>,
    /// The first chunk is placed at its time (before it, silence).
    started: bool,
    /// The track was padded through a gap: the next chunk is placed at its time too.
    in_gap: bool,
}

impl TrackWriter {
    pub fn create(path: &Path) -> io::Result<Self> {
        Ok(Self {
            wav: WavWriter::create(path)?,
            resampler: None,
            meter: Vec::new(),
            started: false,
            in_gap: false,
        })
    }

    fn write(&mut self, samples: &[f32]) -> io::Result<()> {
        self.meter.extend_from_slice(samples);
        self.wav.write(&audio::to_i16(samples))
    }

    /// Adds device samples captured up to `now_ms` after the start.
    fn push(&mut self, rate: u32, samples: &[f32], now_ms: u64) -> io::Result<()> {
        if !self.started || self.in_gap {
            // The chunk ends now: it began its own length earlier.
            let chunk_ms = samples.len() as u64 * 1000 / u64::from(rate.max(1));
            let begins = now_ms.saturating_sub(chunk_ms) * PER_MS;
            let have = self.wav.samples();
            if begins > have {
                self.wav.silence(begins - have)?;
            }
            self.started = true;
            self.in_gap = false;
        }
        let flushed = match &mut self.resampler {
            Some((r, _)) if *r == rate => None,
            // A new device rate (the device changed): finish the old resampler first.
            Some((_, old)) => Some(old.finish()),
            None => None,
        };
        if let Some(tail) = flushed {
            self.write(&tail)?;
        }
        if !matches!(&self.resampler, Some((r, _)) if *r == rate) {
            self.resampler = Some((rate, Resampler::new(rate)));
        }
        let out = match &mut self.resampler {
            Some((_, r)) => r.push(samples),
            None => Vec::new(),
        };
        self.write(&out)
    }

    /// Pads with silence when the track lags the clock by more than [`GAP_MS`].
    fn keep_up(&mut self, now_ms: u64) -> io::Result<()> {
        let expected = now_ms * PER_MS;
        let have = self.wav.samples();
        if expected > have + GAP_MS * PER_MS {
            // Samples still inside the resampler count as written.
            let target = expected - SLACK_MS * PER_MS;
            if target > have {
                if let Some((_, r)) = &mut self.resampler {
                    let tail = r.finish();
                    self.write(&tail)?;
                    self.resampler = None;
                }
                let have = self.wav.samples();
                if target > have {
                    self.wav.silence(target - have)?;
                }
                self.started = true;
                self.in_gap = true;
            }
        }
        Ok(())
    }

    fn level(&mut self) -> f32 {
        let l = audio::level(&self.meter);
        self.meter.clear();
        l
    }

    fn samples(&self) -> u64 {
        self.wav.samples()
    }
}

/// Levels since the previous reading, 0 to 1.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Levels {
    pub mic: f32,
    pub system: Option<f32>,
}

pub struct Recorder {
    mic: TrackWriter,
    system: Option<TrackWriter>,
    /// Problems the streams reported, for the meeting page.
    pub warnings: Vec<String>,
}

impl Recorder {
    pub fn create(dir: &Path, system: bool) -> io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        Ok(Self {
            mic: TrackWriter::create(&dir.join(super::MIC_WAV))?,
            system: if system {
                Some(TrackWriter::create(&dir.join(super::SYSTEM_WAV))?)
            } else {
                None
            },
            warnings: Vec::new(),
        })
    }

    fn track(&mut self, track: Track) -> Option<&mut TrackWriter> {
        match track {
            Track::Mic => Some(&mut self.mic),
            Track::System => self.system.as_mut(),
        }
    }

    pub fn push(
        &mut self,
        track: Track,
        rate: u32,
        samples: &[f32],
        now_ms: u64,
    ) -> io::Result<()> {
        match self.track(track) {
            Some(t) => t.push(rate, samples, now_ms),
            None => Ok(()),
        }
    }

    pub fn warn(&mut self, track: Track, message: String) {
        let which = match track {
            Track::Mic => "Microphone",
            Track::System => "Computer sound",
        };
        let line = format!("{which}: {message}");
        // Streams can repeat an error many times a second.
        if !self.warnings.contains(&line) && self.warnings.len() < 20 {
            self.warnings.push(line);
        }
    }

    /// Called on a timer: pads lagging tracks and reads the levels.
    pub fn tick(&mut self, now_ms: u64) -> io::Result<Levels> {
        self.mic.keep_up(now_ms)?;
        if let Some(s) = &mut self.system {
            s.keep_up(now_ms)?;
        }
        Ok(Levels {
            mic: self.mic.level(),
            system: self.system.as_mut().map(TrackWriter::level),
        })
    }

    pub fn flush(&mut self) -> io::Result<()> {
        self.mic.wav.flush()?;
        if let Some(s) = &mut self.system {
            s.wav.flush()?;
        }
        Ok(())
    }

    /// Ends both tracks at the same length (the clock's, at `now_ms`, or the longer
    /// track's). Returns that length in samples.
    pub fn finish(mut self, now_ms: u64) -> io::Result<u64> {
        let mut tracks = vec![&mut self.mic];
        if let Some(s) = &mut self.system {
            tracks.push(s);
        }
        for t in &mut tracks {
            if let Some((_, r)) = &mut t.resampler {
                let tail = r.finish();
                t.write(&tail)?;
                t.resampler = None;
            }
        }
        let clock = now_ms * PER_MS;
        let longest = tracks.iter().map(|t| t.samples()).max().unwrap_or(0);
        // The clock decides unless a track ran ahead of it (a fast device clock).
        let end = clock.max(longest);
        for t in &mut tracks {
            let have = t.samples();
            if end > have {
                t.wav.silence(end - have)?;
            }
        }
        self.mic.wav.finish()?;
        if let Some(s) = self.system {
            s.wav.finish()?;
        }
        Ok(end)
    }
}

#[cfg(test)]
mod tests {
    use super::super::wav::WavReader;
    use super::super::{MIC_WAV, SYSTEM_WAV};
    use super::*;

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tm-rec-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn chunk(rate: u32, ms: u64, value: f32) -> Vec<f32> {
        vec![value; (u64::from(rate) * ms / 1000) as usize]
    }

    #[test]
    fn tracks_stay_aligned_when_one_falls_silent() {
        let d = dir("gap");
        let mut rec = Recorder::create(&d, true).unwrap();
        // Mic: 48 kHz, 10 ms chunks for 2 s. System: plays for 0.5 s, then nothing (as
        // WASAPI loopback does in silence), then plays again from 1.5 s.
        for step in 1..=200u64 {
            let now = step * 10;
            rec.push(Track::Mic, 48_000, &chunk(48_000, 10, 0.25), now)
                .unwrap();
            if now <= 500 || now > 1_500 {
                rec.push(Track::System, 44_100, &chunk(44_100, 10, -0.25), now)
                    .unwrap();
            }
            if now % 100 == 0 {
                let levels = rec.tick(now).unwrap();
                assert!(levels.mic > 0.0);
            }
        }
        let n = rec.finish(2_000).unwrap();
        assert_eq!(n, 2_000 * PER_MS);
        let mic = WavReader::open(&d.join(MIC_WAV))
            .unwrap()
            .read_all()
            .unwrap();
        let system = WavReader::open(&d.join(SYSTEM_WAV))
            .unwrap()
            .read_all()
            .unwrap();
        assert_eq!(mic.len() as u64, n);
        assert_eq!(system.len() as u64, n);
        // The system track's second part starts close to 1.5 s, not right after 0.5 s.
        let resumed = system
            .iter()
            .enumerate()
            .skip(600 * PER_MS as usize)
            .find(|(_, s)| **s < -4_000)
            .map(|(i, _)| i as u64 / PER_MS)
            .unwrap();
        assert!(
            (1_480..=1_530).contains(&resumed),
            "resumed at {resumed} ms"
        );
        // Silent in the gap.
        let gap = &system[(800 * PER_MS) as usize..(1_300 * PER_MS) as usize];
        assert!(gap.iter().all(|s| *s == 0));
    }

    #[test]
    fn a_late_first_chunk_is_placed_at_its_time() {
        let d = dir("late");
        let mut rec = Recorder::create(&d, false).unwrap();
        // The device only starts delivering 200 ms in (under the gap threshold).
        for step in 1..=10u64 {
            rec.push(Track::Mic, 16_000, &chunk(16_000, 20, 0.5), 200 + step * 20)
                .unwrap();
        }
        let n = rec.finish(400).unwrap();
        assert_eq!(n, 400 * PER_MS);
        let mic = WavReader::open(&d.join(MIC_WAV))
            .unwrap()
            .read_all()
            .unwrap();
        let first = mic.iter().position(|s| *s > 8_000).unwrap() as u64 / PER_MS;
        assert!((195..=225).contains(&first), "first sound at {first} ms");
        assert!(!d.join(SYSTEM_WAV).exists());
    }

    #[test]
    fn a_track_with_no_data_at_all_is_silence_of_the_full_length() {
        let d = dir("none");
        let mut rec = Recorder::create(&d, true).unwrap();
        for now in (100..=1_000).step_by(100) {
            rec.push(Track::Mic, 16_000, &chunk(16_000, 100, 0.1), now)
                .unwrap();
            let levels = rec.tick(now).unwrap();
            assert_eq!(levels.system, Some(0.0));
        }
        rec.warn(Track::System, "device lost".into());
        rec.warn(Track::System, "device lost".into());
        assert_eq!(rec.warnings, vec!["Computer sound: device lost".to_owned()]);
        let n = rec.finish(1_000).unwrap();
        let system = WavReader::open(&d.join(SYSTEM_WAV))
            .unwrap()
            .read_all()
            .unwrap();
        assert_eq!(system.len() as u64, n);
        assert!(system.iter().all(|s| *s == 0));
    }
}
