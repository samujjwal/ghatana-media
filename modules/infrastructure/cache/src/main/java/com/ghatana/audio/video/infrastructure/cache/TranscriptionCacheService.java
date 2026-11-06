package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.core.async.AsyncOperation;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

/**
 * @doc.type class
 * @doc.purpose Source-backed transcription reads with opt-in scope-bound
 *              caching; unscoped cache access remains disabled. The current
 *              source and authority readers remain authoritative for mutable
 *              job, deletion, consent, retention, and revision state.
 * @doc.layer infrastructure
 * @doc.pattern Cache Service
 */
public class TranscriptionCacheService {

    private static final Logger LOG = LoggerFactory.getLogger(TranscriptionCacheService.class);
    private static final int MAX_PENDING_INVALIDATIONS = 1_024;

    private final AudioVideoCache<String, String> cache;
    private final tools.jackson.databind.ObjectMapper objectMapper;
    /** Same-key invalidations join; the registry is bounded and released on completion. */
    private final ConcurrentMap<String, CompletableFuture<Void>> pendingInvalidations = new ConcurrentHashMap<>();
    private final AtomicInteger pendingInvalidationReservations = new AtomicInteger();

    public TranscriptionCacheService(
            com.ghatana.cache.DistributedCachePort<String, String> cachePort,
            tools.jackson.databind.ObjectMapper objectMapper) {
        this.cache = new AudioVideoCache<>(cachePort, "transcription");
        this.objectMapper = Objects.requireNonNull(objectMapper, "objectMapper cannot be null");
    }

    private record ScopedTranscriptionEnvelope(
            int formatVersion,
            String scopedKey,
            Long entityVersion,
            TranscriptionEntity transcription) { }

    /** Returns a miss until protected transcript scope can be revalidated. */
    public AsyncOperation<Optional<TranscriptionEntity>> getTranscription(String tenantId, UUID transcriptionId) {
        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (transcriptionId == null) return AsyncOperation.failure(requiredIdentifier("transcriptionId"));
        // Tenant and entity identity do not prove that consent, retention, source
        // revision, or transcript revision are still current. The cache contract
        // has no trusted authority for those facts, so a hit is not safe to expose.
        // Retire any legacy snapshot under this exact key as well. This also
        // evicts malformed/obsolete serialized values without parsing or
        // exposing bytes that have no current source authorization.
        invalidateStaleSnapshot(buildKey(tenantId, transcriptionId.toString()));
        LOG.debug("Transcription cache hit cannot be revalidated; treating as a miss");
        return AsyncOperation.success(Optional.empty());
    }

    /** Preserves the legacy write API as a no-op until complete protected scope is supplied. */
    public AsyncOperation<Void> cacheTranscription(String tenantId, TranscriptionEntity entity) {
        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (!isWritableForTenant(tenantId, entity)) {
            return AsyncOperation.failure(identityMismatch());
        }
        // This legacy API carries tenant and entity identity only. It cannot
        // partition protected transcript bytes by authenticated principal,
        // rights/purpose/classification, immutable revisions, or source
        // fingerprint, so it deliberately remains a no-op until callers can
        // supply the full trusted scope.
        LOG.debug("Transcription cache write lacks complete protected scope; skipping");
        return AsyncOperation.success(null);
    }

    /** Preserves the legacy custom-TTL write API as a no-op for unscoped transcript bytes. */
    public AsyncOperation<Void> cacheTranscription(String tenantId, TranscriptionEntity entity, Duration ttl) {
        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (ttl == null || ttl.isZero() || ttl.isNegative()) {
            return AsyncOperation.failure(new IllegalArgumentException("ttl must be positive"));
        }
        if (!isWritableForTenant(tenantId, entity)) {
            return AsyncOperation.failure(identityMismatch());
        }
        LOG.debug("Transcription cache write lacks complete protected scope; skipping");
        return AsyncOperation.success(null);
    }

