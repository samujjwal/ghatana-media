package com.ghatana.audio.video.infrastructure.cache;

import tools.jackson.databind.ObjectMapper;
import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.cache.DistributedCachePort;
import com.ghatana.cache.DistributedCacheService;
import com.ghatana.cache.backend.AsyncRedisCacheBackend;
import com.ghatana.core.async.AsyncOperation;
import com.redis.testcontainers.RedisContainer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.time.Duration;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static com.ghatana.audio.video.infrastructure.cache.AsyncOperationTestSupport.await;

/**
 * Integration tests for TranscriptionCacheService against a real Redis instance.
 *
 * <p>Redis persistence and invalidation are checked through the Shared cache port.
 * Protected transcript reads always use a current source loader; Redis contents do
 * not establish current authorization, consent, retention, or source revision.
 *
 * @doc.type class
 * @doc.purpose Redis integration tests for cache TTL, tenant isolation, and invalidation (AV-P1-02)
 * @doc.layer test
 * @doc.pattern IntegrationTest
 */
@Testcontainers
@DisplayName("Transcription Cache Integration Tests (AV-P1-02)")
class TranscriptionCacheIT {

    @Container
    static final RedisContainer REDIS = new RedisContainer(
            DockerImageName.parse("redis:7.2-alpine"));

    private AsyncRedisCacheBackend redisBackend;
    private DistributedCacheService cachePort;
    private TranscriptionCacheService cacheService;
    private ObjectMapper objectMapper;

    @BeforeEach
    void setUp() {
        String host = REDIS.getHost();
        int port = REDIS.getFirstMappedPort();

        objectMapper = new ObjectMapper();

        redisBackend = new AsyncRedisCacheBackend(host, port, null, 0, 2_000);
        cachePort = new DistributedCacheService(
                redisBackend, "transcription-cache-it");

        cacheService = new TranscriptionCacheService(cachePort, objectMapper);
    }

    @AfterEach
    void tearDown() {
        if (redisBackend != null) {
            redisBackend.close();
        }
    }

    @Test
    @DisplayName("Should skip Redis persistence without a complete protected scope")
    void shouldSkipUnscopedTranscriptPersistence() {
        String tenantId = "tenant-cache-1";
        TranscriptionEntity entity = buildEntity(tenantId);

        await(cacheService.cacheTranscription(tenantId, entity));

        Optional<String> stored = await(cachePort.get(cacheKey(tenantId, entity.getId())));
        Optional<TranscriptionEntity> protectedRead = await(cacheService.getTranscription(tenantId, entity.getId()));

        assertThat(stored).isEmpty();
        assertThat(protectedRead).isEmpty();
    }

    @Test
    @DisplayName("Should return empty for cache miss")
    void shouldReturnEmptyForCacheMiss() {
        Optional<TranscriptionEntity> result =
                await(cacheService.getTranscription("tenant-miss", UUID.randomUUID()));

        assertThat(result).isEmpty();
    }

    @Test
    @DisplayName("Should isolate keys between tenants (tenant isolation)")
    void shouldIsolateCacheKeysBetweenTenants() {
        String tenant1 = "tenant-iso-1";
        String tenant2 = "tenant-iso-2";
        UUID sharedId = UUID.randomUUID();

        TranscriptionEntity entity1 = buildEntityWithIdAndText(tenant1, sharedId, "Transcript for tenant-1");
        TranscriptionEntity entity2 = buildEntityWithIdAndText(tenant2, sharedId, "Transcript for tenant-2");

        await(cacheService.cacheTranscription(tenant1, entity1));
        await(cacheService.cacheTranscription(tenant2, entity2));

        Optional<String> t1Stored = await(cachePort.get(cacheKey(tenant1, sharedId)));
        Optional<String> t2Stored = await(cachePort.get(cacheKey(tenant2, sharedId)));
        Optional<TranscriptionEntity> t1Result = await(cacheService.getTranscription(tenant1, sharedId));
        Optional<TranscriptionEntity> t2Result = await(cacheService.getTranscription(tenant2, sharedId));

        assertThat(t1Stored).isEmpty();
        assertThat(t2Stored).isEmpty();
        assertThat(t1Result).isEmpty();
        assertThat(t2Result).isEmpty();
    }

    @Test
    @DisplayName("Should not persist a transcription through the unscoped TTL API")
    void shouldSkipUnscopedTtlWrite() {
        String tenantId = "tenant-ttl";
        TranscriptionEntity entity = buildEntity(tenantId);

        await(cacheService.cacheTranscription(tenantId, entity, Duration.ofSeconds(1)));

        String key = cacheKey(tenantId, entity.getId());
        assertThat(await(cachePort.get(key))).isEmpty();
        assertThat(await(cacheService.getTranscription(tenantId, entity.getId()))).isEmpty();
    }

