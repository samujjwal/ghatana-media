# Audio repair comparison

This module keeps source and repaired PCM revisions separate and reports
SHA-256 fingerprints, changed-sample count, RMS, peak, and SNR only when the
caller supplies an independent reference. Inputs are bounded to 16 MiB and
must have the same signed PCM format, sample rate, channels, duration, and
length. The byte ceiling is checked from metadata before materializing input
copies. The defensive `AudioData` copies make both stored revisions immutable
to callers.

`AudioRepairComparison.undo()` returns a fresh copy of the exact source branch.
Its metrics include source/output peak and RMS, RMS change in dB, near-full-scale
sample counts (>=99.9% of signed PCM full scale; a clipping indicator, not proof
that clipping occurred), and SNR only with an independent reference. For stereo
it reports zero-lag correlation between the first two channels and the absolute
change as an explicit phase/polarity proxy; this is not a spectral phase or
perceptual-quality score, and it is omitted for mono or silent stereo channels.
Exact format, frame count, duration and bounded
payload checks reject drift rather than trimming or padding either revision.

The deterministic waveform repair primitives live in the adjacent
`speech-audio-rust` crate: a noise-profile block gate and bounded linear
interpolation across clipped runs. These are classical local DSP operations,
not RNNoise or a qualified speech-enhancement model. Synthetic metrics verify
the tested vectors only; representative lawful audio, independent references,
perceptual tolerances, and host/resource qualification remain required for a
real quality claim. No source file or external provider is modified by this
comparison module.

`PcmStemMixer` validates each stem and checks its typed local rights evidence
against the exact source version before rendering; this is not an external
rights authority or qualification. A stem with exactly zero gain contributes no
samples; after validation it skips PCM sample conversion and accumulation while
preserving the same output bytes. This local optimization does not establish
lawful production audio, certified true-peak measurement, perceptual mastering
quality, or durable project revision and delivery.

The mix result also exposes an explicitly scoped BS.1770-5 Annex 2-based 4x
four-phase FIR peak estimate, including its method ID/version and finite-buffer
policy (`zero-extension-including-fir-tail`). The reported value is the greater
of the native sample peak and FIR oversampled-grid peak; both components are
available in the measurement. The mixer uses this value and its existing
windowed-sinc estimate in the pre-limit gain guard, then rechecks quantized PCM
against the ceiling. This is an estimate-based ceiling guard, not a proof of the
continuous-time peak or a hard true-peak guarantee. Existing windowed-sinc
accessors remain available for compatibility. No BS.2217 corpus validation is
included. Algorithm basis: [ITU-R BS.1770-5, Annex 2](https://www.itu.int/rec/R-REC-BS.1770-5-202311-I).

The `examples/media-creative-preview` consumer also has an `audioRepairPreview`
task for caller-provided signed PCM WAV. It writes separate source and
linear-interpolation candidate WAVs and verifies the persisted PCM/digest
lineage. The local format and 16 MiB payload bounds, clipping heuristic,
algorithm assumptions, and quality limitations are documented in the example
README; this consumer does not establish rights, independent-reference quality,
or durable J-07 behavior.
