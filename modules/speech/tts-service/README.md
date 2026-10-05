# tts-service

Text-to-Speech (TTS) service for the Audio-Video platform.

## Purpose

Synthesises natural-language text into audio using configurable voice profiles and synthesis engines. Supports user-specific voice adaptation and real-time voice mixing. Exposes a gRPC API.

## Layer

`product` — owns the TTS runtime; extends `libs/java/common` and `modules/infrastructure/*`.

## Key Components

| Class | Responsibility |
|---|---|
| `VoiceMixingService` | Mixes synthesised audio from multiple voice profiles |
| `SynthesisResult` | Value object carrying the synthesised audio payload |
| `UserProfile` / `ProfileSettings` | Per-user voice customisation preferences |
| `AdaptationMode` | Enum of voice adaptation strategies (e.g. `CLONE`, `BLEND`) |
| `EngineState` / `EngineMetrics` | Runtime state and performance metrics of the synthesis engine |

## Configuration

Configuration is loaded through `libs/java/common` (`TtsConfig`):

```properties
tts.engine=local
tts.sample-rate=24000
tts.default-voice=neutral-en
```

## Dependencies

- `libs/java/common` — shared config and cloud fallback
- `modules/infrastructure/persistence` — persisting synthesised audio references
- `modules/infrastructure/security` — authentication interceptor
- `platform:java:observability` — metrics and tracing

## Testing

```bash
./gradlew :services:media:modules:speech:tts-service:test
```