    @Test
    @DisplayName("Should remove entry on explicit invalidation")
    void shouldRemoveEntryOnInvalidation() {
        String tenantId = "tenant-inval";
        TranscriptionEntity entity = buildEntity(tenantId);

        String key = cacheKey(tenantId, entity.getId());
        await(cachePort.put(key, "stale", Duration.ofMinutes(1)));
        assertThat(await(cachePort.get(key))).isPresent();
        assertThat(await(cacheService.getTranscription(tenantId, entity.getId()))).isEmpty();

        await(cacheService.invalidateTranscription(tenantId, entity.getId()));

        Optional<String> after = await(cachePort.get(key));
        assertThat(after).isEmpty();
        assertThat(await(cacheService.getTranscription(tenantId, entity.getId()))).isEmpty();
    }

    @Test
    @DisplayName("Should load current source without persisting protected transcript")
    void shouldLoadCurrentSourceWithoutRedisEntry() {
        String tenantId = "tenant-load";
        UUID transcriptionId = UUID.randomUUID();
        TranscriptionEntity expected = buildEntityWithIdAndText(
                tenantId, transcriptionId, "Current authorized source result");
        expected.setVersion(4L);
        await(cachePort.put(cacheKey(tenantId, transcriptionId),
                "stale-source-version-3", Duration.ofMinutes(5)));
        AtomicInteger currentSourceLoads = new AtomicInteger();

        TranscriptionEntity result = await(cacheService.getOrLoadTranscription(
                tenantId, transcriptionId,
                id -> {
                    currentSourceLoads.incrementAndGet();
                    return AsyncOperation.success(Optional.of(expected));
                }
        ));

        assertThat(result.getText()).isEqualTo("Current authorized source result");
        assertThat(result.getVersion()).isEqualTo(4L);
        assertThat(await(cachePort.get(cacheKey(tenantId, transcriptionId)))).isEmpty();

        TranscriptionEntity readback = await(cacheService.getOrLoadTranscription(
                tenantId, transcriptionId,
                id -> {
                    currentSourceLoads.incrementAndGet();
                    return AsyncOperation.success(Optional.of(expected));
                }));
        assertThat(readback.getId()).isEqualTo(transcriptionId);
        assertThat(readback.getText()).isEqualTo("Current authorized source result");
        assertThat(currentSourceLoads).hasValue(2);
        assertThat(await(cachePort.get(cacheKey(tenantId, transcriptionId)))).isEmpty();
    }

    @Test
    @DisplayName("Should not return a Redis transcript after the current source reports revocation")
    void shouldTreatCachedTranscriptAsMissAfterCurrentSourceRevocation() {
        String tenantId = "tenant-revoked";
        UUID transcriptionId = UUID.randomUUID();
        TranscriptionEntity previouslyAuthorized = buildEntityWithIdAndText(
                tenantId, transcriptionId, "Previously authorized transcript");
        await(cacheService.cacheTranscription(tenantId, previouslyAuthorized));

        TranscriptionEntity current = await(cacheService.getOrLoadTranscription(
                tenantId, transcriptionId,
                ignored -> AsyncOperation.success(Optional.empty())));

        assertThat(current).isNull();
        assertThat(await(cachePort.get(cacheKey(tenantId, transcriptionId)))).isEmpty();
    }

