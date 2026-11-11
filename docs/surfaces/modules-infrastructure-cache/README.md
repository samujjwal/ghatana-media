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
- `TranscriptionCacheService.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
  authority, loader)` is the typed protected path. The loader returns a
  `ScopedTranscriptionSnapshot` pairing the entity with the complete source
  scope it actually observed; the adapter rejects a mismatch before cache
  insertion. It keys by exact transcript ID plus every `CacheKeyScope`
  dimension, stores a format-2 envelope bound to the scoped key digest (raw
  principal/rights/source scope fields are not duplicated in the envelope),
  checks trusted current authority before lookup and again before disclosure,
  and invalidates/reloads malformed or scope-mismatched envelopes. A source
  reader must derive its snapshot from immutable source/transcript records and
  not echo the request scope. The supplied `ScopedAuthority` must verify the
  principal, rights/purpose/classification, immutable source and transcript
  revisions, source fingerprint, retention, policy epoch, and source-rights
  revocation epoch, and return an absolute `validUntil` deadline with each
  `CURRENT` result. The cache rejects expired results and rechecks freshness
  after asynchronous work, so a grant expiring during a source load cannot
  authorize disclosure or a cache write. The revocation epoch is a separate key dimension from
  policy epoch. Scope values alone never grant access. Absent/deleted source
  results are not negative-cached. Call `invalidateTranscriptionScoped` with
  the prior scope for explicit revocation/retention cleanup.
- The protected generic path is
  `AudioVideoCache.getOrLoadScopedWithAuthority(scope, objectIdentity,
  authority, loader)`. A denied or unavailable recheck returns no protected
  value and starts best-effort invalidation for that exact scoped key. The
  deprecated Boolean overloads do not authorize protected cache reads: the
  generic overloads fail closed, and the transcript compatibility overload
  consults only the caller's current source path without reading or writing
  protected cache entries. The deprecated entity-only typed overload remains
  source-compatible but fails closed before cache or source access because it
  cannot return the full observed scope.
  A cache write may already have completed before a revocation is observed; in
  that case disclosure still fails, and later lookups remain gated by fresh
  authority and the policy/source-version key. The backend entry may remain
  stored until its normal TTL or explicit invalidation; expiry prevents reuse
  but does not establish immediate erasure.

## Public operations

| Class | Role |
| --- | --- |
| `AudioVideoCache` | Cache facade over `DistributedCachePort` |
| `TranscriptionCacheService` | Source-authorized transcript reads; scoped opt-in cache path; unscoped transcript cache reads/writes fail closed |

## States and invariants

- `CacheKeyScope` requires non-blank, bounded values for tenant, authenticated
  principal, rights scope, purpose, classification, artifact ID, artifact
  revision, transcript revision, source fingerprint, policy epoch, and model
  license reference, plus a nonnegative source-rights revocation epoch. String
  components reject surrounding whitespace instead of trimming it into an
  alias. Policy and revocation epochs are distinct. This is key-scope
  canonicalization only; owner-backed authorization and rights-invalidation
  wiring remain separately required, and this rule does not qualify runtime
  cache behavior.
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
