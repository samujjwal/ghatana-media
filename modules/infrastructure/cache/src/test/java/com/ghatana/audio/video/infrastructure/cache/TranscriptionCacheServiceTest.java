package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.cache.DistributedCachePort;
import com.ghatana.core.async.AsyncOperation;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.util.Optional;
import java.util.UUID;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.List;
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
    void returnsCacheHitOnlyWhenTenantAndTranscriptionIdentityMatch() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        TranscriptionEntity entry = entity("tenant-a", transcriptionId, false);
        when(cachePort.get("transcription:tenant-a:" + transcriptionId))
                .thenReturn(AsyncOperation.success(Optional.of(objectMapper.writeValueAsString(entry))));

        Optional<TranscriptionEntity> result = await(cacheService.getTranscription("tenant-a", transcriptionId));

        assertThat(result).isPresent();
        assertThat(result.orElseThrow().getTenantId()).isEqualTo(entry.getTenantId());
        assertThat(result.orElseThrow().getId()).isEqualTo(entry.getId());
    }

    @Test
    void treatsCrossTenantWrongIdAndDeletedEntriesAsMisses() throws Exception {
        UUID requestedId = UUID.randomUUID();
        TranscriptionEntity[] poisoned = {
            entity("tenant-b", requestedId, false),
            entity("tenant-a", UUID.randomUUID(), false),
            entity("tenant-a", requestedId, true)
        };
        String key = "transcription:tenant-a:" + requestedId;
        AtomicInteger reads = new AtomicInteger();
        when(cachePort.get(key)).thenAnswer(invocation -> AsyncOperation.success(
                Optional.of(objectMapper.writeValueAsString(poisoned[reads.getAndIncrement()]))));

        for (TranscriptionEntity ignored : poisoned) {
            Optional<TranscriptionEntity> result = await(cacheService.getTranscription("tenant-a", requestedId));
            assertThat(result).isEmpty();
        }
    }

    @Test
    void getOrLoadFallsBackToSourceForMismatchedCacheAndWritesOnlyMatchingLiveResult() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        String key = "transcription:tenant-a:" + transcriptionId;
        TranscriptionEntity poisoned = entity("tenant-b", transcriptionId, false);
        TranscriptionEntity source = entity("tenant-a", transcriptionId, false);
        when(cachePort.get(key)).thenReturn(
                AsyncOperation.success(Optional.of(objectMapper.writeValueAsString(poisoned))));
        when(cachePort.put(eq(key), any(), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));
        AtomicInteger loads = new AtomicInteger();

        TranscriptionEntity result = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> {
                    loads.incrementAndGet();
                    return AsyncOperation.success(Optional.of(source));
                }));

        assertThat(result).isSameAs(source);
        assertThat(loads.get()).isEqualTo(1);
        verify(cachePort).put(eq(key), any(), any(Duration.class));
    }

    @Test
    void wrongIdentitySourceResultFailsWithSanitizedError() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        String key = "transcription:tenant-a:" + transcriptionId;
        when(cachePort.get(key)).thenAnswer(invocation -> AsyncOperation.success(Optional.empty()));

        for (TranscriptionEntity mismatched : new TranscriptionEntity[] {
                entity("tenant-b", transcriptionId, false),
                entity("tenant-a", UUID.randomUUID(), false) }) {
            assertThatThrownBy(() -> await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                    id -> AsyncOperation.success(Optional.of(mismatched)))))
                    .hasRootCauseInstanceOf(IllegalStateException.class)
                    .hasRootCauseMessage("Transcription identity does not match requested scope");
        }
    }

    @Test
    void absentAndDeletedSourceResultsRemainNull() {
        UUID transcriptionId = UUID.randomUUID();
        String key = "transcription:tenant-a:" + transcriptionId;
        when(cachePort.get(key)).thenAnswer(invocation -> AsyncOperation.success(Optional.empty()));

        TranscriptionEntity absent = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.empty())));
        TranscriptionEntity deleted = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.of(entity("tenant-a", id, true)))));

        assertThat(absent).isNull();
        assertThat(deleted).isNull();
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
    void rejectsAudioFileIdentityMismatchBeforeCacheCallAndWritesMatchingEntity() throws Exception {
        UUID audioId = UUID.randomUUID();
        TranscriptionEntity wrongAudio = entity("tenant-a", UUID.randomUUID(), false);

        assertThatThrownBy(() -> await(cacheService.cacheTranscriptionByAudioFileId(
                "tenant-a", audioId, wrongAudio)))
                .hasRootCauseInstanceOf(IllegalStateException.class)
                .hasRootCauseMessage("Transcription identity does not match requested scope");
        verify(cachePort, never()).put(any(), any(), any(Duration.class));

        TranscriptionEntity matching = entity("tenant-a", UUID.randomUUID(), false);
        matching.setAudioFileId(audioId);
        String key = "transcription:tenant-a:audio:" + audioId;
        when(cachePort.put(eq(key), any(), any(Duration.class))).thenReturn(AsyncOperation.success(null));

        await(cacheService.cacheTranscriptionByAudioFileId("tenant-a", audioId, matching));

        verify(cachePort).put(eq(key), any(), any(Duration.class));
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
        verifyNoInteractions(cachePort);
    }

    @Test
    void nonblankTenantVocabularyIsPreservedForCacheWrites() {
        String tenantId = "legacy:tenant/v1";
        TranscriptionEntity entity = entity(tenantId, UUID.randomUUID(), false);
        String key = "transcription:" + tenantId + ":" + entity.getId();
        when(cachePort.put(eq(key), any(), any(Duration.class))).thenReturn(AsyncOperation.success(null));

        await(cacheService.cacheTranscription(tenantId, entity));

        verify(cachePort).put(eq(key), any(), any(Duration.class));
    }

    private static TranscriptionEntity entity(String tenant, UUID id, boolean deleted) {
        TranscriptionEntity entity = new TranscriptionEntity(id, tenant, UUID.randomUUID(), UUID.randomUUID(),
                "private transcript", "en");
        entity.setDeleted(deleted);
        return entity;
    }
}
