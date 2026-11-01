# Media Infrastructure — Cache Adapter

Media caching adapter source; not an independently deployed cache service or a replacement for the authoritative Shared/platform cache contracts. Redis stores optimization entries only. It does not establish current caller scope, consent, retention eligibility, source version, or transcript revision.

## Purpose

Provides a unified facade for writing transcription results and audio-video artefact metadata while keeping services decoupled from the underlying cache backend. Transcript reads do not return a cached entity because the current entity/cache contracts cannot revalidate authorization, consent, retention, source version, or immutable transcript revision. `getOrLoadTranscription` calls its current source/authorization loader on every request; a matching non-deleted result may then be written to cache. Direct cache lookup methods return a miss without deserializing a stored transcript.

## Layer

`infrastructure` — caching adapter; no domain or business logic. Consumed by `stt-service` and `multimodal-service`.

## Key Components

| Class | Responsibility |
|---|---|
| `AudioVideoCache` | Cache facade; read-through / write-through helper for audio artefacts |
| `TranscriptionCacheService` | Writes tenant-scoped transcription optimization entries; reads require the current source loader and never trust cache entries as authorization or revision authority |

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

Focused unit tests:

```bash
./gradlew :services:media:modules:infrastructure:cache:test --tests 'com.ghatana.audio.video.infrastructure.cache.TranscriptionCacheServiceTest'
```

The Redis integration test uses Testcontainers to verify serialization writes, tenant-key separation, TTL expiry, explicit invalidation, cache-on/cache-off source-result equivalence, and write visibility from a fresh service instance. It calls the current source/authorization loader on each protected read, including after a Redis write. Redis persistence does not prove consent, retention, source-version, transcript-revision, or Shared adapter acceptance.
