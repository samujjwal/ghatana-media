# Audio repair comparison

This module keeps source and repaired PCM revisions separate and reports
SHA-256 fingerprints, changed-sample count, RMS, peak, and SNR only when the
caller supplies an independent reference. Inputs are bounded to 16 MiB and
must have the same signed PCM format, sample rate, channels, duration, and
length. The defensive `AudioData` copies make both stored revisions immutable
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