    @Test
    @DisplayName("Should return the same current source result without Redis transcript writes")
    @SuppressWarnings("unchecked")
    void shouldHaveCacheOnCacheOffSourceEquivalence() {
        String tenantId = "tenant-cache-equivalence";
        UUID transcriptionId = UUID.randomUUID();
        TranscriptionEntity authoritative = buildEntityWithIdAndText(
                tenantId, transcriptionId, "Same current source result");
        DistributedCachePort<String, String> cacheOffPort = mock(DistributedCachePort.class);
        TranscriptionCacheService cacheOffService = new TranscriptionCacheService(cacheOffPort, objectMapper);

        TranscriptionEntity cacheOn = await(cacheService.getOrLoadTranscription(tenantId, transcriptionId,
                id -> AsyncOperation.success(Optional.of(authoritative))));
        TranscriptionEntity cacheOff = await(cacheOffService.getOrLoadTranscription(tenantId, transcriptionId,
                id -> AsyncOperation.success(Optional.of(authoritative))));

        assertThat(cacheOn.getId()).isEqualTo(cacheOff.getId());
        assertThat(cacheOn.getTenantId()).isEqualTo(cacheOff.getTenantId());
        assertThat(cacheOn.getText()).isEqualTo(cacheOff.getText());
        assertThat(await(cachePort.get(cacheKey(tenantId, transcriptionId)))).isEmpty();
        verify(cacheOffPort, never()).get(any());
        verify(cacheOffPort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    @DisplayName("Generic authorized fixture survives Redis client restart and matches uncached source")
    void shouldReadGenericFixtureAfterRedisClientRestart() {
        String tenantId = "tenant-restart-fixture";
        String sourceValue = "non-sensitive versioned fixture v1";
        AudioVideoCache<String, String> cacheOn = new AudioVideoCache<>(cachePort, "restart-fixture");
        String key = cacheOn.buildKey(tenantId, "fixture-v1");

        assertThat(await(cacheOn.getOrLoad(key, ignored -> AsyncOperation.success(sourceValue))))
                .isEqualTo(sourceValue);

        // Recreate the Media-side Redis client/adapter while leaving the isolated Redis
        // container alive. This exercises process-local state loss without involving
        // protected transcript persistence or changing its fail-closed policy.
        redisBackend.close();
        redisBackend = new AsyncRedisCacheBackend(REDIS.getHost(), REDIS.getFirstMappedPort(), null, 0, 2_000);
        cachePort = new DistributedCacheService(redisBackend, "transcription-cache-it");
        cacheOn = new AudioVideoCache<>(cachePort, "restart-fixture");

        String afterRestart = await(cacheOn.get(key)).orElseThrow();
        String uncachedSourceResult = sourceValue;

        assertThat(afterRestart).isEqualTo(sourceValue);
        assertThat(afterRestart).isEqualTo(uncachedSourceResult);
    }

    @Test
    @DisplayName("Current source version and erasure denial survive Redis client restart")
    void shouldUseCurrentSourceAndDenyErasedTranscriptAfterRedisClientRestart() {
        String tenantId = "tenant-transcript-restart";
        UUID currentId = UUID.randomUUID();
        UUID erasedId = UUID.randomUUID();
        String currentKey = cacheKey(tenantId, currentId);
        String erasedKey = cacheKey(tenantId, erasedId);

        // Leave legacy tenant/entity-keyed protected snapshots in Redis. The
        // recreated Media client must consult the caller's current source for
        // both a newer revision and a source-side erasure/deletion decision.
        await(cachePort.put(currentKey, "stale protected transcript version 3", Duration.ofMinutes(5)));
        await(cachePort.put(erasedKey, "erased protected transcript", Duration.ofMinutes(5)));
        assertThat(await(cachePort.get(currentKey))).contains("stale protected transcript version 3");
        assertThat(await(cachePort.get(erasedKey))).contains("erased protected transcript");

        // Recreate only Media's cache client/service; Redis itself remains up
        // with the seeded entries, modeling process-local state loss.
        redisBackend.close();
        redisBackend = new AsyncRedisCacheBackend(REDIS.getHost(), REDIS.getFirstMappedPort(), null, 0, 2_000);
        cachePort = new DistributedCacheService(redisBackend, "transcription-cache-it");
        cacheService = new TranscriptionCacheService(cachePort, objectMapper);

        TranscriptionEntity currentSource = buildEntityWithIdAndText(
                tenantId, currentId, "Current source transcript version 4");
        currentSource.setVersion(4L);
        TranscriptionEntity erasedSource = buildEntityWithIdAndText(
                tenantId, erasedId, "Source marks transcript deleted");
        erasedSource.setVersion(5L);
        erasedSource.setDeleted(true);
        AtomicInteger currentSourceLoads = new AtomicInteger();
        AtomicInteger erasedSourceLoads = new AtomicInteger();

        TranscriptionEntity current = await(cacheService.getOrLoadTranscription(
                tenantId, currentId,
                id -> {
                    currentSourceLoads.incrementAndGet();
                    return AsyncOperation.success(Optional.of(currentSource));
                }));
        TranscriptionEntity erased = await(cacheService.getOrLoadTranscription(
                tenantId, erasedId,
                id -> {
                    erasedSourceLoads.incrementAndGet();
                    return AsyncOperation.success(Optional.of(erasedSource));
                }));

        assertThat(current.getVersion()).isEqualTo(4L);
        assertThat(current.getText()).isEqualTo("Current source transcript version 4");
        assertThat(currentSourceLoads).hasValue(1);
        assertThat(erased).isNull();
        assertThat(erasedSourceLoads).hasValue(1);
        assertThat(await(cachePort.get(currentKey))).isEmpty();
        assertThat(await(cachePort.get(erasedKey))).isEmpty();
    }

    private String cacheKey(String tenantId, UUID transcriptionId) {
        return new AudioVideoCache<String, String>(cachePort, "transcription")
                .buildKey(tenantId, transcriptionId.toString());
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private TranscriptionEntity buildEntity(String tenantId) {
        return buildEntityWithIdAndText(tenantId, UUID.randomUUID(), "Test transcription text");
    }

    private TranscriptionEntity buildEntityWithIdAndText(String tenantId, UUID id, String text) {
        TranscriptionEntity entity = new TranscriptionEntity(
                id, tenantId, UUID.randomUUID(), UUID.randomUUID(), text, "en");
        entity.setConfidence(0.95f);
        return entity;
    }
}
