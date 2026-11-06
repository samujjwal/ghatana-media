# Media Infrastructure — Cache Adapter

Media caching adapter source; not an independently deployed cache service or a replacement for the authoritative Shared/platform cache contracts. Redis stores optimization entries only. It does not establish current caller scope, consent, retention eligibility, source version, or transcript revision.

## Purpose

Provides a unified facade for audio-video cache operations while keeping services decoupled from the underlying cache backend. Transcription APIs currently do not read or write transcript values: their inputs lack authenticated principal, rights/purpose/classification, immutable artifact/transcript revisions, source fingerprint, and policy epoch. `getOrLoadTranscription` calls the current source/authorization loader on every request and returns only its matching non-deleted result. On a valid source read it best-effort invalidates the legacy tenant/transcription key, which has no source-version dimension and could contain an older snapshot; absent or deleted source results invalidate that same exact key. Cache invalidation failure never replaces the current source result or its denial. Direct cache lookup methods return a miss.

The generic protected-cache API requires a complete `CacheKeyScope`, including tenant, principal, immutable artifact/transcript/source identity and policy epoch. `getOrLoadScoped` checks trusted current authority before cache access and checks it again after a cache hit or source load, immediately before returning the value. Only explicit `true` at both points permits disclosure. A denied, null, or failed/unknown authority check returns no value and triggers best-effort exact-key invalidation; an initially denied or unavailable authority performs no cache read or source load. Source or policy epoch changes produce distinct keys, preventing reuse of entries from prior versions. Callers processing a revocation, consent, or retention event can use `invalidateScoped` with the prior scope for exact-key cleanup; no tenant-wide invalidation is claimed because the platform cache port does not provide that operation. Cache key scope partitions entries but never grants authority by itself.

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

The Redis integration test uses Testcontainers and the Shared `DistributedCachePort`/`DistributedCacheService`. It verifies that unscoped transcript methods do not persist protected values, source-backed reads evict seeded legacy snapshots and return the current source result, deleted sources invalidate the exact legacy key, and explicit key invalidation works. Unit coverage verifies tenant/source/policy key partitioning, fail-closed authority denial, cache load coalescing, bounded coordination, cache outage fallback, and TTL/value limits. Existing client/service recreation in one test JVM checks loss of process-local state; it is not an OS process restart. These are synthetic-loader tests: the cache module has no Media runtime read-path caller, so they do not establish end-to-end Postgres/job read-path integration or external rights/retention event wiring. Transcript reads call the supplied current-source loader on each request, and transcript writes are intentionally skipped until their API carries complete protected scope.
