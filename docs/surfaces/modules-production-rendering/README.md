# Surface: `modules-production-rendering`

Bounded rendering plans, decoded-frame restoration, image-frame encoding, and
candidate comparison in `modules/production/rendering`.

## Responsibility

- `MultitrackRenderPlanner` validates a typed multitrack graph, maps source PTS
  into timeline time, creates a canonical manifest and digest, and delegates
  execution only to an injected codec pipeline.
- `TemporalVideoRestoration` applies deterministic temporal median, unsharp
  mask, or RGB gain/offset transforms to exact-version decoded RGB8 frames,
  with source/reference rights checks, candidate lineage, and bounded metrics.
- `PngFrameCodec` decodes and encodes bounded **PNG still frames and ordered
  collections of still PNGs**. It is not a video-container decoder or encoder
  and does not establish artifact provenance. A trusted host decoder must bind
  source bytes to the requested artifact/version before constructing
  `DecodedFrameSequence`; the codec's `DecodedPngFrameSequence` alone is not
  such a binding.
- `QualityComparisonAndOptimization` retains immutable source/candidate
  revisions, compares them with an independently supplied authorized reference
  when available, and supports restoring the exact source revision.
- `BoundedRenderOutput` provides a byte-limited output stream for callers.

This module does not persist Media artifacts, mutate jobs or timelines, provide
a production video codec/muxer, or qualify a renderer/provider. It does not
establish lawful source/reference rights itself: injected authorities and host
adapters own those decisions and exact-byte reads.

The separate [`local multitrack preview`](../../../examples/recorder-mux-preview/multitrack/README.md)
uses synthetic video, graphic, audio, and caption layers with a pinned local
FFmpeg build. It demonstrates only preview-file composition and does not call
or admit `MultitrackRenderPlanner` execution, bind a canonical project, or prove
source rights, production quality, or artifact registration.

## Public operations

- `MultitrackRenderPlanner.plan(graph)` returns `PLAN_READY` and an immutable
  canonical plan or a typed refusal. `execute(plan, pipeline)` delegates to the
  supplied `CodecPipeline`; absent or unavailable execution returns
  `NOT_ADMITTED`/`UNAVAILABLE`, never fabricated rendered output.
- `TemporalVideoRestoration.restore(request, sourceRights, source, referenceRights,
  reference)` checks rights at access boundaries and returns `COMPLETED`,
  `NOT_ADMITTED`, or `UNAVAILABLE` with an optional immutable RGB candidate.
- `PngFrameCodec.decode(encodedPng, metadata[, limits])` decodes one supported
  RGB PNG image. `decodeSequence(timeBase, frames[, limits])` validates and
  decodes 3–64 PNG images with ordered indexes and timestamps.
  `encode(candidateFrame[, limits])` encodes one RGB candidate frame to PNG;
  `encodeSequence(timeBase, candidateFrames[, limits])` returns 3–64 ordered
  still PNGs with caller-supplied timebase and per-frame PTS/ROI metadata. The
  sequence output is not a video container or a provenance-bearing artifact.
- `QualityComparisonAndOptimization.optimize(...)` runs bounded candidate
  attempts, reports source and candidate PSNR/SSIM against the same authorized
  reference, and returns a disposition derived from both pairs. Its V3 report
  digest binds all four measurements and the disposition. These decoded RGB8
  measurements do not qualify codec or general perceptual quality.
  `undo(run, exactSourceRevision)` selects the retained exact source revision.
- `BoundedRenderOutput` accepts writes up to its configured byte limit and
  fails when another write would exceed it.

## States and invariants

- Planner outcomes are `PLAN_READY`, `NOT_ADMITTED`, or `UNAVAILABLE`; plan
  readiness is not rendered-media completion. No job state machine is owned
  here.
- Planner execution converts runtime failures while observing host codec
  admission or availability into typed `UNAVAILABLE`; it does not dispatch a
  render. Execution remains unavailable until an executable codec pipeline is
  implemented and admitted.
