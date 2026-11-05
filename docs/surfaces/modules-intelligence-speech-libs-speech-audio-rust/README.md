# Surface: `modules-intelligence-speech-libs-speech-audio-rust`

Speech audio Rust support crate
(`modules/intelligence/speech/libs/speech-audio-rust`). Local audio data
and DSP utilities — its public Rust API is **not** an STT, TTS or
streaming provider interface.

## Responsibility

- Data and errors: `SampleFormat`, `AudioConfig`, `AudioBuffer` (incl.
  `new`, `frame_count`, `duration_seconds`), `AudioMetadata`,
  `SpeechAudioError`, `Result<T>`.
- Bounded file input: `DecodeLimits`, `load_audio_metadata`,
  `load_audio_buffer`, `load_audio_buffer_bounded`.
- Local transforms: `Resampler::{new, with_options, resample}`,
  `slice_audio_buffer`, `mix_audio`.
- File output and visualization: `write_wav`, `extract_waveform`.

## Public operations

Library crate (`src/lib.rs`) consumed by Rust-side speech tooling;
examples include `rs07-benchmark.rs` and `decode-rss-probe.rs`.

## States and invariants

- The 63 capability memberships in
  `docs/implementation/MEDIA-BACKEND-REMAINDER-SOURCE-COVERAGE.v1.json`
  are source-intent/task-ownership rows — **not** evidence that this
  crate implements or is consumed by those capabilities.
- Bounded decode (`DecodeLimits`, `_bounded` loaders) enforces input
  limits locally; this is a data/DSP utility boundary, not a provider
  admission path.
- No STT/TTS/streaming semantics are defined here; provider behavior
  remains with the owning Java services and their admission gates.

## Dependencies and configuration

- Cargo crate; native audio decode via pinned toolchain per
  `docs/TESTING.md` (`mac-native`, `linux-arm64-native`).

## Errors

`SpeechAudioError`/`Result<T>` typed errors for decode, resample, mix
and WAV-write failures; bounds violations reject before allocation.

## Tests and commands

```bash
cargo test --manifest-path modules/intelligence/speech/libs/speech-audio-rust/Cargo.toml
cargo build --release --manifest-path modules/intelligence/speech/libs/speech-audio-rust/Cargo.toml
```

Benchmark/probe examples under `examples/`; DSP correctness coverage is
unit-level — no provider or transport qualification is implied.
