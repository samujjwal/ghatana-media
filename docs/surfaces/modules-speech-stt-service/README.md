# Surface: `modules-speech-stt-service`

Media-owned Speech-to-Text gRPC service (`modules/speech/stt-service`,
`:services:media:modules:speech:stt-service`). Wire contract:
`src/main/proto/stt_service.proto`; production composition:
`com.ghatana.stt.grpc.ProductionSttGrpcService`.

## Responsibility

- Implements the STT gRPC boundary: model state, transcribe, streaming,
  correction and profile operations per the proto contract.
- **Provider boundary is fail-closed**: the server composition rejects
  all provider modes until admission and fails closed **before**
  constructing or warming any model. It does not compose an upstream
  Whisper gRPC client (the `GrpcSttClientAdapter` in Multimodal is a
  *consumer* of this service, not a provider adapter for it).

## Public operations

STT RPCs per `stt_service.proto`; `ProductionSttGrpcService` requires an
explicit `STT_PROVIDER_MODE` selection:

| Mode | Required profile | Current disposition |
| --- | --- | --- |
| `GRPC` | Host, port, TLS/mTLS, model ID/version/SHA-256/license/hardware/region | `NOT_ADMITTED` — no upstream client adapter composed |
| `LOCAL_ONNX` | Readable non-symlink model file + model ID/version/SHA-256/license/hardware/region | `NOT_ADMITTED` — digest checked, but no source-authorized license/quality qualification |
| `NOP` | No provider settings | `NOT_ADMITTED` — disabled mode cannot satisfy transcription |

Missing/unknown modes, mismatched settings and model digest mismatch
fail before the server binds. Descriptive metadata does not admit a
provider; no live provider or model-quality qualification is claimed.

## States and invariants

- No model is constructed, warmed or served on any current path —
  admission requires pinned model/export rights, independent reference,
  host review and quality evidence (per plan ASR corpus policy: FLEURS
  and Hindi deferred/nonblocking; real inference `NOT_ADMITTED`).
- Engine/provider absence is an explicit typed rejection, never a
  fabricated transcript.

## Dependencies and configuration

- `STT_PROVIDER_MODE` plus per-mode profile settings (see module README
  for exact keys); shared gRPC transport security policy.
- `modules/infrastructure/messaging` for the transcription job queue;
  `modules/infrastructure/cache` for source-backed transcript reads.

## Errors

Provider-mode/profile/digest failures reject before bind; RPC-level
rejections are typed (`FAILED_PRECONDITION`-class), not silent.
Wrapped provider `TimeoutException` values map to sanitized gRPC
`DEADLINE_EXCEEDED`; provider exception details are not returned to callers.

## Tests and commands

```bash
./gradlew :services:media:modules:speech:stt-service:test
```

Coverage: mode/profile validation, digest checks, fail-closed startup,
RPC contract behavior. Real inference is not exercised — none is
admitted.
