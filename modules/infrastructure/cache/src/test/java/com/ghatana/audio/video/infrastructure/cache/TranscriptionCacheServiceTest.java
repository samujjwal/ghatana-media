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
import org.mockito.ArgumentCaptor;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
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
    void scopedReadRejectsCrossTenantSourceResultAfterExactKeyLookup() {
        UUID id = UUID.randomUUID();
        TranscriptionCacheService service = new TranscriptionCacheService(cachePort, objectMapper);

        var scope = scopedScope("tenant-b", "principal-a", "policy-1");
        assertThatThrownBy(() -> await(service.getOrLoadTranscriptionWithScopedSnapshot(
                scope, id,
                currentAuthority(),
                requested -> scopedSource(scope, requested, entity("tenant-a", requested, false)))))
                .hasRootCauseInstanceOf(IllegalStateException.class)
                .hasRootCauseMessage("Transcription identity does not match requested scope");

        verify(cachePort).get(any());
        verify(cachePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void scopedAuthorityDenialPrecedesCacheAndSourceAccess() {
        UUID id = UUID.randomUUID();
        TranscriptionCacheService service = new TranscriptionCacheService(cachePort, objectMapper);

        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        assertThatThrownBy(() -> await(service.getOrLoadTranscriptionWithScopedSnapshot(
                scope, id,
                checked -> AsyncOperation.success(AudioVideoCache.ScopedAuthorityResult.rejected(checked)),
                requested -> scopedSource(scope, requested, entity("tenant-a", requested, false)))))
                .hasRootCauseInstanceOf(SecurityException.class)
                .hasRootCauseMessage("Current cache authority is denied or unknown");

        verify(cachePort, never()).get(any());
        verify(cachePort, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void scopedUnknownAuthorityCannotUseCallerScopeMetadataAsCacheAuthority() {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.invalidateAsync(key)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);

        assertThatThrownBy(() -> await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                ignored -> AsyncOperation.success(AudioVideoCache.ScopedAuthorityResult.unknown()),
                requested -> scopedSource(scope, requested, entity("tenant-a", requested, false)))))
                .hasRootCauseInstanceOf(SecurityException.class)
                .hasRootCauseMessage("Current cache authority is denied or unknown");

        verify(port, never()).get(any());
        verify(port, never()).put(any(), any(), any(Duration.class));
        verify(port).invalidateAsync(key);
    }

    @Test
    void forgedCurrentReadbackWithStalePolicyEpochEvictsOnlyRequestedKey() {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-epoch-current");
        var stale = new AudioVideoCache.CacheKeyScope(scope.tenantId(), scope.authenticatedPrincipalId(),
                scope.rightsScope(), scope.purpose(), scope.classification(), scope.artifactId(),
                scope.artifactRevision(), scope.transcriptRevision(), scope.sourceFingerprint(), "policy-epoch-old",
                scope.modelLicenseRef(), scope.revocationEpoch());
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.invalidateAsync(key)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        AtomicInteger sourceLoads = new AtomicInteger();

        assertThatThrownBy(() -> await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                requested -> AsyncOperation.success(AudioVideoCache.ScopedAuthorityResult.current(stale, java.time.Instant.now().plusSeconds(3600))),
                requested -> {
                    sourceLoads.incrementAndGet();
                    return scopedSource(scope, requested, entity("tenant-a", requested, false));
                })))
                .hasRootCauseInstanceOf(SecurityException.class)
                .hasRootCauseMessage("Current cache authority is denied or unknown");

        assertThat(sourceLoads).hasValue(0);
        verify(port, never()).get(any());
        verify(port, never()).put(any(), any(), any(Duration.class));
        verify(port).invalidateAsync(key);
        verify(port, never()).invalidateAll();
    }

    @Test
    void typedAuthorityErrorFailsClosedBeforeLoaderAndEvictsExactKey() {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.invalidateAsync(key)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        AtomicInteger sourceLoads = new AtomicInteger();

        assertThatThrownBy(() -> await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                requested -> AsyncOperation.failure(new IllegalStateException("authority offline")),
                requested -> {
                    sourceLoads.incrementAndGet();
                    return scopedSource(scope, requested, entity("tenant-a", requested, false));
                })))
                .hasRootCauseInstanceOf(SecurityException.class)
                .hasRootCauseMessage("Current cache authority is denied or unknown");

        assertThat(sourceLoads).hasValue(0);
        verify(port, never()).get(any());
        verify(port, never()).put(any(), any(), any(Duration.class));
        verify(port).invalidateAsync(key);
    }

    @Test
    void legacyBooleanPathUsesOnlyCurrentSourceReadAndEvictsScopedKey() {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String scopedKey = scopedKey(scope, id);
        String legacyKey = key(scope.tenantId(), id.toString());
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.invalidateAsync(scopedKey)).thenReturn(AsyncOperation.success(null));
        when(port.invalidateAsync(legacyKey)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        TranscriptionEntity source = versionedEntity("tenant-a", id, 13L, "source read only");

        TranscriptionEntity result = await(service.getOrLoadTranscription(scope, id,
                ignored -> AsyncOperation.success(true),
                requested -> AsyncOperation.success(Optional.of(source))));

        assertThat(result.getText()).isEqualTo("source read only");
        verify(port, never()).get(any());
        verify(port, never()).put(any(), any(), any(Duration.class));
        verify(port).invalidateAsync(scopedKey);
        verify(port).invalidateAsync(legacyKey);
    }

    @Test
    void entityOnlyTypedOverloadFailsClosedWithoutCacheOrSourceAccess() {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        TranscriptionCacheService service = new TranscriptionCacheService(cachePort, objectMapper);
        AtomicInteger sourceLoads = new AtomicInteger();

        assertThatThrownBy(() -> await(service.getOrLoadTranscriptionWithAuthority(scope, id,
                currentAuthority(), requested -> {
                    sourceLoads.incrementAndGet();
                    return AsyncOperation.success(Optional.of(
                            versionedEntity("tenant-a", requested, 4L, "must not be disclosed")));
                })))
                .hasRootCauseInstanceOf(SecurityException.class)
                .hasRootCauseMessage("Protected transcript caching requires a scoped source snapshot");

        assertThat(sourceLoads).hasValue(0);
        verifyNoInteractions(cachePort);
    }

    @Test
    void legacyBooleanUnknownDoesNotStartSourceRead() {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String scopedKey = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.invalidateAsync(scopedKey)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        AtomicInteger sourceLoads = new AtomicInteger();

        assertThatThrownBy(() -> await(service.getOrLoadTranscription(scope, id,
                ignored -> AsyncOperation.failure(new IllegalStateException("unknown authority")),
                requested -> {
                    sourceLoads.incrementAndGet();
                    return AsyncOperation.success(Optional.of(entity("tenant-a", requested, false)));
                })))
                .hasRootCauseInstanceOf(SecurityException.class)
                .hasRootCauseMessage("Boolean cache authority is unavailable; source read was not started");

        assertThat(sourceLoads).hasValue(0);
        verify(port, never()).get(any());
        verify(port, never()).put(any(), any(), any(Duration.class));
        verify(port).invalidateAsync(scopedKey);
    }

    @Test
    void explicitRightsChangeInvalidationUsesTheExactPriorScopeAndTranscriptKey() {
        UUID id = UUID.randomUUID();
        var priorScope = scopedScope("tenant-a", "principal-a", "policy-epoch-before-revocation");
        String priorKey = scopedKey(priorScope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.invalidateAsync(priorKey)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);

        await(service.invalidateTranscriptionScoped(priorScope, id));

        verify(port).invalidateAsync(priorKey);
        verify(port, never()).invalidateAll();
    }

    @Test
    void scopedMissStoresVersionedEnvelopeUnderFullAuthorityAndSourceKey() throws Exception {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.empty()));
        when(port.put(eq(key), any(String.class), any(Duration.class))).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        TranscriptionEntity source = versionedEntity("tenant-a", id, 9L, "current scoped transcript");

        TranscriptionEntity result = await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                currentAuthority(),
                requested -> scopedSource(scope, requested, source)));

        assertThat(result.getText()).isEqualTo(source.getText());
        assertThat(result.getVersion()).isEqualTo(source.getVersion());
        ArgumentCaptor<String> stored = ArgumentCaptor.forClass(String.class);
        verify(port).put(eq(key), stored.capture(), any(Duration.class));
        assertThat(stored.getValue()).contains("current scoped transcript", key)
                .contains("\"formatVersion\":2")
                .doesNotContain("principal-a", "rights-current", "policy-1", "source-sha256-1",
                        "artifact-revision-4");
        verify(port).get(key);
    }

    @Test
    void scopedReadRejectsSourceSnapshotForDifferentArtifactRevisionBeforeCaching() {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        var mismatchedSourceScope = new AudioVideoCache.CacheKeyScope(scope.tenantId(),
                scope.authenticatedPrincipalId(), scope.rightsScope(), scope.purpose(), scope.classification(),
                scope.artifactId(), "artifact-revision-newer", scope.transcriptRevision(),
                scope.sourceFingerprint(), scope.policyEpoch(), scope.modelLicenseRef(), scope.revocationEpoch());
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.empty()));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        TranscriptionEntity source = versionedEntity("tenant-a", id, 9L, "wrong artifact revision");

        assertThatThrownBy(() -> await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                currentAuthority(), requested -> scopedSource(mismatchedSourceScope, requested, source))))
                .hasRootCauseInstanceOf(SecurityException.class)
                .hasRootCauseMessage("Transcription source identity does not match requested cache scope");

        verify(port).get(key);
        verify(port, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void scopedReadRejectsEveryMismatchedScopeDimensionAndTranscriptIdentity() {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        TranscriptionEntity source = versionedEntity("tenant-a", id, 9L, "must not be disclosed");
        List<AudioVideoCache.CacheKeyScope> mismatches = mismatchedScopes(scope);

        for (int index = 0; index < mismatches.size(); index++) {
            String label = "scope dimension " + index;
            DistributedCacheService port = mock(DistributedCacheService.class);
            when(port.get(scopedKey(scope, id))).thenReturn(AsyncOperation.success(Optional.empty()));
            TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
            var mismatchedScope = mismatches.get(index);

            assertThatThrownBy(() -> await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                    currentAuthority(), requested -> scopedSource(mismatchedScope, requested, source))))
                    .as(label)
                    .hasRootCauseInstanceOf(SecurityException.class)
                    .hasRootCauseMessage("Transcription source identity does not match requested cache scope");

            verify(port).get(scopedKey(scope, id));
            verify(port, never()).put(any(), any(), any(Duration.class));
        }

        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.get(scopedKey(scope, id))).thenReturn(AsyncOperation.success(Optional.empty()));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        UUID wrongTranscriptionId = UUID.randomUUID();

        assertThatThrownBy(() -> await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                currentAuthority(), requested -> scopedSource(scope, wrongTranscriptionId, source))))
                .as("transcription identity")
                .hasRootCauseInstanceOf(SecurityException.class)
                .hasRootCauseMessage("Transcription source identity does not match requested cache scope");

        verify(port).get(scopedKey(scope, id));
        verify(port, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void scopedDeletedEntityIsNotDisclosedOrNegativeCached() {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.empty()));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        TranscriptionEntity deleted = entity("tenant-a", id, true);

        TranscriptionEntity result = await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                currentAuthority(), requested -> scopedSource(scope, requested, deleted)));

        assertThat(result).isNull();
        verify(port).get(key);
        verify(port, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void scopedReadRejectsUnpersistedEntityVersionBeforeCaching() {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.empty()));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        TranscriptionEntity source = entity("tenant-a", id, false);

        assertThatThrownBy(() -> await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                currentAuthority(), requested -> scopedSource(scope, requested, source))))
                .hasRootCauseInstanceOf(IllegalStateException.class)
                .hasRootCauseMessage("A protected transcription cache entry requires a persisted entity version");

        verify(port).get(key);
        verify(port, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void scopedCacheHitRechecksAuthorityImmediatelyBeforeReturningContent() throws Exception {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.empty()));
        when(port.put(eq(key), any(String.class), any(Duration.class))).thenReturn(AsyncOperation.success(null));
        when(port.invalidateAsync(key)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        TranscriptionEntity source = versionedEntity("tenant-a", id, 9L, "current scoped transcript");
        await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id, currentAuthority(),
                requested -> scopedSource(scope, requested, source)));
        ArgumentCaptor<String> stored = ArgumentCaptor.forClass(String.class);
        verify(port).put(eq(key), stored.capture(), any(Duration.class));

        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.of(stored.getValue())));
        AtomicInteger authorityReads = new AtomicInteger();
        TranscriptionEntity cached = await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                checked -> AsyncOperation.success(authorityReads.incrementAndGet() <= 2
                        ? AudioVideoCache.ScopedAuthorityResult.current(checked, java.time.Instant.now().plusSeconds(3600))
                        : AudioVideoCache.ScopedAuthorityResult.rejected(checked)),
                requested -> { throw new AssertionError("valid cache hit must not load source"); }));

        assertThat(cached.getText()).isEqualTo("current scoped transcript");
        assertThat(authorityReads).hasValue(2);
    }

    @Test
    void revocationAfterScopedCacheReadInvalidatesExactEntryAndReturnsNoContent() throws Exception {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.empty()));
        when(port.put(eq(key), any(String.class), any(Duration.class))).thenReturn(AsyncOperation.success(null));
        when(port.invalidateAsync(key)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        TranscriptionEntity source = versionedEntity("tenant-a", id, 9L, "protected scoped transcript");
        await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id, currentAuthority(),
                requested -> scopedSource(scope, requested, source)));
        ArgumentCaptor<String> stored = ArgumentCaptor.forClass(String.class);
        verify(port).put(eq(key), stored.capture(), any(Duration.class));

        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.of(stored.getValue())));
        AtomicInteger authorityReads = new AtomicInteger();
        assertThatThrownBy(() -> await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                checked -> AsyncOperation.success(authorityReads.incrementAndGet() == 1
                        ? AudioVideoCache.ScopedAuthorityResult.current(checked, java.time.Instant.now().plusSeconds(3600))
                        : AudioVideoCache.ScopedAuthorityResult.rejected(checked)),
                requested -> { throw new AssertionError("revoked cache hit must not load source"); })))
                .hasRootCauseInstanceOf(SecurityException.class)
                .hasRootCauseMessage("Current cache authority changed or became unavailable before disclosure");

        assertThat(authorityReads).hasValue(2);
        verify(port).invalidateAsync(key);
    }

    @Test
    void malformedScopedCacheEntryIsInvalidatedAndReloadedFromCurrentSource() throws Exception {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.of("{malformed")),
                AsyncOperation.success(Optional.empty()));
        when(port.put(eq(key), any(String.class), any(Duration.class))).thenReturn(AsyncOperation.success(null));
        when(port.invalidateAsync(key)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        AtomicInteger sourceLoads = new AtomicInteger();
        TranscriptionEntity source = versionedEntity("tenant-a", id, 10L, "authoritative replacement");

        TranscriptionEntity result = await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                currentAuthority(),
                requested -> {
                    sourceLoads.incrementAndGet();
                    return scopedSource(scope, requested, source);
                }));

        assertThat(result.getText()).isEqualTo("authoritative replacement");
        assertThat(sourceLoads).hasValue(1);
        verify(port).invalidateAsync(key);
        verify(port, org.mockito.Mockito.times(2)).get(key);
    }

    @Test
    void unboundFormatOneEnvelopeIsInvalidatedAndReloadedUnderCurrentScope() throws Exception {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        TranscriptionEntity stale = versionedEntity("tenant-a", id, 9L, "old unbound envelope");
        String legacy = objectMapper.writeValueAsString(java.util.Map.of(
                "formatVersion", 1,
                "scopedKey", key,
                "entityVersion", stale.getVersion(),
                "transcription", stale));
        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.of(legacy)),
                AsyncOperation.success(Optional.empty()));
        when(port.put(eq(key), any(String.class), any(Duration.class))).thenReturn(AsyncOperation.success(null));
        when(port.invalidateAsync(key)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        TranscriptionEntity current = versionedEntity("tenant-a", id, 10L, "fresh scoped transcript");

        TranscriptionEntity result = await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                currentAuthority(), requested -> scopedSource(scope, requested, current)));

        assertThat(result.getText()).isEqualTo("fresh scoped transcript");
        verify(port).invalidateAsync(key);
        verify(port, org.mockito.Mockito.times(2)).get(key);
        ArgumentCaptor<String> stored = ArgumentCaptor.forClass(String.class);
        verify(port).put(eq(key), stored.capture(), any(Duration.class));
        assertThat(stored.getValue()).contains("\"formatVersion\":2").doesNotContain("old unbound envelope");
    }

    @Test
    void scopedCacheEntryWithStaleSourceScopeIsInvalidatedBeforeCurrentSourceReload() throws Exception {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.empty()));
        when(port.put(eq(key), any(String.class), any(Duration.class))).thenReturn(AsyncOperation.success(null));
        when(port.invalidateAsync(key)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        TranscriptionEntity original = versionedEntity("tenant-a", id, 9L, "old source version");
        await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id, currentAuthority(),
                requested -> scopedSource(scope, requested, original)));
        ArgumentCaptor<String> stored = ArgumentCaptor.forClass(String.class);
        verify(port).put(eq(key), stored.capture(), any(Duration.class));
        String staleScopeEntry = stored.getValue().replace(key, key + "stale");
        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.of(staleScopeEntry)),
                AsyncOperation.success(Optional.empty()));
        AtomicInteger sourceLoads = new AtomicInteger();
        TranscriptionEntity current = versionedEntity("tenant-a", id, 10L, "current source version");

        TranscriptionEntity result = await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                currentAuthority(),
                requested -> {
                    sourceLoads.incrementAndGet();
                    return scopedSource(scope, requested, current);
                }));

        assertThat(result.getText()).isEqualTo("current source version");
        assertThat(sourceLoads).hasValue(1);
        verify(port).invalidateAsync(key);
        verify(port, org.mockito.Mockito.times(3)).get(key);
    }

    @Test
    void scopedCacheEntryWithStaleVersionMetadataIsInvalidatedBeforeCurrentSourceReload() throws Exception {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.empty()));
        when(port.put(eq(key), any(String.class), any(Duration.class))).thenReturn(AsyncOperation.success(null));
        when(port.invalidateAsync(key)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        TranscriptionEntity original = versionedEntity("tenant-a", id, 9L, "version nine");
        await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id, currentAuthority(),
                requested -> scopedSource(scope, requested, original)));

        ArgumentCaptor<String> stored = ArgumentCaptor.forClass(String.class);
        verify(port).put(eq(key), stored.capture(), any(Duration.class));
        String staleMetadata = stored.getValue().replace("\"entityVersion\":9", "\"entityVersion\":8");
        assertThat(staleMetadata).isNotEqualTo(stored.getValue());
        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.of(staleMetadata)),
                AsyncOperation.success(Optional.empty()));
        TranscriptionEntity current = versionedEntity("tenant-a", id, 10L, "current version ten");
        AtomicInteger sourceLoads = new AtomicInteger();

        TranscriptionEntity result = await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                currentAuthority(), requested -> {
                    sourceLoads.incrementAndGet();
                    return scopedSource(scope, requested, current);
                }));

        assertThat(result.getText()).isEqualTo("current version ten");
        assertThat(result.getVersion()).isEqualTo(10L);
        assertThat(sourceLoads).hasValue(1);
        verify(port).invalidateAsync(key);
        verify(port, org.mockito.Mockito.times(3)).get(key);
    }

    @Test
    void concurrentScopedMissesShareOneAuthorizedSourceLoad() {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        CompletableFuture<Optional<String>> cacheRead = new CompletableFuture<>();
        when(port.get(key)).thenReturn(AsyncOperation.from(cacheRead));
        when(port.put(eq(key), any(String.class), any(Duration.class))).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        CompletableFuture<Optional<TranscriptionCacheService.ScopedTranscriptionSnapshot>> sourceRead = new CompletableFuture<>();
        AtomicInteger sourceLoads = new AtomicInteger();
        AtomicInteger authorityReads = new AtomicInteger();
        AudioVideoCache.ScopedAuthority authority = checked -> {
            authorityReads.incrementAndGet();
            return AsyncOperation.success(AudioVideoCache.ScopedAuthorityResult.current(checked, java.time.Instant.now().plusSeconds(3600)));
        };
        TranscriptionCacheService.ScopedTranscriptionLoader loader = requested -> {
            sourceLoads.incrementAndGet();
            return AsyncOperation.from(sourceRead);
        };

        AsyncOperation<TranscriptionEntity> first = service.getOrLoadTranscriptionWithScopedSnapshot(scope, id, authority, loader);
        AsyncOperation<TranscriptionEntity> second = service.getOrLoadTranscriptionWithScopedSnapshot(scope, id, authority, loader);
        cacheRead.complete(Optional.empty());

        assertThat(sourceLoads).hasValue(1);
        assertThat(authorityReads).hasValue(2);
        TranscriptionEntity source = versionedEntity("tenant-a", id, 12L, "one shared source read");
        sourceRead.complete(Optional.of(new TranscriptionCacheService.ScopedTranscriptionSnapshot(scope, id, source)));

        assertThat(await(first).getText()).isEqualTo("one shared source read");
        assertThat(await(second).getText()).isEqualTo("one shared source read");
        verify(port).get(key);
    }

    @Test
    void scopedCacheOutageFallsBackToAuthorizedSourceWithoutChangingResult() {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.get(key)).thenReturn(AsyncOperation.failure(new IllegalStateException("redis unavailable")));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        TranscriptionEntity source = versionedEntity("tenant-a", id, 11L, "source survives cache outage");

        TranscriptionEntity result = await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id,
                currentAuthority(),
                requested -> scopedSource(scope, requested, source)));

        assertThat(result.getText()).isEqualTo(source.getText());
        assertThat(result.getVersion()).isEqualTo(source.getVersion());
        verify(port).get(key);
        verify(port, never()).put(any(), any(), any(Duration.class));
    }

    @Test
    void scopedAbsenceIsNotNegativeCached() {
        UUID id = UUID.randomUUID();
        var scope = scopedScope("tenant-a", "principal-a", "policy-1");
        String key = scopedKey(scope, id);
        DistributedCacheService port = mock(DistributedCacheService.class);
        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.empty()));
        TranscriptionCacheService service = new TranscriptionCacheService(port, objectMapper);
        AtomicInteger sourceLoads = new AtomicInteger();
        TranscriptionCacheService.ScopedTranscriptionLoader loader = requested -> {
            sourceLoads.incrementAndGet();
            return AsyncOperation.success(Optional.empty());
        };

        assertThat(await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id, currentAuthority(), loader))).isNull();
        assertThat(await(service.getOrLoadTranscriptionWithScopedSnapshot(scope, id, currentAuthority(), loader))).isNull();

        assertThat(sourceLoads).hasValue(2);
        verify(port, org.mockito.Mockito.times(2)).get(key);
        verify(port, never()).put(any(), any(), any(Duration.class));
    }

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
        String requestedKey = key("tenant-a", transcriptionId.toString());
        DistributedCacheService scopedPort = mock(DistributedCacheService.class);
        when(scopedPort.invalidateAsync(requestedKey)).thenReturn(AsyncOperation.success(null));
        TranscriptionCacheService scopedService = new TranscriptionCacheService(scopedPort, objectMapper);

        for (TranscriptionEntity mismatched : new TranscriptionEntity[] {
                entity("tenant-b", transcriptionId, false),
                entity("tenant-a", UUID.randomUUID(), false) }) {
            assertThatThrownBy(() -> await(scopedService.getOrLoadTranscription("tenant-a", transcriptionId,
                    id -> AsyncOperation.success(Optional.of(mismatched)))))
                    .hasRootCauseInstanceOf(IllegalStateException.class)
                    .hasRootCauseMessage("Transcription identity does not match requested scope");
        }
        verify(scopedPort, org.mockito.Mockito.times(2)).invalidateAsync(requestedKey);
        verify(scopedPort, never()).get(any());
        verify(scopedPort, never()).put(any(), any(), any(Duration.class));
        verify(scopedPort, never()).invalidateAsync(key("tenant-b", transcriptionId.toString()));
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

    private static AudioVideoCache.CacheKeyScope scopedScope(
            String tenant, String principal, String policyEpoch) {
        return new AudioVideoCache.CacheKeyScope(tenant, principal, "rights-current", "transcription",
                "confidential", "artifact-7", "artifact-revision-4", "transcript-revision-9",
                "source-sha256-1", policyEpoch, "model-license-v1", 0L);
    }

    private static List<AudioVideoCache.CacheKeyScope> mismatchedScopes(
            AudioVideoCache.CacheKeyScope scope) {
        return List.of(
                new AudioVideoCache.CacheKeyScope("tenant-b", scope.authenticatedPrincipalId(), scope.rightsScope(),
                        scope.purpose(), scope.classification(), scope.artifactId(), scope.artifactRevision(),
                        scope.transcriptRevision(), scope.sourceFingerprint(), scope.policyEpoch(),
                        scope.modelLicenseRef(), scope.revocationEpoch()),
                new AudioVideoCache.CacheKeyScope(scope.tenantId(), "principal-b", scope.rightsScope(),
                        scope.purpose(), scope.classification(), scope.artifactId(), scope.artifactRevision(),
                        scope.transcriptRevision(), scope.sourceFingerprint(), scope.policyEpoch(),
                        scope.modelLicenseRef(), scope.revocationEpoch()),
                new AudioVideoCache.CacheKeyScope(scope.tenantId(), scope.authenticatedPrincipalId(), "rights-next",
                        scope.purpose(), scope.classification(), scope.artifactId(), scope.artifactRevision(),
                        scope.transcriptRevision(), scope.sourceFingerprint(), scope.policyEpoch(),
                        scope.modelLicenseRef(), scope.revocationEpoch()),
                new AudioVideoCache.CacheKeyScope(scope.tenantId(), scope.authenticatedPrincipalId(), scope.rightsScope(),
                        "caption-correction", scope.classification(), scope.artifactId(), scope.artifactRevision(),
                        scope.transcriptRevision(), scope.sourceFingerprint(), scope.policyEpoch(),
                        scope.modelLicenseRef(), scope.revocationEpoch()),
                new AudioVideoCache.CacheKeyScope(scope.tenantId(), scope.authenticatedPrincipalId(), scope.rightsScope(),
                        scope.purpose(), "restricted", scope.artifactId(), scope.artifactRevision(),
                        scope.transcriptRevision(), scope.sourceFingerprint(), scope.policyEpoch(),
                        scope.modelLicenseRef(), scope.revocationEpoch()),
                new AudioVideoCache.CacheKeyScope(scope.tenantId(), scope.authenticatedPrincipalId(), scope.rightsScope(),
                        scope.purpose(), scope.classification(), "artifact-next", scope.artifactRevision(),
                        scope.transcriptRevision(), scope.sourceFingerprint(), scope.policyEpoch(),
                        scope.modelLicenseRef(), scope.revocationEpoch()),
                new AudioVideoCache.CacheKeyScope(scope.tenantId(), scope.authenticatedPrincipalId(), scope.rightsScope(),
                        scope.purpose(), scope.classification(), scope.artifactId(), "artifact-revision-next",
                        scope.transcriptRevision(), scope.sourceFingerprint(), scope.policyEpoch(),
                        scope.modelLicenseRef(), scope.revocationEpoch()),
                new AudioVideoCache.CacheKeyScope(scope.tenantId(), scope.authenticatedPrincipalId(), scope.rightsScope(),
                        scope.purpose(), scope.classification(), scope.artifactId(), scope.artifactRevision(),
                        "transcript-revision-next", scope.sourceFingerprint(), scope.policyEpoch(),
                        scope.modelLicenseRef(), scope.revocationEpoch()),
                new AudioVideoCache.CacheKeyScope(scope.tenantId(), scope.authenticatedPrincipalId(), scope.rightsScope(),
                        scope.purpose(), scope.classification(), scope.artifactId(), scope.artifactRevision(),
                        scope.transcriptRevision(), "source-fingerprint-next", scope.policyEpoch(),
                        scope.modelLicenseRef(), scope.revocationEpoch()),
                new AudioVideoCache.CacheKeyScope(scope.tenantId(), scope.authenticatedPrincipalId(), scope.rightsScope(),
                        scope.purpose(), scope.classification(), scope.artifactId(), scope.artifactRevision(),
                        scope.transcriptRevision(), scope.sourceFingerprint(), "policy-epoch-next",
                        scope.modelLicenseRef(), scope.revocationEpoch()),
                new AudioVideoCache.CacheKeyScope(scope.tenantId(), scope.authenticatedPrincipalId(), scope.rightsScope(),
                        scope.purpose(), scope.classification(), scope.artifactId(), scope.artifactRevision(),
                        scope.transcriptRevision(), scope.sourceFingerprint(), scope.policyEpoch(),
                        "model-license-next", scope.revocationEpoch()),
                new AudioVideoCache.CacheKeyScope(scope.tenantId(), scope.authenticatedPrincipalId(), scope.rightsScope(),
                        scope.purpose(), scope.classification(), scope.artifactId(), scope.artifactRevision(),
                        scope.transcriptRevision(), scope.sourceFingerprint(), scope.policyEpoch(),
                        scope.modelLicenseRef(), scope.revocationEpoch() + 1));
    }

    /** Test-only exact-scope decision; this does not establish a production authority provider. */
    private static AudioVideoCache.ScopedAuthority currentAuthority() {
        return scope -> AsyncOperation.success(AudioVideoCache.ScopedAuthorityResult.current(scope, java.time.Instant.now().plusSeconds(3600)));
    }

    private static AsyncOperation<Optional<TranscriptionCacheService.ScopedTranscriptionSnapshot>>
            scopedSource(AudioVideoCache.CacheKeyScope sourceScope, UUID transcriptionId, TranscriptionEntity entity) {
        return AsyncOperation.success(Optional.of(new TranscriptionCacheService.ScopedTranscriptionSnapshot(
                sourceScope, transcriptionId, entity)));
    }

    private String scopedKey(AudioVideoCache.CacheKeyScope scope, UUID transcriptionId) {
        return new AudioVideoCache<String, String>(cachePort, "transcription")
                .buildScopedKey(scope, transcriptionId.toString());
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
