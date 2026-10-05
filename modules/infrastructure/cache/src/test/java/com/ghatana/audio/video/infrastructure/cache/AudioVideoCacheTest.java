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

import static org.assertj.core.api.Assertions.assertThat;
import static com.ghatana.audio.video.infrastructure.cache.AsyncOperationTestSupport.await;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
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
    @DisplayName("buildKey composes namespace tenant and id")
    void buildKeyComposesNamespaceAndTenant() {
        AudioVideoCache<String, String> cache = new AudioVideoCache<>(cachePort, "transcription");

        String key = cache.buildKey("tenant-1", "id-1");

        assertThat(key).isEqualTo("transcription:tenant-1:id-1");
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
}
