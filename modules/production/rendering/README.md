# Bounded video frame restoration

This module implements bounded local candidate filters over host decoded, 8-bit
RGB frames: temporal median denoising, opt-in ROI unsharp mask, and caller-tuned
per-channel RGB gain/offset. It requires an explicit source artifact id, exact
version and SHA-256, purpose, policy decision, and rights evidence. A host supplied
rights authority is checked before reading source pixels, before reference access,
and again before returning a candidate. Each filter uses an exact operation id;
unsharp/color parameters carry a caller version and content-derived SHA-256 in
candidate lineage. The frame source must return bytes for that exact version; this
module verifies frame identity, order, rational PTS, ROI, frame digests, and size
limits.

The temporal median uses a three-frame per-channel median. Unsharp mask uses a
3x3 RGB box mean with edges clamped within the ROI, then computes
`round-half-up(original + amount * (original - blur))`; amount is finite and
bounded to `[0,2]`. RGB adjustment computes
`round-half-up(sample * channelGain + channelOffset)`; gains are finite in
`[0,4]`, offsets are in `[-255,255]`. Both local filters clamp output channels
to `[0,255]`. All operations preserve input dimensions, ordering, PTS, rational
time base, exact source version, and pixels outside the explicit ROI. The
operation emits an immutable decoded RGB candidate plus exact lineage and a
content digest. `clippedSamples` counts output channel samples whose rounded
pre-clamp value fell outside `[0,255]`; `sourceDelta` reports the observed
source/candidate sample change separately. It does not create or mutate a
canonical Media artifact or job.

Each result includes a source-versus-candidate RGB sample delta (changed sample
count, mean absolute change, and maximum absolute change). This describes the
actual A/B pixel difference only; it is not a perceptual quality or improvement
score.

An aligned and separately authorized reference frame set enables global luma
SSIM (`GLOBAL_SRGB_LUMA_SSIM_V1`) and RGB PSNR (`RGB8_SAMPLE_PSNR_V1`). These are
reported as measurements against that reference only; they are not a universal
quality guarantee or a subjective improvement claim. Without an authorized
reference, comparison is explicitly unavailable. Exact matches are reported as
such instead of serializing infinite PSNR.

This is a frame-processing SPI, not a video decoder, motion compensator, codec,
container muxer, upload path, runtime endpoint, or qualified restoration
provider. Temporal median may create motion artifacts; unsharp mask may amplify
noise or halos; RGB adjustment is a deterministic arithmetic transform, not
automatic color correction. No filter claims subjective improvement. An
independently authorized aligned reference can produce measured candidate-vs-
reference metrics; these filters do not claim improvement from that comparison
alone.
Blur-kernel estimation, deblur, automatic color reconstruction, super-resolution,
and unsupported profiles remain unavailable. No output is claimed to be playable
video. Reference metrics are emitted only after a separate exact reference
version is authorized and aligned; they measure candidate-vs-reference values,
not general real-image/video quality.

## Limits

- RGB8 frames only; 3 to 64 frames per set.
- Each frame is at most 2048 by 2048 pixels; the entire set is at most 16 Mi
  pixels and 64 MiB of RGB data.
- One explicit in-bounds ROI is required and must match across the set.
- Time base is a positive bounded rational; frame indexes start at zero and PTS
  values strictly increase.
- Source and optional reference artifact identity, version, SHA-256 and evidence
  references are validated; external currentness and access authority remain
  injected host responsibilities.

## Tests

```bash
./gradlew :services:media:modules:production:rendering:test
```

Tests use small decoded RGB vectors with known ground truth. They do not qualify
any production decoder, codec, provider, content license, host performance, or
real video quality profile.

## Quality comparison and optimization

`QualityComparisonAndOptimization` adds exact-revision A/B comparison and
reversible optimization orchestration. Reports bind source, candidate, and (when
admitted) reference media revision identifiers and digests. Reference-measured
RGB8 PSNR and global-luma SSIM are separated from source-delta and spatial
activity heuristics. Reports contain no wall-clock fields and use a deterministic
digest. A reference requires a fresh injected rights decision, exact reader
identity, and matching frame count, dimensions, timebase, and presentation ticks.
Source rights are rechecked before report disclosure.

The orchestrator retains the original and every returned candidate in attempt
order; `undo` selects the original exact revision and immutable RGB arrays.
Pixel, byte, and attempt budgets are explicit and bounded, including aggregate
candidate/reference bytes. Null, unsupported, or unavailable candidate ports
produce typed non-success results without a fabricated candidate. Improvement is
reported only when PSNR and SSIM against a lawful aligned reference both improve
over the source. These metrics are still limited to decoded RGB8 data and do not
qualify codecs, encoders, muxing, or general perceptual quality. Synthetic-array
tests validate arithmetic and boundaries, not real-media behavior or rights.
