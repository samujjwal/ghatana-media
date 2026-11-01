package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import tools.jackson.databind.ObjectMapper;
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
 * @doc.purpose Cache service for transcription results.
 *              Provides tenant-scoped caching with Redis backend.
 * @doc.layer infrastructure
 * @doc.pattern Cache Service
 */
public class TranscriptionCacheService {

    private static final Logger LOG = LoggerFactory.getLogger(TranscriptionCacheService.class);

    private static final Duration DEFAULT_TTL = Duration.ofMinutes(30);
    private static final Duration LONG_TTL = Duration.ofHours(2);

    private final AudioVideoCache<String, String> cache;
    private final ObjectMapper objectMapper;

    public TranscriptionCacheService(
            com.ghatana.cache.DistributedCachePort<String, String> cachePort,
            ObjectMapper objectMapper) {
        this.cache = new AudioVideoCache<>(cachePort, "transcription");
        this.objectMapper = Objects.requireNonNull(objectMapper, "objectMapper cannot be null");
    }

    /**
     * Get cached transcription by ID.
     */
    public AsyncOperation<Optional<TranscriptionEntity>> getTranscription(String tenantId, UUID transcriptionId) {
        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (transcriptionId == null) return AsyncOperation.failure(requiredIdentifier("transcriptionId"));
        String key = buildKey(tenantId, transcriptionId.toString());

        return cache.get(key)
            .flatMap(optJson -> {
                if (optJson.isPresent()) {
                    try {
                        TranscriptionEntity entity = objectMapper.readValue(optJson.get(), TranscriptionEntity.class);
                        if (matchesIdentity(entity, tenantId, transcriptionId) && !entity.isDeleted()) {
                            LOG.debug("Cache hit for transcription");
                            return AsyncOperation.success(Optional.of(entity));
                        }
                        LOG.debug("Ignoring transcription cache entry with invalid identity or deletion state");
                        return AsyncOperation.success(Optional.empty());
                    } catch (Exception e) {
                        LOG.warn("Failed to deserialize cached transcription; treating it as a miss");
                        return AsyncOperation.success(Optional.<TranscriptionEntity>empty());
                    }
                }
                LOG.debug("Cache miss for transcription");
                return AsyncOperation.success(Optional.<TranscriptionEntity>empty());
            });
    }

    /**
     * Cache a transcription result.
     */
    public AsyncOperation<Void> cacheTranscription(String tenantId, TranscriptionEntity entity) {
        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (!isWritableForTenant(tenantId, entity)) {
            return AsyncOperation.failure(identityMismatch());
        }
        String key = buildKey(tenantId, entity.getId().toString());

        try {
            String json = objectMapper.writeValueAsString(entity);
            return cache.put(key, json, DEFAULT_TTL).thenRun(__ ->
                LOG.debug("Cached transcription: tenantId={}, id={}", tenantId, entity.getId()));
        } catch (Exception e) {
            LOG.error("Failed to serialize transcription for caching: {}", entity.getId(), e);
            return AsyncOperation.success(null);
        }
    }

    /**
     * Cache transcription with custom TTL.
     */
    public AsyncOperation<Void> cacheTranscription(String tenantId, TranscriptionEntity entity, Duration ttl) {
        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (!isWritableForTenant(tenantId, entity)) {
            return AsyncOperation.failure(identityMismatch());
        }
        String key = buildKey(tenantId, entity.getId().toString());

        try {
            String json = objectMapper.writeValueAsString(entity);
            return cache.put(key, json, ttl).thenRun(__ ->
                LOG.debug("Cached transcription with TTL {}s: tenantId={}, id={}",
                    ttl.getSeconds(), tenantId, entity.getId()));
        } catch (Exception e) {
            LOG.error("Failed to serialize transcription for caching: {}", entity.getId(), e);
            return AsyncOperation.success(null);
        }
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
        return cache.get(key).flatMap(cached -> {
            if (cached.isPresent()) {
                try {
                    TranscriptionEntity entity = objectMapper.readValue(cached.get(), TranscriptionEntity.class);
                    if (matchesIdentity(entity, tenantId, transcriptionId) && !entity.isDeleted()) {
                        return AsyncOperation.success(entity);
                    }
                    LOG.debug("Ignoring transcription cache entry with invalid identity or deletion state");
                } catch (Exception malformed) {
                    LOG.warn("Failed to deserialize cached transcription; loading from source");
                }
            }
            return loader.apply(transcriptionId).flatMap(source -> {
                if (source.isEmpty() || source.get() == null || source.get().isDeleted()) {
                    return AsyncOperation.success(null);
                }
                if (!matchesIdentity(source.get(), tenantId, transcriptionId)) {
                    return AsyncOperation.failure(identityMismatch());
                }
                TranscriptionEntity entity = source.get();
                try {
                    String json = objectMapper.writeValueAsString(entity);
                    return cache.put(key, json).map(ignored -> entity);
                } catch (Exception serializationFailure) {
                    LOG.warn("Failed to serialize loaded transcription for caching; returning source value");
                    return AsyncOperation.success(entity);
                }
            });
        });
    }

