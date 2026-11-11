# Surface: `modules-production-audio-mixing`

Bounded local PCM stem mixing and immutable audio-repair comparison primitives
in `modules/production/audio-mixing`.

## Responsibility

- `PcmStemMixer` mixes aligned signed 16-bit little-endian stereo PCM stems,
  applies bounded per-stem gain/pan, estimates inter-sample peaks, applies a
  global ceiling and encodes WAV output.
- `AudioRepairComparison` compares immutable PCM source and repaired revisions,
  supports restoring the exact source branch, and reports sample-level metrics
  (with SNR only when an independent reference is supplied).
- `BoundedPcmDeclipper` creates a local PCM candidate by linearly interpolating
  bounded interior clipped runs, returning typed errors for unsupported or
  underdetermined inputs.
- The runnable [`media-creative-preview` consumer](../../../examples/media-creative-preview/README.md)
  preserves separate synthetic clipped-source and repaired-candidate WAVs,
  reopens both through Java Sound, and records their digests plus descriptive
  PCM-only comparison metrics. Its example is not a quality benchmark.
- The same example exposes `foleyStemMasterPreview` for 1–16 caller WAV stems.
  It accepts exact-rate, exact-frame, little-endian PCM16 stereo input, calls
  `PcmStemMixer`, writes and reopens a playable WAV master, and records input
  and output digests plus mix observations. Caller-declared rights are marked
  unverified; peak output is an estimate, not certified mastering evidence.
- The same consumer accepts a caller-provided signed PCM16/24/32 mono/stereo
  WAV up to 16 MiB of decoded PCM. It snapshots bounded input bytes, writes
  separate source and bounded-declip candidate WAVs, reopens both, and binds
  their PCM/file digests and descriptive metrics in a local manifest. The
  input is never overwritten; rights, independent-reference, quality, durable
  revision, and hosted-job evidence are not supplied.
- The Rust `speech-audio-rust` crate also has a runnable caller-file preview:
  `cargo run --offline --manifest-path modules/intelligence/speech/libs/speech-audio-rust/Cargo.toml --example audio-repair-preview -- INPUT OUTPUT_DIR NOISE_START_FRAME NOISE_END_FRAME`.
  It requires the caller's explicit noise-only frame span, copies the exact
  encoded source into its own branch, and emits separate denoise-only and
  declip-only float WAV candidates using the crate's default denoise options
  and a 0.98 declip threshold. It reopens outputs, binds SHA-256 file
  digests and descriptive `compare_audio` metrics, and records effective
  parameters plus decoded sample rate, channels, sample format, and frame
  count for the source and each candidate. It records no independent reference
  or quality claim. Existing output paths are rejected. Input,
  decoded-sample (lowered to the 6,000,000 repair-sample cap), profile-frame,
  channel, sample-rate, and decode-time bounds come from the crate APIs; this
  local example does not create durable timeline A/B revisions or complete
  J-07.
- This is an in-memory DSP surface. It does not persist timeline revisions,
  create a durable A/B branch, generate music/Foley, establish actor authority,
  or qualify rights. Asset inputs require typed, current, exact-version
  `PCM_STEM_MIX` rights evidence at invocation; this evidence check is not an
  external rights decision service.

## Public operations

- `PcmStemMixer.mix(stems, spec, clock)` returns PCM/WAV bytes, SHA-256 digests,
  applied master gain, estimated/sample peak, unweighted RMS dBFS, and
  `inputStems()` with the ordered exact version reference, asset/synthetic
  provenance, gain, and pan for each validated input.
- `AudioRepairComparison.compare(source, repaired[, reference])` returns
  defensive-copy source/repaired values, digests, metrics and `undo()` for the
  source value. Inputs must be same-shape, bounded PCM.

## States and invariants

- Calls are synchronous and return a result only after validation and mixing;
  there is no job or persisted state machine here.
- Mixer input is limited to 16 stems, 1,000,000 frames, and 16 MiB aggregate
  PCM; each stem must exactly match requested sample rate, stereo S16 layout,
  and frame count. No implicit trim, pad, or resample occurs.
- The result's stem-lineage list is immutable and preserves the validated mix
  order. This is local render provenance; it does not establish external rights
  or create a durable project/master revision.
- Supported mixer rates are 8–192 kHz, gain is finite and bounded, pan is in
  [-1, 1], and ceiling is in (0, 0.98]. Returned byte arrays and input stems
  are defensively copied.
- The 4x linear-interpolation peak estimate and RMS dBFS are engineering
  metrics, not certified true-peak or BS.1770 LUFS measurements.
- `AudioRepairComparison` accepts non-empty 16 MiB maximum PCM with exact frame
  duration and 16/24/32-bit signed samples. SNR is `NaN` without an independent
  reference; stereo correlation is only a zero-lag phase/polarity proxy.
- `BoundedPcmDeclipper` uses little-endian signed PCM, a caller threshold, a
  16 MiB payload cap, and a maximum 4096-frame run. Since the source capability
  does not select reconstruction semantics or parameters, short interior runs
  are conservatively replaced by straight-line interpolation; runs touching an
  edge or exceeding the caller's tighter limit fail with `UNREPAIRABLE_RUN`.
  This estimates missing signal and does not claim recovery or quality.
- Deterministic synthetic DSP tests do not establish lawful-corpus or
  perceptual-quality qualification. Durable timeline A/B persistence and
  recovery are also open; no such integration is implemented by this module.

## Dependencies and configuration

- Runtime API dependency: Media Java common (`AudioData`/`AudioFormat`) for
  comparison values. Test dependencies are JUnit Jupiter and AssertJ.
- No external service, model, credentials, environment variables, or runtime
  configuration are required. Resource ceilings are constants in the code.

## Errors

`PcmStemMixer.MixException` exposes a typed `ErrorCode`: `INVALID_INPUT`,
`RIGHTS_MISSING`, `RIGHTS_STALE`, `RIGHTS_DENIED`, `FORMAT_MISMATCH`,
`RESOURCE_LIMIT`, or `ENCODE_FAILED`. `AudioRepairComparison` rejects invalid,
unsupported, mismatched, malformed, or oversized PCM with
`IllegalArgumentException`. The declipper exposes `INVALID_INPUT`,
`UNSUPPORTED_FORMAT`, `RESOURCE_LIMIT`, and `UNREPAIRABLE_RUN`.

## Tests and commands

```bash
./gradlew :services:media:modules:production:audio-mixing:test
./gradlew :services:media:examples:media-creative-preview:test
```

To run the caller-WAV preview, use the command and input constraints in the
[example guide](../../../examples/media-creative-preview/README.md).

Tests cover deterministic stereo mix, gain/pan and peak limiting, bounded PCM
declip interpolation and rejection cases, WAV
decodability, silence, rights-evidence denial/staleness, malformed formats,
resource bounds, defensive copying, comparison metrics and source restoration.
`J17MusicEffectsLocalScenarioTest` is explicitly a transient synthetic fixture;
it does not prove lawful source quality, perceptual acceptance, durable
timeline A/B, or actor/capability authorization.

`PcmStemMixerTest` also pins center, midpoint, and hard-left/right pan behavior
and checks that a single-channel stem does not crossfeed into the other stereo
channel (15/15 tests). These synthetic samples verify DSP mechanics only;
lawful production stems and perceptual/mastering qualification remain open.
