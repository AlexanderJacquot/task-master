//! Ogg Opus (RFC 7845) for stored tracks: a recording's WAV is encoded once it stops,
//! about 11 MB per hour of speech, and decoded back to 16 kHz for transcription. The
//! webview plays the files directly.

use std::fs::File;
use std::io::{self, BufReader, BufWriter, Write};
use std::path::Path;

use ogg::{PacketReader, PacketWriteEndInfo, PacketWriter};
use opus_rs::{Application, OpusDecoder, OpusEncoder};

use super::audio::RATE;
use super::wav::WavReader;

/// 20 ms at 16 kHz.
const FRAME: usize = 320;
/// Granule positions count 48 kHz samples whatever the input rate.
const GRANULE_PER_SAMPLE: u64 = 48_000 / RATE as u64;
/// Speech at 16 kHz mono: SILK wideband, transparent enough for transcription.
const BITRATE: i32 = 24_000;
/// Ogg pages are closed about once a second, so a cut file still plays.
const FRAMES_PER_PAGE: u64 = 50;
const SERIAL: u32 = 0x7473_6d31; // "tsm1"

fn other(e: impl std::fmt::Display) -> io::Error {
    io::Error::other(e.to_string())
}

fn opus_head(pre_skip: u16) -> Vec<u8> {
    let mut h = Vec::with_capacity(19);
    h.extend_from_slice(b"OpusHead");
    h.push(1); // version
    h.push(1); // channels
    h.extend_from_slice(&pre_skip.to_le_bytes());
    h.extend_from_slice(&RATE.to_le_bytes()); // original input rate
    h.extend_from_slice(&0i16.to_le_bytes()); // output gain
    h.push(0); // mapping family: mono/stereo
    h
}

fn opus_tags() -> Vec<u8> {
    let vendor = b"task-master";
    let mut t = Vec::new();
    t.extend_from_slice(b"OpusTags");
    t.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    t.extend_from_slice(vendor);
    t.extend_from_slice(&0u32.to_le_bytes()); // no comments
    t
}

/// Encodes a recorded WAV track to Ogg Opus at `out`. `progress` gets the fraction done.
pub fn encode_wav(wav: &Path, out: &Path, mut progress: impl FnMut(f32)) -> io::Result<()> {
    let mut reader = WavReader::open(wav)?;
    let total = reader.samples_left().max(1);
    let file = BufWriter::new(File::create(out)?);
    let mut encoder = OpusEncoder::new(RATE as i32, 1, Application::Voip).map_err(other)?;
    encoder.bitrate_bps = BITRATE;
    // Pre-skip is counted at 48 kHz.
    let pre_skip = encoder.lookahead() as u64 * GRANULE_PER_SAMPLE;
    let mut writer = PacketWriter::new(file);
    writer.write_packet(
        opus_head(pre_skip as u16),
        SERIAL,
        PacketWriteEndInfo::EndPage,
        0,
    )?;
    writer.write_packet(opus_tags(), SERIAL, PacketWriteEndInfo::EndPage, 0)?;

    let samples_total = reader.samples_left();
    // Enough frames to push the encoder's delay out after the last sample.
    let frames = (samples_total + encoder.lookahead() as u64)
        .div_ceil(FRAME as u64)
        .max(1);
    let mut packet = vec![0u8; 1500];
    for f in 1..=frames {
        let mut samples = reader.read(FRAME)?;
        samples.resize(FRAME, 0);
        let n = encoder
            .encode_i16(&samples, FRAME, &mut packet)
            .map_err(other)?;
        let last = f == frames;
        // A page's granule counts the 48 kHz samples decoded through it; the last one
        // marks where the real audio ends, so players trim the padding.
        let (granule, info) = if last {
            (
                pre_skip + samples_total * GRANULE_PER_SAMPLE,
                PacketWriteEndInfo::EndStream,
            )
        } else if f % FRAMES_PER_PAGE == 0 {
            (
                f * FRAME as u64 * GRANULE_PER_SAMPLE,
                PacketWriteEndInfo::EndPage,
            )
        } else {
            (
                f * FRAME as u64 * GRANULE_PER_SAMPLE,
                PacketWriteEndInfo::NormalPacket,
            )
        };
        writer.write_packet(packet[..n].to_vec(), SERIAL, info, granule)?;
        if f % 500 == 0 {
            progress((f * FRAME as u64) as f32 / total as f32);
        }
    }
    let mut file = writer.into_inner();
    file.flush()?;
    file.get_ref().sync_all()?;
    progress(1.0);
    Ok(())
}

