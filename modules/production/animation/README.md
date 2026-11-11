# 2D animation renderer

`AnimationRenderer` accepts the existing versioned `AnimationSpec` envelope plus a separately resolved, closed Java scene value. The PDP-1 envelope intentionally carries opaque version references; the owner has not asserted a field mapping from those references to scene objects. This module therefore makes no implicit graph lookup, asset fetch, or rights decision. Its first implementation profile explicitly supports pixel-space rectangles, ellipses, lines, caller-supplied in-memory ARGB raster assets, seeded particle fields, frame-index transform keyframes, four easing functions, and PNG output. Raster assets are immutable typed pixel arrays; the renderer does not open paths/URIs or run an asset decoder. Asset ids must resolve in the supplied scene and their aggregate area is bounded.

The renderer uses only the JDK 2D and PNG APIs. It executes no user code, expression, shader, or asset decoder. Coordinates and dimensions are pixels; keyframe translation is pixel-relative; scale is a nonnegative ratio; rotation is degrees; opacity is in `[0,1]`. Raster and vector shapes share the same center-based keyframe pivot, and raster geometry preserves exact fractional pixel bounds. Supported primitives are rectangles, ellipses, lines, and seeded procedural particle fields. Frame PTS is an exact rational number of seconds. Each frame also records the exact rational story-clock tick value derived from the envelope's initial tick and rational time base; overflow beyond the canonical signed-int64 tick domain is rejected. This is a local rendering assumption and does not establish a canonical PDP graph mapping or an approved external codec.

For local preview/playback checks, `renderAnimated` can sequence the generated PNG frames into an animated GIF using the JDK ImageIO writer. It accepts the GIF path only when `100 * fpsDenominator / fpsNumerator` is an integer centisecond delay in the GIF range; the delay and each exact PTS/story-clock pair are carried in the immutable output. A rate such as 24 fps is returned as `UNSUPPORTED_FRAME_RATE` because GIF cannot represent it exactly. WebP and MP4 currently return `UNSUPPORTED_CODEC`; there is no silent PNG, GIF, or other-codec fallback. A missing ImageIO GIF writer is reported as `CODEC_UNAVAILABLE`, and write/size failures produce `ENCODING_FAILED` without output bytes. The encoder caps its output buffer at the animation byte limit.

Inputs are bounded before rendering: 2048 by 2048 per frame, 240 frames, 33,554,432 total raster pixels, 4096 vector shapes, 64 particle fields, 10,000 particles per field, 1,000,000 particle draws per animation, 240 keyframes per shape, 16 MiB per encoded frame, and 64 MiB aggregate frame/GIF output. The JDK PNG writer produces real decodable pixels and the optional GIF path produces a decoder-readable animated file. This is a local candidate/preview export, not a persisted canonical artifact or an admitted production codec. The module does not produce video, audio sync, 3D, text/math layout, accessibility shadows, asset resolution, or qualified production media. Pixel identity/playback is checked on the test host/JDK; no cross-platform codec or renderer qualification is claimed.

## Runnable local consumer

The reusable API returns immutable PNG frame bytes from `render(...)` and an encoded GIF plus exact frame-clock metadata from `renderAnimated(...)`. The runnable consumer in [`examples/media-creative-preview`](../../../examples/media-creative-preview/README.md) writes six PNGs and an `animation.gif` to disk, hashes the persisted bytes, reopens PNG and GIF files through ImageIO decoders, and checks GIF frame count/dimensions before writing its local preview manifest. Run its tests and example from the Media repository root:

```bash
./gradlew --no-parallel --max-workers=1 \
  -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE \
  -Pghatana.media.compositeScope=FULL \
  :services:media:examples:media-creative-preview:test

./gradlew --no-parallel --max-workers=1 \
  -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE \
  -Pghatana.media.compositeScope=FULL \
  :services:media:examples:media-creative-preview:run
```

The output directory can be passed as the first `run` argument; the default is `examples/media-creative-preview/build/media-creative-preview/`. This consumer and its decoder checks prove local fixture behavior only. They do not bind owner-selected source/scene inputs, actor/workspace authority, an admitted job, canonical project commit, durable UNKNOWN/restart, or delivery.
