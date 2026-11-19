//! Audio input (ADR 026): the microphone and the computer's sound output, through cpal on
//! Windows (WASAPI; an input stream on an output device records it in loopback) and macOS
//! (CoreAudio; the same call makes a process tap, macOS 14.6 and later). Other systems
//! build without it and report that recording is unsupported.
//!
//! The streams live on a thread of their own until told to stop, so nothing here relies on
//! a stream being `Send`. Callbacks only mix down to mono and hand the samples on.

use std::sync::mpsc::Sender;

use serde::Serialize;

/// Which track a chunk belongs to. (Only the recorder's tests make chunks where there is
/// no capture backend.)
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Track {
    Mic,
    System,
}

/// What the capture thread sends to the recorder.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub enum Input {
    /// Mono samples at `rate`.
    Audio {
        track: Track,
        rate: u32,
        samples: Vec<f32>,
    },
    /// A stream reported a problem (device unplugged, permission revoked).
    Error { track: Track, message: String },
}

/// An input device the user can pick.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AudioDevice {
    /// Stable id to pass back to `scribe_start`.
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// What recording can do on this system.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct CaptureSupport {
    /// Microphone recording works here.
    pub recording: bool,
    /// The computer's sound can be recorded too.
    pub system_audio: bool,
    /// Why not, or what to know first (permissions).
    pub note: Option<String>,
}

