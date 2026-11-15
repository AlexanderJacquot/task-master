# ADR 026: Scribe audio capture and speech models

Date: 2026-11-14 · Status: accepted; capture and storage settled by the M19 spike
(2026-11-15, below), speech models by M20

## Context

Scribe (ADR 025) records two tracks, the microphone and the system output, on Windows and
macOS. It then transcribes them and separates the speakers on the device. None of the
crates for this are in the tree yet.

## Decisions

- **Capture:** `cpal` for the microphone everywhere and for WASAPI loopback on Windows.
  On macOS, system audio comes from ScreenCaptureKit (macOS 13+, `screencapturekit`
  crate) and needs the screen recording permission and its usage strings. On other OSes
  a stub reports that recording is unsupported.
- **Storage:** chunked 16 kHz mono WAV while recording, then Opus (`opus` /
  `ogg` crates or an equivalent pure-Rust encoder, chosen in the spike).
- **Transcription:** whisper.cpp through `whisper-rs`, built from source (cmake). Metal
  on macOS, CPU on Windows in v1.
- **Diarization:** sherpa-onnx (Rust bindings) with a pyannote segmentation model and a
  speaker embedding model, using prebuilt onnxruntime. It runs on the system track only;
  the mic track is "Me".
- **Models:** never bundled. Settings → Scribe offers whisper `large-v3-turbo` (≈1.6 GB)
  and `small` (≈0.5 GB). Either or both can be downloaded, and one is active. The
  diarization models (≈40 MB) come with the first download. Each file is checked against
  a pinned SHA-256 and stored under the app data dir.
- The workspace keeps `unsafe_code = "forbid"`. Any FFI stays inside these crates.

## Risks

- Native builds in `release.yml` on three OSes: cmake/clang for whisper.cpp, and
  notarization of the bundled onnxruntime dylib on macOS. Test this first.
- CPU transcription of a 1 h meeting with `large-v3-turbo` takes about 15–30 min.

## M19 spike (2026-11-15)

- **cpal 0.18.2 records both tracks on both systems.** On Windows an input stream on the
  default output device records it in loopback (WASAPI). On macOS the same call makes a
  CoreAudio process tap (macOS 14.6 and later). This replaces ScreenCaptureKit: no screen
  recording permission, only "system audio recording" (`NSAudioCaptureUsageDescription`)
  and the microphone (`NSMicrophoneUsageDescription`), both in `src-tauri/Info.plist`.
  Before 14.6, starting with "Record the computer's sound" on fails with a message saying
  to record the microphone only. cpal is a dependency on Windows and macOS only, so Linux
  needs no ALSA headers; there, `scribe_status` says recording is unsupported.
- **Releases are not signed**, so no entitlements file is needed. Signing and notarizing
  later needs `com.apple.security.device.audio-input`.
- **Opus: `opus-rs` =0.1.42** (a pure-Rust port of libopus 1.6, BSD-3-Clause; pinned
  exactly as it releases often) **in `ogg` 0.9.2** (BSD-3-Clause). 24 kb/s SILK wideband
  mono at 16 kHz is about 11 MB an hour per track. Decoding is the same crate, for
  transcription.
- **Resampling to 16 kHz and the mixdown are in-house** (`scribe/audio.rs`, a windowed-sinc
  resampler at exact rational positions; unit tested), not `rubato`.
- **No `unsafe`** in the app: the FFI is inside cpal.
- CI gets a `native` job (Windows, macOS) that lints and tests the desktop crate, because
  the capture code compiles nowhere else before a release tag.

