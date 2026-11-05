# Logical surface: `media.surface.grpc.stt`

STT gRPC channel. Physical owner: `modules/speech/stt-service`.
Contract: `src/main/proto/stt_service.proto`; composition:
`ProductionSttGrpcService`.

## Supported operations

STT RPCs for model state, transcribe, streaming, correction and
profile per the proto. See the physical surface doc
(`modules-speech-stt-service`) for the `STT_PROVIDER_MODE` matrix.

## States and invariants

- Exact RPC semantics require real audio, cancel and rights positive
  and denial paths — current provider modes (`GRPC`, `LOCAL_ONNX`,
  `NOP`) are all `NOT_ADMITTED`; the server fails closed before model
  construction/warm-up.
- No upstream Whisper client is composed in this server; the Multimodal
  `GrpcSttClientAdapter` is a consumer of this service.
- ASR corpus policy: FLEURS deferred/nonblocking, Hindi deferred; real
  inference `NOT_ADMITTED` pending pinned model/export rights,
  independent reference, host review and quality evidence.

## Dependencies

`STT_PROVIDER_MODE` profile settings; messaging/cache infrastructure;
shared gRPC security policy.

## Errors

Mode/profile/digest failures reject before bind; RPC rejections are
typed, never fabricated transcripts.

## Tests

`./gradlew :services:media:modules:speech:stt-service:test` —
mode/profile validation, digest checks, fail-closed startup, RPC
contract behavior. No live inference is exercised or claimed.