/// Names of what was opened.
#[derive(Debug, Clone, Default)]
pub struct Opened {
    pub mic: String,
    pub system: Option<String>,
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod backend {
    use super::{AudioDevice, CaptureSupport, Input, Opened, Track};
    use crate::scribe::audio::downmix;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{Device, FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig};
    use std::sync::mpsc::{Receiver, Sender};

    fn device_name(d: &Device) -> String {
        d.description()
            .map(|desc| desc.name().to_owned())
            .unwrap_or_else(|_| "Unknown device".into())
    }

    fn device_id(d: &Device) -> Option<String> {
        d.id().ok().map(|id| id.to_string())
    }

    pub fn support() -> CaptureSupport {
        #[cfg(target_os = "macos")]
        let note = Some(
            "macOS asks for the microphone the first time, and for \"system audio recording\" \
             when the computer's sound is recorded (macOS 14.6 or later)."
                .to_owned(),
        );
        #[cfg(not(target_os = "macos"))]
        let note = None;
        CaptureSupport {
            recording: true,
            system_audio: true,
            note,
        }
    }

    pub fn input_devices() -> Result<Vec<AudioDevice>, String> {
        let host = cpal::default_host();
        let default = host.default_input_device().as_ref().and_then(device_id);
        let devices = host
            .input_devices()
            .map_err(|e| format!("cannot list microphones: {e}"))?;
        Ok(devices
            .filter_map(|d| {
                let id = device_id(&d)?;
                Some(AudioDevice {
                    is_default: default.as_deref() == Some(id.as_str()),
                    name: device_name(&d),
                    id,
                })
            })
            .collect())
    }

    fn build<T>(
        device: &Device,
        config: &StreamConfig,
        track: Track,
        sink: Sender<Input>,
    ) -> Result<Stream, cpal::Error>
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        let channels = usize::from(config.channels.max(1));
        let rate = config.sample_rate;
        let errors = sink.clone();
        device.build_input_stream(
            *config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let floats: Vec<f32> = data.iter().map(|s| f32::from_sample(*s)).collect();
                let _ = sink.send(Input::Audio {
                    track,
                    rate,
                    samples: downmix(&floats, channels),
                });
            },
            move |err| {
                let _ = errors.send(Input::Error {
                    track,
                    message: err.to_string(),
                });
            },
            None,
        )
    }

    fn open_stream(
        device: &Device,
        loopback: bool,
        track: Track,
        sink: Sender<Input>,
    ) -> Result<Stream, String> {
        let supported = if loopback {
            device.default_output_config()
        } else {
            device.default_input_config()
        }
        .map_err(|e| format!("{}: {e}", device_name(device)))?;
        let format = supported.sample_format();
        let config: StreamConfig = supported.into();
        let stream = match format {
            SampleFormat::F32 => build::<f32>(device, &config, track, sink),
            SampleFormat::I16 => build::<i16>(device, &config, track, sink),
            SampleFormat::I32 => build::<i32>(device, &config, track, sink),
            SampleFormat::U16 => build::<u16>(device, &config, track, sink),
            SampleFormat::U8 => build::<u8>(device, &config, track, sink),
            SampleFormat::I8 => build::<i8>(device, &config, track, sink),
            SampleFormat::F64 => build::<f64>(device, &config, track, sink),
            other => {
                return Err(format!(
                    "{}: unsupported sample format {other}",
                    device_name(device)
                ));
            }
        }
        .map_err(|e| format!("{}: {e}", device_name(device)))?;
        stream
            .play()
            .map_err(|e| format!("{}: {e}", device_name(device)))?;
        Ok(stream)
    }

    /// Opens the streams and keeps them until `stop` receives (or is dropped).
    pub fn run(
        mic: Option<String>,
        system: bool,
        sink: Sender<Input>,
        stop: Receiver<()>,
        opened: Sender<Result<Opened, String>>,
    ) {
        let host = cpal::default_host();
        let mic_device = match &mic {
            Some(id) => host
                .input_devices()
                .ok()
                .and_then(|mut all| all.find(|d| device_id(d).as_deref() == Some(id.as_str())))
                .or_else(|| host.default_input_device()),
            None => host.default_input_device(),
        };
        let Some(mic_device) = mic_device else {
            let _ = opened.send(Err("no microphone found".into()));
            return;
        };
        let mic_stream = match open_stream(&mic_device, false, Track::Mic, sink.clone()) {
            Ok(s) => s,
            Err(e) => {
                let _ = opened.send(Err(format!("cannot open the microphone: {e}")));
                return;
            }
        };
        let mut names = Opened {
            mic: device_name(&mic_device),
            system: None,
        };
        let mut system_stream = None;
        if system {
            match host.default_output_device() {
                Some(out) => match open_stream(&out, true, Track::System, sink.clone()) {
                    Ok(s) => {
                        names.system = Some(device_name(&out));
                        system_stream = Some(s);
                    }
                    Err(e) => {
                        let _ = opened.send(Err(format!(
                            "cannot record the computer's sound: {e}. Turn off \"Record the \
                             computer's sound\" to record the microphone only."
                        )));
                        return;
                    }
                },
                None => {
                    let _ = opened.send(Err("no sound output device found".into()));
                    return;
                }
            }
        }
        let _ = opened.send(Ok(names));
        let _ = stop.recv();
        drop(system_stream);
        drop(mic_stream);
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod backend {
    use super::{AudioDevice, CaptureSupport, Input, Opened};
    use std::sync::mpsc::{Receiver, Sender};

    pub fn support() -> CaptureSupport {
        CaptureSupport {
            recording: false,
            system_audio: false,
            note: Some("Recording works on Windows and macOS; not yet on this system.".into()),
        }
    }

    pub fn input_devices() -> Result<Vec<AudioDevice>, String> {
        Ok(Vec::new())
    }

    pub fn run(
        _mic: Option<String>,
        _system: bool,
        _sink: Sender<Input>,
        _stop: Receiver<()>,
        opened: Sender<Result<Opened, String>>,
    ) {
        let _ = opened.send(Err(
            "recording works on Windows and macOS; not yet on this system".into(),
        ));
    }
}

pub use backend::{input_devices, support};

/// Running capture streams; dropping this (or [`Streams::stop`]) closes them.
pub struct Streams {
    stop: Option<Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Streams {
    /// Opens the microphone (`mic`, or the default one) and, with `system`, the
    /// computer's sound output. Waits until they run or fail.
    pub fn open(
        mic: Option<String>,
        system: bool,
        sink: Sender<Input>,
    ) -> Result<(Self, Opened), String> {
        let (stop_tx, stop_rx) = std::sync::mpsc::channel();
        let (opened_tx, opened_rx) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("scribe-capture".into())
            .spawn(move || backend::run(mic, system, sink, stop_rx, opened_tx))
            .map_err(|e| format!("cannot start recording: {e}"))?;
        let opened = opened_rx
            .recv()
            .map_err(|_| "the recording stopped while opening".to_owned())??;
        Ok((
            Self {
                stop: Some(stop_tx),
                thread: Some(thread),
            },
            opened,
        ))
    }

    pub fn stop(mut self) {
        self.close();
    }

    fn close(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Streams {
    fn drop(&mut self) {
        self.close();
    }
}
