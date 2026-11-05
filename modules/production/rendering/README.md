# Bounded video frame restoration

This module implements one local candidate operation: temporal median denoising
over host decoded, 8-bit RGB frames for the exact `media.enhance.video.temporal-denoise`
capability. It requires an explicit source artifact id, exact version and SHA-256,
purpose, policy decision, and rights evidence. A host supplied rights authority is
checked before reading source pixels and again before returning a candidate. The
frame source must return bytes for that exact version; this module verifies the
frame set's identity, order, rational PTS, ROI, frame digests, and size limits.

The algorithm uses a three-frame per-channel median and preserves all input
frame dimensions, ordering, timestamps, time base, and ROI. Pixels outside the
explicit ROI are copied unchanged. The operation emits an immutable decoded RGB
candidate plus exact lineage and a content digest. It does not create or mutate a
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
provider. Motion can create temporal artifacts; callers must inspect the
candidate. Deblur, color reconstruction, super-resolution, and unsupported
profiles remain unavailable. No output is claimed to be playable video.

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
