# Surface: `modules-video-streaming`

Video streaming helpers and source matrix (`modules/video-streaming`,
`:services:media:modules:video-streaming`). A **source inventory**, not a
capability admission or qualification record — the surface disposition
is `NO_IMPLEMENTATION_ADMITTED` for video-specific transport.

## Responsibility

- `VideoFrameTimebase` — keeps capture PTS, presentation PTS, declared
  rational timebases, clock identity, discontinuity, codec identity and
  presentation mapping explicit. Unknown values remain unknown; the
  adapter does not infer a clock or normalize VFR timestamps.
- `VideoFrameReconciler` — in-memory helper holding sequence gaps and
  reporting decodability; it remains **not wired** into `MediaRuntime`,
  `MediaStreamSessionStore` or provider dispatch. The launcher-owned
  `MediaRuntimeCanonicalVideoStreamFramePort` separately binds decoded
  frames to the canonical lease, generation, exact next sequence and ACK
  cursor.
- `InProcessVideoTransport` — bounded in-process transport (queue capped
  at 512 frames); rejects overflow as backpressure.
- `VideoCaptureProfile` — declares `WEBRTC`, `ADAPTIVE_HTTP`, `HLS`,
  `DASH` transport enums, all explicitly `UNQUALIFIED`.
- `GrpcVideoSourceCapture` — bounded, source-free-tested adapter that
  requires trusted exact-version/cursor authorization readback, preserves
  rational source PTS (including explicit unknown), and delegates writes to
  `CanonicalVideoStreamFramePort`. No concrete authenticated gRPC client is
  wired; canonical ACK does not durably persist source cursor/version/PTS.
Video Streaming owns transport and session frame semantics. It does not own
artifact/version/PTS/ROI source-frame extraction. The public source-frame
readback path is implemented by the Vision service, where the source-frame
resolution RPC
revalidates source rights and returns metadata without exposing frame pixels.
This path does not qualify a detector/model or authorize external processing.

## Public operations

Generic stream routes are shared with the runtime (`POST
/api/v1/streams`, `/connect`, `/frames/{sequence}`, `/close`) — the
module's README VS-01 matrix maps each of the 17 PDP-0 `media.stream.*`
leaves to route evidence and disposition: shared-runtime implemented
rows vs local-helper-only vs `NOT_ADMITTED` vs delegated rows.

## States and invariants

- Canonical session/frame state lives in `MediaRuntime` +
  `MediaStreamSessionStore`; video helpers do not create another
  durable session store or establish end-to-end stream success.
- `media.stream.ordering.enforce` has a **canonical bounded sequence
  binding** through the launcher adapter. Gaps, duplicates, stale
  generations, expired leases and unresolved outcomes fail closed. The
  helper/reconciler sequence still caps at `Integer.MAX_VALUE - 1` while
  the public route is `int64`; values beyond the video helper bound are
  rejected.
- `media.stream.lease.renew` is `NOT_ADMITTED` (connect/reconnect is not
  renewal; no renewal route exists).
- All four transport profiles are `UNQUALIFIED` → resolve unavailable.
- Canonical EOS uses the exact next cursor and transitions to `DRAINING`;
  it does not claim provider finality. `OfferFeedback` exposes buffered
  bytes/backpressure only when the runtime provides that feedback. The
  legacy video timestamp remains unqualified and is not source PTS.
- gRPC source batches are capped at 128 frames / 16 MiB, reordered only to
  deliver a contiguous prefix, and stopped on gaps, revocation, unknown
  authorization, or backpressure. Lost ACK is `OUTCOME_UNKNOWN`; no blind
  replay occurs. A frame ACK confirms Media sequence acceptance only, not a
  durable source-provenance receipt.
- Trusted gRPC source readbacks reject Media sequence values outside the
  canonical frame range before they can authorize source bytes or frame offers.
- After the initial trusted source readback, capture rechecks the canonical
  session generation and ACK cursor before reading the source batch; a change
  returns `UNKNOWN` without fetching source bytes.
- If the highest canonical frame sequence is accepted and that batch also
  declares EOS, capture returns `UNKNOWN` before readback or dispatch of an
  out-of-range EOS sequence.
- Recording/live-processing/captions rows are delegated to their owning
  surfaces (`media.recording`, intelligence live-processing, STT
  captioning).

## Dependencies and configuration

- Shares the canonical stream session store via `runtime-contracts`;
  no independent configuration.

## Errors

Unqualified transport profiles resolve unavailable; in-process overflow
rejects as backpressure; ambiguous provider outcomes remain `UNKNOWN`.
After an egress sink may have acted without a known result, the local video
session fences further frame delivery, provider egress, detach, claim and
resume until owner reconciliation; this helper fence does not resolve
provider finality or persist a recovery receipt.

## Tests and commands

```bash
./gradlew :services:media:modules:video-streaming:test
./gradlew -Pghatana.media.compositeScope=FULL :services:media:modules:video-streaming:test --tests com.ghatana.video.streaming.GrpcVideoSourceCaptureTest
```

`VideoVfrTransportIntegrationTest` exercises source timing and frame
reconciliation with fixtures — it is not real external-transport
qualification.
