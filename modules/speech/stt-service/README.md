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

## gRPC message bounds

`SttGrpcServer` explicitly keeps gRPC-Java's documented 4 MiB
[`ServerBuilder.maxInboundMessageSize`](https://grpc.github.io/grpc-java/javadoc/io/grpc/ServerBuilder.html)
default per-message receive limit. That is the effective maximum serialized
request size when the production server is admitted and bound, including
`Transcribe`. The current production provider profile is `NOT_ADMITTED`, so no
public STT server currently binds;
`SttAudioInputDecoder` enforces the same 4 MiB input ceiling after protobuf
bytes have been received and materialized, so it cannot raise the transport limit.
`SttStreamSequenceValidator` defines a 1 MiB
chunk limit, but the production `StreamTranscribe` RPC is `NOT_ADMITTED` before
chunk dispatch, so that helper limit is not an active transport bound today.
Raising the public unary upload size requires a method-specific transport
boundary so a larger server-wide cap does not also allow oversized stream
chunks to be materialized before rejection.

## RPC inventory — 12 methods

The method names and field numbers remain those in the protobuf authority.
`IMPLEMENTATION PRESENT` describes code reachability only; it does not mean the
provider is admitted or quality-qualified.

| RPC | Current SPI/handler disposition | Runtime/provider and qualification |
| --- | --- | --- |
| `Transcribe` | `SttEngine.transcribe` plus gRPC validation/response mapping are implemented | Production provider `NOT_ADMITTED`; no real-provider or model-quality qualification |
| `StreamTranscribe` | Streaming SPI exists; handler fails closed with `STT_STREAM_CONSENT_NOT_ADMITTED` before session/provider work | Provider `NOT_ADMITTED`; resume, reconnect, finality, and real-provider qualification open |
| `LoadModel` | Handler calls `SttEngine.loadModel` | Production provider `NOT_ADMITTED`; no admitted model profile |
| `UnloadModel` | `SttEngine` has no unload operation; handler returns `UNIMPLEMENTED` | Not implemented; no provider qualification |
| `ListModels` | Handler reads `SttEngine` model catalog | Catalog data is not provider admission or qualification |
| `AdaptModel` | Handler returns `STT_ADAPTATION_NOT_ADMITTED` (`FAILED_PRECONDITION`) | Explicitly not admitted; versioned corrections, trusted rights, and provider unavailable |
| `GetStatus` | Handler reads local engine status/metrics | Provider readiness remains `NOT_ADMITTED` regardless of engine status |
| `HealthCheck` | Handler reads local engine readiness | Local runtime health only; cannot promote provider admission |
| `CreateProfile` | Handler returns `STT_SPEAKER_PROFILE_NOT_ADMITTED` (`FAILED_PRECONDITION`) | Explicitly not admitted; trusted rights, consent, embedding, and tenant storage unavailable |
| `GetProfile` | Handler returns `STT_SPEAKER_PROFILE_NOT_ADMITTED` (`FAILED_PRECONDITION`) | Explicitly not admitted; trusted rights, consent, embedding, and tenant storage unavailable |
| `UpdateProfile` | Handler returns `STT_SPEAKER_PROFILE_NOT_ADMITTED` (`FAILED_PRECONDITION`) | Explicitly not admitted; trusted rights, consent, embedding, and tenant storage unavailable |
| `SubmitCorrection` | Handler returns `STT_CORRECTION_NOT_ADMITTED` (`FAILED_PRECONDITION`) | Explicitly not admitted; immutable transcript revisions and expected-version CAS unavailable |

`SttProtoContractTest` pins all 12 generated service method identities, RPC
streaming shapes, request/response message identities, and the selected
transcription/streaming field numbers. PDP-3 service-registry entries exist for
all 12 methods, with `pending-owner-review` experience bindings; this is a
source mapping, not approval or runtime evidence.

### SPI/provider distinction

The execution SPI is the shared `com.ghatana.media.stt.api.SttEngine` consumed
through `AudioVideoLibrary`; it provides transcription, streaming sessions,
profiles, model listing/loading, and status/metrics, but has no model-unload or
adaptation operation. The production composition has no gRPC provider adapter.
`config/provider-manifest.json` lists `GRPC`, `LOCAL_ONNX`, and `NOP`, all
`NOT_ADMITTED`. Local ONNX model metadata and digest checks do not establish
license or quality admission. No live provider, licensed corpus, or model
quality qualification is claimed.

## PDP-0 capability inventory — 16 intents

These are the exact STT intent memberships assigned by the Wave 2 execution
plan. A proto field, utility class, local engine path, or synthetic fixture is
not evidence of a qualified provider result.

| Capability intent | Task | Implementation and admission disposition |
| --- | --- | --- |
| `media.speech.transcription.file` | STT-04 | `SttEngine.transcribe` and gRPC path implemented; production provider explicitly `NOT_ADMITTED`; no provider qualification |
| `media.speech.transcription.stream` | STT-05 | SPI/stream validator present; canonical RPC explicitly `NOT_ADMITTED` pending trusted purpose/consent; resume and finality unimplemented/unqualified |
| `media.speech.transcription.language.detect` | STT-10 | Utility implementation only; not wired into production gRPC; no qualified detector |
| `media.speech.transcription.voice-activity.detect` | STT-05 | No runtime VAD implementation or admitted provider |
| `media.speech.transcription.speaker.diarize` | STT-07 | Utility guarded by `NOT_ADMITTED`; no qualified diarization provider |
| `media.speech.transcription.speaker.segment` | STT-07 | Utility-only; no qualified diarization/segmentation provider |
| `media.speech.transcription.speaker.separate` | STT-07 | Not implemented; no separated-audio provider |
| `media.speech.transcription.speaker.identify-authorized` | STT-07 | Explicitly `NOT_ADMITTED`; no biometric identity path; profile RPCs fail with `FAILED_PRECONDITION` |
| `media.speech.transcription.word-timestamp.create` | STT-06 | Proto field and mapper support exist; production model result does not currently emit timings; quality unqualified |
| `media.speech.transcription.phoneme-timestamp.create` | STT-06 | Not implemented; no phoneme alignment provider |
| `media.speech.transcription.forced-align` | STT-08 | Not implemented and no alignment provider admitted |
| `media.speech.transcription.punctuate-capitalize` | STT-06 | Config option reaches engine; no separately qualified production output path |
| `media.speech.transcription.alternatives.provide` | STT-06 | Proto option/result shape and mapper exist; production model path does not provide alternatives; no quality qualification |
| `media.speech.transcription.confidence.provide` | STT-06 | Engine confidence may pass through with availability metadata; calibration/model provenance remain unqualified |
| `media.speech.transcription.translate` | STT-08 | Not implemented; no translation provider admitted |
| `media.speech.transcription.subtitle.generate` | STT-08 | Not implemented; no persisted source-versioned subtitle output path |

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

Existing test dispositions by boundary: `ProductionSttGrpcServiceTest` checks
the production service method set, fail-closed provider profiles, health, and
explicit unavailable handlers; `SttGrpcServiceTest` covers unary transcription
validation/mapping, model calls, status/health, correction, and profile
unavailability; `SttGrpcServiceInProcessIntegrationTest` covers transport
transcription, invalid audio, unload, health, and authenticated/unauthenticated
calls. `PersistentSttGrpcServiceTest` verifies authentication and that the
transcript-version path has no unsafe provider/persistence fallback.
`SttProtoContractTest` adds descriptor-level identity and field-number checks.
Existing stream coverage is limited to fail-closed/authentication and validator
semantics; it does not establish an admitted stream provider, reconnect, or
durable finality. Tests not run in the current STT-01 worktree are not recorded
as newly verified.

The source-level RPC-to-test mapping is: `Transcribe` — `SttGrpcServiceTest`,
`SttGrpcServiceInProcessIntegrationTest`; `StreamTranscribe` —
`SttGrpcStreamingSemanticsTest`, `SttStreamSequenceValidatorTest`,
`PersistentSttGrpcServiceTest`; `LoadModel`, `UnloadModel`, `ListModels` —
`SttGrpcServiceTest` (unload also has in-process coverage); `AdaptModel`,
`SubmitCorrection`, and profile RPCs — `SttGrpcServiceTest` and
`ProductionSttGrpcServiceTest` (profile auth also has persistent/in-process
coverage); `GetStatus`, `HealthCheck` — `SttGrpcServiceTest`, with health also
covered in production and in-process tests. These existing suites were not
rerun for STT-01; only the new descriptor test was run.

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