    /**
     * Get or load transcription using provided loader.
     */
    public AsyncOperation<TranscriptionEntity> getOrLoadTranscription(
            String tenantId,
            UUID transcriptionId,
            Function<UUID, AsyncOperation<Optional<TranscriptionEntity>>> loader) {

        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (transcriptionId == null) return AsyncOperation.failure(requiredIdentifier("transcriptionId"));
        String key = buildKey(tenantId, transcriptionId.toString());
        Objects.requireNonNull(loader, "loader cannot be null");
        // Always consult the caller's current source/authorization path. A cached
        // entity contains no trusted current scope, consent, retention, source
        // version, or immutable transcript revision to validate before exposure.
        // This API also cannot safely write the returned protected content under
        // its tenant/entity-only key. On a validated source hit, it only issues
        // best-effort invalidation of a legacy snapshot under that exact key.
        return loadCurrentTranscription(tenantId, transcriptionId, key, loader);
    }

    /**
     * Gets a transcript under an immutable, caller-specific authority scope.
     * The supplied authority reader must consult the current trusted rights and
     * source owner; scope values partition entries but do not grant access.
     * Authority is checked before the cache lookup and again immediately before
     * a decoded value is returned. A scope change, revocation, retention change,
     * or source revision change therefore cannot reuse an older entry.
     */
    public AsyncOperation<TranscriptionEntity> getOrLoadTranscription(
            AudioVideoCache.CacheKeyScope scope,
            UUID transcriptionId,
            Function<AudioVideoCache.CacheKeyScope, AsyncOperation<Boolean>> authorityCheck,
            Function<UUID, AsyncOperation<Optional<TranscriptionEntity>>> loader) {
        if (!isValidScopedIdentity(scope, transcriptionId)) {
            return AsyncOperation.failure(identityMismatch());
        }
        Objects.requireNonNull(authorityCheck, "authorityCheck cannot be null");
        Objects.requireNonNull(loader, "loader cannot be null");

        return cache.getOrLoadScoped(scope, transcriptionId.toString(), authorityCheck,
                ignoredKey -> loadScopedEnvelope(scope, transcriptionId, loader))
                .flatMap(encoded -> decodeOrRepairScopedEnvelope(scope, transcriptionId, encoded,
                        authorityCheck, loader, false));
    }

    /** Invalidates one exact transcript and immutable authority/source scope. */
    public AsyncOperation<Void> invalidateTranscriptionScoped(
            AudioVideoCache.CacheKeyScope scope, UUID transcriptionId) {
        if (!isValidScopedIdentity(scope, transcriptionId)) {
            return AsyncOperation.failure(identityMismatch());
        }
        return cache.invalidateScoped(scope, transcriptionId.toString());
    }

    private AsyncOperation<String> loadScopedEnvelope(
            AudioVideoCache.CacheKeyScope scope,
            UUID transcriptionId,
            Function<UUID, AsyncOperation<Optional<TranscriptionEntity>>> loader) {
        final AsyncOperation<Optional<TranscriptionEntity>> source;
        try {
            source = Objects.requireNonNull(loader.apply(transcriptionId), "loader returned null operation");
        } catch (RuntimeException failure) {
            return AsyncOperation.failure(failure);
        }
        return source.flatMap(result -> {
            TranscriptionEntity entity = result == null ? null : result.orElse(null);
            if (entity != null && !matchesIdentity(entity, scope.tenantId(), transcriptionId)) {
                return AsyncOperation.failure(identityMismatch());
            }
            if (entity != null && entity.isDeleted()) entity = null;
            // Do not negative-cache absence or deletion: a subsequently created
            // revision must be visible without waiting for an optimization TTL.
            if (entity == null) return AsyncOperation.success(null);
            return AsyncOperation.success(encodeEnvelope(scope, transcriptionId, entity));
        });
    }

