package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.cache.DistributedCachePort;
import com.ghatana.core.async.AsyncOperation;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.Objects;
import java.util.Optional;
import java.util.function.Function;

/**
 * @doc.type class
 * @doc.purpose Audio-video specific cache wrapper around platform DistributedCachePort
 * @doc.layer infrastructure
 * @doc.pattern Cache
 */
public class AudioVideoCache<K, V> {
    
    private static final Logger LOG = LoggerFactory.getLogger(AudioVideoCache.class);
    private static final Duration DEFAULT_TTL = Duration.ofMinutes(30);
    
    private final DistributedCachePort<K, V> cachePort;
    private final String namespace;
    
    public AudioVideoCache(DistributedCachePort<K, V> cachePort, String namespace) {
        this.cachePort = Objects.requireNonNull(cachePort, "cachePort cannot be null");
        this.namespace = Objects.requireNonNull(namespace, "namespace cannot be null");
    }
    
    /**
     * Get value from cache
     */
    public AsyncOperation<Optional<V>> get(K key) {
        Objects.requireNonNull(key, "key cannot be null");
        
        return cachePort.get(key).whenComplete((opt, error) -> {
            if (error != null) {
                LOG.error("Cache get error: namespace={}, key={}", namespace, key, error);
            } else if (opt.isPresent()) {
                LOG.trace("Cache hit: namespace={}, key={}", namespace, key);
            } else {
                LOG.trace("Cache miss: namespace={}, key={}", namespace, key);
            }
        });
    }
    
    /**
     * Put value in cache with default TTL
     */
    public AsyncOperation<Void> put(K key, V value) {
        Objects.requireNonNull(key, "key cannot be null");
        Objects.requireNonNull(value, "value cannot be null");
        
        return observePut(cachePort.put(key, value, DEFAULT_TTL), key, DEFAULT_TTL);
    }
    
    /**
     * Put value with custom TTL
     */
    public AsyncOperation<Void> put(K key, V value, Duration ttl) {
        Objects.requireNonNull(key, "key cannot be null");
        Objects.requireNonNull(value, "value cannot be null");
        Objects.requireNonNull(ttl, "ttl cannot be null");
        
        return observePut(cachePort.put(key, value, ttl), key, ttl);
    }
    
    /**
     * Get or load value using provided loader function
     */
    public AsyncOperation<V> getOrLoad(K key, Function<K, AsyncOperation<V>> loader) {
        Objects.requireNonNull(key, "key cannot be null");
        Objects.requireNonNull(loader, "loader cannot be null");
        
        return cachePort.get(key).flatMap(cached -> {
            if (cached.isPresent()) {
                return AsyncOperation.success(cached.get());
            }
            return loader.apply(key).flatMap(loaded -> {
                if (loaded == null) {
                    return AsyncOperation.success(null);
                }
                return cachePort.put(key, loaded, DEFAULT_TTL).map(ignored -> loaded);
            });
        }).whenComplete((ignored, error) -> {
            if (error != null) {
                LOG.error("Cache load error: namespace={}, key={}", namespace, key, error);
            }
        });
    }
    
    /**
     * Invalidate a single key
     */
    public AsyncOperation<Void> invalidate(K key) {
        Objects.requireNonNull(key, "key cannot be null");
        
        if (cachePort instanceof com.ghatana.cache.DistributedCacheService service
                && key instanceof String stringKey) {
            return service.invalidateAsync(stringKey).whenComplete((ignored, error) -> {
                if (error == null) {
                    LOG.debug("Cache invalidate: namespace={}, key={}", namespace, key);
                } else {
                    LOG.error("Cache invalidate error: namespace={}, key={}", namespace, key, error);
                }
            });
        }
        return AsyncOperation.failure(new UnsupportedOperationException(
                "The configured cache port does not provide single-key invalidation"));
    }
    
    /**
     * Invalidate all entries in namespace
     */
    public AsyncOperation<Void> invalidateAll() {
        return cachePort.invalidateAll().map(outcome -> (Void) null).whenComplete((ignored, error) -> {
            if (error == null) {
                LOG.info("Cache invalidate all: namespace={}", namespace);
            } else {
                LOG.error("Cache invalidate all error: namespace={}", namespace, error);
            }
        });
    }
    
    /**
     * Build tenant-scoped key
     */
    public String buildKey(String tenantId, String id) {
        return namespace + ":" + tenantId + ":" + id;
    }

    private AsyncOperation<Void> observePut(AsyncOperation<Void> operation, K key, Duration ttl) {
        return operation.whenComplete((ignored, error) -> {
            if (error == null) {
                LOG.trace("Cache put: namespace={}, key={}, ttl={}s", namespace, key, ttl.getSeconds());
            } else {
                LOG.error("Cache put error: namespace={}, key={}", namespace, key, error);
            }
        });
    }
}
