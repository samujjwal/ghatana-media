# Media Multimodal Analysis Service

Prepared Media multimodal service source, separate from the Vision service. Its gRPC contracts and tests describe cross-modal composition; production execution and provider qualification remain separate from PDP development completion. The former `vision-service` label was a historical audit alias, not the module's identity.

## Purpose

The intended capability composes source-grounded audio and visual observations for authorized gRPC clients and Media adapters. It owns temporal association and multimodal semantics, not duplicate STT/Vision engines, generic model routing, OCR or Data Cloud storage.

The public `MultimodalGrpcService` composition currently has unavailable source authorization and no canonical operation executor. Runtime-port injection is an integration seam, not source authorization. Family processing remains `MULTIMODAL_FAMILY_NOT_ADMITTED` (`FAILED_PRECONDITION`) until canonical per-operation bindings exist. STT/Vision readiness probes return false because qualified provider readiness is not wired. The [RPC matrix](WAVE2-RPC-CAPABILITY-MATRIX.md) preserves the inventory, but its combined/partial response descriptions are historical observations; follow canonical MM-08 and the actual guards for current execution behavior.

## Layer

`product` — owns the cross-modal intelligence runtime; builds on top of `libs/java/common` and `modules/infrastructure/*`.

## Key Components

| Class | Responsibility |
|---|---|
| `MultimodalGrpcServer` | gRPC server entry-point |
| `MultimodalGrpcService` | gRPC request handler; validates and delegates |
| `CrossModalFusionEngine` | Fuses audio and visual embeddings into a unified representation |
| `MultimodalAnalysisRequest` / `MultimodalAnalysisResult` | Request/response models |

The optional `adapters/agent-tools-media` module contains the existing `AudioTranscriptionAgent` and `MultimodalAnalysisAgent` wrappers. Their package names remain unchanged; keeping them at the Tools SPI boundary lets the multimodal service compile and run without pulling Tool runtime into its core classpath.

## Configuration

`MultimodalGrpcServer` reads `MULTIMODAL_GRPC_PORT` (default 50055, valid range 1–65535) and shared `GrpcTransportSecurityPolicy` configuration under the `MULTIMODAL` prefix. Missing production-like TLS configuration rejects startup. The former `vision.model`/`vision.fusion-strategy` examples were not read by this server and do not activate a provider.

Extend the existing runtime/source-authorization/operation-executor seams with bounded child operations, immutable source versions, explicit clocks and independent finality. Preserve protobuf method identities/field numbers and tenant/principal/purpose binding on dispatch and retry. Timestamp comparability is not measured AV synchronization; heuristic similarity is not calibrated confidence, and biometric association requires separate rights.

## Dependencies

- `runtime-contracts`, Media common libraries and observability — runtime seams, transport/security and telemetry
- STT and Vision modules — public stubs and existing Media frame preparation
- `modules/infrastructure/persistence` and Shared governance/security/messaging/audit — existing persistence and platform primitives; no duplicate queue or policy engine
- `services/ai-inference:delivery:api` — generic inference API whose version 1.1.0 request schema now accepts either text input or 1–32 opaque `mediaInputs` references. Each media input carries modality (`AUDIO`, `VIDEO`, or `IMAGE`), constrained reference, media type, role, purpose, classification, and expiry. The references identify material only: the contract does not authorize dereferencing, establish rights or consent, or qualify a provider. Media operations remain unbound to this API; schema support does not qualify a Media runtime, model, storage path, or execution.
- `platform:java:observability` — metrics and tracing

## Testing

```bash
./gradlew :services:media:modules:intelligence:multimodal-service:test
```

For the bounded core graph add `-Pghatana.media.compositeScope=FOCUSED -Pghatana.media.focusedModules=multimodal` and select the affected tests. The `MultimodalGrpcServiceInProcessIntegrationTest` suite uses controlled dependencies: absent trusted identity/source authority must deny before child effects, and absent canonical execution must not emit a family result. Executor-handoff failure must preserve unknown outcome without blind replay.

The [Wave 2 plan](../../../docs/implementation/MEDIA-BACKEND-MODALITY-WAVE2-EXECUTION.md) owns MM-01–12 acceptance; [TESTING](../../../docs/TESTING.md) and [EVIDENCE](../../../docs/EVIDENCE.md) own prerequisites and proof requirements. Real STT/Vision output, source clocks/ROI, restart/fencing, privacy and bounded fanout/resource measurements remain required for the applicable whole-task claims. This backend has no GUI accessibility surface; language/script handling and downstream accessible presentation still apply at their owning interfaces. No test pass, provider qualification or lifecycle completion is asserted here.
