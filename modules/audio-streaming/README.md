# Audio streaming helpers

## Purpose and boundary

This module provides bounded, deterministic audio-frame helpers for Media. Its production integration is in the Media launcher; `modules/integration-tests` also depends on it for tests. The helpers decode a local frame format, order and bound pending frames, check current consent at local session boundaries, and expose a narrow port to the canonical Media stream-session owner.

The canonical stream session and its tenant, principal, lease, cursor, ACK, and finality state belong to `MediaRuntime` and its `MediaStreamSessionStore`. This module does not create a second session store, transport server, durable ACK journal, provider authority, or job writer. The launcher implementation of `CanonicalStreamFramePort` is `MediaRuntimeCanonicalStreamFramePort`; without that adapter the port returns `NOT_ADMITTED`.

Product meaning remains in the phase-owned sources under `.product-experience/`. The HTTP route and its operation mapping are in [`contracts/openapi/media.yaml`](../../contracts/openapi/media.yaml) and `.product-experience/interface-parity/operation-parity.yaml`. The module's 17-intent code disposition is `StreamIntentSupport`; it is a local support declaration, not PDP currentness, admission, or acceptance.

## AS-01 intent and API-field disposition

The denominator is the exact 17 IDs in `.product-experience/pdp-0-product-truth/capabilities.yaml#families[id=media.stream].capabilityIds`; these match `StreamIntentSupport.MATRIX`. The table records the module's current local classification and the existing public HTTP field surface. `IMPLEMENTED (local)` describes code/runtime behavior only: PDP-0 leaves remain `IN_SCOPE_DRAFT`, with owner acceptance pending and implementation state `UNKNOWN`; it is not formal capability or transport admission. OpenAPI fields below are observed fields on the named route, not an accepted leaf-to-route binding: the current operation-parity entries are `ADAPTER_REQUIRED` and list missing semantics. `Absent/unmapped` includes explicit delegation to another owning surface.

| PDP-0 capability intent | Current status | Existing route / API-field evidence and disposition |
| --- | --- | --- |
| `media.stream.session.open` | IMPLEMENTED (local) | `POST /api/v1/streams` (`openMediaStream`): required `X-Tenant-Id` and `X-Principal-Id` headers must match the body `tenantId` and `principalId`; body fields are `correlationId`, `streamKind`, optional `providerHint`, `maximumBufferedBytes`, `leaseDuration`, `metadata`, and optional `governanceContext`. Response: `StreamSessionRegistration {session, connectionToken}`. Runtime: `MediaRuntime.openStream(StreamSessionRequest)`. |
| `media.stream.session.connect` | IMPLEMENTED (local) | `POST /api/v1/streams/{sessionId}/connect` (`connectMediaStream`): `TenantHeader`, `SessionId`, `StreamTokenHeader`; response `StreamSession`. Runtime: `MediaRuntime.connectStream(tenantId, sessionId, token)`. |
| `media.stream.frame.submit` | IMPLEMENTED (local) | `POST /api/v1/streams/{sessionId}/frames/{sequence}` (`submitMediaStreamFrame`): `sessionId`, path `sequence` (`int64`, minimum 0), `TenantHeader`, `StreamTokenHeader`, optional `X-End-Of-Stream`, optional octet-stream body. Runtime `StreamFrame` carries tenant, session, token, `long sequence`, payload, end-of-stream, and received-at. |
| `media.stream.frame.acknowledge` | IMPLEMENTED (local) | Same frame route; `202` returns `StreamAck {acceptedSequence, bufferedBytes, backpressured}` with `Location` and `Retry-After`. This acknowledges the accepted frame operation; it does not by itself prove downstream artifact creation or provider finality. |
| `media.stream.session.close` | IMPLEMENTED (local) | `POST /api/v1/streams/{sessionId}/close` (`closeMediaStream`): `TenantHeader`, `SessionId`, `StreamTokenHeader`; response `StreamSession`. Runtime: `MediaRuntime.closeStream(tenantId, sessionId, token)`. |
| `media.stream.session.reconnect` | IMPLEMENTED (local) | No separate reconnect route is declared. The existing `/connect` operation is also used to reconnect; `StreamSession.reconnectCount` is the durable generation. A distinct reconnect request/field contract is absent. |
| `media.stream.ordering.enforce` | IMPLEMENTED (local) | Frame route path `sequence`; session response `lastSequence`; `StreamFrameReconciler` and `MediaStreamSessionStore.beginFrame/recordFrame` enforce ordered cursor behavior. Public route sequence is `int64`. |
| `media.stream.lease.renew` | NOT_ADMITTED | No renewal route or public renewal request/response fields exist. `MediaStreamSessionStore.renewLease` is only a storage CAS primitive; source requires generation, current consent/rights, replay identity, and authoritative renewed-expiry result before a public operation is admitted. |
| `media.stream.buffer.bound` | IMPLEMENTED (local) | Open request `maximumBufferedBytes` (`int64`, 1..1,073,741,824); session projection repeats `maximumBufferedBytes` and `bufferedBytes`. Runtime request validation and bounded helper enforce local limits. |
| `media.stream.backpressure.apply` | IMPLEMENTED (local) | Frame ACK fields `bufferedBytes` and `backpressured`; the reconciler/decoder enforce local pending-frame and byte bounds. No separate backpressure route exists. |
| `media.stream.recording.integrate` | Absent/unmapped (delegated) | `StreamIntentSupport` delegates to the `media.recording` surface. No stream recording route or recording-specific field mapping is declared in the stream OpenAPI paths. |
| `media.stream.live-processing.integrate` | Absent/unmapped (delegated) | `StreamIntentSupport` delegates to the intelligence/live-processing surface. No stream live-processing route or field mapping is declared in the stream OpenAPI paths. |
| `media.stream.transport.webrtc` | NOT_ADMITTED | No WebRTC route, signaling fields, or qualified transport implementation is declared by this module. Existing generic session/frame HTTP fields do not establish WebRTC support. |
| `media.stream.transport.adaptive-http` | NOT_ADMITTED | No adaptive-HTTP route or transport-specific fields/qualified adapter are declared. Existing generic session/frame HTTP fields do not establish adaptive transport support. |
| `media.stream.transport.hls` | NOT_ADMITTED | No HLS route, playlist/segment fields, or qualified adapter are declared. |
| `media.stream.transport.dash` | NOT_ADMITTED | No DASH route, manifest/segment fields, or qualified adapter are declared. |
| `media.stream.caption.live` | Absent/unmapped (delegated) | `StreamIntentSupport` delegates to the speech/STT captioning surface. No live-caption route or caption-specific fields are declared in the stream OpenAPI paths. |

