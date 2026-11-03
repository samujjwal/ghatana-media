package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.cache.CachePolicy;
import com.ghatana.cache.DistributedCachePort;
import com.ghatana.cache.DistributedCacheService;
import com.ghatana.core.async.AsyncOperation;
import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Property;
import org.junit.jupiter.api.Test;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * Cache keys can embed tenant, principal, artifact or transcript identity.
 * Diagnostics must expose only a bounded, correlatable reference — never the
 * raw key material or a secret marker.
 */
class AudioVideoCacheKeyRedactionTest {

    @Test
    void keyReferenceIsBoundedDeterministicAndDisclosesNoKeyMaterial() {
        String tenantKey = "media-cache:tenant-987-secret:transcript-654-private";

        String reference = AudioVideoCache.keyReference(tenantKey);
        assertThat(reference).matches("hmac256:[0-9a-f]{24}");
        assertThat(reference).isEqualTo(AudioVideoCache.keyReference(tenantKey));
        assertThat(reference).doesNotContain("tenant-987-secret", "transcript-654-private",
                "tenant", "secret");
        assertThat(AudioVideoCache.keyReference(
                        "media-cache:tenant-987-secret:other-id"))
                .isNotEqualTo(reference);
        assertThat(AudioVideoCache.keyReference(12345)).matches("hmac256:[0-9a-f]{24}");
    }

    @Test
    void cacheKeyFramesTenantAndIdWithoutExposingTheirValues() {
        DistributedCachePort<String, String> port = mock(DistributedCachePort.class);
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(port, "transcription");
        String baseline = cache.buildKey("a:audio", "123e4567-e89b-12d3-a456-426614174000");

        assertThat(baseline).matches("av2-[0-9a-f]{64}");
        assertThat(baseline).doesNotContain(":", "*", "?");
        assertThat(baseline).isEqualTo(cache.buildKey("a:audio",
                "123e4567-e89b-12d3-a456-426614174000"));
        assertThat(cache.buildKey("a", "audio:123e4567-e89b-12d3-a456-426614174000"))
                .isNotEqualTo(baseline);
        assertThat(baseline).doesNotContain("a:audio", "123e4567");
    }

    @Test
    void cacheKeyHashFramesDistinctMalformedUtf16CodeUnits() {
        DistributedCachePort<String, String> port = mock(DistributedCachePort.class);
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(port, "transcription");
        String highSurrogateA = cache.buildKey("tenant", "\uD800");
        String highSurrogateB = cache.buildKey("tenant", "\uD801");

        assertThat(highSurrogateA).isNotEqualTo(highSurrogateB);
    }

    @Test
    void equalAudioFingerprintDoesNotProduceCrossTenantCacheHits() {
        DistributedCachePort<String, String> port = mock(DistributedCachePort.class);
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(port, "transcription");
        String audioFingerprint = "audio-sha256:" + "a".repeat(64);
        String tenantOneKey = cache.buildKey("tenant-one", audioFingerprint);
        String tenantTwoKey = cache.buildKey("tenant-two", audioFingerprint);
        ConcurrentHashMap<String, String> values = new ConcurrentHashMap<>();
        AtomicInteger tenantOneLoads = new AtomicInteger();
        AtomicInteger tenantTwoLoads = new AtomicInteger();
        when(port.get(org.mockito.ArgumentMatchers.anyString())).thenAnswer(invocation ->
                AsyncOperation.success(Optional.ofNullable(values.get(invocation.getArgument(0)))));
        when(port.put(org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.any(Duration.class)))
                .thenAnswer(invocation -> {
                    values.put(invocation.getArgument(0), invocation.getArgument(1));
                    return AsyncOperation.success(null);
                });

        assertThat(AsyncOperationTestSupport.await(cache.getOrLoad(tenantOneKey, ignored -> {
            tenantOneLoads.incrementAndGet();
            return AsyncOperation.success("tenant-one-transcript");
        }))).isEqualTo("tenant-one-transcript");
        assertThat(AsyncOperationTestSupport.await(cache.getOrLoad(tenantTwoKey, ignored -> {
            tenantTwoLoads.incrementAndGet();
            return AsyncOperation.success("tenant-two-transcript");
        }))).isEqualTo("tenant-two-transcript");

        assertThat(tenantOneKey).isNotEqualTo(tenantTwoKey);
        assertThat(tenantOneLoads).hasValue(1);
        assertThat(tenantTwoLoads).hasValue(1);
        assertThat(values).containsEntry(tenantOneKey, "tenant-one-transcript")
                .containsEntry(tenantTwoKey, "tenant-two-transcript");
    }