/// Decodes an Ogg Opus track this module wrote back to 16 kHz samples.
#[allow(dead_code)] // Transcription (M20) reads tracks with it.
pub fn decode(path: &Path) -> io::Result<Vec<i16>> {
    let mut reader = PacketReader::new(BufReader::new(File::open(path)?));
    let head = reader
        .read_packet()
        .map_err(other)?
        .ok_or_else(|| other("empty audio file"))?;
    if head.data.len() < 19 || &head.data[..8] != b"OpusHead" {
        return Err(other("not an Opus file"));
    }
    let pre_skip = u64::from(u16::from_le_bytes([head.data[10], head.data[11]]));
    // OpusTags.
    reader.read_packet().map_err(other)?;
    let mut decoder = OpusDecoder::new(RATE as i32, 1).map_err(other)?;
    let mut out: Vec<i16> = Vec::new();
    let mut pcm = vec![0f32; FRAME * 6];
    let mut last_granule = None;
    while let Some(packet) = reader.read_packet().map_err(other)? {
        let n = decoder
            .decode(&packet.data, FRAME * 6, &mut pcm)
            .map_err(other)?;
        out.extend(
            pcm[..n]
                .iter()
                .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16),
        );
        if packet.last_in_page() {
            last_granule = Some(packet.absgp_page());
        }
    }
    let skip = (pre_skip / GRANULE_PER_SAMPLE) as usize;
    let skip = skip.min(out.len());
    out.drain(..skip);
    if let Some(g) = last_granule {
        let len = (g.saturating_sub(pre_skip) / GRANULE_PER_SAMPLE) as usize;
        out.truncate(len);
    }
    Ok(out)
}

/// Length in 16 kHz samples, from the last page's granule position (reads the file).
#[cfg(test)]
pub fn duration_samples(path: &Path) -> io::Result<u64> {
    let mut reader = PacketReader::new(BufReader::new(File::open(path)?));
    let head = reader
        .read_packet()
        .map_err(other)?
        .ok_or_else(|| other("empty audio file"))?;
    if head.data.len() < 19 || &head.data[..8] != b"OpusHead" {
        return Err(other("not an Opus file"));
    }
    let pre_skip = u64::from(u16::from_le_bytes([head.data[10], head.data[11]]));
    let mut last = 0;
    while let Some(packet) = reader.read_packet().map_err(other)? {
        if packet.last_in_page() {
            last = packet.absgp_page();
        }
    }
    Ok(last.saturating_sub(pre_skip) / GRANULE_PER_SAMPLE)
}

#[cfg(test)]
mod tests {
    use super::super::wav::WavWriter;
    use super::*;

    fn dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tm-opus-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn speechlike(n: usize) -> Vec<i16> {
        // Two tones with a slow envelope: enough structure for SILK.
        (0..n)
            .map(|i| {
                let t = i as f64 / f64::from(RATE);
                let env = 0.5 + 0.5 * (2.0 * std::f64::consts::PI * 3.0 * t).sin();
                let s = (2.0 * std::f64::consts::PI * 220.0 * t).sin() * 0.4
                    + (2.0 * std::f64::consts::PI * 660.0 * t).sin() * 0.2;
                (s * env * 20_000.0) as i16
            })
            .collect()
    }

    #[test]
    fn a_track_survives_encoding_with_its_length_and_shape() {
        let d = dir("roundtrip");
        let (wav, ogg) = (d.join("mic.wav"), d.join("mic.opus"));
        // 2.5 s, not a whole number of frames.
        let input = speechlike(40_123);
        let mut w = WavWriter::create(&wav).unwrap();
        w.write(&input).unwrap();
        w.finish().unwrap();
        let mut seen = Vec::new();
        encode_wav(&wav, &ogg, |p| seen.push(p)).unwrap();
        assert_eq!(seen.last(), Some(&1.0));
        let bytes = std::fs::metadata(&ogg).unwrap().len();
        // 24 kb/s for 2.5 s is about 7.5 kB; well under the 80 kB of the WAV.
        assert!(bytes < 12_000, "{bytes} bytes");
        assert_eq!(duration_samples(&ogg).unwrap(), 40_123);
        let output = decode(&ogg).unwrap();
        assert_eq!(output.len(), input.len());
        // Lossy, but the waveform lines up: strong correlation in the middle.
        let (a, b) = (&input[4_000..36_000], &output[4_000..36_000]);
        let dot: f64 = a
            .iter()
            .zip(b)
            .map(|(x, y)| f64::from(*x) * f64::from(*y))
            .sum();
        let na: f64 = a.iter().map(|x| f64::from(*x).powi(2)).sum::<f64>().sqrt();
        let nb: f64 = b.iter().map(|x| f64::from(*x).powi(2)).sum::<f64>().sqrt();
        let corr = dot / (na * nb);
        assert!(corr > 0.8, "correlation {corr}");
    }

    #[test]
    fn an_empty_track_encodes_to_an_empty_stream() {
        let d = dir("empty");
        let (wav, ogg) = (d.join("system.wav"), d.join("system.opus"));
        WavWriter::create(&wav).unwrap().finish().unwrap();
        encode_wav(&wav, &ogg, |_| {}).unwrap();
        assert_eq!(duration_samples(&ogg).unwrap(), 0);
        assert!(decode(&ogg).unwrap().is_empty());
    }
}
