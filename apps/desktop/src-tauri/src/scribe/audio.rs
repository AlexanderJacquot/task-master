//! Sample processing for recordings (pure, unit tested): device frames are mixed down to
//! mono, resampled to 16 kHz, and measured for the level meters.

/// The rate every track is stored and transcribed at.
pub const RATE: u32 = 16_000;
/// Samples per millisecond at [`RATE`].
pub const PER_MS: u64 = RATE as u64 / 1000;

/// Averages interleaved frames into one channel.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub fn downmix(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Kernel half-width in input samples (before widening for downsampling).
const HALF_TAPS: usize = 16;

/// Streaming band-limited resampler from any device rate to [`RATE`]: a Blackman-windowed
/// sinc evaluated at exact rational positions, so 48 kHz and 44.1 kHz input never drift.
pub struct Resampler {
    in_rate: u64,
    out_rate: u64,
    /// Half-width of the kernel in input samples.
    taps: usize,
    /// Cutoff relative to the input Nyquist frequency.
    cutoff: f64,
    /// Input samples from `base` on.
    buf: Vec<f32>,
    base: u64,
    /// Next output sample index.
    next: u64,
    /// Kernels by the fractional position (`(n * in_rate) % out_rate`), built on demand.
    kernels: Vec<Option<Box<[f32]>>>,
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { gcd(b, a % b) }
}

impl Resampler {
    pub fn new(in_rate: u32) -> Self {
        let in_rate = u64::from(in_rate.max(1));
        let out_rate = u64::from(RATE);
        let ratio = in_rate as f64 / out_rate as f64;
        let taps = (HALF_TAPS as f64 * ratio.max(1.0)).ceil() as usize;
        // Distinct fractional positions: out_rate / gcd(in, out).
        let phases = (out_rate / gcd(in_rate, out_rate)) as usize;
        Self {
            in_rate,
            out_rate,
            taps,
            cutoff: (1.0 / ratio).min(1.0) * 0.92,
            buf: Vec::new(),
            base: 0,
            next: 0,
            kernels: vec![None; phases],
        }
    }

    /// Input position of output sample `n`: whole sample and fractional numerator.
    fn position(&self, n: u64) -> (u64, u64) {
        let num = n * self.in_rate;
        (num / self.out_rate, num % self.out_rate)
    }

    /// Builds the kernel for this fractional position if needed; returns its slot.
    fn kernel_slot(&mut self, frac_num: u64) -> usize {
        let step = self.out_rate / self.kernels.len() as u64;
        let slot = (frac_num / step) as usize;
        if self.kernels[slot].is_none() {
            let frac = frac_num as f64 / self.out_rate as f64;
            let taps = self.taps as i64;
            let kernel: Box<[f32]> = (-taps + 1..=taps)
                .map(|i| {
                    // Distance from the output position to input sample `whole + i`.
                    let d = i as f64 - frac;
                    let u = d / taps as f64;
                    if u.abs() >= 1.0 {
                        return 0.0;
                    }
                    let x = self.cutoff * d;
                    let sinc = if x.abs() < 1e-9 {
                        1.0
                    } else {
                        (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
                    };
                    let window = 0.42
                        + 0.5 * (std::f64::consts::PI * u).cos()
                        + 0.08 * (2.0 * std::f64::consts::PI * u).cos();
                    (self.cutoff * sinc * window) as f32
                })
                .collect();
            self.kernels[slot] = Some(kernel);
        }
        slot
    }

    /// Feeds mono input; returns the output samples now complete.
    pub fn push(&mut self, input: &[f32]) -> Vec<f32> {
        self.buf.extend_from_slice(input);
        self.drain()
    }

    /// Pads with silence so the last input sample comes out; for the end of a recording.
    pub fn finish(&mut self) -> Vec<f32> {
        let pad = vec![0.0; self.taps + 1];
        let end = self.base + self.buf.len() as u64;
        self.buf.extend_from_slice(&pad);
        let mut out = self.drain();
        // Only the outputs that fall within the real input.
        let keep = (end * self.out_rate).div_ceil(self.in_rate);
        let produced_before = self.next - out.len() as u64;
        out.truncate(keep.saturating_sub(produced_before) as usize);
        out
    }

    fn drain(&mut self) -> Vec<f32> {
        let mut out = Vec::new();
        let taps = self.taps as u64;
        loop {
            let (whole, frac) = self.position(self.next);
            // Needs input samples whole - taps + 1 ..= whole + taps.
            if whole + taps >= self.base + self.buf.len() as u64 {
                break;
            }
            let start = (whole + 1).saturating_sub(taps);
            let kernel_skip = (start + taps).saturating_sub(whole + 1) as usize;
            let from = (start - self.base) as usize;
            let slot = self.kernel_slot(frac);
            let kernel = self.kernels[slot].as_deref().unwrap_or(&[]);
            let mut acc = 0.0f32;
            for (k, x) in kernel[kernel_skip..].iter().zip(&self.buf[from..]) {
                acc += k * x;
            }
            out.push(acc);
            self.next += 1;
        }
        // Drop the input no later output needs.
        let (whole, _) = self.position(self.next);
        let keep_from = (whole + 1).saturating_sub(taps);
        if keep_from > self.base {
            let drop = ((keep_from - self.base) as usize).min(self.buf.len());
            self.buf.drain(..drop);
            self.base += drop as u64;
        }
        out
    }
}

/// Converts to 16-bit PCM, clipping.
pub fn to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|s| (s.clamp(-1.0, 1.0) * 32767.0).round() as i16)
        .collect()
}

