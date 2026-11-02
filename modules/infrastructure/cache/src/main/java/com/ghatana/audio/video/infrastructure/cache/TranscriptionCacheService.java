package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.core.async.AsyncOperation;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Function;

/**
 * @doc.type class
 * @doc.purpose Source-backed transcription reads with unscoped cache access
 *              disabled until complete protected identity is available.
 *              The source loader remains authoritative for mutable job,
 *              deletion, consent, retention, and revision state.
 * @doc.layer infrastructure
 * @doc.pattern Cache Service
 */
public class TranscriptionCacheService {

    private static final Logger LOG = LoggerFactory.getLogger(TranscriptionCacheService.class);

    private final AudioVideoCache<String, String> cache;

    public TranscriptionCacheService(
            com.ghatana.cache.DistributedCachePort<String, String> cachePort,
            tools.jackson.databind.ObjectMapper objectMapper) {
        this.cache = new AudioVideoCache<>(cachePort, "transcription");
        Objects.requireNonNull(objectMapper, "objectMapper cannot be null");
    }

    /** Returns a miss until protected transcript scope can be revalidated. */
    public AsyncOperation<Optional<TranscriptionEntity>> getTranscription(String tenantId, UUID transcriptionId) {
        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (transcriptionId == null) return AsyncOperation.failure(requiredIdentifier("transcriptionId"));
        // Tenant and entity identity do not prove that consent, retention, source
        // revision, or transcript revision are still current. The cache contract
        // has no trusted authority for those facts, so a hit is not safe to expose.
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
        // its tenant/entity-only key, so it performs no cache I/O.
        return loadCurrentTranscription(tenantId, transcriptionId, key, loader);
    }

    private AsyncOperation<TranscriptionEntity> loadCurrentTranscription(
            String tenantId,
            UUID transcriptionId,
            String key,
            Function<UUID, AsyncOperation<Optional<TranscriptionEntity>>> loader) {
        return loader.apply(transcriptionId).flatMap(source -> {
            if (source.isEmpty() || source.get() == null) {
                return invalidateAfterSourceDenial(key);
            }
            if (!matchesIdentity(source.get(), tenantId, transcriptionId)) {
                return AsyncOperation.failure(identityMismatch());
            }
            if (source.get().isDeleted()) {
                return invalidateAfterSourceDenial(key);
            }
            return AsyncOperation.success(source.get());
        });
    }

    /** Best-effort cleanup never delays or changes the authoritative source denial. */
    private AsyncOperation<TranscriptionEntity> invalidateAfterSourceDenial(String key) {
        try {
            cache.invalidate(key).whenComplete((ignored, invalidationFailure) -> {
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
     * Invalidate cached transcription.
     */
    public AsyncOperation<Void> invalidateTranscription(String tenantId, UUID transcriptionId) {
        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (transcriptionId == null) return AsyncOperation.failure(requiredIdentifier("transcriptionId"));
        String key = buildKey(tenantId, transcriptionId.toString());
        return cache.invalidate(key).thenRun(__ ->
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
