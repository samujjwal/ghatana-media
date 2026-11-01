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

### Engine pool leases

Use `EnginePool.borrowLease()` or the service registry's STT/TTS lease methods
for new code, and close each lease when its work ends. A lease rejects raw
returns and can be closed repeatedly without returning a later borrow. Pool
shutdown rejects new borrows, closes idle engines, and defers destruction of a
borrowed engine until its lease or legacy borrow is returned. A caller that
never returns an engine can therefore retain it after shutdown. Shutdown is not
a quiescence barrier: a return already in its health check can finish cleanup
later. If destruction fails, its capacity remains reserved because the native
resource may still be live; `getFailedDestructionCount()` exposes that condition.

The legacy raw `borrow`/`returnEngine` API remains available for compatibility;
it carries no lease token and cannot detect a stale return of a handle that
has already been borrowed again. Neither local pool leases nor these lifecycle
checks constitute a distributed worker fence or provider admission.
