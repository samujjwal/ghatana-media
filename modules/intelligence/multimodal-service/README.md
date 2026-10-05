# multimodal-service (vision-service)

Multimodal analysis service for the Audio-Video platform — referred to as `vision-service` in the platform audit.

## Purpose

Fuses audio transcription with visual signals (frames, images) to produce multimodal analysis results. Exposes a gRPC API consumed by AI agents and downstream pipelines.

## Layer

`product` — owns the cross-modal intelligence runtime; builds on top of `libs/java/common` and `modules/infrastructure/*`.

## Key Components

| Class | Responsibility |
|---|---|
| `MultimodalGrpcServer` | gRPC server entry-point |
| `MultimodalGrpcService` | gRPC request handler; validates and delegates |
| `MultimodalAnalysisAgent` | Orchestrates multi-step analysis pipelines |
| `CrossModalFusionEngine` | Fuses audio and visual embeddings into a unified representation |
| `AudioTranscriptionAgent` | Runs audio-specific transcription within a multimodal pipeline |
| `MultimodalAnalysisRequest` / `MultimodalAnalysisResult` | Request/response models |

## Configuration

Configured via `libs/java/common` (`VisionConfig`):

```properties
vision.model=clip-vit-base-patch32
vision.fusion-strategy=late-fusion
```

## Dependencies

- `libs/java/common` — shared config, `VisionEngineFactory`, cloud fallback
- `modules/infrastructure/messaging` — job queue for async multimodal pipelines
- `modules/infrastructure/security` — authentication interceptor
- `services/ai-inference:delivery:api` — typed AI Inference gateway for multimodal reasoning
- `platform:java:observability` — metrics and tracing

## Testing

```bash
./gradlew :services:media:modules:intelligence:multimodal-service:test
```