- Restoration and optimization distinguish completed work from admission or
  availability failures. Rights are checked by injected authorities and are
  rechecked before disclosure; caller-asserted rights are not accepted.
- Nonempty authority decision IDs are exact identities; the restoration and
  quality-comparison records reject surrounding whitespace instead of
  normalizing a potentially different rights-evidence reference.
- Restoration sequences contain 3–64 RGB8 frames, bounded to 2048×2048 each,
  16 Mi pixels and 64 MiB aggregate RGB. Frame indexes are contiguous, PTS
  strictly increase, and timebase, dimensions, ROI, artifact/version binding,
  order, and pixel digests are validated. ROI is explicit and in bounds.
- PNG input accepts only non-interlaced 8-bit truecolor RGB PNG with validated
  chunk CRCs and no unsupported ancillary/animation chunks. Dimensions and
  encoded/output/aggregate pixel budgets are checked before decoding/encoding;
  metadata dimensions must equal the PNG header. Sequence metadata must be
  contiguous and timestamps strictly increasing.
- PNG metadata is caller-supplied descriptive frame metadata. Decoding proves
  the bytes form a supported PNG image with matching dimensions; it does not
  prove which artifact/version supplied those bytes. Only a trusted host
  decoder that binds exact source bytes/version may construct the restoration
  `DecodedFrameSequence`.
- Candidate arrays are defensively copied. Filters preserve frame shape,
  ordering, PTS, timebase, and pixels outside the declared ROI. Filter
  parameters and source/candidate pixel digests are retained in lineage.
- Reference comparisons require separately authorized, aligned reference
  frames. SSIM, PSNR, RGB deltas, clipping and spatial activity are measurements
  over decoded pixel values; metrics and synthetic tests do not prove
  perceptual quality, improvement in general, or real-reference qualification.
- Planner time values are bounded rational values; graph references,
  intervals, transitions, and captions are validated before canonicalization.
  Planning never implies an injected pipeline ran successfully.

## Dependencies and configuration

- Runtime code uses the Java platform (including `javax.imageio`) and classes
  within this module. There are no network services, credentials, models, or
  environment variables required by these primitives.
- JUnit Jupiter and AssertJ are test-only dependencies. The module is registered
  as `:services:media:modules:production:rendering` in Gradle.
- `PngFrameCodec.Limits.defaults()` sets 16 MiB per encoded input and output,
  2048 maximum dimension, 4,194,304 pixels per frame, and 64 MiB aggregate
  encoded sequence bytes. Callers can supply stricter limits; global frame,
  pixel, and RGB ceilings still apply.
- Restoration/reference authorities and exact-version frame readers are
  constructor/call-site supplied ports. Their configuration and trusted host
  decoder behavior belong to the owning runtime, not this module.

## Errors

- Invalid graph, unsupported planner input, malformed PNG, inconsistent frame
  metadata, arithmetic overflow, or resource-limit violations fail with
  `IllegalArgumentException` (or its documented subtype); PNG I/O failures are
  surfaced as `IllegalArgumentException` with the decoding/encoding cause.
- Planner execution reports typed `NOT_ADMITTED` or `UNAVAILABLE` outcomes
  when no executable codec pipeline is available.
- Restoration/quality operations report typed denial, unavailable authority,
  revoked/unknown source, reference unavailability, or unavailable metric
  outcomes. They do not turn these into successful fabricated output.
- `BoundedRenderOutput` throws `IOException` when a write exceeds its configured
  maximum or when writing after close.

## Tests and commands

Run the focused module suite from the repository root:

```bash
./gradlew :services:media:modules:production:rendering:test
```

The tests cover planner validation and execution refusal, deterministic filter
arithmetic and ROI preservation, authority denial/unavailability, reference
alignment and metrics, optimization bounds and undo, PNG encode/decode round
trips, ordered candidate-sequence encoding, malformed/unsupported PNG chunks
and CRCs, inconsistent metadata, defensive copies, and resource limits. These
tests and reported metrics validate
code paths and pixel arithmetic only; they do not prove perceptual quality,
production decoder/encoder behavior, lawful media rights, or real reference
qualification.
