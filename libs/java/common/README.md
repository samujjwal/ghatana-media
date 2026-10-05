# libs/java/common

Shared Java library for the Audio-Video platform.

## Purpose

Provides cross-cutting configuration, factory utilities, and shared models consumed by all Audio-Video services (STT, TTS, multimodal, infrastructure modules). Avoids duplication of cloud fallback and model-loading logic.

## Layer

`platform-local` — shared within the `audio-video` product boundary; must not depend on product-specific modules.

## Key Components

| Class | Responsibility |
|---|---|
| `ConfigurationProvider` | Central config loader; bootstraps service-specific config objects |
| `SttConfig` | STT-specific configuration (model, language, cloud fallback) |
| `TtsConfig` | TTS-specific configuration (engine, sample rate, voice) |
| `VisionConfig` | Vision/multimodal configuration (model, fusion strategy) |
| `CloudFallbackConfig` | Cloud provider fallback policy and credentials |
| `TimeoutConfig` | Shared timeout and retry configuration |
| `VisionEngineFactory` | Factory that instantiates the configured vision detection engine |
| `DetectionModelInfo` | Value object describing a loaded detection model |

## Dependencies

- `platform:java:observability` — shared metrics instrumentation
- No product-level dependencies — this library is consumed by services, not the reverse

## Testing

```bash
./gradlew :services:media:libs:java:common:test
```

Coverage target: ≥80% on all public configuration and factory paths.
