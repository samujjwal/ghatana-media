package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.cache.DistributedCachePort;
import com.ghatana.core.async.AsyncOperation;
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
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static com.ghatana.audio.video.infrastructure.cache.AsyncOperationTestSupport.await;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.times;
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

        assertThat(key).matches("av2-[0-9a-f]{64}");
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
    @DisplayName("distinct-key contention never exceeds in-flight cap and overflow loads source")
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
            assertThat(sourceLoads).hasValue(requestCount - capacity);
            cacheReads.values().forEach(read -> read.complete(Optional.empty()));
            for (int index = 0; index < requestCount; index++) {
                assertThat(await(requests.get(index))).isEqualTo("source-key-" + index);
            }
            assertThat(sourceLoads).hasValue(requestCount);
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
}
