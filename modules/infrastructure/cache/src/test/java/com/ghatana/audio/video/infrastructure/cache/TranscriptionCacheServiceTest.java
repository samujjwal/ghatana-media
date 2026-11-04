package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.cache.DistributedCachePort;
import com.ghatana.cache.DistributedCacheService;
import com.ghatana.core.async.AsyncOperation;
import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Property;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

import static com.ghatana.audio.video.infrastructure.cache.AsyncOperationTestSupport.await;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class TranscriptionCacheServiceTest {

    @SuppressWarnings("unchecked")
    private final DistributedCachePort<String, String> cachePort = mock(DistributedCachePort.class);
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final TranscriptionCacheService cacheService = new TranscriptionCacheService(cachePort, objectMapper);

    @Test
    void treatsMatchingCacheEntryAsMissWhenCurrentAuthorizationCannotBeRevalidated() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        TranscriptionEntity entry = entity("tenant-a", transcriptionId, false);
        when(cachePort.get(key("tenant-a", transcriptionId.toString())))
                .thenReturn(AsyncOperation.success(Optional.of(objectMapper.writeValueAsString(entry))));

        Optional<TranscriptionEntity> result = await(cacheService.getTranscription("tenant-a", transcriptionId));

        assertThat(result).isEmpty();
        verify(cachePort, never()).get(any());
    }

    @Test
    void directMissInvalidatesLegacySerializedValueWithoutParsingIt() {
        UUID transcriptionId = UUID.randomUUID();
        String scopedKey = key("tenant-a", transcriptionId.toString());
        DistributedCacheService servicePort = mock(DistributedCacheService.class);
        when(servicePort.get(scopedKey))
                .thenReturn(AsyncOperation.success(Optional.of("{invalid-json")));
        when(servicePort.invalidateAsync(scopedKey)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService service = new TranscriptionCacheService(servicePort, objectMapper);

        Optional<TranscriptionEntity> result = await(service.getTranscription("tenant-a", transcriptionId));

        assertThat(result).isEmpty();
        verify(servicePort).invalidateAsync(scopedKey);
        verify(servicePort, never()).get(any());
        verify(servicePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void explicitInvalidationJoinsInFlightBestEffortCleanup() {
        UUID transcriptionId = UUID.randomUUID();
        String scopedKey = key("tenant-a", transcriptionId.toString());
        DistributedCacheService servicePort = mock(DistributedCacheService.class);
        CompletableFuture<Void> invalidation = new CompletableFuture<>();
        when(servicePort.invalidateAsync(scopedKey)).thenReturn(AsyncOperation.from(invalidation));
        TranscriptionCacheService service = new TranscriptionCacheService(servicePort, objectMapper);

        assertThat(await(service.getTranscription("tenant-a", transcriptionId))).isEmpty();
        AsyncOperation<Void> explicitInvalidation = service.invalidateTranscription("tenant-a", transcriptionId);

        verify(servicePort).invalidateAsync(scopedKey);
        assertThat(invalidation).isNotCompleted();
        invalidation.complete(null);
        await(explicitInvalidation);
        verify(servicePort).invalidateAsync(scopedKey);
    }

    @Test
    void directMissRemainsEmptyWhenLegacySnapshotInvalidationFails() {
        UUID asynchronousFailureId = UUID.randomUUID();
        UUID synchronousFailureId = UUID.randomUUID();
        String asynchronousKey = key("tenant-a", asynchronousFailureId.toString());
        String synchronousKey = key("tenant-a", synchronousFailureId.toString());
        DistributedCacheService servicePort = mock(DistributedCacheService.class);
        when(servicePort.invalidateAsync(asynchronousKey))
                .thenReturn(AsyncOperation.failure(new IllegalStateException("redis unavailable")));
        when(servicePort.invalidateAsync(synchronousKey))
                .thenThrow(new IllegalStateException("redis dispatch failed"));
        TranscriptionCacheService service = new TranscriptionCacheService(servicePort, objectMapper);

        assertThat(await(service.getTranscription("tenant-a", asynchronousFailureId))).isEmpty();
        assertThat(await(service.getTranscription("tenant-a", synchronousFailureId))).isEmpty();

        verify(servicePort).invalidateAsync(asynchronousKey);
        verify(servicePort).invalidateAsync(synchronousKey);
        verify(servicePort, never()).get(any());
        verify(servicePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void v2KeyTreatsLegacyEntryAsMiss() throws Exception {
        UUID id = UUID.randomUUID();
        String legacyKey = "transcription:tenant-a:" + id;
        String currentKey = key("tenant-a", id.toString());
        when(cachePort.get(currentKey)).thenReturn(AsyncOperation.success(Optional.empty()));

        Optional<TranscriptionEntity> result = await(cacheService.getTranscription("tenant-a", id));

        assertThat(result).isEmpty();
        verify(cachePort, never()).get(any());
        verify(cachePort, never()).get(legacyKey);
    }

    @Test
    void tenantScopeKeysRemainIsolatedAndInvalidateUsesTheSameV2Key() {
        UUID id = UUID.randomUUID();
        String tenantAKey = key("tenant-a", id.toString());
        String tenantBKey = key("tenant-b", id.toString());
        assertThat(tenantAKey).isNotEqualTo(tenantBKey);
        DistributedCacheService servicePort = mock(DistributedCacheService.class);
        when(servicePort.invalidateAsync(tenantAKey)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService isolated = new TranscriptionCacheService(servicePort, objectMapper);

        await(isolated.invalidateTranscription("tenant-a", id));

        verify(servicePort).invalidateAsync(tenantAKey);
        verify(servicePort, never()).invalidateAsync(tenantBKey);
    }

    @Test
    void equalAudioIdentityAcrossTenantsIsNotPersistedWithoutProtectedScope() {
        UUID sharedAudioId = UUID.randomUUID();
        UUID transcriptAId = UUID.randomUUID();
        UUID transcriptBId = UUID.randomUUID();
        TranscriptionEntity tenantA = entity("tenant-private-a", transcriptAId, false);
        tenantA.setAudioFileId(sharedAudioId);
        TranscriptionEntity tenantB = entity("tenant-private-b", transcriptBId, false);
        tenantB.setAudioFileId(sharedAudioId);
        await(cacheService.cacheTranscriptionByAudioFileId("tenant-private-a", sharedAudioId, tenantA));
        await(cacheService.cacheTranscriptionByAudioFileId("tenant-private-b", sharedAudioId, tenantB));
        assertThat(await(cacheService.getTranscriptionByAudioFileId("tenant-private-a", sharedAudioId))).isEmpty();
        assertThat(await(cacheService.getTranscriptionByAudioFileId("tenant-private-b", sharedAudioId))).isEmpty();

        verifyNoInteractions(cachePort);
    }

    @Test
    void tenantWideInvalidationFailsClosedInsteadOfClearingEveryTenant() {
        assertThatThrownBy(() -> await(cacheService.invalidateAllForTenant("tenant-a")))
                .hasRootCauseInstanceOf(UnsupportedOperationException.class)
                .hasRootCauseMessage("Tenant-scoped transcription cache invalidation is not supported");

        verify(cachePort, never()).invalidateAll();
    }

    @Test
    void sameIdForTwoTenantsNeverExposesUnrevalidatedCacheEntries() throws Exception {
        UUID id = UUID.randomUUID();
        String tenantAKey = key("tenant-a", id.toString());
        String tenantBKey = key("tenant-b", id.toString());
        TranscriptionEntity tenantAValue = entity("tenant-a", id, false);
        TranscriptionEntity tenantBValue = entity("tenant-b", id, false);
        when(cachePort.get(tenantAKey)).thenReturn(AsyncOperation.success(
                Optional.of(objectMapper.writeValueAsString(tenantAValue))));
        when(cachePort.get(tenantBKey)).thenReturn(AsyncOperation.success(
                Optional.of(objectMapper.writeValueAsString(tenantBValue))));

        Optional<TranscriptionEntity> tenantAResult = await(cacheService.getTranscription("tenant-a", id));
        Optional<TranscriptionEntity> tenantBResult = await(cacheService.getTranscription("tenant-b", id));

        assertThat(tenantAResult).isEmpty();
        assertThat(tenantBResult).isEmpty();
        verify(cachePort, never()).get(any());
    }

    @Test
    void treatsCrossTenantWrongIdAndDeletedEntriesAsMisses() throws Exception {
        UUID requestedId = UUID.randomUUID();
        TranscriptionEntity[] poisoned = {
            entity("tenant-b", requestedId, false),
            entity("tenant-a", UUID.randomUUID(), false),
            entity("tenant-a", requestedId, true)
        };
        String key = key("tenant-a", requestedId.toString());
        AtomicInteger reads = new AtomicInteger();
        when(cachePort.get(key)).thenAnswer(invocation -> AsyncOperation.success(
                Optional.of(objectMapper.writeValueAsString(poisoned[reads.getAndIncrement()]))));

        for (TranscriptionEntity ignored : poisoned) {
            Optional<TranscriptionEntity> result = await(cacheService.getTranscription("tenant-a", requestedId));
            assertThat(result).isEmpty();
        }
    }

    @Test
    void getOrLoadReturnsCurrentSourceWithoutReadingOrWritingCache() {
        UUID transcriptionId = UUID.randomUUID();
        TranscriptionEntity source = entity("tenant-a", transcriptionId, false);
        AtomicInteger loads = new AtomicInteger();

        TranscriptionEntity result = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> {
                    loads.incrementAndGet();
                    return AsyncOperation.success(Optional.of(source));
                }));

        assertThat(result).isSameAs(source);
        assertThat(loads.get()).isEqualTo(1);
        verify(cachePort, never()).get(any());
        verify(cachePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void currentSourceResultDoesNotDependOnCacheAvailability() {
        UUID transcriptionId = UUID.randomUUID();
        TranscriptionEntity source = entity("tenant-a", transcriptionId, false);

        TranscriptionEntity result = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.of(source))));

        assertThat(result).isSameAs(source);
        verify(cachePort, never()).get(any());
        verify(cachePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void currentAuthorizationDenialPrecedesAnyCachedProtectedTranscript() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        DistributedCacheService scopedPort = mock(DistributedCacheService.class);
        TranscriptionCacheService scopedService = new TranscriptionCacheService(scopedPort, objectMapper);
        IllegalStateException authorizationDenied = new IllegalStateException("current consent denied");

        assertThatThrownBy(() -> await(scopedService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.failure(authorizationDenied))))
                .hasRootCauseInstanceOf(IllegalStateException.class)
                .hasRootCauseMessage("current consent denied");

        verifyNoInteractions(scopedPort);
    }

    @Test
    void synchronousSourceLoaderFailureIsReturnedAsFailedOperation() {
        UUID transcriptionId = UUID.randomUUID();
        IllegalStateException sourceFailure = new IllegalStateException("source lookup failed");

        AsyncOperation<TranscriptionEntity> operation = cacheService.getOrLoadTranscription(
                "tenant-a", transcriptionId, id -> { throw sourceFailure; });

        assertThatThrownBy(() -> await(operation))
                .hasRootCauseInstanceOf(IllegalStateException.class)
                .hasRootCauseMessage("source lookup failed");
        verifyNoInteractions(cachePort);
    }

    @Test
    void nullSourceLoaderOperationIsReturnedAsFailedOperation() {
        UUID transcriptionId = UUID.randomUUID();

        AsyncOperation<TranscriptionEntity> operation = cacheService.getOrLoadTranscription(
                "tenant-a", transcriptionId, id -> null);

        assertThatThrownBy(() -> await(operation))
                .hasRootCauseInstanceOf(NullPointerException.class)
                .hasRootCauseMessage("loader returned null operation");
        verifyNoInteractions(cachePort);
    }

    @Test
    void wrongIdentitySourceResultFailsWithSanitizedError() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        DistributedCacheService scopedPort = mock(DistributedCacheService.class);
        TranscriptionCacheService scopedService = new TranscriptionCacheService(scopedPort, objectMapper);

        for (TranscriptionEntity mismatched : new TranscriptionEntity[] {
                entity("tenant-b", transcriptionId, false),
                entity("tenant-a", UUID.randomUUID(), false) }) {
            assertThatThrownBy(() -> await(scopedService.getOrLoadTranscription("tenant-a", transcriptionId,
                    id -> AsyncOperation.success(Optional.of(mismatched)))))
                    .hasRootCauseInstanceOf(IllegalStateException.class)
                    .hasRootCauseMessage("Transcription identity does not match requested scope");
        }
        verifyNoInteractions(scopedPort);
    }

    @Test
    void absentOrDeletedCurrentSourceInvalidatesOnlyItsExactScopedKey() {
        UUID transcriptionId = UUID.randomUUID();
        String tenantAKey = key("tenant-a", transcriptionId.toString());
        DistributedCacheService scopedPort = mock(DistributedCacheService.class);
        when(scopedPort.invalidateAsync(tenantAKey)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService scopedService = new TranscriptionCacheService(scopedPort, objectMapper);

        TranscriptionEntity absent = await(scopedService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.empty())));
        TranscriptionEntity deleted = await(scopedService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.of(entity("tenant-a", id, true)))));

        assertThat(absent).isNull();
        assertThat(deleted).isNull();
        verify(scopedPort, org.mockito.Mockito.times(2)).invalidateAsync(tenantAKey);
        verify(scopedPort, never()).invalidateAsync(key("tenant-b", transcriptionId.toString()));
        verify(scopedPort, never()).get(any());
        verify(scopedPort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void sourceDenialReturnsWithoutWaitingForScopedInvalidation() {
        UUID transcriptionId = UUID.randomUUID();
        String tenantAKey = key("tenant-a", transcriptionId.toString());
        DistributedCacheService scopedPort = mock(DistributedCacheService.class);
        when(scopedPort.invalidateAsync(tenantAKey))
                .thenReturn(AsyncOperation.from(new java.util.concurrent.CompletableFuture<>()));
        TranscriptionCacheService scopedService = new TranscriptionCacheService(scopedPort, objectMapper);

        TranscriptionEntity result = await(scopedService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.empty())));

        assertThat(result).isNull();
        verify(scopedPort).invalidateAsync(tenantAKey);
        verify(scopedPort, never()).get(any());
        verify(scopedPort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void revokedOrExpiredCurrentSourceWinsOverPreviouslyCachedProtectedTranscript() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        String key = key("tenant-a", transcriptionId.toString());
        DistributedCacheService scopedPort = mock(DistributedCacheService.class);
        when(scopedPort.invalidateAsync(key)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService scopedService = new TranscriptionCacheService(scopedPort, objectMapper);

        for (int currentSourceState = 0; currentSourceState < 2; currentSourceState++) {
            int state = currentSourceState;
            TranscriptionEntity result = await(scopedService.getOrLoadTranscription("tenant-a", transcriptionId,
                    id -> state == 0
                            ? AsyncOperation.success(Optional.empty())
                            : AsyncOperation.success(Optional.of(entity("tenant-a", id, true)))));
            assertThat(result).isNull();
        }

        verify(scopedPort, org.mockito.Mockito.times(2)).invalidateAsync(key);
        verify(scopedPort, never()).get(any());
        verify(scopedPort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void changedCurrentTranscriptRevisionIsReturnedInsteadOfCachedRevision() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        TranscriptionEntity cached = entity("tenant-a", transcriptionId, false);
        cached.setText("stale protected revision");
        TranscriptionEntity current = entity("tenant-a", transcriptionId, false);
        current.setText("current authorized revision");

        TranscriptionEntity result = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.of(current))));

        assertThat(result.getText()).isEqualTo("current authorized revision");
        verify(cachePort, never()).get(any());
        verify(cachePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void rechecksCurrentSourceAcrossRevisionConsentAndRetentionChanges() {
        UUID transcriptionId = UUID.randomUUID();
        String currentKey = key("tenant-a", transcriptionId.toString());
        DistributedCacheService scopedPort = mock(DistributedCacheService.class);
        when(scopedPort.invalidateAsync(currentKey)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService scopedService = new TranscriptionCacheService(scopedPort, objectMapper);
        AtomicInteger sourceLoads = new AtomicInteger();
        java.util.concurrent.atomic.AtomicReference<Optional<TranscriptionEntity>> currentSource =
                new java.util.concurrent.atomic.AtomicReference<>(
                        Optional.of(versionedEntity("tenant-a", transcriptionId, 1L, "revision 1")));

        TranscriptionEntity first = await(scopedService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> {
                    sourceLoads.incrementAndGet();
                    return AsyncOperation.success(currentSource.get());
                }));
        assertThat(first.getVersion()).isEqualTo(1L);

        // The authoritative source advances the immutable transcript revision.
        currentSource.set(Optional.of(versionedEntity("tenant-a", transcriptionId, 2L, "revision 2")));
        TranscriptionEntity revised = await(scopedService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> {
                    sourceLoads.incrementAndGet();
                    return AsyncOperation.success(currentSource.get());
                }));
        assertThat(revised.getVersion()).isEqualTo(2L);
        assertThat(revised.getText()).isEqualTo("revision 2");

        // The loader represents the current rights/consent check. Revocation
        // denies the same request even though an earlier call returned content.
        currentSource.set(Optional.empty());
        assertThat(await(scopedService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> {
                    sourceLoads.incrementAndGet();
                    return AsyncOperation.success(currentSource.get());
                }))).isNull();

        // A current source marked deleted represents retention/erasure expiry;
        // it also wins over the previously authorized revision.
        currentSource.set(Optional.of(entity("tenant-a", transcriptionId, true)));
        assertThat(await(scopedService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> {
                    sourceLoads.incrementAndGet();
                    return AsyncOperation.success(currentSource.get());
                }))).isNull();

        assertThat(sourceLoads).hasValue(4);
        verify(scopedPort, org.mockito.Mockito.times(4)).invalidateAsync(currentKey);
        verify(scopedPort, never()).get(any());
        verify(scopedPort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void currentVersionedSourceEvictsLegacySnapshotForExactTenantAndTranscript() {
        UUID transcriptionId = UUID.randomUUID();
        String currentKey = key("tenant-a", transcriptionId.toString());
        DistributedCacheService scopedPort = mock(DistributedCacheService.class);
        when(scopedPort.invalidateAsync(currentKey)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService scopedService = new TranscriptionCacheService(scopedPort, objectMapper);
        TranscriptionEntity current = entity("tenant-a", transcriptionId, false);
        current.setVersion(8L);
        current.setText("source version 8");

        TranscriptionEntity result = await(scopedService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.of(current))));

        assertThat(result.getVersion()).isEqualTo(8L);
        assertThat(result.getText()).isEqualTo("source version 8");
        verify(scopedPort).invalidateAsync(currentKey);
        verify(scopedPort, never()).get(any());
        verify(scopedPort, never()).put(any(), any(), any(Duration.class));
        verify(scopedPort, never()).invalidateAsync(key("tenant-b", transcriptionId.toString()));
    }

    @Test
    void currentSourceDoesNotWaitForBestEffortLegacySnapshotInvalidation() {
        UUID transcriptionId = UUID.randomUUID();
        String currentKey = key("tenant-a", transcriptionId.toString());
        DistributedCacheService scopedPort = mock(DistributedCacheService.class);
        java.util.concurrent.CompletableFuture<Void> pendingInvalidation = new java.util.concurrent.CompletableFuture<>();
        when(scopedPort.invalidateAsync(currentKey)).thenReturn(AsyncOperation.from(pendingInvalidation));
        TranscriptionCacheService scopedService = new TranscriptionCacheService(scopedPort, objectMapper);
        TranscriptionEntity current = entity("tenant-a", transcriptionId, false);

        TranscriptionEntity result = await(scopedService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.of(current))));

        assertThat(result).isSameAs(current);
        assertThat(pendingInvalidation).isNotDone();
        verify(scopedPort).invalidateAsync(currentKey);
        verify(scopedPort, never()).get(any());
        verify(scopedPort, never()).put(any(), any(), any(Duration.class));
        pendingInvalidation.complete(null);
    }

    @Test
    void staleSnapshotInvalidationFailureDoesNotReplaceCurrentSource() {
        UUID transcriptionId = UUID.randomUUID();
        String currentKey = key("tenant-a", transcriptionId.toString());
        DistributedCacheService scopedPort = mock(DistributedCacheService.class);
        when(scopedPort.invalidateAsync(currentKey))
                .thenReturn(AsyncOperation.failure(new IllegalStateException("cache unavailable")));
        TranscriptionCacheService scopedService = new TranscriptionCacheService(scopedPort, objectMapper);
        TranscriptionEntity current = entity("tenant-a", transcriptionId, false);
        current.setVersion(9L);

        TranscriptionEntity result = await(scopedService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.of(current))));

        assertThat(result).isSameAs(current);
        verify(scopedPort).invalidateAsync(currentKey);
        verify(scopedPort, never()).get(any());
        verify(scopedPort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void cachedCompletedJobSnapshotCannotOverrideCurrentProcessingState() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        TranscriptionEntity cachedCompleted = entity("tenant-a", transcriptionId, false);
        cachedCompleted.setStatus(TranscriptionEntity.TranscriptionStatus.COMPLETED);
        TranscriptionEntity currentProcessing = entity("tenant-a", transcriptionId, false);
        currentProcessing.setStatus(TranscriptionEntity.TranscriptionStatus.PROCESSING);

        TranscriptionEntity result = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.of(currentProcessing))));

        assertThat(result.getStatus()).isEqualTo(TranscriptionEntity.TranscriptionStatus.PROCESSING);
        verify(cachePort, never()).get(any());
        verify(cachePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void rejectsCrossTenantWritesBeforeSerializationOrCacheCall() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        TranscriptionEntity otherTenant = entity("tenant-b", transcriptionId, false);
        ObjectMapper mapper = mock(ObjectMapper.class);
        TranscriptionCacheService isolatedService = new TranscriptionCacheService(cachePort, mapper);

        assertThatThrownBy(() -> await(isolatedService.cacheTranscription("tenant-a", otherTenant)))
                .hasRootCauseInstanceOf(IllegalStateException.class)
                .hasRootCauseMessage("Transcription identity does not match requested scope");
        assertThatThrownBy(() -> await(isolatedService.cacheTranscription("tenant-a", otherTenant,
                Duration.ofMinutes(5))))
                .hasRootCauseInstanceOf(IllegalStateException.class)
                .hasRootCauseMessage("Transcription identity does not match requested scope");
        verifyNoInteractions(cachePort, mapper);
    }

    @Test
    void audioFileIdentityWriteIsSkippedAfterIdentityValidation() throws Exception {
        UUID audioId = UUID.randomUUID();
        TranscriptionEntity wrongAudio = entity("tenant-a", UUID.randomUUID(), false);

        assertThatThrownBy(() -> await(cacheService.cacheTranscriptionByAudioFileId(
                "tenant-a", audioId, wrongAudio)))
                .hasRootCauseInstanceOf(IllegalStateException.class)
                .hasRootCauseMessage("Transcription identity does not match requested scope");
        verify(cachePort, never()).put(any(), any(), any(Duration.class));

        TranscriptionEntity matching = entity("tenant-a", UUID.randomUUID(), false);
        matching.setAudioFileId(audioId);
        await(cacheService.cacheTranscriptionByAudioFileId("tenant-a", audioId, matching));

        verify(cachePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void rejectsNullOrBlankTenantAndNullIdentifiersBeforeCacheAccess() {
        UUID id = UUID.randomUUID();
        TranscriptionEntity entity = entity("tenant-a", id, false);
        List<Supplier<AsyncOperation<?>>> invalidCalls = List.of(
                () -> cacheService.getTranscription(null, id),
                () -> cacheService.getTranscription("  \t", id),
                () -> cacheService.getTranscription(" tenant-a", id),
                () -> cacheService.getTranscription("tenant-a ", id),
                () -> cacheService.getTranscription("tenant-a", null),
                () -> cacheService.getOrLoadTranscription("", id,
                        ignored -> AsyncOperation.success(Optional.of(entity))),
                () -> cacheService.getOrLoadTranscription("tenant-a", null,
                        ignored -> AsyncOperation.success(Optional.of(entity))),
                () -> cacheService.invalidateTranscription(null, id),
                () -> cacheService.invalidateTranscription("tenant-a", null),
                () -> cacheService.invalidateAllForTenant("\n"),
                () -> cacheService.cacheTranscription(null, entity),
                () -> cacheService.cacheTranscription("  ", entity, Duration.ofMinutes(1)),
                () -> cacheService.cacheTranscriptionByAudioFileId("tenant-a", null, entity),
                () -> cacheService.getTranscriptionByAudioFileId(null, id),
                () -> cacheService.getTranscriptionByAudioFileId("tenant-a", null));

        for (Supplier<AsyncOperation<?>> invalidCall : invalidCalls) {
            assertThatThrownBy(() -> await(invalidCall.get()))
                    .hasRootCauseInstanceOf(IllegalArgumentException.class);
        }
        verify(cachePort, never()).get(any());
        verify(cachePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void unscopedCacheWriteDoesNotPersistTranscript() {
        String tenantId = "legacy:tenant/v1";
        TranscriptionEntity entity = entity(tenantId, UUID.randomUUID(), false);

        await(cacheService.cacheTranscription(tenantId, entity));

        verifyNoInteractions(cachePort);
    }

    @Test
    void oversizedWritesAreSkippedWithoutLoggingTranscriptionContent() {
        String marker = "oversized-private-transcript-marker";
        TranscriptionEntity oversized = entity("tenant-a", UUID.randomUUID(), false);
        oversized.setText(marker + "x".repeat(8_192));

        try (LogCapture logs = capture(TranscriptionCacheService.class)) {
            await(cacheService.cacheTranscription("tenant-a", oversized));
            await(cacheService.cacheTranscription("tenant-a", oversized, Duration.ofMinutes(5)));
            oversized.setAudioFileId(UUID.randomUUID());
            await(cacheService.cacheTranscriptionByAudioFileId(
                    "tenant-a", oversized.getAudioFileId(), oversized));
            assertThat(logs.output()).doesNotContain(marker);
        }

        verify(cachePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void cachedJsonIsNeverDeserializedWithoutCurrentRevalidationOnEitherReadPath() {
        @SuppressWarnings("unchecked")
        DistributedCachePort<String, String> isolatedPort = mock(DistributedCachePort.class);
        ObjectMapper isolatedMapper = mock(ObjectMapper.class);
        TranscriptionCacheService isolatedService = new TranscriptionCacheService(isolatedPort, isolatedMapper);
        UUID transcriptionId = UUID.randomUUID();
        UUID audioFileId = UUID.randomUUID();
        String transcriptionKey = key("tenant-a", transcriptionId.toString());
        String audioKey = key("tenant-a", "audio:" + audioFileId);
        String cachedJson = "{ protected transcript }";
        when(isolatedPort.get(transcriptionKey)).thenReturn(
                AsyncOperation.success(Optional.of(cachedJson)));
        when(isolatedPort.get(audioKey)).thenReturn(AsyncOperation.success(Optional.of(cachedJson)));

        assertThat(await(isolatedService.getTranscription("tenant-a", transcriptionId))).isEmpty();
        assertThat(await(isolatedService.getTranscriptionByAudioFileId("tenant-a", audioFileId))).isEmpty();

        verify(isolatedPort, never()).get(any());
        verifyNoInteractions(isolatedMapper);
    }

    @Test
    void legacyCachedJsonIsNotConsultedByCurrentSourceLoad() {
        UUID transcriptionId = UUID.randomUUID();
        TranscriptionEntity source = entity("tenant-a", transcriptionId, false);
        AtomicInteger loads = new AtomicInteger();

        TranscriptionEntity result = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> {
                    loads.incrementAndGet();
                    return AsyncOperation.success(Optional.of(source));
                }));

        assertThat(result).isSameAs(source);
        assertThat(loads.get()).isEqualTo(1);
        verify(cachePort, never()).get(any());
        verify(cachePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void invalidCustomTtlFailsExplicitlyAndDoesNotWrite() {
        UUID transcriptionId = UUID.randomUUID();
        TranscriptionEntity entry = entity("tenant-a", transcriptionId, false);

        for (Duration invalidTtl : new Duration[] {Duration.ZERO, Duration.ofNanos(-1)}) {
            assertThatThrownBy(() -> await(cacheService.cacheTranscription(
                    "tenant-a", entry, invalidTtl)))
                    .hasRootCauseInstanceOf(IllegalArgumentException.class)
                    .hasRootCauseMessage("ttl must be positive");
        }
        assertThatThrownBy(() -> await(cacheService.cacheTranscription("tenant-a", entry, null)))
                .hasRootCauseInstanceOf(IllegalArgumentException.class)
                .hasRootCauseMessage("ttl must be positive");

        verify(cachePort, never()).get(any());
        verify(cachePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void validCustomTtlIsAcceptedWithoutUnscopedCacheIo() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        TranscriptionEntity entry = entity("tenant-a", transcriptionId, false);

        await(cacheService.cacheTranscription("tenant-a", entry, Duration.ofDays(2)));

        verifyNoInteractions(cachePort);
    }

    @Test
    void oversizedSourceValueIsReturnedWithoutSerializationOrCacheReadWrite() {
        UUID transcriptionId = UUID.randomUUID();
        String marker = "oversized-source-private-marker";
        TranscriptionEntity source = entity("tenant-a", transcriptionId, false);
        source.setText(marker + "x".repeat(24_576));
        try (LogCapture logs = capture(TranscriptionCacheService.class)) {
            TranscriptionEntity result = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                    id -> AsyncOperation.success(Optional.of(source))));

            assertThat(result).isSameAs(source);
            assertThat(logs.output()).doesNotContain(marker);
        }

        verify(cachePort, never()).get(any());
        verify(cachePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void diagnosticLogsRedactTenantTranscriptAndAudioIdentifiers() {
        String tenant = "tenant-private-marker";
        UUID transcriptId = UUID.randomUUID();
        UUID audioId = UUID.randomUUID();
        TranscriptionEntity entity = entity(tenant, transcriptId, false);
        entity.setAudioFileId(audioId);
        String transcriptKey = key(tenant, transcriptId.toString());
        String audioKey = key(tenant, "audio:" + audioId);
        DistributedCacheService servicePort = mock(DistributedCacheService.class);
        TranscriptionCacheService isolatedService = new TranscriptionCacheService(servicePort, objectMapper);
        when(servicePort.invalidateAsync(transcriptKey)).thenReturn(AsyncOperation.success(null));

        try (LogCapture logs = capture(TranscriptionCacheService.class)) {
            await(isolatedService.cacheTranscription(tenant, entity));
            await(isolatedService.cacheTranscription(tenant, entity, Duration.ofMinutes(5)));
            await(isolatedService.cacheTranscriptionByAudioFileId(tenant, audioId, entity));
            await(isolatedService.invalidateTranscription(tenant, transcriptId));

            assertThat(logs.output()).contains("scopeRef=hmac256:")
                    .doesNotContain(tenant, transcriptId.toString(), audioId.toString());
        }
    }

    private String key(String tenant, String id) {
        return new AudioVideoCache<String, String>(cachePort, "transcription").buildKey(tenant, id);
    }

    private static TranscriptionEntity entity(String tenant, UUID id, boolean deleted) {
        TranscriptionEntity entity = new TranscriptionEntity(id, tenant, UUID.randomUUID(), UUID.randomUUID(),
                "private transcript", "en");
        entity.setDeleted(deleted);
        return entity;
    }

    private static TranscriptionEntity versionedEntity(String tenant, UUID id, long version, String text) {
        TranscriptionEntity entity = entity(tenant, id, false);
        entity.setVersion(version);
        entity.setText(text);
        return entity;
    }

    private static LogCapture capture(Class<?> loggerClass) {
        LoggerContext context = (LoggerContext) org.apache.logging.log4j.LogManager.getContext(false);
        org.apache.logging.log4j.core.Logger logger = context.getLogger(loggerClass.getName());
        LogCapture appender = new LogCapture(logger, logger.getLevel());
        appender.start();
        logger.addAppender(appender);
        logger.setLevel(Level.DEBUG);
        return appender;
    }

    private static final class LogCapture extends AbstractAppender implements AutoCloseable {
        private final org.apache.logging.log4j.core.Logger logger;
        private final Level previousLevel;
        private final List<String> messages = new ArrayList<>();

        LogCapture(org.apache.logging.log4j.core.Logger logger, Level previousLevel) {
            super("transcription-cache-size", null, null, true, Property.EMPTY_ARRAY);
            this.logger = logger;
            this.previousLevel = previousLevel;
        }

        @Override
        public void append(LogEvent event) {
            messages.add(event.getMessage().getFormattedMessage());
        }

        String output() {
            return String.join("\n", messages);
        }

        @Override
        public void close() {
            logger.removeAppender(this);
            logger.setLevel(previousLevel);
            stop();
        }
    }
}
