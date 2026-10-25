# Media Speech-to-Text service

Media-owned STT gRPC implementation. The protobuf service contract is
`src/main/proto/stt_service.proto`; the production composition is
`com.ghatana.stt.grpc.ProductionSttGrpcService`.

## Runtime provider boundary

Before this Wave 2 change, the STT server composition built the shared
`AudioVideoLibrary` with a local ONNX `SttConfig` and warmed that engine before
binding. The current provider selector rejects all modes until admission, so
the server now fails closed before constructing or warming a model. It does
**not** compose an upstream Whisper gRPC client. The separate
`GrpcSttClientAdapter` in Multimodal is a consumer of this Media STT service,
not a provider adapter for this server. The earlier description of an external
Whisper provider as the STT server's execution engine was inaccurate.

The production server now requires an explicit `STT_PROVIDER_MODE` selection:

| Mode | Required profile | Current disposition |
| --- | --- | --- |
| `GRPC` | Host, port, TLS or mTLS, model ID/version/SHA-256/license/hardware/region | `NOT_ADMITTED`: no upstream client adapter is composed in this server |
| `LOCAL_ONNX` | Readable non-symlink model file plus model ID/version/SHA-256/license/hardware/region | `NOT_ADMITTED`: the digest is checked, but no source-authorized model license and quality qualification is admitted |
| `NOP` | No provider settings | `NOT_ADMITTED`: an explicit disabled mode cannot satisfy transcription requests |

Missing or unknown modes, mismatched settings, and local model digest mismatch
fail before the server binds. Supplying descriptive metadata does not admit a
provider. No live provider or model quality qualification is claimed. The
current STT entry in `config/provider-manifest.json` records these dispositions.

## RPC inventory — 12 methods

The method names and field numbers remain those in the protobuf authority.
`IMPLEMENTATION PRESENT` describes code reachability only; it does not mean the
provider is admitted or quality-qualified.

| RPC | Current implementation disposition |
| --- | --- |
| `Transcribe` | Local engine path exists; production startup is `NOT_ADMITTED` |
| `StreamTranscribe` | Local streaming engine path exists; production startup is `NOT_ADMITTED`; reconnect/finality qualification remains open |
| `LoadModel` | Calls the local engine model API; no admitted model profile |
| `UnloadModel` | Production composition returns `UNIMPLEMENTED` |
| `ListModels` | Reads local engine model catalog; entries are not provider qualification |
| `AdaptModel` | Production composition returns `UNIMPLEMENTED` |
| `GetStatus` | Reports local engine status; provider readiness remains `NOT_ADMITTED` |
| `HealthCheck` | Reports local engine readiness; it cannot promote provider admission |
| `CreateProfile` | Production composition returns `UNIMPLEMENTED` |
| `GetProfile` | Production composition returns `UNIMPLEMENTED` |
| `UpdateProfile` | Production composition returns `UNIMPLEMENTED` |
| `SubmitCorrection` | Production composition returns `UNIMPLEMENTED` |

## PDP-0 capability inventory — 16 intents

These are the exact STT intent memberships assigned by the Wave 2 execution
plan. A proto field, utility class, local engine path, or synthetic fixture is
not evidence of a qualified provider result.

| Capability intent | Task | Current implementation/provider disposition |
| --- | --- | --- |
| `media.speech.transcription.file` | STT-04 | Local engine path exists; provider is `NOT_ADMITTED` |
| `media.speech.transcription.stream` | STT-05 | Local stream path exists; reconnect, ordered finality, and provider qualification remain open |
| `media.speech.transcription.language.detect` | STT-10 | Utility API exists but is not wired into the production gRPC path |
| `media.speech.transcription.voice-activity.detect` | STT-05 | No admitted runtime VAD path |
| `media.speech.transcription.speaker.diarize` | STT-07 | Utility-only implementation; no qualified diarization provider |
| `media.speech.transcription.speaker.segment` | STT-07 | Utility-only implementation; no qualified diarization provider |
| `media.speech.transcription.speaker.separate` | STT-07 | No separated-audio provider path |
| `media.speech.transcription.speaker.identify-authorized` | STT-07 | No admitted biometric/identity path; profile RPCs are `UNIMPLEMENTED` in production |
| `media.speech.transcription.word-timestamp.create` | STT-06 | Proto result field exists; production transcription response does not emit word timings |
| `media.speech.transcription.phoneme-timestamp.create` | STT-06 | No runtime implementation |
| `media.speech.transcription.forced-align` | STT-08 | No admitted alignment provider |
| `media.speech.transcription.punctuate-capitalize` | STT-06 | Config flag exists; no separately qualified output path |
| `media.speech.transcription.alternatives.provide` | STT-06 | Proto option exists; production result path does not provide alternatives |
| `media.speech.transcription.confidence.provide` | STT-06 | Engine confidence is passed through; calibration and model provenance are not qualified |
| `media.speech.transcription.translate` | STT-08 | No admitted translation provider |
| `media.speech.transcription.subtitle.generate` | STT-08 | No persisted, source-versioned subtitle output path |

## Identity and privacy boundary

`PersistentSttGrpcService` requires the authenticated tenant and subject from
`JwtServerInterceptor` context before reading audio bytes or invoking the
persistence/service layer. The persistence service rejects blank tenant IDs at
its direct entry points. The subject must parse as the current persistence
contract's UUID identifier; absent or unsupported subjects return
`UNAUTHENTICATED`, with no persistence or provider effect. Request fields such
as `consent_status` are not treated as trusted consent authority. The current
shared auth context exposes tenant and subject but no trusted processing-purpose
value, so purpose-bound admission remains an explicit unresolved boundary.

## Focused development tests

```bash
./gradlew :services:media:modules:speech:stt-service:test \
  --tests 'com.ghatana.stt.grpc.ProductionSttGrpcServiceTest' \
  --tests 'com.ghatana.stt.grpc.PersistentSttGrpcServiceTest' \
  --tests 'com.ghatana.stt.service.PersistentSttServiceValidationTest'
```

These tests prove local configuration and negative-path behavior, not model
license, real-model quality, external provider execution, or production
qualification.

## STT-12 fixture transport load

`SttRuntimeLoadRestartTest` exercises authenticated gRPC in-process transport
with the real `JwtServerInterceptor`, a bounded synthetic PCM request, and a
deterministic test-only engine double. It starts a fresh ephemeral server for
each 16- and 64-request concurrent batch and records client-observed fixture
RPC p50/p95/p99 and throughput. The returned text/model identifiers are
explicit fixture markers, not ASR output; these measurements are not a service
SLO or provider performance evidence. The ephemeral server restart does not
prove production process restart or recovery.

The following remain `NOT_AVAILABLE`: provider real-time factor, model memory,
model quality (WER/CER/DER), production restart behavior, persisted
cross-tenant isolation, and real SLO values. No admitted model or licensed
speech corpus is configured. Run the fixture transport check with:

```bash
./gradlew :services:media:modules:speech:stt-service:test \
  --tests 'com.ghatana.stt.grpc.SttRuntimeLoadRestartTest' --no-build-cache
```
