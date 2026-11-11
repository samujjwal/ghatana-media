# Media Infrastructure — Cache Adapter

Media caching adapter source; not an independently deployed cache service or a replacement for the authoritative Shared/platform cache contracts. Redis stores optimization entries only. It does not establish current caller scope, consent, retention eligibility, source version, or transcript revision.

## Purpose

Provides a unified facade for audio-video cache operations while keeping services decoupled from the underlying cache backend. Unscoped transcription methods do not read or write protected transcript values because their inputs lack authenticated principal, rights/purpose/classification, immutable artifact/transcript revisions, source fingerprint, and policy/revocation epochs. `getOrLoadTranscription` calls the current source/authorization loader on every request and returns only its matching non-deleted result. On a valid source read it best-effort invalidates the legacy tenant/transcription key, which has no source-version dimension and could contain an older snapshot; absent or deleted source results invalidate that same exact key. Cache invalidation failure never replaces the current source result or its denial. Direct unscoped cache lookup methods return a miss.

The generic protected-cache API requires a complete `CacheKeyScope`, including tenant, principal, rights, purpose, classification, immutable artifact/transcript/source identity, policy epoch, model-license reference, and a nonnegative source-rights `revocationEpoch`. The revocation epoch is separate from policy epoch. `getOrLoadScopedWithAuthority` accepts a typed `ScopedAuthorityResult`: only `CURRENT` with an exact echo of the requested scope permits a cache lookup, and authority is checked again immediately before disclosure. `REJECTED`, `UNKNOWN`, null, error, or mismatched scope fails closed and triggers best-effort invalidation of only that exact key. The deprecated Boolean `getOrLoadScoped` overload cannot authorize protected cache reads or writes; it evicts the exact scoped key best-effort and returns an unavailable error without invoking the loader. A typed callback is only an SPI: production use requires a host owner-backed current-authority provider. Source, policy, or revocation-epoch changes produce distinct keys, preventing reuse of entries from prior versions or rights states. Callers processing a revocation, consent, or retention change can use `invalidateScoped` with the prior scope for exact-key cleanup; this adapter does not claim event wiring or tenant-wide invalidation. Cache key scope partitions entries but never grants authority by itself.

Protected transcription caching also requires a `ScopedTranscriptionSnapshot` that pairs the entity with the complete scope observed by the host loader. The host loader must construct `observedScope` from independently fetched immutable source/transcript facts plus owner-authority evidence; it must not echo the requested scope as a substitute for source readback. The adapter rejects a mismatched scope, transcription identity, tenant, or unpersisted entity version before caching. The public callback contract cannot prove that an arbitrary implementation is truthful, so production use still requires a reviewed owner-backed loader and authority provider. Envelope format 2 invalidates prior envelopes that lacked this scope binding. Example composition shape (the source-reader methods are host-owned):

```java
cacheService.getOrLoadTranscriptionWithScopedSnapshot(
    requestedScope,
    transcriptionId,
    ownerBackedAuthority,
    id -> sourceReader.readCurrent(id).map(read -> Optional.of(
        new TranscriptionCacheService.ScopedTranscriptionSnapshot(
            read.observedScope(), id, read.transcription()))));
```

`readCurrent` must return its scope from authoritative source metadata and current policy evidence. A local callback or unit fixture is not production authority, and this example does not claim production wiring exists. The deprecated entity-only `getOrLoadTranscriptionWithAuthority` overload is retained for source compatibility but fails closed without cache or source access because its loader cannot attest the complete scope. Use `getOrLoadTranscriptionWithScopedSnapshot` only from a host composition that can supply that source readback.

## Layer

`infrastructure` — caching adapter; no domain or business logic. A source search found no runtime callers under `modules/` or `adapters/`; the only out-of-module caller is the cache benchmark. Do not infer STT or multimodal runtime integration from this module's presence in the build.

## Key Components

| Class | Responsibility |
|---|---|
| `AudioVideoCache` | Cache facade; read-through / write-through helper for audio artefacts |
| `TranscriptionCacheService` | Source-backed transcript reads; unscoped reads are source-only, scoped cache requires typed exact-scope authority |

## Configuration

```properties
cache.provider=redis            # in-process | redis
cache.redis.host=localhost
cache.redis.port=6379
```

The generic `AudioVideoCache` facade uses a 30-minute default TTL and caps
caller-supplied TTLs at 30 minutes. There is no active
`cache.transcription.ttl-seconds` setting. The
Shared `DistributedCachePort` owns backend storage and expiration behavior,
while this adapter applies its local TTL cap before calling the port. Unscoped
transcript APIs remain source-read-only; protected scoped cache use is available
only through the typed authority SPI and has no production provider wired here.
Each typed `CURRENT` authority result must carry an absolute `validUntil`
deadline. A result that is expired when received or expires during an
asynchronous cache/source operation fails closed before protected disclosure.
The host derives this deadline from current source and rights facts; cache TTL
does not extend the authority lease.

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