The route field names are from `contracts/openapi/media.yaml` (`StreamSessionRequest`, `StreamSession`, `StreamSessionRegistration`, `StreamAck`) and the existing five canonical Media stream-session paths under `/api/v1/streams`. `config/route-manifest.json` lists those same five routes. This is not an inventory of separate STT/TTS streaming RPCs, which are owned by their speech services. There is no audio-streaming protobuf service or stream RPC in this module. PDP-0 capability definitions and PDP-1 operations remain owner-defined draft sources, so a field's presence in OpenAPI does not resolve leaf semantics or prove public admission.

## Implemented surfaces

| Type | Responsibility | Boundaries |
| --- | --- | --- |
| `AudioStreamSession` | Encode/decode the helper's fixed frame header and check local sequence/order values. | Header fields are signed 32-bit sequence, 64-bit timestamp in milliseconds, signed 32-bit payload length, then payload. Payload is capped at 8 MiB; sequence values are `0..2,147,483,646`, with `Integer.MAX_VALUE` reserved. |
| `StreamFrameReconciler` | Bound local pending frames, ordering, and ACK cursor behavior. | In-memory helper only; it is not the durable Media stream-session store or a replay receipt. |
| `CanonicalStreamFramePort` | Pass an audio helper frame or EOS marker to the runtime under a trusted tenant/principal/purpose, generation, version, cursor, and lease binding. | The port owns no session state. `offerWithFeedback` preserves buffered bytes/backpressure when the runtime provides them; `endOfStreamWithFeedback` uses the exact next sequence. ACK means the runtime accepted the frame/EOS marker, not provider finality or artifact creation. Default/custom ports fail closed for EOS and mark unavailable feedback explicitly. |
| `GuardedAudioStreamSession` / `StreamConsentGate` | Recheck consent for local connect, frame, delivery, provider-dispatch, and reconnect boundaries; separate detach from terminal cancel. | Uses the injected authority. A local fixture does not establish an external consent or provider grant. |
| `GrpcAudioSourceCapture` | Accept a bounded batch from an authenticated gRPC audio source and offer only a contiguous, currently authorized prefix through `CanonicalStreamFramePort`. | Rechecks trusted source readback before each offer and EOS; binds each frame to exact source version/cursor and Media sequence. Unknown/denied/revoked readback, gaps, backpressure, or uncertain ACK stop forward offers. It does not own session state. |
| `BoundedAudioFrameDecoder` | Validate declared PCM S16LE frames, exact rational source positions, and per-session frame/byte budgets. | OPUS is recognized but returns `UNAVAILABLE`; no codec is guessed and no wall clock is substituted for a missing source timebase. |
| `StreamIntentSupport` | Classify all 17 `media.stream.*` intents as local, delegated, or `NOT_ADMITTED`. | WebRTC, adaptive HTTP, HLS, and DASH are not qualified transports in this module. |