    /**
     * Invalidate cached transcription.
     */
    public AsyncOperation<Void> invalidateTranscription(String tenantId, UUID transcriptionId) {
        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (transcriptionId == null) return AsyncOperation.failure(requiredIdentifier("transcriptionId"));
        String key = buildKey(tenantId, transcriptionId.toString());
        return cache.invalidate(key).thenRun(__ ->
            LOG.debug("Invalidated transcription cache: tenantId={}, id={}", tenantId, transcriptionId));
    }

    /**
     * Invalidate all transcriptions for a tenant.
     */
    public AsyncOperation<Void> invalidateAllForTenant(String tenantId) {
        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        // Note: This would need pattern-based invalidation support in the cache
        LOG.debug("Invalidate all transcriptions for tenant: {}", tenantId);
        return cache.invalidateAll();
    }

    /**
     * Cache transcription by audio file ID (for lookup optimization).
     */
    public AsyncOperation<Void> cacheTranscriptionByAudioFileId(
            String tenantId,
            UUID audioFileId,
            TranscriptionEntity entity) {

        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (audioFileId == null) return AsyncOperation.failure(requiredIdentifier("audioFileId"));
        if (!isWritableForAudioFile(tenantId, audioFileId, entity)) {
            return AsyncOperation.failure(identityMismatch());
        }

        String key = buildKey(tenantId, "audio:" + audioFileId.toString());

        try {
            String json = objectMapper.writeValueAsString(entity);
            return cache.put(key, json, DEFAULT_TTL).thenRun(__ ->
                LOG.debug("Cached transcription by audio file: tenantId={}, audioId={}",
                    tenantId, audioFileId));
        } catch (Exception e) {
            LOG.error("Failed to cache transcription by audio file: {}", audioFileId, e);
            return AsyncOperation.success(null);
        }
    }

    /**
     * Get transcription by audio file ID.
     */
    public AsyncOperation<Optional<TranscriptionEntity>> getTranscriptionByAudioFileId(
            String tenantId,
            UUID audioFileId) {

        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (audioFileId == null) return AsyncOperation.failure(requiredIdentifier("audioFileId"));
        String key = buildKey(tenantId, "audio:" + audioFileId.toString());

        return cache.get(key)
            .flatMap(optJson -> {
                if (optJson.isPresent()) {
                    try {
                        TranscriptionEntity entity = objectMapper.readValue(optJson.get(), TranscriptionEntity.class);
                        if (Objects.equals(entity.getTenantId(), tenantId)
                                && Objects.equals(entity.getAudioFileId(), audioFileId)
                                && !entity.isDeleted()) {
                            return AsyncOperation.success(Optional.of(entity));
                        }
                        LOG.debug("Ignoring audio transcription cache entry with invalid identity or deletion state");
                        return AsyncOperation.success(Optional.empty());
                    } catch (Exception e) {
                        LOG.warn("Failed to deserialize audio transcription cache entry; treating it as a miss");
                        return AsyncOperation.success(Optional.<TranscriptionEntity>empty());
                    }
                }
                return AsyncOperation.success(Optional.<TranscriptionEntity>empty());
            });
    }

    private String buildKey(String tenantId, String id) {
        return cache.buildKey(tenantId, id);
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
