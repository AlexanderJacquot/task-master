# ADR 026: Scribe audio capture and speech models

Date: 2026-11-14 · Status: accepted in principle; crate versions are pinned after the
M19 build spike

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
