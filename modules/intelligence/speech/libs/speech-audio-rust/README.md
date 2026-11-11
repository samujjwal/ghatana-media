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
  `slice_audio_buffer`, `mix_audio`, and bounded waveform repair APIs
  `NoiseProfile`, `denoise`, `declip`, and `compare_audio`.
- File output and visualization support: `write_wav` and `extract_waveform`.

Before the local preview consumer below, the only in-repository Rust source
consumer found for this crate was `examples/decode-rss-probe.rs`. The topology
source coverage records `consumerSurfaceRefs: []` for this physical surface.
These examples are local tools, not a Media runtime consumer. No Java/JNI, C
ABI, provider adapter, STT/TTS engine, or streaming session/frame API is
exported here.

`examples/audio-repair-preview.rs` is a runnable local caller-input consumer of
the existing bounded decode, repair, WAV, and immutable comparison APIs. It
requires the caller to provide an explicit noise-only frame span, preserves an
exact copy of the encoded source file, and writes denoise-only and declip-only
WAV candidates as separate branches. It reopens every output, binds SHA-256
file digests and descriptive PCM metrics in a JSON manifest, and does not
produce reference-SNR values without an independent reference: both source and
candidate SNR fields are present as JSON `null` in that case. It does not make a
quality conclusion. It uses
`DenoiseOptions::DEFAULT` and a 0.98 declip threshold; the two operations are
never chained. The manifest records the effective algorithm options (including
the caller-selected profile span and measured per-channel profile RMS), plus
sample rate, channel count, sample format, and frame count for the source and
each decoded candidate. Run it with:

```bash
cargo run --offline --manifest-path modules/intelligence/speech/libs/speech-audio-rust/Cargo.toml \
  --example audio-repair-preview -- INPUT_AUDIO OUTPUT_DIRECTORY NOISE_START_FRAME NOISE_END_FRAME
```

The source is limited by the existing 512 MiB encoded-input cap and the
preview lowers the decoder's 96,000,000 default decoded-sample ceiling to the
repair API's 6,000,000 interleaved-sample cap. Noise profiling is limited to
2,000,000 frames. A profile span must be non-empty and
within the decoded source. Output names are fixed within the selected directory;
existing paths and collisions are rejected before writing. This example is
local preview tooling only and does not establish lawful corpus/reference
qualification, durable timeline revisions, or J-07 completion.

## Build and platform evidence

On 2026-11-03, the crate passed `cargo fmt --check`,
`cargo test --offline` (57 unit tests; 0 doc tests), and
`cargo clippy --offline --all-targets -- -D warnings` with Rust 1.94.0
on `aarch64-apple-darwin`. Offline mode confirms this run used the dependencies
already available locally; it does not establish builds for other target
triples. There is no Java consumer in `modules/`, so no Java consumer vector or
supported Java/FFI platform is claimed. The repository has no Cargo config
setting a shared target directory or artifact cleanup policy; this check left
the normal `target/` artifacts in place.

The deterministic RS-07 harness is `examples/rs07-benchmark.rs`. Run it with
`cargo run --offline --example rs07-benchmark`. On this host, 15 measured runs
after two warmups reported resample p50/p95 0.229384/0.243778 seconds (5-second
48 kHz mono input to 16 kHz; RTF 0.045877) and decode p50/p95
0.009406/0.009657 seconds (10-second generated PCM16 WAV; RTF 0.000941).
Output checksums were stable across runs. Process CPU was 4.299717 seconds and
peak RSS was 4,947,968 bytes for the whole harness process, including setup;
these are diagnostic host-specific observations, not thresholds or portable
qualification.

The RS-02 `decode-rss-probe` and `scripts/measure-speech-audio-rss.py` also
measure deterministic generated PCM WAV in isolated child processes. They do
not measure compressed-codec transient allocation: the crate pins Symphonia
decoders but has no pinned encoder for generating a valid compressed fixture,
and an external encoder would make the workload depend on an unpinned tool.
`compressed_source_byte_budget_rejects_before_codec_probe` instead verifies
that a synthetic MP3-labeled file over the caller's byte cap is rejected before
codec probing. Compressed packet allocation therefore remains unmeasured; the
per-packet output cap and the cooperative time ceiling do not interrupt or
bound an individual synchronous codec allocation/call.

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

## Bounded waveform repair

`NoiseProfile::estimate` measures per-channel RMS only over a caller-designated
noise-only span; the crate does not guess the noise region. `denoise` applies a
block RMS gate with interpolated gain and one shared gain across channels.
`declip` reconstructs only interior clipped runs by linear interpolation and
returns a typed error for edge or overlong runs. Input and output are immutable
separate buffers. Repair is linear in at most 6,000,000 interleaved samples;
profile scans are capped at 2,000,000 frames, channels at 8, sample rate at
768 kHz, and clipped runs at 4,096 frames. `compare_audio` requires exact PCM
shape and reports RMS, peak, changed-sample count, and both source and repaired
SNR against the same explicit independent reference. This paired measurement
makes measured gains or regressions visible without implying perceptual quality.
It also reports source/output near-full-scale
sample counts (>=99.9%; an indicator, not proof of clipping) and the change in
zero-lag correlation of the first two channels (a phase/polarity proxy, not a
spectral or perceptual score). `AudioComparison` retains owned source and
repaired buffers and exposes read-only `source()`, `repaired()`, and `metrics()`
accessors; `undo()` returns a fresh copy of its stored source branch. Its fields
are private so callers cannot mutate a branch without recomputing its metrics.
These local DSP primitives are deterministic and bounded, but are not RNNoise,
do not establish perceptual speech quality, and have not been qualified against
representative lawful source/reference material or a production host performance
budget. The Java comparison surface adds SHA-256 digests; this Rust helper does
not persist revisions. The caller-input preview example computes SHA-256 file
digests for its local artifacts; that does not create a durable revision or
qualify artifact provenance.

Call `declip_bounded(input, clip_threshold, limits)` when the caller needs to
set a lower resource ceiling than the crate defaults. `RepairLimits` can reduce
the maximum interleaved samples and clipped-run frames, but cannot raise the
crate's hard caps; `max_profile_frames` applies to bounded noise-profile
estimation. `declip` remains the convenience form using the defaults. The
public bounded entry point does not change the interpolation method or qualify
its output; source truth and perceptual quality remain unverified.

## Resampler fidelity boundary

`Resampler` uses a bounded direct Blackman-windowed sinc kernel and computes
each source position from integer rate arithmetic. Unit vectors cover impulse
alignment, rational drift, channel isolation, an analytic in-band tone, and
downsampling alias attenuation. These synthetic checks establish those
specific properties for the tested vectors. They do not establish a general
speech-quality bound, codec interoperability/fidelity, or a portable
performance limit. `with_options` exposes tuning parameters without a fidelity
guarantee; application qualification still needs representative, lawfully
available source material and an independently selected reference and
tolerance. The implementation is not a polyphase resampler.