## Sequence formats and runtime mapping

The audio helper's binary header uses an `int32` sequence. The public HTTP frame route `/api/v1/streams/{sessionId}/frames/{sequence}` uses an `int64` path parameter, and the canonical `StreamFrame`, `StreamAck`, session cursor, and store operations preserve that `long` value. The HTTP handler passes the sequence directly to the canonical runtime path; it does not decode or narrow it through the helper header.

`MediaRuntimeCanonicalStreamFramePort` is a separate bounded adapter from the audio helper's `int32` frame into the canonical `long` cursor. It accepts only the exact next sequence representable by the helper and returns `NOT_ADMITTED` when the canonical cursor is outside that helper range. It does not truncate or wrap. Do not treat the helper header as the serialization of the HTTP route.

`endOfStreamWithFeedback` submits an empty `StreamFrame` with `endOfStream=true` at the exact next sequence. A canonical ACK transitions the session to `DRAINING`; it does not set `StreamFinality.FINAL_ACKNOWLEDGED` or claim downstream completion. `OfferFeedback.feedbackAvailable` must be checked before interpreting `backpressured=false` as a provider signal.

## Authenticated gRPC source capture

`GrpcAudioSourceCapture` accepts a transport-neutral `AuthenticatedGrpcSource` seam. The source must supply authenticated readback for the exact source version, source cursor, and next Media sequence. The helper reads at most 128 frames and 8 MiB per batch, checks batch identity/cursor uniqueness, sorts by Media sequence, and offers only a contiguous prefix. It refreshes both source authorization and the canonical session binding before every frame and before EOS. Unknown, denied, and explicitly revoked readback return distinct non-success outcomes without offering the corresponding frame; gaps stop at the first missing cursor. Backpressure stops subsequent offers from the already bounded batch, and a lost/null canonical ACK is `OUTCOME_UNKNOWN` and is never retried blindly.

No concrete authenticated gRPC transport binding is wired. Until a real source client and trusted readback implementation are supplied, this seam does not admit host/provider capture; fixtures prove only the fail-closed adapter logic. The canonical ACK records the Media stream sequence acceptance only: the current canonical stream port does **not** durably persist the gRPC source cursor or source version. Audio source timing beyond its exact cursor is not inferred from the legacy millisecond field.

## Usage

```java
AudioStreamSession helper = new AudioStreamSession();
byte[] wire = helper.encodeFrame(0, 0L, new byte[] {1, 2});
AudioStreamSession.DecodedFrame frame = helper.decodeFrame(wire);
```

This example exercises the local framing helper only. A runtime-backed frame offer additionally requires a current `CanonicalStreamFramePort.Binding` and a connected, leased canonical stream session.

## Failure and privacy behavior

- Reject short, truncated, trailing, negative-length, oversized, and out-of-range frames before payload acceptance.
- Keep absent source timebase and unsupported codecs explicitly unavailable; preserve exact rational source time when declared.
- Bound pending frame and decoder work; serialize shared per-session decoder budget updates.
- Recheck the injected consent authority before protected frame delivery or provider dispatch. A runtime-backed stream offer may report `OUTCOME_UNKNOWN`; `GuardedAudioStreamSession` consumes its local provider candidate before calling the injected sink, so a thrown sink leaves the outcome unknown and must not be retried as a new positive ACK.
- Do not log or infer source audio, identity, rights, or consent from frame bytes or caller-supplied metadata.

The helper has no real transport qualification. The local frame, consent, and ordering tests do not establish WebRTC/HLS/DASH support, a real provider effect, process-restart recovery, or AS-07 host performance at 1/16/64 sessions.

## Verification

Run the module tests from the repository root:

```bash
./gradlew :services:media:modules:audio-streaming:test --no-daemon --max-workers=2 --console=plain
```

Focused selectors include `AudioStreamSessionFrameTest`, `StreamFrameReconcilerTest`, `CanonicalStreamFramePortTest`, `GuardedAudioStreamSessionTest`, `BoundedAudioFrameDecoderTest`, and `StreamIntentSupportTest`. These prove local implementation behavior only. The remaining-only execution plan and original AS-01..AS-07 acceptance criteria are in [`MEDIA-REMAINING-ONLY-OWNER-EXECUTION-2026-11-02.md`](../../docs/implementation/MEDIA-REMAINING-ONLY-OWNER-EXECUTION-2026-11-02.md).