    @Test
    void equalAudioFingerprintHasNoCrossScopeHitsAcrossProtectedDimensions() {
        DistributedCachePort<String, String> port = mock(DistributedCachePort.class);
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(port, "transcription");
        ConcurrentHashMap<String, String> values = new ConcurrentHashMap<>();
        AtomicInteger loads = new AtomicInteger();
        when(port.get(org.mockito.ArgumentMatchers.anyString())).thenAnswer(invocation ->
                AsyncOperation.success(Optional.ofNullable(values.get(invocation.getArgument(0)))));
        when(port.put(org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.any(Duration.class)))
                .thenAnswer(invocation -> {
                    values.put(invocation.getArgument(0), invocation.getArgument(1));
                    return AsyncOperation.success(null);
                });

        AudioVideoCache.CacheKeyScope baseline = scopedKey("tenant-a", "principal-a", "rights-a",
                "transcription", "sensitive", "artifact-1", "artifact-rev-1", "transcript-rev-1");
        List<AudioVideoCache.CacheKeyScope> otherScopes = List.of(
                scopedKey("tenant-b", "principal-a", "rights-a", "transcription", "sensitive",
                        "artifact-1", "artifact-rev-1", "transcript-rev-1"),
                scopedKey("tenant-a", "principal-b", "rights-a", "transcription", "sensitive",
                        "artifact-1", "artifact-rev-1", "transcript-rev-1"),
                scopedKey("tenant-a", "principal-a", "rights-b", "transcription", "sensitive",
                        "artifact-1", "artifact-rev-1", "transcript-rev-1"),
                scopedKey("tenant-a", "principal-a", "rights-a", "translation", "sensitive",
                        "artifact-1", "artifact-rev-1", "transcript-rev-1"),
                scopedKey("tenant-a", "principal-a", "rights-a", "transcription", "restricted",
                        "artifact-1", "artifact-rev-1", "transcript-rev-1"),
                scopedKey("tenant-a", "principal-a", "rights-a", "transcription", "sensitive",
                        "artifact-2", "artifact-rev-1", "transcript-rev-1"),
                scopedKey("tenant-a", "principal-a", "rights-a", "transcription", "sensitive",
                        "artifact-1", "artifact-rev-2", "transcript-rev-1"),
                scopedKey("tenant-a", "principal-a", "rights-a", "transcription", "sensitive",
                        "artifact-1", "artifact-rev-1", "transcript-rev-2"));

        String fingerprint = "audio-sha256:" + "a".repeat(64);
        String baseKey = cache.buildScopedKey(withFingerprint(baseline, fingerprint));
        assertThat(AsyncOperationTestSupport.await(cache.getOrLoad(baseKey, ignored -> {
            loads.incrementAndGet();
            return AsyncOperation.success("baseline-transcript");
        }))).isEqualTo("baseline-transcript");

        for (AudioVideoCache.CacheKeyScope scope : otherScopes) {
            String key = cache.buildScopedKey(withFingerprint(scope, fingerprint));
            assertThat(key).matches("av2-[0-9a-f]{64}").isNotEqualTo(baseKey);
            assertThat(AsyncOperationTestSupport.await(cache.getOrLoad(key, ignored -> {
                loads.incrementAndGet();
                return AsyncOperation.success("isolated-transcript");
            }))).isEqualTo("isolated-transcript");
        }

        assertThat(loads).hasValue(1 + otherScopes.size());
    }

