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
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

import static com.ghatana.audio.video.infrastructure.cache.AsyncOperationTestSupport.await;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.doThrow;
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
    void equalAudioIdentityAcrossTenantsUsesSeparateKeysAndNeverReadsAcrossScope() {
        UUID sharedAudioId = UUID.randomUUID();
        UUID transcriptAId = UUID.randomUUID();
        UUID transcriptBId = UUID.randomUUID();
        TranscriptionEntity tenantA = entity("tenant-private-a", transcriptAId, false);
        tenantA.setAudioFileId(sharedAudioId);
        TranscriptionEntity tenantB = entity("tenant-private-b", transcriptBId, false);
        tenantB.setAudioFileId(sharedAudioId);
        String keyA = key("tenant-private-a", "audio:" + sharedAudioId);
        String keyB = key("tenant-private-b", "audio:" + sharedAudioId);
        when(cachePort.put(eq(keyA), any(), any(Duration.class))).thenReturn(AsyncOperation.success(null));
        when(cachePort.put(eq(keyB), any(), any(Duration.class))).thenReturn(AsyncOperation.success(null));

        await(cacheService.cacheTranscriptionByAudioFileId("tenant-private-a", sharedAudioId, tenantA));
        await(cacheService.cacheTranscriptionByAudioFileId("tenant-private-b", sharedAudioId, tenantB));
        assertThat(await(cacheService.getTranscriptionByAudioFileId("tenant-private-a", sharedAudioId))).isEmpty();
        assertThat(await(cacheService.getTranscriptionByAudioFileId("tenant-private-b", sharedAudioId))).isEmpty();

        assertThat(keyA).isNotEqualTo(keyB);
        verify(cachePort).put(eq(keyA), any(), any(Duration.class));
        verify(cachePort).put(eq(keyB), any(), any(Duration.class));
        verify(cachePort, never()).get(any());
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
    void getOrLoadUsesCurrentSourceEvenWhenCacheContainsValueAndWritesOnlyMatchingResult() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        String key = key("tenant-a", transcriptionId.toString());
        TranscriptionEntity poisoned = entity("tenant-b", transcriptionId, false);
        TranscriptionEntity source = entity("tenant-a", transcriptionId, false);
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
        verify(cachePort, never()).get(any());
        verify(cachePort).put(eq(key), any(), any(Duration.class));
    }

    @Test
    void cacheWriteFailureDoesNotHideCurrentSourceResult() {
        UUID transcriptionId = UUID.randomUUID();
        String key = key("tenant-a", transcriptionId.toString());
        TranscriptionEntity source = entity("tenant-a", transcriptionId, false);
        when(cachePort.put(eq(key), any(), any(Duration.class)))
                .thenReturn(AsyncOperation.failure(new IllegalStateException("cache unavailable")));

        TranscriptionEntity result = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.of(source))));

        assertThat(result).isSameAs(source);
        verify(cachePort).put(eq(key), any(), any(Duration.class));
        verify(cachePort, never()).get(any());
    }

    @Test
    void wrongIdentitySourceResultFailsWithSanitizedError() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        String key = key("tenant-a", transcriptionId.toString());
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
        String key = key("tenant-a", transcriptionId.toString());
        when(cachePort.get(key)).thenAnswer(invocation -> AsyncOperation.success(Optional.empty()));

        TranscriptionEntity absent = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.empty())));
        TranscriptionEntity deleted = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.of(entity("tenant-a", id, true)))));

        assertThat(absent).isNull();
        assertThat(deleted).isNull();
    }

    @Test
    void revokedOrExpiredCurrentSourceWinsOverPreviouslyCachedProtectedTranscript() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        String key = key("tenant-a", transcriptionId.toString());
        TranscriptionEntity cached = entity("tenant-a", transcriptionId, false);
        when(cachePort.get(key)).thenReturn(AsyncOperation.success(
                Optional.of(objectMapper.writeValueAsString(cached))));

        for (int currentSourceState = 0; currentSourceState < 2; currentSourceState++) {
            int state = currentSourceState;
            TranscriptionEntity result = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                    id -> state == 0
                            ? AsyncOperation.success(Optional.empty())
                            : AsyncOperation.success(Optional.of(entity("tenant-a", id, true)))));
            assertThat(result).isNull();
        }

        verify(cachePort, never()).get(any());
        verify(cachePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void changedCurrentTranscriptRevisionIsReturnedInsteadOfCachedRevision() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        String key = key("tenant-a", transcriptionId.toString());
        TranscriptionEntity cached = entity("tenant-a", transcriptionId, false);
        cached.setText("stale protected revision");
        TranscriptionEntity current = entity("tenant-a", transcriptionId, false);
        current.setText("current authorized revision");
        when(cachePort.get(key)).thenReturn(AsyncOperation.success(
                Optional.of(objectMapper.writeValueAsString(cached))));
        when(cachePort.put(eq(key), any(), any(Duration.class))).thenReturn(AsyncOperation.success(null));

        TranscriptionEntity result = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.of(current))));

        assertThat(result.getText()).isEqualTo("current authorized revision");
        verify(cachePort, never()).get(any());
        verify(cachePort).put(eq(key), any(), any(Duration.class));
    }

    @Test
    void cachedCompletedJobSnapshotCannotOverrideCurrentProcessingState() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        String key = key("tenant-a", transcriptionId.toString());
        TranscriptionEntity cachedCompleted = entity("tenant-a", transcriptionId, false);
        cachedCompleted.setStatus(TranscriptionEntity.TranscriptionStatus.COMPLETED);
        TranscriptionEntity currentProcessing = entity("tenant-a", transcriptionId, false);
        currentProcessing.setStatus(TranscriptionEntity.TranscriptionStatus.PROCESSING);
        when(cachePort.get(key)).thenReturn(AsyncOperation.success(
                Optional.of(objectMapper.writeValueAsString(cachedCompleted))));
        when(cachePort.put(eq(key), any(), any(Duration.class))).thenReturn(AsyncOperation.success(null));

        TranscriptionEntity result = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> AsyncOperation.success(Optional.of(currentProcessing))));

        assertThat(result.getStatus()).isEqualTo(TranscriptionEntity.TranscriptionStatus.PROCESSING);
        verify(cachePort, never()).get(any());
        verify(cachePort).put(eq(key), any(), any(Duration.class));
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
        String key = key("tenant-a", "audio:" + audioId);
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
        String key = key(tenantId, entity.getId().toString());
        when(cachePort.put(eq(key), any(), any(Duration.class))).thenReturn(AsyncOperation.success(null));

        await(cacheService.cacheTranscription(tenantId, entity));

        verify(cachePort).put(eq(key), any(), any(Duration.class));
    }

    @Test
    void serializedEntryLimitAcceptsAtLimitAndRejectsOneByteOver() {
        assertThat(TranscriptionCacheService.withinSerializedEntryLimit(
                "a".repeat(TranscriptionCacheService.MAX_SERIALIZED_ENTRY_BYTES))).isTrue();
        assertThat(TranscriptionCacheService.withinSerializedEntryLimit(
                "a".repeat(TranscriptionCacheService.MAX_SERIALIZED_ENTRY_BYTES + 1))).isFalse();
        assertThat(TranscriptionCacheService.withinSerializedEntryLimit(
                "é".repeat(TranscriptionCacheService.MAX_SERIALIZED_ENTRY_BYTES / 2 + 1))).isFalse();
    }

    @Test
    void oversizedWritesAreSkippedWithoutLoggingTranscriptionContent() {
        String marker = "oversized-private-transcript-marker";
        TranscriptionEntity oversized = entity("tenant-a", UUID.randomUUID(), false);
        oversized.setText(marker + "x".repeat(TranscriptionCacheService.MAX_SERIALIZED_ENTRY_BYTES));

        try (LogCapture logs = capture(TranscriptionCacheService.class)) {
            await(cacheService.cacheTranscription("tenant-a", oversized));
            await(cacheService.cacheTranscription("tenant-a", oversized, Duration.ofMinutes(5)));
            oversized.setAudioFileId(UUID.randomUUID());
            await(cacheService.cacheTranscriptionByAudioFileId(
                    "tenant-a", oversized.getAudioFileId(), oversized));
            assertThat(logs.output()).contains("Oversized transcription cache value")
                    .doesNotContain(marker);
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
    void cachedValueCannotShortCircuitCurrentSourceLoad() {
        UUID transcriptionId = UUID.randomUUID();
        String key = key("tenant-a", transcriptionId.toString());
        TranscriptionEntity source = entity("tenant-a", transcriptionId, false);
        when(cachePort.put(eq(key), any(), any(Duration.class))).thenReturn(AsyncOperation.success(null));
        AtomicInteger loads = new AtomicInteger();

        TranscriptionEntity result = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                id -> {
                    loads.incrementAndGet();
                    return AsyncOperation.success(Optional.of(source));
                }));

        assertThat(result).isSameAs(source);
        assertThat(loads.get()).isEqualTo(1);
        verify(cachePort, never()).get(any());
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

        verifyNoInteractions(cachePort);
    }

    @Test
    void customTtlAboveCacheMaximumIsCapped() throws Exception {
        UUID transcriptionId = UUID.randomUUID();
        String cacheKey = key("tenant-a", transcriptionId.toString());
        TranscriptionEntity entry = entity("tenant-a", transcriptionId, false);
        when(cachePort.put(eq(cacheKey), any(), eq(Duration.ofMinutes(30))))
                .thenReturn(AsyncOperation.success(null));

        await(cacheService.cacheTranscription("tenant-a", entry, Duration.ofDays(2)));

        verify(cachePort).put(eq(cacheKey), any(), eq(Duration.ofMinutes(30)));
    }

    @Test
    void oversizedSourceValueIsReturnedButNotSerializedBeyondTheCacheBoundOrLogged() {
        UUID transcriptionId = UUID.randomUUID();
        String key = key("tenant-a", transcriptionId.toString());
        String marker = "oversized-source-private-marker";
        TranscriptionEntity source = entity("tenant-a", transcriptionId, false);
        source.setText(marker + "x".repeat(TranscriptionCacheService.MAX_SERIALIZED_ENTRY_BYTES * 3));
        when(cachePort.get(key)).thenReturn(AsyncOperation.success(Optional.empty()));

        try (LogCapture logs = capture(TranscriptionCacheService.class)) {
            TranscriptionEntity result = await(cacheService.getOrLoadTranscription("tenant-a", transcriptionId,
                    id -> AsyncOperation.success(Optional.of(source))));

            assertThat(result).isSameAs(source);
            assertThat(logs.output()).contains("Oversized source transcription; skipping cache write")
                    .doesNotContain(marker);
        }

        verify(cachePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void serializationFailuresDoNotLogCauseMessageOrEntityIdentifiers() {
        String marker = "serializer-leaked-secret-payload";
        ObjectMapper mapper = mock(ObjectMapper.class);
        TranscriptionCacheService isolatedService = new TranscriptionCacheService(cachePort, mapper);
        TranscriptionEntity entry = entity("tenant-private-marker", UUID.randomUUID(), false);
        entry.setAudioFileId(UUID.randomUUID());
        doThrow(new IllegalStateException(marker)).when(mapper)
                .writeValue(any(OutputStream.class), eq(entry));

        try (LogCapture logs = capture(TranscriptionCacheService.class)) {
            await(isolatedService.cacheTranscription("tenant-private-marker", entry));
            await(isolatedService.cacheTranscription("tenant-private-marker", entry, Duration.ofMinutes(1)));
            await(isolatedService.cacheTranscriptionByAudioFileId(
                    "tenant-private-marker", entry.getAudioFileId(), entry));

            assertThat(logs.output()).contains("cache write preparation failed")
                    .doesNotContain(marker, "tenant-private-marker", entry.getId().toString(),
                            entry.getAudioFileId().toString());
        }

        verifyNoInteractions(cachePort);
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
        when(servicePort.put(eq(transcriptKey), any(), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));
        when(servicePort.put(eq(audioKey), any(), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));
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
