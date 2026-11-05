# Surface: `modules-infrastructure-cache`

Media caching adapter (`modules/infrastructure/cache`). Redis stores
optimization entries only — it is not an independently deployed cache
service and not a replacement for the authoritative Shared/platform cache
contracts. A cache entry never establishes caller scope, consent,
retention eligibility, source version or transcript revision.

## Responsibility

- `AudioVideoCache` — unified facade for audio-video cache operations
  (read-through/write-through for audio artefacts); default 30-minute TTL,
  caller-supplied TTLs capped at 30 minutes, backed by the Shared
  `DistributedCachePort`.
- `TranscriptionCacheService` — source-backed transcript reads only.
  `getOrLoadTranscription` calls the current source/authorization loader
  on every request and returns only its matching non-deleted result; on a
  valid source read it best-effort invalidates the legacy
  tenant/transcription key (no source-version dimension). Cache
  invalidation failure never replaces the current source result or its
  denial. Direct cache lookups return a miss.

## Public operations

| Class | Role |
| --- | --- |
| `AudioVideoCache` | Cache facade over `DistributedCachePort` |
| `TranscriptionCacheService` | Source-authorized transcript reads; unscoped transcript cache reads/writes fail closed |

## States and invariants

- **No transcript persistence without complete protected scope**:
  transcription APIs lack authenticated principal, rights/purpose/
  classification, immutable artifact/transcript revisions and
  authoritative source fingerprint — so transcript cache writes are
  disabled and there is no active `cache.transcription.ttl-seconds`.
- No runtime callers under `modules/` or `adapters/` were found except
  the cache benchmark — do not infer STT/multimodal runtime integration
  from build presence.
- A future protected transcript cache path requires complete scope
  dimensions from the current authorized source path before persisting
  or serving bytes.

## Dependencies and configuration

```properties
cache.provider=redis            # in-process | redis
cache.redis.host=localhost
cache.redis.port=6379
```

Shared `DistributedCachePort` owns backend storage/expiration; this
adapter applies its local TTL cap before calling the port.

## Errors

Unscoped transcript cache access fails closed (miss/denial); invalidation
failures are best-effort and never mask the authoritative source result.

## Tests and commands

```bash
./gradlew :services:media:modules:infrastructure:cache:test
```

Coverage: facade TTL bounds, source-backed transcript read/invalidation,
fail-closed unscoped access, denial preservation.
