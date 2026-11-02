package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import tools.jackson.databind.ObjectMapper;
import com.ghatana.core.async.AsyncOperation;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Function;

/**
 * @doc.type class
 * @doc.purpose Best-effort write-through cache for transcription snapshots.
 *              The source loader remains authoritative for mutable job,
 *              deletion, consent, retention, and revision state.
 * @doc.layer infrastructure
 * @doc.pattern Cache Service
 */
public class TranscriptionCacheService {

    private static final Logger LOG = LoggerFactory.getLogger(TranscriptionCacheService.class);

    private static final Duration DEFAULT_TTL = Duration.ofMinutes(30);
    // No cache-specific ceiling is defined; keep entries well below the existing 8 MiB HTTP body default.
    static final int MAX_SERIALIZED_ENTRY_BYTES = 1024 * 1024;

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
        // Tenant and entity identity do not prove that consent, retention, source
        // revision, or transcript revision are still current. The cache contract
        // has no trusted authority for those facts, so a hit is not safe to expose.
        LOG.debug("Transcription cache hit cannot be revalidated; treating as a miss");
        return AsyncOperation.success(Optional.empty());
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
            String json = serializeBounded(entity);
            return cache.put(key, json, DEFAULT_TTL).thenRun(__ ->
                LOG.debug("Cached transcription: scopeRef={}", scopeReference(tenantId, entity.getId().toString())));
        } catch (Exception e) {
            if (isOversizedSerializationFailure(e)) {
                LOG.warn("Oversized transcription cache value; skipping cache write");
                return AsyncOperation.success(null);
            }
            LOG.warn("Transcription cache write preparation failed; skipping cache entry");
            return AsyncOperation.success(null);
        }
    }

    /**
     * Cache transcription with custom TTL.
     */
    public AsyncOperation<Void> cacheTranscription(String tenantId, TranscriptionEntity entity, Duration ttl) {
        if (!hasTenantId(tenantId)) return AsyncOperation.failure(invalidTenantId());
        if (ttl == null || ttl.isZero() || ttl.isNegative()) {
            return AsyncOperation.failure(new IllegalArgumentException("ttl must be positive"));
        }
        if (!isWritableForTenant(tenantId, entity)) {
            return AsyncOperation.failure(identityMismatch());
        }
        String key = buildKey(tenantId, entity.getId().toString());

        try {
            String json = serializeBounded(entity);
            return cache.put(key, json, ttl).thenRun(__ ->
                LOG.debug("Cached transcription with TTL {}s: scopeRef={}",
                    ttl.getSeconds(), scopeReference(tenantId, entity.getId().toString())));
        } catch (Exception e) {
            if (isOversizedSerializationFailure(e)) {
                LOG.warn("Oversized transcription cache value; skipping cache write");
                return AsyncOperation.success(null);
            }
            LOG.warn("Transcription cache write preparation failed; skipping cache entry");
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
        // Always consult the caller's current source/authorization path. A cached
        // entity contains no trusted current scope, consent, retention, source
        // version, or immutable transcript revision to validate before exposure.
        return loadCurrentTranscription(tenantId, transcriptionId, key, loader);
    }

    private AsyncOperation<TranscriptionEntity> loadCurrentTranscription(
            String tenantId,
            UUID transcriptionId,
            String key,
            Function<UUID, AsyncOperation<Optional<TranscriptionEntity>>> loader) {
        return loader.apply(transcriptionId).flatMap(source -> {
            if (source.isEmpty() || source.get() == null) {
                // The caller's current source/authorization path is authoritative.
                // Remove the stale optimization entry when that path says the
                // protected source is absent (including revoked/erased access).
                return invalidateAfterSourceDenial(key);
            }
            if (!matchesIdentity(source.get(), tenantId, transcriptionId)) {
                return AsyncOperation.failure(identityMismatch());
            }
            if (source.get().isDeleted()) {
                return invalidateAfterSourceDenial(key);
            }
            TranscriptionEntity entity = source.get();
            try {
                String json = serializeBounded(entity);
                return writeOptimizationEntry(key, json, entity);
            } catch (Exception serializationFailure) {
                if (isOversizedSerializationFailure(serializationFailure)) {
                    LOG.warn("Oversized source transcription; skipping cache write");
                    return AsyncOperation.success(entity);
                }
                LOG.warn("Failed to serialize loaded transcription for caching; returning source value");
                return AsyncOperation.success(entity);
            }
        });
    }

    /**
     * Eviction is best effort: the current source decision remains authoritative
     * even if the distributed cache is unavailable or cannot invalidate a key.
     */
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
        // The cache is never read as an authorization/source of truth on this
        // API, so a slow optimization port must not delay a current denial.
        return AsyncOperation.success(null);
    }

    /**
     * Cache persistence is an optimization on this read-through path. The already
     * resolved source result remains authoritative if the cache is unavailable.
     */
    private AsyncOperation<TranscriptionEntity> writeOptimizationEntry(
            String key, String json, TranscriptionEntity source) {
        java.util.concurrent.CompletableFuture<TranscriptionEntity> result =
                new java.util.concurrent.CompletableFuture<>();
        try {
            cache.put(key, json).whenComplete((ignored, cacheFailure) -> {
                if (cacheFailure != null) {
                    LOG.warn("Transcription cache write failed; returning current source value: causeType={}",
                            cacheFailure.getClass().getSimpleName());
                }
                result.complete(source);
            });
        } catch (RuntimeException cacheFailure) {
            LOG.warn("Transcription cache write failed; returning current source value: causeType={}",
                    cacheFailure.getClass().getSimpleName());
            result.complete(source);
        }
        return AsyncOperation.from(result);
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
            String json = serializeBounded(entity);
            return cache.put(key, json, DEFAULT_TTL).thenRun(__ ->
                LOG.debug("Cached transcription by audio file: scopeRef={}",
                    scopeReference(tenantId, "audio:" + audioFileId)));
        } catch (Exception e) {
            if (isOversizedSerializationFailure(e)) {
                LOG.warn("Oversized transcription cache value; skipping cache write");
                return AsyncOperation.success(null);
            }
            LOG.warn("Audio transcription cache write preparation failed; skipping cache entry");
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

    /** Counts UTF-8 bytes without allocating a second copy of the serialized value. */
    static boolean withinSerializedEntryLimit(String serialized) {
        if (serialized == null || serialized.length() > MAX_SERIALIZED_ENTRY_BYTES) {
            return false;
        }
        int byteCount = 0;
        for (int index = 0; index < serialized.length(); index++) {
            char current = serialized.charAt(index);
            if (current <= 0x7f) {
                byteCount++;
            } else if (current <= 0x7ff) {
                byteCount += 2;
            } else if (Character.isHighSurrogate(current)
                    && index + 1 < serialized.length()
                    && Character.isLowSurrogate(serialized.charAt(index + 1))) {
                byteCount += 4;
                index++;
            } else if (Character.isSurrogate(current)) {
                // Match the UTF-8 encoder replacement byte for unpaired UTF-16 surrogates.
                byteCount++;
            } else {
                byteCount += 3;
            }
            if (byteCount > MAX_SERIALIZED_ENTRY_BYTES) {
                return false;
            }
        }
        return true;
    }

    private String serializeBounded(TranscriptionEntity entity) throws IOException {
        BoundedJsonOutputStream output = new BoundedJsonOutputStream(MAX_SERIALIZED_ENTRY_BYTES);
        objectMapper.writeValue(output, entity);
        return output.asUtf8String();
    }

    private static boolean isOversizedSerializationFailure(Throwable failure) {
        java.util.Set<Throwable> seen = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
        Throwable current = failure;
        while (current != null && seen.add(current)) {
            if (current instanceof OversizedCacheEntryException) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    private static final class BoundedJsonOutputStream extends OutputStream {
        private final int maximumBytes;
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();

        private BoundedJsonOutputStream(int maximumBytes) {
            this.maximumBytes = maximumBytes;
        }

        @Override
        public void write(int value) throws IOException {
            ensureCapacity(1);
            bytes.write(value);
        }

        @Override
        public void write(byte[] value, int offset, int length) throws IOException {
            if (length < 0 || offset < 0 || offset > value.length - length) {
                throw new IndexOutOfBoundsException();
            }
            ensureCapacity(length);
            bytes.write(value, offset, length);
        }

        private void ensureCapacity(int additionalBytes) throws OversizedCacheEntryException {
            if (additionalBytes > maximumBytes - bytes.size()) {
                throw new OversizedCacheEntryException();
            }
        }

        private String asUtf8String() {
            return bytes.toString(StandardCharsets.UTF_8);
        }
    }

    private static final class OversizedCacheEntryException extends IOException {
        private OversizedCacheEntryException() {
            super("serialized cache entry exceeds configured limit");
        }
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
