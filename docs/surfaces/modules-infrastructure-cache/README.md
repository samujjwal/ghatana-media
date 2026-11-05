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
- `getOrLoadTranscription(scope, id, authorityCheck, loader)` is the opt-in
  protected path. It keys by exact transcript ID plus every `CacheKeyScope`
  dimension, stores a versioned envelope bound to the scoped key digest (raw
  principal/rights/source scope fields are not duplicated in the envelope),
  checks trusted current authority before lookup and again before disclosure,
  and invalidates/reloads malformed or scope-mismatched envelopes. The supplied
  authority reader must verify the principal, rights/purpose/classification,
  immutable source and transcript revisions, source fingerprint, retention and
  policy epoch. Scope values alone never grant access. Absent/deleted source
  results are not negative-cached. Call `invalidateTranscriptionScoped` with
  the prior scope for explicit revocation/retention cleanup.

## Public operations

| Class | Role |
| --- | --- |
| `AudioVideoCache` | Cache facade over `DistributedCachePort` |
| `TranscriptionCacheService` | Source-authorized transcript reads; scoped opt-in cache path; unscoped transcript cache reads/writes fail closed |

## States and invariants

- **No unscoped transcript persistence**: the legacy tenant/entity-only APIs
  lack authenticated principal, rights/purpose/classification, immutable
  artifact/transcript revisions and authoritative source fingerprint, so their
  writes remain disabled and there is no active
  `cache.transcription.ttl-seconds`.
- No runtime callers under `modules/` or `adapters/` were found except
  the cache benchmark — do not infer STT/multimodal runtime integration
  from build presence.
- The scoped API is an available infrastructure capability; no Media runtime
  caller currently supplies its trusted rights/source verifier. Runtime
  integration and owner-side consent/readback remain separate work.

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
fail-closed unscoped access, scoped versioned envelopes, cross-tenant and
stale-scope rejection, revocation at disclosure, negative-cache avoidance,
single-flight loads, cache outage fallback, Redis client restart, and denial
preservation.
