package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.cache.DistributedCachePort;
import com.ghatana.cache.CachePolicy;
import com.ghatana.cache.CacheBulkInvalidationOutcome;
import com.ghatana.cache.DistributedCacheService;
import com.ghatana.cache.backend.CacheOperationResult;
import com.ghatana.core.async.AsyncOperation;
import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Property;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Duration;
import java.util.Optional;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiConsumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static com.ghatana.audio.video.infrastructure.cache.AsyncOperationTestSupport.await;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * @doc.type class
 * @doc.purpose Unit tests for AudioVideoCache wrapper semantics
 * @doc.layer test
 * @doc.pattern Test
 */
@ExtendWith(MockitoExtension.class)
@DisplayName("AudioVideoCache Tests")
class AudioVideoCacheTest {

    @Mock
    private DistributedCachePort<String, String> cachePort;

    @Test
    @DisplayName("buildKey emits a bounded Shared-compatible versioned key")
    void buildKeyEmitsSharedCompatibleVersionedKey() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");

        String key = cache.buildKey("tenant-1", "id-1");

        assertThat(key).matches("av2u-[0-9a-f]{64}");
        assertThat(key).doesNotContain(":", "*", "?");
    }

    @Test
    @DisplayName("get delegates to cache port")
    void getDelegatesToPort() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        when(cachePort.get("k1")).thenReturn(AsyncOperation.success(Optional.of("value")));

        Optional<String> value = await(cache.get("k1"));

        assertThat(value).contains("value");
        verify(cachePort).get("k1");
    }

    @Test
    @DisplayName("put with ttl delegates to cache port with ttl")
    void putWithTtlDelegatesToPort() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        Duration ttl = Duration.ofMinutes(5);
        when(cachePort.put("k1", "v1", ttl)).thenReturn(AsyncOperation.success(null));

        await(cache.put("k1", "v1", ttl));

        verify(cachePort).put("k1", "v1", ttl);
    }

    @Test
    @DisplayName("custom TTL is capped and non-positive TTL is rejected")
    void customTtlIsBounded() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        when(cachePort.put("k1", "v1", Duration.ofMinutes(30)))
                .thenReturn(AsyncOperation.success(null));

        await(cache.put("k1", "v1", Duration.ofDays(2)));

        verify(cachePort).put("k1", "v1", Duration.ofMinutes(30));
        org.assertj.core.api.Assertions.assertThatThrownBy(
                () -> cache.put("k1", "v1", Duration.ZERO))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void scopedCacheHitRechecksAuthorityBeforeDisclosureAndInvalidatesOnRevocation() {
        DistributedCacheService port = mock(DistributedCacheService.class);
        var cache = new AudioVideoCache<String, String>(port, "protected-transcripts");
        var scope = new AudioVideoCache.CacheKeyScope("tenant-a", "principal-a", "rights-7",
                "transcription", "CONFIDENTIAL", "artifact-a", "artifact-v4", "transcript-v9",
                "sha256-source-9", "policy-epoch-12");
        String key = cache.buildScopedKey(scope, "transcript-a");
        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.of("protected payload")));
        when(port.invalidateAsync(key)).thenReturn(AsyncOperation.success(null));
        AtomicInteger checks = new AtomicInteger();

        assertThatThrownBy(() -> await(cache.getOrLoadScopedWithAuthority(scope, "transcript-a",
                checked -> AsyncOperation.success(checks.incrementAndGet() == 1
                        ? AudioVideoCache.ScopedAuthorityResult.current(checked)
                        : AudioVideoCache.ScopedAuthorityResult.rejected(checked)),
                ignored -> { throw new AssertionError("cache hit should not call source"); })))
                .hasRootCauseInstanceOf(SecurityException.class)
                .hasRootCauseMessage("Current cache authority changed or became unavailable before disclosure");

        assertThat(checks).hasValue(2);
        verify(port).get(key);
        verify(port).invalidateAsync(key);
    }

    @Test
    void genericRawOperationsCannotReadOrWriteProtectedOrLegacyScopedKeys() {
        DistributedCacheService port = mock(DistributedCacheService.class);
        var cache = new AudioVideoCache<String, String>(port, "protected-transcripts");
        var scope = new AudioVideoCache.CacheKeyScope("tenant-a", "principal-a", "rights-7",
                "transcription", "CONFIDENTIAL", "artifact-a", "artifact-v4", "transcript-v9",
                "sha256-source-9", "policy-epoch-12");
        String protectedKey = cache.buildScopedKey(scope, "transcript-a");
        String legacySharedKey = "av2-" + "0".repeat(64);
        String rawKey = cache.buildKey("tenant-a", "unprotected-fixture");
        when(port.get(rawKey)).thenReturn(AsyncOperation.success(Optional.of("raw-value")));

        assertThat(protectedKey).startsWith("av2p-");
        assertThat(rawKey).startsWith("av2u-");
        assertThatThrownBy(() -> cache.get(protectedKey))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("scoped authority");
        assertThatThrownBy(() -> cache.getOrLoad(protectedKey,
                ignored -> AsyncOperation.success("must-not-load")))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("scoped authority");
        assertThatThrownBy(() -> cache.put(protectedKey, "must-not-write"))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("scoped authority");
        assertThatThrownBy(() -> cache.get(legacySharedKey))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("scoped authority");
        assertThatThrownBy(() -> cache.getOrLoad(legacySharedKey,
                ignored -> AsyncOperation.success("must-not-load")))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("scoped authority");

        assertThat(await(cache.get(rawKey))).contains("raw-value");
        verify(port).get(rawKey);
        verify(port, org.mockito.Mockito.never()).get(protectedKey);
        verify(port, org.mockito.Mockito.never()).get(legacySharedKey);
        verify(port, org.mockito.Mockito.never()).put(eq(protectedKey), any(), any(Duration.class));
    }

    @Test
    void initiallyDeniedScopedAuthorityEvictsExactKeyWithoutReadingOrLoading() {
        DistributedCacheService port = mock(DistributedCacheService.class);
        var cache = new AudioVideoCache<String, String>(port, "protected-transcripts");
        var scope = new AudioVideoCache.CacheKeyScope("tenant-a", "principal-a", "rights-7",
                "transcription", "CONFIDENTIAL", "artifact-a", "artifact-v4", "transcript-v9",
                "sha256-source-9", "policy-epoch-revoked");
        String key = cache.buildScopedKey(scope, "transcript-a");
        when(port.invalidateAsync(key)).thenReturn(AsyncOperation.success(null));

        assertThatThrownBy(() -> await(cache.getOrLoadScopedWithAuthority(scope, "transcript-a",
                checked -> AsyncOperation.success(AudioVideoCache.ScopedAuthorityResult.rejected(checked)),
                ignored -> { throw new AssertionError("denied authority must not load source"); })))
                .hasRootCauseInstanceOf(SecurityException.class)
                .hasRootCauseMessage("Current cache authority is denied or unknown");

        verify(port).invalidateAsync(key);
        verify(port, org.mockito.Mockito.never()).get(key);
    }

    @Test
    void scopedSourceLoadIsNotReturnedWhenAuthorityBecomesUnavailableBeforeDisclosure() {
        DistributedCacheService port = mock(DistributedCacheService.class);
        var cache = new AudioVideoCache<String, String>(port, "protected-transcripts");
        var scope = new AudioVideoCache.CacheKeyScope("tenant-a", "principal-a", "rights-7",
                "transcription", "CONFIDENTIAL", "artifact-a", "artifact-v4", "transcript-v9",
                "sha256-source-9", "policy-epoch-12");
        String key = cache.buildScopedKey(scope, "transcript-a");
        when(port.get(key)).thenReturn(AsyncOperation.success(Optional.empty()));
        when(port.put(eq(key), eq("protected payload"), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));
        when(port.invalidateAsync(key)).thenReturn(AsyncOperation.success(null));
        AtomicInteger checks = new AtomicInteger();

        assertThatThrownBy(() -> await(cache.getOrLoadScopedWithAuthority(scope, "transcript-a", checked -> {
            if (checks.incrementAndGet() == 1) {
                return AsyncOperation.success(AudioVideoCache.ScopedAuthorityResult.current(checked));
            }
            return AsyncOperation.failure(new IllegalStateException("rights authority unavailable"));
        }, ignored -> AsyncOperation.success("protected payload"))))
                .hasRootCauseInstanceOf(SecurityException.class)
                .hasRootCauseMessage("Current cache authority changed or became unavailable before disclosure");

        assertThat(checks).hasValue(2);
        verify(port).put(eq(key), eq("protected payload"), any(Duration.class));
        verify(port).invalidateAsync(key);
    }

    @Test
    void legacyBooleanScopedLookupInvalidatesExactKeyWithoutCacheReadOrLoader() {
        DistributedCacheService port = mock(DistributedCacheService.class);
        var cache = new AudioVideoCache<String, String>(port, "protected-transcripts");
        var scope = new AudioVideoCache.CacheKeyScope("tenant-a", "principal-a", "rights-7",
                "transcription", "CONFIDENTIAL", "artifact-a", "artifact-v4", "transcript-v9",
                "sha256-source-9", "policy-epoch-12");
        String key = cache.buildScopedKey(scope, "transcript-a");
        when(port.invalidateAsync(key)).thenReturn(AsyncOperation.success(null));

        assertThatThrownBy(() -> await(cache.getOrLoadScoped(scope, "transcript-a",
                ignored -> AsyncOperation.success(true),
                ignored -> { throw new AssertionError("legacy Boolean must not invoke loader"); })))
                .hasRootCauseInstanceOf(SecurityException.class)
                .hasRootCauseMessage("Boolean cache authority is unavailable; exact scoped readback is required");

        verify(port, org.mockito.Mockito.never()).get(key);
        verify(port, org.mockito.Mockito.never()).put(eq(key), any(), any(Duration.class));
        verify(port).invalidateAsync(key);
    }

    @Test
    @DisplayName("string cache entries obey Shared value bounds")
    void stringCacheEntriesObeySharedValueBounds() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        String oversized = "x".repeat(CachePolicy.MAX_VALUE_LENGTH + 1);
        when(cachePort.get("oversized-hit")).thenReturn(AsyncOperation.success(Optional.of(oversized)));
        when(cachePort.get("oversized-source")).thenReturn(AsyncOperation.success(Optional.empty()));

        assertThat(await(cache.get("oversized-hit"))).isEmpty();
        assertThat(await(cache.getOrLoad("oversized-source", ignored -> AsyncOperation.success(oversized)))
                ).isEqualTo(oversized);
        assertThatThrownBy(() -> cache.put("oversized-put", oversized))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("value length exceeds");

        verify(cachePort, org.mockito.Mockito.never())
                .put(eq("oversized-source"), eq(oversized), any(Duration.class));
        verify(cachePort, org.mockito.Mockito.never())
                .put(eq("oversized-put"), eq(oversized), any(Duration.class));
    }

    @Test
    @DisplayName("binary cache values are bounded by payload bytes")
    void binaryCacheValuesObeyPayloadByteBound() {
        @SuppressWarnings("unchecked")
        DistributedCachePort<String, byte[]> binaryPort = mock(DistributedCachePort.class);
        AudioVideoCache<String, byte[]> cache = new AudioVideoCache<>(binaryPort, "binary-fixture");
        byte[] oversized = new byte[CachePolicy.MAX_VALUE_LENGTH + 1];
        when(binaryPort.get("oversized-binary-hit"))
                .thenReturn(AsyncOperation.success(Optional.of(oversized)));
        when(binaryPort.get("oversized-binary-source"))
                .thenReturn(AsyncOperation.success(Optional.empty()));

        assertThat(await(cache.get("oversized-binary-hit"))).isEmpty();
        assertThat(await(cache.getOrLoad("oversized-binary-source", ignored ->
                AsyncOperation.success(oversized)))).isSameAs(oversized);
        assertThatThrownBy(() -> cache.put("oversized-binary-put", oversized))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Cache value length exceeds");

        verify(binaryPort, org.mockito.Mockito.never())
                .put(eq("oversized-binary-source"), eq(oversized), any(Duration.class));
        verify(binaryPort, org.mockito.Mockito.never())
                .put(eq("oversized-binary-put"), eq(oversized), any(Duration.class));
    }

    @Test
    @DisplayName("oversized cached entries are evicted when the adapter supports key invalidation")
    void oversizedCachedEntriesAreQuarantinedWhenSupported() {
        DistributedCacheService service = mock(DistributedCacheService.class);
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(service, "transcription");
        String oversized = "x".repeat(CachePolicy.MAX_VALUE_LENGTH + 1);
        when(service.get("bad-direct")).thenReturn(AsyncOperation.success(Optional.of(oversized)));
        when(service.get("bad-read-through")).thenReturn(AsyncOperation.success(Optional.of(oversized)));
        when(service.invalidateAsync("bad-direct")).thenReturn(AsyncOperation.success(null));
        when(service.invalidateAsync("bad-read-through")).thenReturn(AsyncOperation.success(null));

        assertThat(await(cache.get("bad-direct"))).isEmpty();
        assertThat(await(cache.getOrLoad("bad-read-through",
                ignored -> AsyncOperation.success("current-source-value"))))
                .isEqualTo("current-source-value");

        verify(service).invalidateAsync("bad-direct");
        verify(service).invalidateAsync("bad-read-through");
        verify(service, org.mockito.Mockito.never())
                .put(eq("bad-read-through"), anyString(), any(Duration.class));
    }

    @Test
    @DisplayName("quarantine fences writes until the rejected entry invalidation settles")
    void oversizedEntryQuarantineFencesConcurrentWrites() {
        DistributedCacheService service = mock(DistributedCacheService.class);
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(service, "transcription");
        String oversized = "x".repeat(CachePolicy.MAX_VALUE_LENGTH + 1);
        CompletableFuture<Void> pendingInvalidation = new CompletableFuture<>();
        when(service.get("quarantine-race"))
                .thenReturn(AsyncOperation.success(Optional.of(oversized)));
        when(service.invalidateAsync("quarantine-race"))
                .thenReturn(AsyncOperation.from(pendingInvalidation));
        when(service.put(eq("quarantine-race"), eq("valid-new-value"), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));

        assertThat(await(cache.get("quarantine-race"))).isEmpty();
        assertThatThrownBy(() -> await(cache.put("quarantine-race", "valid-new-value")))
                .hasRootCauseMessage("Cache write is already pending or coordination capacity is full");

        pendingInvalidation.complete(null);
        await(cache.put("quarantine-race", "valid-new-value"));
        verify(service).invalidateAsync("quarantine-race");
        verify(service).put(eq("quarantine-race"), eq("valid-new-value"), any(Duration.class));
    }

    @Test
    @DisplayName("stale oversized read cannot quarantine a valid write that overtook it")
    void oversizedReadDoesNotDeleteWriteThatOvertakesItsQuarantine() {
        DistributedCacheService service = mock(DistributedCacheService.class);
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(service, "transcription");
        String key = "oversized-overtaken";
        String oversized = "x".repeat(CachePolicy.MAX_VALUE_LENGTH + 1);
        java.util.concurrent.atomic.AtomicReference<String> stored =
                new java.util.concurrent.atomic.AtomicReference<>(oversized);
        java.util.concurrent.atomic.AtomicBoolean racedWrite = new java.util.concurrent.atomic.AtomicBoolean();
        java.util.concurrent.atomic.AtomicReference<Throwable> appenderFailure =
                new java.util.concurrent.atomic.AtomicReference<>();
        when(service.get(key)).thenAnswer(ignored ->
                AsyncOperation.success(Optional.ofNullable(stored.get())));
        when(service.put(eq(key), eq("valid-new-value"), any(Duration.class))).thenAnswer(invocation -> {
            stored.set(invocation.getArgument(1));
            return AsyncOperation.success(null);
        });
        org.mockito.Mockito.lenient().when(service.invalidateAsync(key)).thenAnswer(ignored -> {
            stored.set(null);
            return AsyncOperation.success(null);
        });

        LoggerContext context = (LoggerContext) org.apache.logging.log4j.LogManager.getContext(false);
        org.apache.logging.log4j.core.Logger logger = context.getLogger(AudioVideoCache.class.getName());
        Level previousLevel = logger.getLevel();
        AbstractAppender raceAppender = new AbstractAppender(
                "oversized-quarantine-race", null, null, true, Property.EMPTY_ARRAY) {
            @Override
            public void append(LogEvent event) {
                if (event.getMessage().getFormattedMessage().startsWith(
                        "Cache entry exceeded Shared value limit; treating as miss")
                        && racedWrite.compareAndSet(false, true)) {
                    try {
                        await(cache.put(key, "valid-new-value"));
                    } catch (Throwable failure) {
                        appenderFailure.set(failure);
                    }
                }
            }
        };
        raceAppender.start();
        logger.addAppender(raceAppender);
        logger.setLevel(Level.WARN);
        try {
            assertThat(await(cache.get(key))).isEmpty();
        } finally {
            logger.removeAppender(raceAppender);
            logger.setLevel(previousLevel);
            raceAppender.stop();
        }

        assertThat(racedWrite).isTrue();
        assertThat(appenderFailure.get()).isNull();
        assertThat(stored).hasValue("valid-new-value");
        verify(service, org.mockito.Mockito.never()).invalidateAsync(key);
    }

    @Test
    @DisplayName("getOrLoad delegates loader function")
    void getOrLoadDelegates() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        when(cachePort.get("k1")).thenReturn(AsyncOperation.success(Optional.empty()));
        when(cachePort.put(eq("k1"), eq("loaded"), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));

        String value = await(cache.getOrLoad("k1", k -> AsyncOperation.success("loaded")));

        assertThat(value).isEqualTo("loaded");
        verify(cachePort).get("k1");
        verify(cachePort).put(eq("k1"), eq("loaded"), any(Duration.class));
    }

    @Test
    @DisplayName("read-through uses the documented 30-minute default TTL")
    void readThroughUsesDocumentedDefaultTtl() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "audio-video");
        when(cachePort.get("source-backed-key"))
                .thenReturn(AsyncOperation.success(Optional.empty()));
        when(cachePort.put("source-backed-key", "source-value", Duration.ofMinutes(30)))
                .thenReturn(AsyncOperation.success(null));

        String result = await(cache.getOrLoad(
                "source-backed-key", ignored -> AsyncOperation.success("source-value")));

        assertThat(result).isEqualTo("source-value");
        verify(cachePort).put("source-backed-key", "source-value", Duration.ofMinutes(30));
    }

    @Test
    @DisplayName("same-key concurrent misses share one source load")
    void concurrentMissesShareOneLoad() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        CompletableFuture<String> source = new CompletableFuture<>();
        AtomicInteger loads = new AtomicInteger();
        when(cachePort.get("k1")).thenReturn(AsyncOperation.success(Optional.empty()));
        when(cachePort.put(eq("k1"), eq("loaded"), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));

        List<AsyncOperation<String>> requests = new ArrayList<>();
        for (int index = 0; index < 64; index++) {
            requests.add(cache.getOrLoad("k1", ignored -> {
                loads.incrementAndGet();
                return AsyncOperation.from(source);
            }));
        }

        assertThat(loads).hasValue(1);
        source.complete("loaded");
        for (AsyncOperation<String> request : requests) assertThat(await(request)).isEqualTo("loaded");
        verify(cachePort, times(1)).get("k1");
        verify(cachePort, times(1)).put(eq("k1"), eq("loaded"), any(Duration.class));
    }

    @Test
    @DisplayName("64 simultaneous same-key contenders share one cache read and source load")
    void simultaneousContendersShareOneLoad() throws Exception {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        CompletableFuture<Optional<String>> cacheRead = new CompletableFuture<>();
        CompletableFuture<String> source = new CompletableFuture<>();
        AtomicInteger loads = new AtomicInteger();
        when(cachePort.get("same-key")).thenReturn(AsyncOperation.from(cacheRead));
        when(cachePort.put(eq("same-key"), eq("loaded-once"), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));

        ExecutorService workers = Executors.newFixedThreadPool(64);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<AsyncOperation<String>>> submitted = new ArrayList<>();
        try {
            for (int index = 0; index < 64; index++) {
                submitted.add(workers.submit(() -> {
                    start.await();
                    return cache.getOrLoad("same-key", ignored -> {
                        loads.incrementAndGet();
                        return AsyncOperation.from(source);
                    });
                }));
            }
            start.countDown();

            List<AsyncOperation<String>> requests = new ArrayList<>();
            for (Future<AsyncOperation<String>> contender : submitted) {
                requests.add(contender.get(10, TimeUnit.SECONDS));
            }
            verify(cachePort, times(1)).get("same-key");
            assertThat(loads).hasValue(0);

            cacheRead.complete(Optional.empty());
            assertThat(loads).hasValue(1);
            source.complete("loaded-once");
            for (AsyncOperation<String> request : requests) {
                assertThat(await(request)).isEqualTo("loaded-once");
            }
            verify(cachePort, times(1)).put(eq("same-key"), eq("loaded-once"), any(Duration.class));
        } finally {
            workers.shutdownNow();
        }
    }

    @Test
    @DisplayName("distinct-key contention caps source concurrency and rejects overflow")
    void distinctKeyContentionRespectsInFlightCap() throws Exception {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        int requestCount = 1_200;
        int capacity = 1_024;
        ConcurrentHashMap<String, CompletableFuture<Optional<String>>> cacheReads =
                new ConcurrentHashMap<>();
        AtomicInteger sourceLoads = new AtomicInteger();
        when(cachePort.get(anyString())).thenAnswer(invocation -> {
            String key = invocation.getArgument(0);
            return AsyncOperation.from(cacheReads.computeIfAbsent(key, ignored -> new CompletableFuture<>()));
        });
        when(cachePort.put(anyString(), anyString(), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));

        ExecutorService workers = Executors.newFixedThreadPool(64);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<AsyncOperation<String>>> submitted = new ArrayList<>();
        try {
            for (int index = 0; index < requestCount; index++) {
                String key = "key-" + index;
                submitted.add(workers.submit(() -> {
                    start.await();
                    return cache.getOrLoad(key, ignored -> {
                        sourceLoads.incrementAndGet();
                        return AsyncOperation.success("source-" + key);
                    });
                }));
            }
            start.countDown();

            List<AsyncOperation<String>> requests = new ArrayList<>();
            for (Future<AsyncOperation<String>> future : submitted) {
                requests.add(future.get(10, TimeUnit.SECONDS));
            }

            assertThat(cacheReads).hasSize(capacity);
            assertThat(sourceLoads).hasValue(0);
            cacheReads.values().forEach(read -> read.complete(Optional.empty()));
            for (int index = 0; index < requestCount; index++) {
                String key = "key-" + index;
                AsyncOperation<String> request = requests.get(index);
                if (cacheReads.containsKey(key)) {
                    assertThat(await(request)).isEqualTo("source-" + key);
                } else {
                    assertThatThrownBy(() -> await(request))
                            .hasRootCauseInstanceOf(IllegalStateException.class)
                            .hasRootCauseMessage("Cache load coordination capacity reached");
                }
            }
            assertThat(sourceLoads).hasValue(capacity);
        } finally {
            workers.shutdownNow();
        }
    }

    @Test
    @DisplayName("cache read and write failures return the source value")
    void cacheFailuresDoNotReplaceSourceResult() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        when(cachePort.get("read-fails")).thenReturn(AsyncOperation.failure(
                new IllegalStateException("cache unavailable")));
        when(cachePort.get("write-fails")).thenReturn(AsyncOperation.success(Optional.empty()));
        when(cachePort.put(eq("write-fails"), eq("source-value"), any(Duration.class)))
                .thenReturn(AsyncOperation.failure(new IllegalStateException("cache unavailable")));

        assertThat(await(cache.getOrLoad("read-fails", ignored -> AsyncOperation.success("source-value")))
                ).isEqualTo("source-value");
        assertThat(await(cache.getOrLoad("write-fails", ignored -> AsyncOperation.success("source-value")))
                ).isEqualTo("source-value");
    }

    @Test
    @DisplayName("synchronous cache dispatch failure falls back to the source without caching")
    void synchronousCacheReadDispatchFailureFallsBackToSource() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        when(cachePort.get("sync-read-fails")).thenThrow(new IllegalStateException("cache dispatch failed"));
        AtomicInteger sourceLoads = new AtomicInteger();

        String result = await(cache.getOrLoad("sync-read-fails", ignored -> {
            sourceLoads.incrementAndGet();
            return AsyncOperation.success("authoritative-source-value");
        }));

        assertThat(result).isEqualTo("authoritative-source-value");
        assertThat(sourceLoads).hasValue(1);
        verify(cachePort, times(0)).put(anyString(), anyString(), any(Duration.class));
    }

    @Test
    @DisplayName("pending cache write keeps same-key calls coalesced until timeout releases reservation")
    void pendingCacheWriteKeepsSameKeyCoalescedUntilTimeoutThenReleasesReservation() throws Exception {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(
                cachePort, "transcription", Duration.ofSeconds(2));
        CompletableFuture<Void> pendingWrite = new CompletableFuture<>();
        AtomicInteger loads = new AtomicInteger();
        when(cachePort.get("write-pends")).thenReturn(AsyncOperation.success(Optional.empty()));
        when(cachePort.put(eq("write-pends"), eq("source-value"), any(Duration.class)))
                .thenReturn(AsyncOperation.from(pendingWrite), AsyncOperation.success(null));

        AsyncOperation<String> first = cache.getOrLoad("write-pends", ignored -> {
            loads.incrementAndGet();
            return AsyncOperation.success("source-value");
        });
        CompletableFuture<String> firstResult = new CompletableFuture<>();
        first.whenComplete((value, error) -> {
            if (error == null) firstResult.complete(value);
            else firstResult.completeExceptionally(error);
        });
        assertThat(firstResult.get(500, TimeUnit.MILLISECONDS)).isEqualTo("source-value");
        assertThat(pendingWrite).isNotCompleted();

        AsyncOperation<String> duringWrite = cache.getOrLoad("write-pends", ignored -> {
            loads.incrementAndGet();
            return AsyncOperation.success("unexpected-duplicate-load");
        });
        assertThat(await(duringWrite)).isEqualTo("source-value");
        assertThat(loads).hasValue(1);

        CompletableFuture<String> recoveredValue = new CompletableFuture<>();
        CompletableFuture.delayedExecutor(2_100, TimeUnit.MILLISECONDS).execute(() ->
                cache.getOrLoad("write-pends", ignored -> {
                    loads.incrementAndGet();
                    return AsyncOperation.success("source-after-timeout");
                }).whenComplete((value, error) -> {
                    if (error == null) recoveredValue.complete(value);
                    else recoveredValue.completeExceptionally(error);
                }));
        assertThat(recoveredValue.get(3, TimeUnit.SECONDS)).isEqualTo("source-after-timeout");
        assertThat(loads).hasValue(2);
        verify(cachePort).put(eq("write-pends"), eq("source-value"), any(Duration.class));
        assertThat(pendingWrite).isNotCompleted();
    }

    @Test
    @DisplayName("cache write is dispatched and observed before caller completion")
    @SuppressWarnings("unchecked")
    void dispatchesAndObservesCacheWriteBeforeCallerCompletion() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        CompletableFuture<Void> pendingWrite = new CompletableFuture<>();
        AtomicBoolean putDispatched = new AtomicBoolean();
        AtomicBoolean writeCompletionRegistered = new AtomicBoolean();
        AtomicBoolean callerSawWriteRegistration = new AtomicBoolean();
        when(cachePort.get("ordered-write")).thenReturn(AsyncOperation.success(Optional.empty()));
        AsyncOperation<Void> trackedWrite = mock(AsyncOperation.class);
        when(cachePort.put(eq("ordered-write"), eq("source-value"), any(Duration.class)))
                .thenAnswer(invocation -> {
                    putDispatched.set(true);
                    return trackedWrite;
                });
        when(trackedWrite.whenComplete(any())).thenAnswer(invocation -> {
            BiConsumer<Void, Throwable> callback = invocation.getArgument(0);
            pendingWrite.whenComplete(callback);
            writeCompletionRegistered.set(true);
            return trackedWrite;
        });

        cache.getOrLoad("ordered-write", ignored -> AsyncOperation.success("source-value"))
                .whenComplete((value, error) -> callerSawWriteRegistration.set(
                        putDispatched.get() && writeCompletionRegistered.get()));

        assertThat(putDispatched).isTrue();
        assertThat(writeCompletionRegistered).isTrue();
        assertThat(callerSawWriteRegistration).isTrue();
    }

    @Test
    @DisplayName("uncertain late write fences reads, newer writes and invalidation until it settles")
    void uncertainLateWriteFencesSameKeyUntilActualCompletion() throws Exception {
        DistributedCacheService service = mock(DistributedCacheService.class);
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(
                service, "transcription", Duration.ofMillis(25));
        CompletableFuture<Void> lateWrite = new CompletableFuture<>();
        java.util.concurrent.ConcurrentHashMap<String, String> values = new java.util.concurrent.ConcurrentHashMap<>();
        AtomicInteger sourceLoads = new AtomicInteger();
        AtomicInteger cacheWrites = new AtomicInteger();
        AtomicInteger cacheReads = new AtomicInteger();
        when(service.get("uncertain-write")).thenAnswer(invocation -> {
            cacheReads.incrementAndGet();
            return AsyncOperation.success(Optional.ofNullable(values.get("uncertain-write")));
        });
        when(service.put(eq("uncertain-write"), anyString(), any(Duration.class)))
                .thenAnswer(invocation -> {
                    String value = invocation.getArgument(1);
                    cacheWrites.incrementAndGet();
                    lateWrite.whenComplete((ignored, error) -> {
                        if (error == null) values.put("uncertain-write", value);
                    });
                    return AsyncOperation.from(lateWrite);
                });

        assertThat(await(cache.getOrLoad("uncertain-write", ignored -> {
            sourceLoads.incrementAndGet();
            return AsyncOperation.success("original-value");
        }))).isEqualTo("original-value");
        CompletableFuture<Void> timeoutElapsed = new CompletableFuture<>();
        CompletableFuture.delayedExecutor(100, TimeUnit.MILLISECONDS)
                .execute(() -> timeoutElapsed.complete(null));
        timeoutElapsed.get(1, TimeUnit.SECONDS);

        assertThat(await(cache.get("uncertain-write"))).isEmpty();
        assertThat(await(cache.getOrLoad("uncertain-write", ignored -> {
            sourceLoads.incrementAndGet();
            return AsyncOperation.success("fresh-source-value");
        }))).isEqualTo("fresh-source-value");
        assertThatThrownBy(() -> await(cache.put("uncertain-write", "new-cache-value")))
                .hasRootCauseInstanceOf(IllegalStateException.class)
                .hasRootCauseMessage("Cache write is already pending or coordination capacity is full");
        assertThatThrownBy(() -> await(cache.invalidate("uncertain-write")))
                .hasRootCauseInstanceOf(IllegalStateException.class)
                .hasRootCauseMessage("Cache key has an active mutation or coordination capacity is full");
        assertThat(cacheReads).hasValue(1);
        assertThat(cacheWrites).hasValue(1);
        assertThat(sourceLoads).hasValue(2);

        lateWrite.complete(null);
        assertThat(values).containsEntry("uncertain-write", "original-value");
        await(cache.put("uncertain-write", "after-settlement"));
        assertThat(cacheWrites).hasValue(2);
    }

    @Test
    @DisplayName("pending cache read falls back once and ignores a late cache hit")
    void pendingCacheReadTimesOutToSourceAndIgnoresLateCompletion() throws Exception {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(
                cachePort, "transcription", Duration.ofMillis(100));
        CompletableFuture<Optional<String>> pendingRead = new CompletableFuture<>();
        CompletableFuture<String> sourceValue = new CompletableFuture<>();
        java.util.concurrent.CountDownLatch sourceStarted = new java.util.concurrent.CountDownLatch(1);
        AtomicInteger loads = new AtomicInteger();
        when(cachePort.get("read-pends")).thenReturn(AsyncOperation.from(pendingRead));

        AsyncOperation<String> first = cache.getOrLoad("read-pends", ignored -> {
            loads.incrementAndGet();
            sourceStarted.countDown();
            return AsyncOperation.from(sourceValue);
        });
        assertThat(sourceStarted.await(1, TimeUnit.SECONDS)).isTrue();

        AsyncOperation<String> duringSourceLoad = cache.getOrLoad("read-pends", ignored -> {
            loads.incrementAndGet();
            return AsyncOperation.success("duplicate-source-value");
        });
        sourceValue.complete("source-value");
        assertThat(await(first)).isEqualTo("source-value");
        assertThat(await(duringSourceLoad)).isEqualTo("source-value");
        assertThat(loads).hasValue(1);

        pendingRead.complete(Optional.of("late-cache-value"));
        assertThat(await(first)).isEqualTo("source-value");
        assertThat(loads).hasValue(1);
        verify(cachePort, times(0)).put(anyString(), anyString(), any(Duration.class));
    }

    @Test
    @DisplayName("source errors remain visible when a cache read times out")
    void sourceLoaderFailureRemainsVisibleAfterCacheReadTimeout() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(
                cachePort, "transcription", Duration.ofMillis(20));
        CompletableFuture<Optional<String>> pendingRead = new CompletableFuture<>();
        when(cachePort.get("read-and-source-fail")).thenReturn(AsyncOperation.from(pendingRead));

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> await(cache.getOrLoad(
                "read-and-source-fail", ignored -> AsyncOperation.failure(
                        new IllegalStateException("source unavailable")))))
                .hasRootCauseInstanceOf(IllegalStateException.class)
                .hasRootCauseMessage("source unavailable");

        verify(cachePort, times(0)).put(anyString(), anyString(), any(Duration.class));
    }

    @Test
    @DisplayName("direct cache get and put have bounded caller outcomes")
    void directCacheOperationsTimeOutWithoutReleasingPendingWriteMarker() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(
                cachePort, "transcription", Duration.ofMillis(20));
        CompletableFuture<Optional<String>> pendingRead = new CompletableFuture<>();
        CompletableFuture<Void> pendingWrite = new CompletableFuture<>();
        when(cachePort.get("public-read-pends")).thenReturn(AsyncOperation.from(pendingRead));
        when(cachePort.put(eq("public-write-pends"), eq("value"), any(Duration.class)))
                .thenReturn(AsyncOperation.from(pendingWrite));

        assertThatThrownBy(() -> await(cache.get("public-read-pends")))
                .hasRootCauseInstanceOf(java.util.concurrent.TimeoutException.class);
        pendingRead.complete(Optional.of("late-read"));

        assertThatThrownBy(() -> await(cache.put("public-write-pends", "value")))
                .hasRootCauseInstanceOf(java.util.concurrent.TimeoutException.class);
        assertThat(await(cache.get("public-write-pends"))).isEmpty();
        verify(cachePort, times(0)).get("public-write-pends");

        pendingWrite.complete(null);
    }

    @Test
    @DisplayName("pending write markers cap memory and recover when writes settle")
    void pendingWriteMarkerCapacityIsBoundedAndReleasedOnCompletion() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        CompletableFuture<Void> pendingWrite = new CompletableFuture<>();
        when(cachePort.put(anyString(), anyString(), any(Duration.class)))
                .thenReturn(AsyncOperation.from(pendingWrite));
        List<AsyncOperation<Void>> writes = new ArrayList<>();
        for (int index = 0; index < 1_024; index++) {
            writes.add(cache.put("pending-" + index, "value"));
        }

        assertThatThrownBy(() -> await(cache.put("overflow", "value")))
                .hasRootCauseInstanceOf(IllegalStateException.class)
                .hasRootCauseMessage("Cache write is already pending or coordination capacity is full");

        pendingWrite.complete(null);
        for (AsyncOperation<Void> write : writes) await(write);
        await(cache.put("after-settlement", "value"));
    }

    @Test
    @DisplayName("unknown synchronous cache write outcome remains fenced")
    void synchronousWriteFailureRetainsFenceAndReturnsFailure() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        when(cachePort.put(eq("write-throws"), eq("value"), any(Duration.class)))
                .thenThrow(new IllegalStateException("cache dispatch failed"));

        assertThatThrownBy(() -> await(cache.put("write-throws", "value")))
                .hasRootCauseInstanceOf(IllegalStateException.class)
                .hasRootCauseMessage("cache dispatch failed");
        assertThat(await(cache.get("write-throws"))).isEmpty();
        assertThat(await(cache.getOrLoad("write-throws", ignored -> AsyncOperation.success("source-value"))))
                .isEqualTo("source-value");
        verify(cachePort, times(0)).get("write-throws");
    }

    @Test
    @DisplayName("null cache operations fail closed or fall back to source without leaking uncertain writes")
    void nullCacheOperationsAreHandledSafely() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        when(cachePort.get("null-get")).thenReturn(null);
        when(cachePort.get("null-read-through")).thenReturn(null);
        when(cachePort.put(eq("null-write"), eq("value"), any(Duration.class))).thenReturn(null);

        assertThatThrownBy(() -> await(cache.get("null-get")))
                .hasRootCauseInstanceOf(NullPointerException.class);
        assertThat(await(cache.getOrLoad("null-read-through",
                ignored -> AsyncOperation.success("source-value"))))
                .isEqualTo("source-value");
        assertThatThrownBy(() -> await(cache.put("null-write", "value")))
                .hasRootCauseInstanceOf(NullPointerException.class);
        assertThat(await(cache.get("null-write"))).isEmpty();
        verify(cachePort, times(0)).get("null-write");
    }

    @Test
    @DisplayName("cache epochs downgrade reads and source loads that overlap a write")
    void cacheEpochFencesPendingReadAndStaleSourceRecache() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        CompletableFuture<Optional<String>> directRead = new CompletableFuture<>();
        CompletableFuture<Optional<String>> readThrough = new CompletableFuture<>();
        when(cachePort.get("direct-epoch")).thenReturn(AsyncOperation.from(directRead));
        when(cachePort.get("read-through-epoch")).thenReturn(AsyncOperation.from(readThrough));
        when(cachePort.put(eq("direct-epoch"), eq("new-value"), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));
        when(cachePort.put(eq("read-through-epoch"), eq("write-during-read"), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));
        AtomicInteger loads = new AtomicInteger();

        AsyncOperation<Optional<String>> direct = cache.get("direct-epoch");
        await(cache.put("direct-epoch", "new-value"));
        directRead.complete(Optional.of("pre-write-stale"));
        assertThat(await(direct)).isEmpty();

        AsyncOperation<String> readThroughResult = cache.getOrLoad("read-through-epoch", ignored -> {
            loads.incrementAndGet();
            return AsyncOperation.success("current-source-value");
        });
        await(cache.put("read-through-epoch", "write-during-read"));
        readThrough.complete(Optional.of("pre-write-stale"));
        assertThat(await(readThroughResult)).isEqualTo("current-source-value");
        assertThat(loads).hasValue(1);
        verify(cachePort, times(1)).put(eq("read-through-epoch"), eq("write-during-read"),
                any(Duration.class));
    }

    @Test
    @DisplayName("mutating one key does not invalidate another key's pending load or read")
    void perKeyGenerationsDoNotFenceUnrelatedKeys() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        CompletableFuture<Optional<String>> readA = new CompletableFuture<>();
        CompletableFuture<Optional<String>> readB = new CompletableFuture<>();
        CompletableFuture<String> sourceB = new CompletableFuture<>();
        when(cachePort.get("a")).thenReturn(AsyncOperation.from(readA));
        when(cachePort.get("b")).thenReturn(AsyncOperation.from(readB));
        when(cachePort.put(eq("a"), eq("mutation"), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));
        when(cachePort.put(eq("b"), eq("loaded-b"), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));

        AsyncOperation<String> loadB = cache.getOrLoad("b", ignored -> AsyncOperation.from(sourceB));
        AsyncOperation<String> loadA = cache.getOrLoad("a", ignored -> AsyncOperation.success("loaded-a"));
        await(cache.put("a", "mutation"));
        readA.complete(Optional.empty());
        readB.complete(Optional.empty());
        sourceB.complete("loaded-b");
        assertThat(await(loadB)).isEqualTo("loaded-b");
        assertThat(await(loadA)).isEqualTo("loaded-a");
        verify(cachePort).put(eq("b"), eq("loaded-b"), any(Duration.class));
    }

    @Test
    @DisplayName("a direct read for one key survives mutation of another key")
    void unrelatedDirectReadSurvivesOtherKeyMutation() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        CompletableFuture<Optional<String>> readB = new CompletableFuture<>();
        when(cachePort.get("b")).thenReturn(AsyncOperation.from(readB));
        when(cachePort.put(eq("a"), eq("mutation"), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));
        AsyncOperation<Optional<String>> directB = cache.get("b");
        await(cache.put("a", "mutation"));
        readB.complete(Optional.of("cached-b"));
        assertThat(await(directB)).contains("cached-b");
    }

    @Test
    @DisplayName("completing a read callback does not hold the lock needed by unrelated mutations")
    void blockedReadCallbackDoesNotBlockUnrelatedMutation() throws Exception {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        CompletableFuture<Optional<String>> read = new CompletableFuture<>();
        CountDownLatch callbackEntered = new CountDownLatch(1);
        CountDownLatch releaseCallback = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        when(cachePort.get("callback-key")).thenReturn(AsyncOperation.from(read));
        when(cachePort.put(eq("other-key"), eq("value"), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));
        try {
            cache.get("callback-key").whenComplete((ignored, error) -> {
                callbackEntered.countDown();
                try {
                    releaseCallback.await(2, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            });
            Future<?> completingRead = executor.submit(() -> read.complete(Optional.of("cached")));
            assertThat(callbackEntered.await(1, TimeUnit.SECONDS)).isTrue();
            Future<Void> mutation = executor.submit(() -> await(cache.put("other-key", "value")));
            mutation.get(1, TimeUnit.SECONDS);
            releaseCallback.countDown();
            completingRead.get(1, TimeUnit.SECONDS);
        } finally {
            releaseCallback.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    @DisplayName("cache-hit load callbacks run outside the mutation lock")
    void blockedCacheHitCallbackDoesNotBlockUnrelatedMutation() throws Exception {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        CompletableFuture<Optional<String>> read = new CompletableFuture<>();
        CountDownLatch callbackEntered = new CountDownLatch(1);
        CountDownLatch releaseCallback = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        when(cachePort.get("cache-hit")).thenReturn(AsyncOperation.from(read));
        when(cachePort.put(eq("other-key"), eq("value"), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));
        try {
            cache.getOrLoad("cache-hit", ignored -> AsyncOperation.success("source"))
                    .whenComplete((ignored, error) -> {
                        callbackEntered.countDown();
                        try {
                            releaseCallback.await(2, TimeUnit.SECONDS);
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                        }
                    });
            Future<?> completingRead = executor.submit(() -> read.complete(Optional.of("cached")));
            assertThat(callbackEntered.await(1, TimeUnit.SECONDS)).isTrue();
            Future<Void> mutation = executor.submit(() -> await(cache.put("other-key", "value")));
            mutation.get(1, TimeUnit.SECONDS);
            releaseCallback.countDown();
            completingRead.get(1, TimeUnit.SECONDS);
        } finally {
            releaseCallback.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    @DisplayName("accepted cache-hit delivery fences port invalidation until completion returns")
    void cacheHitDeliveryFencesPortInvalidation() throws Exception {
        DistributedCacheService service = mock(DistributedCacheService.class);
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(service, "transcription");
        CompletableFuture<Optional<String>> read = new CompletableFuture<>();
        CountDownLatch callbackEntered = new CountDownLatch(1);
        CountDownLatch releaseCallback = new CountDownLatch(1);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        when(service.get("cache-hit-during-invalidate"))
                .thenReturn(AsyncOperation.from(read));
        when(service.invalidateAll()).thenReturn(AsyncOperation.success(bulkInvalidationSuccess()));
        try {
            cache.getOrLoad("cache-hit-during-invalidate", ignored -> AsyncOperation.success("source"))
                    .whenComplete((ignored, error) -> {
                        callbackEntered.countDown();
                        try {
                            releaseCallback.await(2, TimeUnit.SECONDS);
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                        }
                    });
            Future<?> completingRead = executor.submit(
                    () -> read.complete(Optional.of("cached-before-invalidation")));
            assertThat(callbackEntered.await(1, TimeUnit.SECONDS)).isTrue();
            assertThatThrownBy(() -> await(cache.invalidateAll()))
                    .hasRootCauseInstanceOf(IllegalStateException.class);
            verify(service, times(0)).invalidateAll();
            releaseCallback.countDown();
            completingRead.get(1, TimeUnit.SECONDS);
            await(cache.invalidateAll());
            verify(service, times(1)).invalidateAll();
        } finally {
            releaseCallback.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    @DisplayName("sequential unique mutations release bounded per-key coordination state")
    void uniqueSequentialMutationsDoNotRetainKeyState() {
        DistributedCacheService service = mock(DistributedCacheService.class);
        when(service.put(anyString(), anyString(), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));
        when(service.invalidateAsync(anyString())).thenReturn(AsyncOperation.success(null));
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(service, "transcription");

        for (int i = 0; i < 2_500; i++) {
            String key = "unique-" + i;
            await(cache.put(key, "value"));
            assertThat(cache.activeKeyCoordinationCount()).isZero();
            await(cache.invalidate(key));
            assertThat(cache.activeKeyCoordinationCount()).isZero();
        }
    }

    @Test
    @DisplayName("single-key invalidation atomically fences reads and writes")
    void singleKeyInvalidationReservesMutationBarrier() {
        DistributedCacheService service = mock(DistributedCacheService.class);
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(service, "transcription");
        CompletableFuture<Void> invalidation = new CompletableFuture<>();
        when(service.invalidateAsync("invalidate-key")).thenReturn(AsyncOperation.from(invalidation));
        when(service.put(eq("invalidate-key"), anyString(), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));

        AsyncOperation<Void> result = cache.invalidate("invalidate-key");
        assertThat(await(cache.get("invalidate-key"))).isEmpty();
        assertThatThrownBy(() -> await(cache.put("invalidate-key", "new-value")))
                .hasRootCauseInstanceOf(IllegalStateException.class);
        verify(service, times(0)).get("invalidate-key");
        verify(service, times(0)).put(eq("invalidate-key"), anyString(), any(Duration.class));

        invalidation.complete(null);
        await(result);
        await(cache.put("invalidate-key", "after-invalidation"));
    }

    @Test
    @DisplayName("port-scope invalidation rejects overlapping writes and fences old reads")
    void portScopeInvalidationBlocksMutationsAndStaleReads() throws Exception {
        DistributedCacheService service = mock(DistributedCacheService.class);
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(service, "transcription");
        CompletableFuture<Void> pendingWrite = new CompletableFuture<>();
        CompletableFuture<String> oldSourceResult = new CompletableFuture<>();
        java.util.concurrent.CountDownLatch oldSourceStarted = new java.util.concurrent.CountDownLatch(1);
        when(service.put(eq("active-write"), eq("old"), any(Duration.class)))
                .thenReturn(AsyncOperation.from(pendingWrite));
        when(service.get("source-before-port-invalidate"))
                .thenReturn(AsyncOperation.success(Optional.empty()));
        when(service.put(eq("during-port-invalidate"), eq("after-erase"), any(Duration.class)))
                .thenReturn(AsyncOperation.success(null));

        AsyncOperation<Void> write = cache.put("active-write", "old");
        assertThatThrownBy(() -> await(cache.invalidateAll()))
                .hasRootCauseInstanceOf(IllegalStateException.class);
        verify(service, times(0)).invalidateAll();
        pendingWrite.complete(null);
        await(write);

        AsyncOperation<String> oldSourceLoad = cache.getOrLoad("source-before-port-invalidate", ignored -> {
            oldSourceStarted.countDown();
            return AsyncOperation.from(oldSourceResult);
        });
        assertThat(oldSourceStarted.await(1, TimeUnit.SECONDS)).isTrue();

        CompletableFuture<com.ghatana.cache.CacheBulkInvalidationOutcome> pendingInvalidation =
                new CompletableFuture<>();
        when(service.invalidateAll()).thenReturn(AsyncOperation.from(pendingInvalidation));
        AsyncOperation<Void> invalidation = cache.invalidateAll();
        assertThatThrownBy(() -> await(cache.put("during-port-invalidate", "blocked")))
                .hasRootCauseInstanceOf(IllegalStateException.class);
        assertThat(await(cache.get("during-port-invalidate"))).isEmpty();
        assertThat(await(cache.getOrLoad("during-port-invalidate",
                ignored -> AsyncOperation.success("source-only")))).isEqualTo("source-only");
        verify(service, times(0)).get("during-port-invalidate");

        oldSourceResult.complete("old-source-result");
        assertThat(await(oldSourceLoad)).isEqualTo("old-source-result");
        verify(service, times(0)).put(eq("source-before-port-invalidate"), anyString(),
                any(Duration.class));

        pendingInvalidation.complete(bulkInvalidationSuccess());
        await(invalidation);
        await(cache.put("during-port-invalidate", "after-erase"));
    }

    private static CacheBulkInvalidationOutcome bulkInvalidationSuccess() {
        return CacheBulkInvalidationOutcome.from(
                "test", CacheOperationResult.complete(0, 0, 0));
    }

    @Test
    @DisplayName("source loader failure remains visible and is not cached")
    void sourceLoaderFailureIsNotHiddenByCache() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        when(cachePort.get("source-fails")).thenReturn(AsyncOperation.success(Optional.empty()));

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> await(cache.getOrLoad(
                "source-fails", ignored -> AsyncOperation.failure(
                        new IllegalStateException("source unavailable")))))
                .hasRootCauseInstanceOf(IllegalStateException.class)
                .hasRootCauseMessage("source unavailable");

        verify(cachePort, times(0)).put(anyString(), anyString(), any(Duration.class));
    }

    @Test
    @DisplayName("source provider timeout remains classified and is not cached")
    void sourceProviderTimeoutRemainsVisibleAndIsNotCached() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");
        when(cachePort.get("provider-times-out")).thenReturn(AsyncOperation.success(Optional.empty()));

        assertThatThrownBy(() -> await(cache.getOrLoad("provider-times-out", ignored ->
                AsyncOperation.failure(new java.util.concurrent.TimeoutException("provider timed out")))))
                .hasRootCauseInstanceOf(java.util.concurrent.TimeoutException.class)
                .hasRootCauseMessage("provider timed out");

        verify(cachePort, times(0)).put(anyString(), anyString(), any(Duration.class));
    }
}