    @Test
    void changedSourceFingerprintDoesNotReuseProtectedCacheEntry() {
        DistributedCachePort<String, String> port = mock(DistributedCachePort.class);
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(port, "transcription");
        ConcurrentHashMap<String, String> values = new ConcurrentHashMap<>();
        AtomicInteger loads = new AtomicInteger();
        when(port.get(org.mockito.ArgumentMatchers.anyString())).thenAnswer(invocation ->
                AsyncOperation.success(Optional.ofNullable(values.get(invocation.getArgument(0)))));
        when(port.put(org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.any(Duration.class)))
                .thenAnswer(invocation -> {
                    values.put(invocation.getArgument(0), invocation.getArgument(1));
                    return AsyncOperation.success(null);
                });

        AudioVideoCache.CacheKeyScope scope = scopedKey("tenant", "principal", "rights",
                "transcription", "sensitive", "artifact", "artifact-rev", "transcript-rev");
        String firstKey = cache.buildScopedKey(withFingerprint(scope, "source-sha256:revision-one"));
        String changedSourceKey = cache.buildScopedKey(withFingerprint(scope, "source-sha256:revision-two"));

        assertThat(AsyncOperationTestSupport.await(cache.getOrLoad(firstKey, ignored -> {
            loads.incrementAndGet();
            return AsyncOperation.success("transcript-for-source-one");
        }))).isEqualTo("transcript-for-source-one");
        assertThat(AsyncOperationTestSupport.await(cache.getOrLoad(changedSourceKey, ignored -> {
            loads.incrementAndGet();
            return AsyncOperation.success("transcript-for-source-two");
        }))).isEqualTo("transcript-for-source-two");

        assertThat(changedSourceKey).isNotEqualTo(firstKey);
        assertThat(loads).hasValue(2);
    }

    @Test
    void protectedScopeRequiresAllDimensions() {
        assertThatThrownBy(() -> new AudioVideoCache.CacheKeyScope("tenant", "principal", "rights",
                "purpose", "classification", "artifact", "artifact-rev", "transcript-rev", " "))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sourceFingerprint");
    }