/// Loudness of a block for a meter: 0 at -60 dBFS RMS or below, 1 at 0 dBFS.
pub fn level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mean = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
    let rms = mean.sqrt();
    if rms <= 1e-6 {
        return 0.0;
    }
    ((20.0 * rms.log10() + 60.0) / 60.0).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, hz: f64, seconds: f64) -> Vec<f32> {
        let n = (f64::from(rate) * seconds) as usize;
        (0..n)
            .map(|i| {
                (0.5 * (2.0 * std::f64::consts::PI * hz * i as f64 / f64::from(rate)).sin()) as f32
            })
            .collect()
    }

    /// Amplitude of `hz` in `samples` at `RATE` (single-bin DFT).
    fn amplitude(samples: &[f32], hz: f64) -> f64 {
        let (mut re, mut im) = (0.0, 0.0);
        for (i, s) in samples.iter().enumerate() {
            let phase = 2.0 * std::f64::consts::PI * hz * i as f64 / f64::from(RATE);
            re += f64::from(*s) * phase.cos();
            im += f64::from(*s) * phase.sin();
        }
        2.0 * (re * re + im * im).sqrt() / samples.len() as f64
    }

    fn resample_all(rate: u32, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut r = Resampler::new(rate);
        let mut out = Vec::new();
        for part in input.chunks(chunk) {
            out.extend(r.push(part));
        }
        out.extend(r.finish());
        out
    }

    #[test]
    fn downmix_averages_channels() {
        assert_eq!(downmix(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(downmix(&[0.25, 0.75], 1), vec![0.25, 0.75]);
    }

    #[test]
    fn common_rates_keep_the_length_and_a_speech_tone() {
        for rate in [48_000, 44_100, 16_000, 32_000, 96_000, 8_000] {
            let input = tone(rate, 1_000.0, 2.0);
            let out = resample_all(rate, &input, 441);
            let expected = 2 * RATE as usize;
            assert!(
                out.len().abs_diff(expected) <= 1,
                "{rate} Hz gave {} samples",
                out.len()
            );
            // Skip the edges, where the kernel sees the padding.
            let middle = &out[1_000..out.len() - 1_000];
            let a = amplitude(middle, 1_000.0);
            assert!((a - 0.5).abs() < 0.02, "{rate} Hz: 1 kHz amplitude {a}");
        }
    }

    #[test]
    fn frequencies_above_eight_khz_are_filtered_out() {
        // 12 kHz would alias to 4 kHz at 16 kHz without the low-pass.
        let input = tone(48_000, 12_000.0, 1.0);
        let out = resample_all(48_000, &input, 480);
        let middle = &out[1_000..out.len() - 1_000];
        assert!(amplitude(middle, 4_000.0) < 0.005);
        assert!(level(middle) < 0.3);
    }

    #[test]
    fn chunking_does_not_change_the_output() {
        let input = tone(44_100, 440.0, 0.5);
        let a = resample_all(44_100, &input, 64);
        let b = resample_all(44_100, &input, 10_000);
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(&b) {
            assert!((x - y).abs() < 1e-6);
        }
    }

    #[test]
    fn levels_follow_loudness() {
        assert_eq!(level(&[]), 0.0);
        assert_eq!(level(&[0.0; 160]), 0.0);
        let loud = level(&tone(RATE, 440.0, 0.1));
        let quiet = level(
            &tone(RATE, 440.0, 0.1)
                .iter()
                .map(|s| s * 0.01)
                .collect::<Vec<_>>(),
        );
        assert!(loud > 0.8, "{loud}");
        assert!(quiet > 0.0 && quiet < loud - 0.5, "{quiet}");
        assert_eq!(to_i16(&[2.0, -2.0, 0.0]), vec![32767, -32767, 0]);
    }
}