    private AsyncOperation<TranscriptionEntity> decodeOrRepairScopedEnvelope(
            AudioVideoCache.CacheKeyScope scope,
            UUID transcriptionId,
            String encoded,
            Function<AudioVideoCache.CacheKeyScope, AsyncOperation<Boolean>> authorityCheck,
            Function<UUID, AsyncOperation<Optional<TranscriptionEntity>>> loader,
            boolean refreshed) {
        // getOrLoadScoped rechecks authority after the cache/source operation and
        // before returning this encoded value. Decode only after that final check.
        // A null loader result is an authoritative miss and is never negative-cached.
        if (encoded == null) return AsyncOperation.success(null);
        ScopedTranscriptionEnvelope envelope = decodeEnvelope(encoded);
        if (isValidEnvelope(envelope, scope, transcriptionId)) {
            return AsyncOperation.success(envelope.transcription());
        }
        if (refreshed) {
            return AsyncOperation.failure(new IllegalStateException(
                    "Scoped transcription cache entry failed identity validation after refresh"));
        }
        // Malformed or scope-mismatched values are never exposed. Retire the exact
        // key and use the same bounded, authority-checked single-flight path again.
        return cache.invalidateScoped(scope, transcriptionId.toString()).flatMap(ignored ->
                cache.getOrLoadScoped(scope, transcriptionId.toString(), authorityCheck,
                        key -> loadScopedEnvelope(scope, transcriptionId, loader))
                        .flatMap(reloaded -> decodeOrRepairScopedEnvelope(scope, transcriptionId, reloaded,
                                authorityCheck, loader, true)));
    }

    private String encodeEnvelope(
            AudioVideoCache.CacheKeyScope scope,
            UUID transcriptionId,
            TranscriptionEntity entity) {
        try {
            return objectMapper.writeValueAsString(new ScopedTranscriptionEnvelope(
                    1, cache.buildScopedKey(scope, transcriptionId.toString()),
                    entity.getVersion(), entity));
        } catch (Exception failure) {
            throw new IllegalStateException("Unable to encode scoped transcription cache entry", failure);
        }
    }

    private ScopedTranscriptionEnvelope decodeEnvelope(String encoded) {
        if (encoded == null || encoded.isBlank()) return null;
        try {
            return objectMapper.readValue(encoded, ScopedTranscriptionEnvelope.class);
        } catch (Exception malformed) {
            return null;
        }
    }

    private boolean isValidEnvelope(
            ScopedTranscriptionEnvelope envelope,
            AudioVideoCache.CacheKeyScope scope,
            UUID transcriptionId) {
        if (envelope == null || envelope.formatVersion() != 1
                || !Objects.equals(envelope.scopedKey(), cache.buildScopedKey(scope, transcriptionId.toString()))) {
            return false;
        }
        TranscriptionEntity entity = envelope.transcription();
        return entity != null
                && matchesIdentity(entity, scope.tenantId(), transcriptionId)
                && !entity.isDeleted()
                && Objects.equals(envelope.entityVersion(), entity.getVersion());
    }

    private static boolean isValidScopedIdentity(
            AudioVideoCache.CacheKeyScope scope, UUID transcriptionId) {
        return scope != null && transcriptionId != null
                && hasTenantId(scope.tenantId());
    }

    private AsyncOperation<TranscriptionEntity> loadCurrentTranscription(
            String tenantId,
            UUID transcriptionId,
            String key,
            Function<UUID, AsyncOperation<Optional<TranscriptionEntity>>> loader) {
        final AsyncOperation<Optional<TranscriptionEntity>> load;
        try {
            load = Objects.requireNonNull(loader.apply(transcriptionId), "loader returned null operation");
        } catch (RuntimeException loaderFailure) {
            return AsyncOperation.failure(loaderFailure);
        }
        return load.flatMap(source -> {
            if (source.isEmpty() || source.get() == null) {
                return invalidateAfterSourceDenial(key);
            }
            if (!matchesIdentity(source.get(), tenantId, transcriptionId)) {
                // A source identity violation cannot authorize a read. Retire any
                // legacy snapshot under the requested identity as a best-effort
                // defense against a later stale read, while keeping the mismatch
                // failure authoritative and avoiding tenant-wide invalidation.
                invalidateStaleSnapshot(key);
                return AsyncOperation.failure(identityMismatch());
            }
            if (source.get().isDeleted()) {
                return invalidateAfterSourceDenial(key);
            }
            // Evict any legacy tenant/entity-keyed snapshot after the current
            // source has been checked. Its key carries no source version, so
            // retaining it would let a later cache consumer observe an older
            // transcript revision. Cache cleanup is best effort; the value
            // returned here remains the authoritative source result.
            invalidateStaleSnapshot(key);
            return AsyncOperation.success(source.get());
        });
    }