    @Test
    void protectedScopeRejectsComponentsBeyondSharedCacheKeyLimit() {
        assertThatThrownBy(() -> new AudioVideoCache.CacheKeyScope("tenant", "principal", "rights",
                "purpose", "classification", "artifact", "artifact-rev", "transcript-rev",
                "f".repeat(CachePolicy.MAX_KEY_LENGTH + 1)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sourceFingerprint")
                .hasMessageContaining(Integer.toString(CachePolicy.MAX_KEY_LENGTH));
    }

    @Test
    void oversizedStringKeysAreRejectedBeforeCacheIoOrLoaderInvocation() {
        DistributedCachePort<String, String> port = mock(DistributedCachePort.class);
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(port, "transcription");
        String oversizedKey = "k".repeat(CachePolicy.MAX_KEY_LENGTH + 1);
        AtomicInteger loaderCalls = new AtomicInteger();

        assertThatThrownBy(() -> cache.get(oversizedKey))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Cache key exceeds supported length");
        assertThatThrownBy(() -> cache.put(oversizedKey, "value"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> cache.put(oversizedKey, "value", Duration.ofMinutes(1)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> cache.getOrLoad(oversizedKey, ignored -> {
            loaderCalls.incrementAndGet();
            return AsyncOperation.success("value");
        })).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> cache.invalidate(oversizedKey))
                .isInstanceOf(IllegalArgumentException.class);

        assertThat(loaderCalls).hasValue(0);
        verifyNoInteractions(port);
    }

    private static AudioVideoCache.CacheKeyScope scopedKey(
            String tenant, String principal, String rights, String purpose, String classification,
            String artifact, String artifactRevision, String transcriptRevision) {
        return new AudioVideoCache.CacheKeyScope(tenant, principal, rights, purpose, classification,
                artifact, artifactRevision, transcriptRevision, "fingerprint-placeholder");
    }

    private static AudioVideoCache.CacheKeyScope withFingerprint(
            AudioVideoCache.CacheKeyScope scope, String fingerprint) {
        return new AudioVideoCache.CacheKeyScope(scope.tenantId(), scope.authenticatedPrincipalId(),
                scope.rightsScope(), scope.purpose(), scope.classification(), scope.artifactId(),
                scope.artifactRevision(), scope.transcriptRevision(), fingerprint);
    }

    @Test
    void backendFailureLogsNeverRenderRawKeyOrThrowableMessage() {
        String key = "media-cache:tenant-987-secret:transcript-654-private";
        String exceptionMarker = "backend failure for " + key + " secret-cache-material";
        IllegalStateException failure = new IllegalStateException(exceptionMarker);
        DistributedCachePort<String, String> port = mock(DistributedCachePort.class);
        when(port.get(key)).thenReturn(
                AsyncOperation.failure(failure), AsyncOperation.failure(failure));
        when(port.put(key, "value", Duration.ofMinutes(30)))
                .thenReturn(AsyncOperation.failure(failure));
        when(port.invalidateAll()).thenReturn(AsyncOperation.failure(failure));
        DistributedCacheService service = mock(DistributedCacheService.class);
        when(service.invalidateAsync(key)).thenReturn(AsyncOperation.failure(failure));

        String secretNamespace = "secret-marker-cache-namespace";
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(port, secretNamespace);
        AudioVideoCache<String, String> serviceCache =
                new AudioVideoCache<>(service, "transcription");
        try (LogCapture logs = capture(AudioVideoCache.class)) {
            assertOperationFails(() -> cache.get(key));
            assertThat(AsyncOperationTestSupport.await(cache.getOrLoad(key,
                    ignored -> AsyncOperation.success("source-value")))).isEqualTo("source-value");
            assertOperationFails(() -> cache.put(key, "value"));
            assertOperationFails(cache::invalidateAll);
            verify(port, never()).invalidateAll();
            assertOperationFails(() -> serviceCache.invalidate(key));

            String output = logs.output();
            // The failed write has an unresolved backend outcome, so the port-scope
            // invalidation is rejected locally and produces no backend error log.
            assertThat(logs.entries).hasSize(4);
            assertThat(output).contains("causeType=IllegalStateException", "keyRef="
                    + AudioVideoCache.keyReference(key), "namespaceRef="
                    + AudioVideoCache.keyReference(secretNamespace));
            assertThat(output).doesNotContain(key, exceptionMarker, "secret-cache-material", secretNamespace);
            assertThat(logs.entries).allSatisfy(entry ->
                    assertThat(entry).doesNotContain("java.lang.IllegalStateException:"));
        }
    }

    private static void assertOperationFails(
            java.util.function.Supplier<AsyncOperation<?>> operation) {
        assertThatThrownBy(() -> {
            AsyncOperation<?> result = operation.get();
            java.util.concurrent.CompletableFuture<Object> completion =
                    new java.util.concurrent.CompletableFuture<>();
            result.whenComplete((value, error) -> {
                if (error == null) completion.complete(value);
                else completion.completeExceptionally(error);
            });
            completion.join();
        }).hasRootCauseInstanceOf(IllegalStateException.class);
    }

    private static LogCapture capture(Class<?> loggerClass) {
        LoggerContext context = (LoggerContext) org.apache.logging.log4j.LogManager.getContext(false);
        org.apache.logging.log4j.core.Logger logger = context.getLogger(loggerClass.getName());
        LogCapture appender = new LogCapture("cache-redaction", logger, logger.getLevel());
        appender.start();
        logger.addAppender(appender);
        logger.setLevel(Level.DEBUG);
        return appender;
    }

    private static final class LogCapture extends AbstractAppender implements AutoCloseable {
        private final List<String> entries = new ArrayList<>();
        private final org.apache.logging.log4j.core.Logger logger;
        private final Level previousLevel;

        LogCapture(String name, org.apache.logging.log4j.core.Logger logger, Level previousLevel) {
            super(name, null, null, true, Property.EMPTY_ARRAY);
            this.logger = logger;
            this.previousLevel = previousLevel;
        }

        @Override public void append(LogEvent event) {
            StringBuilder entry = new StringBuilder(event.getMessage().getFormattedMessage());
            if (event.getThrown() != null) {
                StringWriter stack = new StringWriter();
                event.getThrown().printStackTrace(new PrintWriter(stack));
                entry.append(' ').append(stack);
            }
            entries.add(entry.toString());
        }

        String output() { return String.join("\n", entries); }

        @Override public void close() {
            logger.removeAppender(this);
            logger.setLevel(previousLevel);
            stop();
        }
    }
}
