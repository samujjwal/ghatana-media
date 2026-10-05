# infrastructure/cache

In-memory and distributed caching layer for the Audio-Video platform.

## Purpose

Reduces latency and redundant computation by caching transcription results and audio-video artefact metadata. Provides a unified cache facade so services remain decoupled from the underlying cache backend (in-process vs. Redis).

## Layer

`infrastructure` — caching adapter; no domain or business logic. Consumed by `stt-service` and `multimodal-service`.

## Key Components

| Class | Responsibility |
|---|---|
| `AudioVideoCache` | Cache facade; read-through / write-through helper for audio artefacts |
| `TranscriptionCacheService` | Higher-level service: caches and retrieves transcription results by audio fingerprint |

## Configuration

```properties
cache.provider=redis            # in-process | redis
cache.redis.host=localhost
cache.redis.port=6379
cache.transcription.ttl-seconds=3600
```

## Dependencies

- `platform:java:observability` — cache hit/miss metrics
- Optional: Lettuce Redis client when `cache.provider=redis`

## Testing

```bash
./gradlew :services:media:modules:infrastructure:cache:test
```

Tests run with an in-process cache backend. Redis integration tests use Testcontainers.
