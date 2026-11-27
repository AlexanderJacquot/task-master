# ADR 026: Scribe audio capture and speech models

Date: 2026-11-14 · Status: accepted; capture and storage settled by the M19 spike
(2026-11-15, below), speech models by M20 (2026-11-18, below)

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
  later needs `com.apple.security.device.audio-input`. (Since 0.23.0 the macOS bundle is
  ad-hoc signed with the hardened runtime, ADR 027, so `src-tauri/entitlements.plist`
  carries it.)
- **Opus: `opus-rs` =0.1.42** (a pure-Rust port of libopus 1.6, BSD-3-Clause; pinned
  exactly as it releases often) **in `ogg` 0.9.2** (BSD-3-Clause). 24 kb/s SILK wideband
  mono at 16 kHz is about 11 MB an hour per track. Decoding is the same crate, for
  transcription.
- **Resampling to 16 kHz and the mixdown are in-house** (`scribe/audio.rs`, a windowed-sinc
  resampler at exact rational positions; unit tested), not `rubato`.
- **No `unsafe`** in the app: the FFI is inside cpal.
- CI gets a `native` job (Windows, macOS) that lints and tests the desktop crate, because
  the capture code compiles nowhere else before a release tag.

## M20 notes (2026-11-18)

- **Crates.** `whisper-rs` 0.16.0 (whisper.cpp built from source by cmake; `metal` on
  macOS, CPU on Windows) and `sherpa-onnx` 2.0.1 with `static` (prebuilt sherpa-onnx and
  onnxruntime static libraries, downloaded by its build script): **no dylib to bundle or
  notarize**. Both are dependencies on Windows and macOS and dev-dependencies elsewhere, so
  Linux CI lints and tests the engines while Linux releases ship without them
  (`scribe_status.transcription` is false there). `.cargo/config.toml` sets
  a portable AVX2 baseline instead of `-march=native`, and `+crt-static` on Windows
  (sherpa-onnx's Windows libraries use /MT).
  GitHub's runners already have cmake; no workflow change was needed. whisper.cpp uses
  `std::filesystem`, so the macOS app needs 10.15 or later (`minimumSystemVersion`, 0.23.2).
  On Windows it is built with the static C runtime (`CMAKE_MSVC_RUNTIME_LIBRARY`) and its
  bindings are generated with libclang (0.23.1). The `cmake` crate replaces CMake's
  Release flags (`/O2 /Ob2 /DNDEBUG`) with its own, which have no /O flag, so up to
  0.31.0 MSVC compiled whisper.cpp unoptimized; `.cargo/whisper-msvc.cmake`
  (`CMAKE_PROJECT_INCLUDE`) puts them back.
- **Models.** `models.rs` pins URL, size and SHA-256 of whisper `large-v3-turbo` (1.6 GB)
  and `small` (488 MB) from `ggerganov/whisper.cpp`, and of the support files fetched with
  the first one: pyannote segmentation 3.0 and WeSpeaker ResNet34 (sherpa-onnx exports)
  and Silero VAD v6.2.0 (`ggml-org/whisper-vad`), 33 MB together. Pins checked against
  Hugging Face's LFS metadata on 2026-11-18. Files live in the app's local data folder
  (`scribe-models/`), download as `.part` and resume with a `Range` request.
- **Voice detection is ours, not whisper.cpp's.** whisper.cpp applies its `vad` option
  only in `whisper_full`, not in `whisper_full_with_state`, which whisper-rs calls: the
  option is silently ignored. `engine.rs` runs Silero (`WhisperVadContext`) itself, copies
  the stretches of speech one after the other with 300 ms of silence between them
  (`condense`), transcribes that, and maps each word back exactly (`to_track`). A word
  whisper stretches over a pause is kept to the stretch it overlaps most.
- **Speakers.** Diarization on the computer's sound only, clustering threshold 0.4 (errs
  toward one voice found as two: one "same voice as" merge to fix). `merge.rs` gives each
  word the voice whose turn overlaps it most, then moves a change of voice that falls
  within two words of a sentence end to that end (whisper's times are least sure at pauses,
  people rarely hand over mid-sentence). Echo of the others in the microphone (no
  headphones) is dropped when most of a microphone segment's words were said on the
  computer's sound at the same time.
- **Tried on real speech** (WSL, Linux build of the engines, `tiny` model): two synthesized
  voices on the computer's sound and one on the microphone, 33 s + 40 s, transcribed in 5 s
  of CPU; every line had the right speaker and started within 0.2 s of the truth
  (`pipeline.rs` ignored test `real_models_transcribe_a_recording`). Not run on Windows or
  macOS hardware, nor with Metal.