    private void invalidateStaleSnapshot(String key) {
        try {
            invalidateSnapshot(key).whenComplete((ignored, invalidationFailure) -> {
                if (invalidationFailure != null) {
                    LOG.debug("Stale transcription cache invalidation failed; source result remains authoritative: causeType={}",
                            invalidationFailure.getClass().getSimpleName());
                }
            });
        } catch (RuntimeException invalidationFailure) {
            LOG.debug("Stale transcription cache invalidation failed; source result remains authoritative: causeType={}",
                    invalidationFailure.getClass().getSimpleName());
        }
    }

    /** Best-effort cleanup never delays or changes the authoritative source denial. */
    private AsyncOperation<TranscriptionEntity> invalidateAfterSourceDenial(String key) {
        try {
            invalidateSnapshot(key).whenComplete((ignored, invalidationFailure) -> {
                if (invalidationFailure != null) {
                    LOG.debug("Stale transcription cache invalidation failed; source denial remains authoritative: causeType={}",
                            invalidationFailure.getClass().getSimpleName());
                }
            });
        } catch (RuntimeException invalidationFailure) {
            LOG.debug("Stale transcription cache invalidation failed; source denial remains authoritative: causeType={}",
                    invalidationFailure.getClass().getSimpleName());
        }
        return AsyncOperation.success(null);
    }

    /**
     * Runs at most one invalidation per exact key and lets callers join it.
     * A source read may start cleanup immediately before an explicit delete;
     * joining avoids reporting a spurious mutation conflict for that race.
     */
    private AsyncOperation<Void> invalidateSnapshot(String key) {
        CompletableFuture<Void> existing = pendingInvalidations.get(key);
        if (existing != null) return AsyncOperation.from(existing);
        if (!reserveInvalidationSlot()) {
            existing = pendingInvalidations.get(key);
            if (existing != null) return AsyncOperation.from(existing);
            return AsyncOperation.failure(new IllegalStateException(
                    "Transcription cache invalidation coordination capacity reached"));
        }

        CompletableFuture<Void> candidate = new CompletableFuture<>();
        existing = pendingInvalidations.putIfAbsent(key, candidate);
        if (existing != null) {
            pendingInvalidationReservations.decrementAndGet();
            return AsyncOperation.from(existing);
        }

        try {
            AsyncOperation<Void> operation = Objects.requireNonNull(
                    cache.invalidate(key), "cache invalidation returned null operation");
            operation.whenComplete((ignored, failure) -> {
                pendingInvalidations.remove(key, candidate);
                pendingInvalidationReservations.decrementAndGet();
                if (failure == null) candidate.complete(null);
                else candidate.completeExceptionally(failure);
            });
        } catch (RuntimeException failure) {
            pendingInvalidations.remove(key, candidate);
            pendingInvalidationReservations.decrementAndGet();
            candidate.completeExceptionally(failure);
        }
        return AsyncOperation.from(candidate);
    }

    private boolean reserveInvalidationSlot() {
        while (true) {
            int current = pendingInvalidationReservations.get();
            if (current >= MAX_PENDING_INVALIDATIONS) return false;
            if (pendingInvalidationReservations.compareAndSet(current, current + 1)) return true;
        }
    }

