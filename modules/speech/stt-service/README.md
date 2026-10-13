# Media Speech-to-Text service

Media-owned STT service module in the prepared runtime source tree; the canonical runtime remains `ghatana/services/media` until approved transfer. Source presence is not a claim of qualified provider availability.

## Purpose

Transcribes audio streams and files to text through the Whisper gRPC service. The client adapter supports `GRPC` and explicit `NOP` modes. Exposes a gRPC API and persists transcription results for downstream consumers.

> **Engine decision:** The STT engine is an **external gRPC dependency**, not a local ONNX/JNI bundle. See the [STT gRPC configuration contract](../../../docs/configuration/stt-grpc-configuration.md) for prerequisite and admission constraints. The former `docs-generated/ADR-STT-001` link is not present in this repository and is not a source authority.

## Layer

`product` — owns the STT runtime; extends `libs/java/common` and `modules/infrastructure/persistence`.

## Key Components

| Class | Responsibility |
|---|---|
| `SttGrpcServer` | gRPC server entry-point; wires and starts the service |
| `SttGrpcService` | gRPC request handler; validates requests and delegates |
| `PersistentSttService` | Core STT orchestration: transcribe → persist → emit |
| `PersistentSttGrpcService` | gRPC adapter over `PersistentSttService` |
| `GrpcSttClientAdapter` | Canonical STT client — `SttMode.GRPC` for provider-backed transcription, `SttMode.NOP` for explicit disablement |
| `SttStreamingLatencyEnhancer` | Reduces streaming latency via partial-result processing |
| `LanguageDetectionService` | Auto-detects spoken language before transcription |
| `CustomVocabularyManager` | Manages tenant-specific vocabulary hints |

> **Deprecated:** `WhisperTranscriptionEngine` is `@Deprecated(since="1.0", forRemoval=true)` and throws `UnsupportedOperationException` for `transcribe()`. Use `GrpcSttClientAdapter` instead. Tracked for removal in GH-90000.

## Configuration

Configuration is loaded through `libs/java/common` (`SttConfig`). Key properties:

```properties
stt.model=whisper-large-v3
stt.language=auto
stt.cloud-fallback.enabled=false
```

## Dependencies

- `libs/java/common` — shared config, vision/detection models, cloud fallback
- `modules/infrastructure/persistence` — audio file and transcription repositories
- `modules/infrastructure/messaging` — transcription job queue
- `modules/infrastructure/security` — authentication interceptor
- `platform:java:observability` — metrics and tracing

## Observability

- gRPC server exposes Prometheus metrics at `/metrics`
- Correlation IDs are propagated through MDC on all transcription spans

## Testing

```bash
./gradlew :services:media:modules:speech:stt-service:test
```

Integration tests require a running messaging broker and persistence layer (see `integration-tests/`).
