# Speech audio Rust support crate

This crate provides local audio data and DSP utilities. Its public Rust API is
not an STT, TTS, or streaming provider interface. The 63 capability memberships
in `docs/implementation/MEDIA-BACKEND-REMAINDER-SOURCE-COVERAGE.v1.json` are
source-intent/task ownership rows, not evidence that this crate implements or
is consumed by those capabilities.

## Public API and consumer boundary

`src/lib.rs` exports:

- Data and errors: `SampleFormat`, `AudioConfig`, `AudioBuffer` (including
  `new`, `frame_count`, and `duration_seconds`), `AudioMetadata`,
  `SpeechAudioError`, and `Result<T>`.
- Bounded file input: `DecodeLimits`, `load_audio_metadata`,
  `load_audio_buffer`, and `load_audio_buffer_bounded`.
- Local transforms: `Resampler::{new, with_options, resample}`,
  `slice_audio_buffer`, and `mix_audio`.
- File output and visualization support: `write_wav` and `extract_waveform`.

The only in-repository Rust source consumer found for this crate is its
`examples/decode-rss-probe.rs` example. The topology source coverage records
`consumerSurfaceRefs: []` for this physical surface. The example is a local
resource probe, not a Media runtime consumer. No Java/JNI, C ABI, provider
adapter, STT/TTS engine, or streaming session/frame API is exported here.

## Build and platform evidence

On 2026-11-03, the locked crate passed `cargo fmt --check`,
`cargo test --locked --offline` (55 unit tests; 0 doc tests), and
`cargo clippy --locked --offline --all-targets -- -D warnings` with Rust 1.94.0
on `aarch64-apple-darwin`. Offline mode confirms this run used the dependencies
already available locally; it does not establish builds for other target
triples. There is no Java consumer in `modules/`, so no Java consumer vector or
supported Java/FFI platform is claimed. The repository has no Cargo config
setting a shared target directory or artifact cleanup policy; this check left
the normal `target/` artifacts in place.

## Capability disposition

All 63 IDs below are service-level intents assigned to RS work for review. The
crate supplies reusable local audio primitives where useful; it does not
provide the corresponding service capability. “Delegated” here means the
capability belongs outside this support crate. It does not assert that a
runtime provider is installed, admitted, qualified, or currently connected.

| Capability family | Count | Exact source capability IDs | Crate disposition |
| --- | ---: | --- | --- |
| Streaming (RS-06) | 17 | `media.stream.session.open`, `media.stream.session.connect`, `media.stream.frame.submit`, `media.stream.frame.acknowledge`, `media.stream.session.close`, `media.stream.session.reconnect`, `media.stream.ordering.enforce`, `media.stream.lease.renew`, `media.stream.buffer.bound`, `media.stream.backpressure.apply`, `media.stream.recording.integrate`, `media.stream.live-processing.integrate`, `media.stream.transport.webrtc`, `media.stream.transport.adaptive-http`, `media.stream.transport.hls`, `media.stream.transport.dash`, `media.stream.caption.live` | Delegated to the streaming/service boundary. No session, transport, lease, frame, ACK, or live-caption implementation is exported by this crate. |
| Speech transcription (RS-01) | 16 | `media.speech.transcription.file`, `media.speech.transcription.stream`, `media.speech.transcription.language.detect`, `media.speech.transcription.voice-activity.detect`, `media.speech.transcription.speaker.diarize`, `media.speech.transcription.speaker.segment`, `media.speech.transcription.speaker.separate`, `media.speech.transcription.speaker.identify-authorized`, `media.speech.transcription.word-timestamp.create`, `media.speech.transcription.phoneme-timestamp.create`, `media.speech.transcription.forced-align`, `media.speech.transcription.punctuate-capitalize`, `media.speech.transcription.alternatives.provide`, `media.speech.transcription.confidence.provide`, `media.speech.transcription.translate`, `media.speech.transcription.subtitle.generate` | Delegated to the STT/product service boundary. Decode, slicing, and waveform utilities do not transcribe, identify speakers, align, translate, or generate subtitles. |
| Audio analysis (RS-04) | 13 | `media.audio.analysis.segment.content-kind`, `media.audio.analysis.measure.loudness`, `media.audio.analysis.measure.peaks`, `media.audio.analysis.detect.clipping`, `media.audio.analysis.measure.noise`, `media.audio.analysis.analyze.spectral`, `media.audio.analysis.analyze.phase`, `media.audio.analysis.analyze.channels`, `media.audio.analysis.detect.beat-onset`, `media.audio.analysis.detect.silence`, `media.audio.analysis.diagnose.source-separation`, `media.audio.analysis.assess.timing`, `media.audio.analysis.assess.intelligibility` | Unowned source-to-runtime gap: no canonical analysis executor/provider or consumer is identified in the current Media modules, libraries, or adapters. PDP-0 marks these intents `TARGET` / `IN_SCOPE_DRAFT` and does not select an algorithm or provider. They are not delegated, so RS-01 acceptance remains open for this family. `extract_waveform` returns bucket samples only; it is not evidence of these analysis capabilities. |
| Speech synthesis (RS-01) | 17 | `media.speech.synthesis.text-to-speech`, `media.speech.synthesis.streaming`, `media.speech.synthesis.multilingual`, `media.speech.synthesis.cross-lingual`, `media.speech.synthesis.expressive`, `media.speech.synthesis.control.prosody`, `media.speech.synthesis.control.rate`, `media.speech.synthesis.control.pitch`, `media.speech.synthesis.control.emotion-style`, `media.speech.synthesis.control.pronunciation`, `media.speech.synthesis.control.phoneme`, `media.speech.synthesis.speaker.condition`, `media.speech.synthesis.speaker.clone-authorized`, `media.speech.synthesis.voice.convert`, `media.speech.synthesis.speech-to-speech`, `media.speech.synthesis.speech.translate`, `media.speech.synthesis.dub` | Delegated to the TTS/product service boundary. WAV encoding and mixing are audio utilities, not generated speech or voice-cloning behavior. |

These groups total 63. The local primitives (bounded decode, resampling,
sample-window slicing, scalar-gain mixing, WAV writing, and waveform buckets)
remain support operations; they are not additional capability IDs and do not
establish provider or product behavior. Keep the exact source IDs and ownership
in the existing source coverage/topology; do not create a second registry here.