    /**
     * Invalidate cached transcription.
     */
    public AsyncOperation<Void> invalidateTranscription(String tenantId, UUID transcriptionId) {
        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (transcriptionId == null) return AsyncOperation.failure(requiredIdentifier("transcriptionId"));
        String key = buildKey(tenantId, transcriptionId.toString());
        return invalidateSnapshot(key).thenRun(__ ->
            LOG.debug("Invalidated transcription cache: scopeRef={}",
                    scopeReference(tenantId, transcriptionId.toString())));
    }

    /**
     * Invalidate all transcriptions for a tenant.
     */
    public AsyncOperation<Void> invalidateAllForTenant(String tenantId) {
        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        // DistributedCachePort only exposes port-wide invalidation. Calling it
        // here would evict other tenants' entries while claiming tenant scope.
        // Fail closed until the platform contract supports scoped invalidation.
        return AsyncOperation.failure(new UnsupportedOperationException(
                "Tenant-scoped transcription cache invalidation is not supported"));
    }

    /** Preserves the legacy audio-ID write API as a no-op without complete protected scope. */
    public AsyncOperation<Void> cacheTranscriptionByAudioFileId(
            String tenantId,
            UUID audioFileId,
            TranscriptionEntity entity) {

        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (audioFileId == null) return AsyncOperation.failure(requiredIdentifier("audioFileId"));
        if (!isWritableForAudioFile(tenantId, audioFileId, entity)) {
            return AsyncOperation.failure(identityMismatch());
        }

        // Audio identity alone is also insufficient protected-content scope.
        LOG.debug("Audio transcription cache write lacks complete protected scope; skipping");
        return AsyncOperation.success(null);
    }

    /** Returns a miss until audio identity is joined to current protected scope and source revision. */
    public AsyncOperation<Optional<TranscriptionEntity>> getTranscriptionByAudioFileId(
            String tenantId,
            UUID audioFileId) {

        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (audioFileId == null) return AsyncOperation.failure(requiredIdentifier("audioFileId"));
        // Audio identity does not establish current consent, retention, or source
        // and transcript revisions. Do not deserialize or expose a cache hit.
        LOG.debug("Audio transcription cache hit cannot be revalidated; treating as a miss");
        return AsyncOperation.success(Optional.empty());
    }

    private String buildKey(String tenantId, String id) {
        return cache.buildKey(tenantId, id);
    }

    private String scopeReference(String tenantId, String id) {
        return AudioVideoCache.keyReference(buildKey(tenantId, id));
    }

    private static boolean matchesIdentity(TranscriptionEntity entity, String tenantId, UUID transcriptionId) {
        return entity != null && hasTenantId(tenantId) && Objects.equals(entity.getTenantId(), tenantId)
                && Objects.equals(entity.getId(), transcriptionId);
    }

    private static boolean isWritableForTenant(String tenantId, TranscriptionEntity entity) {
        return entity != null && entity.getId() != null && hasTenantId(tenantId)
                && Objects.equals(entity.getTenantId(), tenantId);
    }

    private static boolean isWritableForAudioFile(String tenantId, UUID audioFileId, TranscriptionEntity entity) {
        return entity != null && entity.getId() != null && hasTenantId(tenantId)
                && Objects.equals(entity.getTenantId(), tenantId)
                && Objects.equals(entity.getAudioFileId(), audioFileId);
    }

    private static boolean hasTenantId(String tenantId) {
        return tenantId != null && !tenantId.isBlank() && tenantId.equals(tenantId.strip());
    }

    private static IllegalArgumentException invalidTenantId() {
        return new IllegalArgumentException("tenantId must be nonblank and have no leading or trailing whitespace");
    }

    private static IllegalArgumentException requiredIdentifier(String name) {
        return new IllegalArgumentException(name + " is required");
    }

    /** Does not disclose either requested or returned identities. */
    private static IllegalStateException identityMismatch() {
        return new IllegalStateException("Transcription identity does not match requested scope");
    }
}
