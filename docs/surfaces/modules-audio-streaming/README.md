# Surface: `modules-audio-streaming`

Bounded, deterministic audio-frame helpers (`modules/audio-streaming`,
`:services:media:modules:audio-streaming`). Production integration is in
the Media launcher; `modules/integration-tests` also depends on it.

## Responsibility

- Decode the local frame format, order and bound pending frames, check
  current consent at local session boundaries, and expose a narrow port
  to the canonical Media stream-session owner.
- The canonical stream session — tenant, principal, lease, cursor, ACK,
  finality — belongs to `MediaRuntime` and `MediaStreamSessionStore`.
  This module does **not** create a second session store, transport
  server, durable ACK journal, provider authority or job writer.
- The launcher implementation of `CanonicalStreamFramePort` is
  `MediaRuntimeCanonicalStreamFramePort`; without that adapter the port
  returns `NOT_ADMITTED`.
- `offerWithFeedback` preserves provider buffered bytes/backpressure when
  the runtime supplies them. `endOfStreamWithFeedback` submits the exact
  next sequence and moves the canonical session to `DRAINING`; it does not
  claim provider finality. Older/custom ports mark feedback unavailable
  and fail closed for EOS.
- `GrpcAudioSourceCapture` is a bounded source adapter that rechecks trusted
  authorization readback for exact source version/cursor before each frame
  and EOS, then delegates frame/EOS writes to `CanonicalStreamFramePort`.
  After its initial authorization readback it also rechecks the same canonical
  session generation and ACK cursor before fetching the source batch; a changed
  binding returns `UNKNOWN` without reading source bytes. It has no concrete
  authenticated gRPC transport binding. Canonical ACK persists Media sequence
  acceptance only, not source cursor/version.

## Public operations

- Frame decode/order/bound helpers and the `CanonicalStreamFramePort`
  seam; `StreamIntentSupport` declares the local 17-intent
  classification (`StreamIntentSupport.MATRIX`) matching the PDP-0
  `media.stream.*` capability IDs — a local support declaration, not PDP
  currentness, admission or acceptance.
- Detailed per-intent route/field disposition lives in the module
  README's AS-01 table (session open/connect/frame submit+ack/close are
  `IMPLEMENTED (local)`; lease renew, WebRTC and adaptive-HTTP are
  `NOT_ADMITTED`; recording/live-processing/captions are delegated).

## States and invariants

- `IMPLEMENTED (local)` describes code/runtime behavior only — PDP-0
  leaves remain `IN_SCOPE_DRAFT` with owner acceptance pending;
  operation-parity entries are `ADAPTER_REQUIRED`.
- Frame ACK acknowledges the accepted frame operation; it does not by
  itself prove downstream artifact creation or provider finality.
- `CanonicalStreamFramePort.Binding` rejects blank values and surrounding
  ASCII/Unicode whitespace for stream, tenant, principal, and purpose identity
  fields. It preserves the exact accepted strings rather than trimming an
  alternate spelling into the same identity.
- Callers must inspect `OfferFeedback.feedbackAvailable` before treating
  `backpressured=false` as a provider signal.
- Session reconnect reuses `/connect` (durable `reconnectCount`
  generation); no separate reconnect route exists.
- Unknown provider/transport outcomes stay unresolved — never inferred
  success.
- gRPC source batches are capped at 128 frames / 8 MiB, reordered only to
  deliver a contiguous prefix, and stopped on gaps or backpressure. Unknown,
  denied, revoked, stale-version, and lost-ACK outcomes do not produce an
  accepted frame; lost ACK is never replayed automatically.
- Trusted gRPC source readbacks reject Media sequence values outside the
  canonical frame range before they can authorize source bytes or frame offers.
- If the highest canonical frame sequence is accepted and that batch also
  declares EOS, capture returns `UNKNOWN` before readback or dispatch of an
  out-of-range EOS sequence.
- If the canonical session generation or ACK cursor changes while initial
  source authorization is being resolved, capture returns `UNKNOWN` before
  reading the source batch.

## Dependencies and configuration

- Consumed by `launcher` and `modules/integration-tests`; canonical
  session state in `runtime-contracts`/`MediaRuntime`.

## Errors

Unwired `CanonicalStreamFramePort` → `NOT_ADMITTED`; bounded-decoder and
consent-check failures reject locally before dispatch.

## Tests and commands

```bash
./gradlew :services:media:modules:audio-streaming:test
```

Coverage: frame decode/order/bounds, consent-boundary checks,
reconciler behavior, intent-matrix consistency. Real multi-client
transport evidence (1/16/64 clients, reconnect, mid-stream revocation)
is tracked by the plan's executable-completion criteria, not claimed
here.
