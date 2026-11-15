//! 16 kHz mono 16-bit WAV files, written while recording. The header's sizes are brought
//! up to date at every flush, so a crash loses at most the last unflushed second, and
//! [`repair`] fixes a header left behind by one.

use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

use super::audio::RATE;

const HEADER_LEN: u64 = 44;

fn header(data_len: u32) -> [u8; 44] {
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_len).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
    h[24..28].copy_from_slice(&RATE.to_le_bytes());
    h[28..32].copy_from_slice(&(RATE * 2).to_le_bytes()); // bytes per second
    h[32..34].copy_from_slice(&2u16.to_le_bytes()); // block align
    h[34..36].copy_from_slice(&16u16.to_le_bytes()); // bits per sample
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_len.to_le_bytes());
    h
}

/// Appends samples to a WAV file. A new file starts empty; an existing one (after a crash
/// and "keep what was recorded") is not reopened: recordings start a new file.
pub struct WavWriter {
    out: BufWriter<File>,
    samples: u64,
}

impl WavWriter {
    pub fn create(path: &Path) -> io::Result<Self> {
        let mut file = File::create(path)?;
        file.write_all(&header(0))?;
        Ok(Self {
            out: BufWriter::with_capacity(64 * 1024, file),
            samples: 0,
        })
    }

    pub fn write(&mut self, samples: &[i16]) -> io::Result<()> {
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for s in samples {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        self.out.write_all(&bytes)?;
        self.samples += samples.len() as u64;
        Ok(())
    }

    /// Writes `n` samples of silence (to keep the tracks aligned across gaps).
    pub fn silence(&mut self, n: u64) -> io::Result<()> {
        const CHUNK: usize = 1600;
        let zeros = [0i16; CHUNK];
        let mut left = n;
        while left > 0 {
            let part = left.min(CHUNK as u64) as usize;
            self.write(&zeros[..part])?;
            left -= part as u64;
        }
        Ok(())
    }

    pub fn samples(&self) -> u64 {
        self.samples
    }

    /// Pushes the samples to disk and rewrites the header's sizes.
    pub fn flush(&mut self) -> io::Result<()> {
        self.out.flush()?;
        let data_len = u32::try_from(self.samples * 2).unwrap_or(u32::MAX);
        let file = self.out.get_mut();
        file.seek(SeekFrom::Start(0))?;
        file.write_all(&header(data_len))?;
        file.seek(SeekFrom::End(0))?;
        file.sync_data()
    }

    pub fn finish(mut self) -> io::Result<u64> {
        self.flush()?;
        Ok(self.samples)
    }
}

/// Makes the header match the samples on disk (after a crash). Returns the sample count.
pub fn repair(path: &Path) -> io::Result<u64> {
    let mut file = OpenOptions::new().read(true).write(true).open(path)?;
    let len = file.metadata()?.len();
    if len < HEADER_LEN {
        file.set_len(0)?;
        file.write_all(&header(0))?;
        return Ok(0);
    }
    // A sample cut in half by the crash is dropped.
    let data = (len - HEADER_LEN) & !1;
    file.set_len(HEADER_LEN + data)?;
    let data_len = u32::try_from(data).unwrap_or(u32::MAX);
    file.seek(SeekFrom::Start(0))?;
    file.write_all(&header(data_len))?;
    file.sync_data()?;
    Ok(data / 2)
}

/// Number of samples in a file this module wrote, from its size.
pub fn sample_count(path: &Path) -> io::Result<u64> {
    let len = std::fs::metadata(path)?.len();
    Ok(len.saturating_sub(HEADER_LEN) / 2)
}

/// Reads a file this module wrote (16 kHz mono PCM16, data right after the 44-byte
/// header), in chunks of at most `chunk` samples.
pub struct WavReader {
    file: io::BufReader<File>,
    left: u64,
}

impl WavReader {
    pub fn open(path: &Path) -> io::Result<Self> {
        let mut file = File::open(path)?;
        let mut h = [0u8; 44];
        file.read_exact(&mut h)?;
        let ok = &h[0..4] == b"RIFF"
            && &h[8..12] == b"WAVE"
            && &h[36..40] == b"data"
            && u16::from_le_bytes([h[22], h[23]]) == 1
            && u32::from_le_bytes([h[24], h[25], h[26], h[27]]) == RATE
            && u16::from_le_bytes([h[34], h[35]]) == 16;
        if !ok {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "not a 16 kHz mono recording",
            ));
        }
        // The size on disk wins over the header (a crash may have left it behind).
        let on_disk = file.metadata()?.len().saturating_sub(HEADER_LEN) / 2;
        Ok(Self {
            file: io::BufReader::with_capacity(64 * 1024, file),
            left: on_disk,
        })
    }

    pub fn samples_left(&self) -> u64 {
        self.left
    }

    /// The next samples; empty at the end.
    pub fn read(&mut self, chunk: usize) -> io::Result<Vec<i16>> {
        let n = self.left.min(chunk as u64) as usize;
        let mut bytes = vec![0u8; n * 2];
        self.file.read_exact(&mut bytes)?;
        self.left -= n as u64;
        Ok(bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| i16::from_le_bytes(*b))
            .collect())
    }

    /// Every remaining sample.
    #[cfg(test)]
    pub fn read_all(mut self) -> io::Result<Vec<i16>> {
        let n = self.left as usize;
        self.read(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tm-wav-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("track.wav")
    }

    #[test]
    fn written_samples_read_back() {
        let path = temp("roundtrip");
        let mut w = WavWriter::create(&path).unwrap();
        w.write(&[1, -2, 3]).unwrap();
        w.silence(2).unwrap();
        w.flush().unwrap();
        w.write(&[7]).unwrap();
        assert_eq!(w.finish().unwrap(), 6);
        assert_eq!(sample_count(&path).unwrap(), 6);
        let r = WavReader::open(&path).unwrap();
        assert_eq!(r.samples_left(), 6);
        assert_eq!(r.read_all().unwrap(), vec![1, -2, 3, 0, 0, 7]);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 12);
    }

    #[test]
    fn a_crash_keeps_the_flushed_samples_and_repair_fixes_the_header() {
        let path = temp("crash");
        let mut w = WavWriter::create(&path).unwrap();
        w.write(&[5; 100]).unwrap();
        w.flush().unwrap();
        w.write(&[6; 50]).unwrap();
        // Dropped without finish: what reached the disk stays, the header lags.
        drop(w);
        // A torn last sample.
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(&[9]).unwrap();
        drop(f);
        let n = repair(&path).unwrap();
        assert!(n >= 100, "{n}");
        let samples = WavReader::open(&path).unwrap().read_all().unwrap();
        assert_eq!(samples.len() as u64, n);
        assert!(samples[..100].iter().all(|s| *s == 5));
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(
            u64::from(u32::from_le_bytes(bytes[40..44].try_into().unwrap())),
            n * 2
        );
    }

    #[test]
    fn repair_of_a_truncated_header_gives_an_empty_file() {
        let path = temp("short");
        std::fs::write(&path, b"RIFF").unwrap();
        assert_eq!(repair(&path).unwrap(), 0);
        assert!(
            WavReader::open(&path)
                .unwrap()
                .read_all()
                .unwrap()
                .is_empty()
        );
    }
}
