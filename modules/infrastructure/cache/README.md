# Media Infrastructure — Cache Adapter

Media caching adapter source; not an independently deployed cache service or a replacement for the authoritative Shared/platform cache contracts. Redis stores optimization entries only. It does not establish current caller scope, consent, retention eligibility, source version, or transcript revision.

## Purpose

Provides a unified facade for audio-video cache operations while keeping services decoupled from the underlying cache backend. Transcription APIs currently do not read or write transcript values: their inputs lack authenticated principal, rights/purpose/classification, immutable artifact/transcript revisions, and authoritative source fingerprint. `getOrLoadTranscription` calls the current source/authorization loader on every request and returns only its matching non-deleted result. On a valid source read it best-effort invalidates the legacy tenant/transcription key, which has no source-version dimension and could contain an older snapshot; absent or deleted source results invalidate that same exact key. Cache invalidation failure never replaces the current source result or its denial. Direct cache lookup methods return a miss. A future protected transcript cache path requires complete scope dimensions from the current authorized source path before it can persist or serve bytes.

## Layer

`infrastructure` — caching adapter; no domain or business logic. A source search found no runtime callers under `modules/` or `adapters/`; the only out-of-module caller is the cache benchmark. Do not infer STT or multimodal runtime integration from this module's presence in the build.

## Key Components

| Class | Responsibility |
|---|---|
| `AudioVideoCache` | Cache facade; read-through / write-through helper for audio artefacts |
| `TranscriptionCacheService` | Source-backed transcript reads; unscoped transcript cache reads and writes fail closed |

## Configuration

```properties
cache.provider=redis            # in-process | redis
cache.redis.host=localhost
cache.redis.port=6379
```

The generic `AudioVideoCache` facade uses a 30-minute default TTL and caps
caller-supplied TTLs at 30 minutes. Transcription cache writes are currently
disabled because the transcription API does not carry complete protected
scope; there is no active `cache.transcription.ttl-seconds` setting. The
Shared `DistributedCachePort` owns backend storage and expiration behavior,
while this adapter applies its local TTL cap before calling the port.

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

The Redis integration test uses Testcontainers to verify that unscoped transcript methods do not persist protected values, source-backed reads evict a seeded stale legacy snapshot and preserve the current source result, and explicit key invalidation works through the Shared cache port. Transcript reads call the supplied current-source loader on each request, and transcript writes are intentionally skipped; therefore this IT does not establish cache-backed Postgres read-path behavior or transcript-cache survival across a process restart. Same-key stale-snapshot cleanup and explicit invalidation join one bounded in-flight invalidation, so read-triggered cleanup cannot make an immediate explicit delete fail with a local mutation conflict. Redis persistence does not prove consent, retention, source-version, transcript-revision, or Shared adapter acceptance. TTL and generic `AudioVideoCache` behavior are tested separately; transcript Redis persistence remains unavailable until the public API carries complete current protected scope.
