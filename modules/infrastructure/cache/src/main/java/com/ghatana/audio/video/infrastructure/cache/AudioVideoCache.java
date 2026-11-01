package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.cache.DistributedCachePort;
import com.ghatana.core.async.AsyncOperation;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicInteger;
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
    private static final int MAX_IN_FLIGHT_KEYS = 1_024;
    
    private final DistributedCachePort<K, V> cachePort;
    private final String namespace;
    /** Bounded, process-local coordination only; this is not a distributed lock. */
    private final ConcurrentMap<K, CompletableFuture<V>> inFlightLoads = new ConcurrentHashMap<>();
    private final AtomicInteger inFlightReservations = new AtomicInteger();
    
    public AudioVideoCache(DistributedCachePort<K, V> cachePort, String namespace) {
        this.cachePort = Objects.requireNonNull(cachePort, "cachePort cannot be null");
        this.namespace = Objects.requireNonNull(namespace, "namespace cannot be null");
    }
    
    /**
     * Bounded, redacted key reference for diagnostics. Cache keys can embed
     * tenant, principal, artifact or transcript identity, so the raw key is
     * never written to logs or metrics; a fixed-length SHA-256 prefix keeps
     * entries correlatable without disclosing the key material.
     */
    static String keyReference(Object key) {
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(String.valueOf(key).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder ref = new StringBuilder("sha256:");
            for (int i = 0; i < 6; i++) {
                ref.append(Character.forDigit((digest[i] >> 4) & 0xf, 16))
                        .append(Character.forDigit(digest[i] & 0xf, 16));
            }
            return ref.toString();
        } catch (java.security.NoSuchAlgorithmException failure) {
            throw new IllegalStateException("SHA-256 is unavailable", failure);
        }
    }

    /**
     * Get value from cache
     */
    public AsyncOperation<Optional<V>> get(K key) {
        Objects.requireNonNull(key, "key cannot be null");
        
        return cachePort.get(key).whenComplete((opt, error) -> {
            if (error != null) {
                LOG.error("Cache get error: namespace={}, keyRef={}, causeType={}",
                        namespace, keyReference(key), failureType(error));
            } else if (opt.isPresent()) {
                LOG.trace("Cache hit: namespace={}, keyRef={}", namespace, keyReference(key));
            } else {
                LOG.trace("Cache miss: namespace={}, keyRef={}", namespace, keyReference(key));
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
        
        Duration boundedTtl = boundedTtl(ttl);
        return observePut(cachePort.put(key, value, boundedTtl), key, boundedTtl);
    }
    
    /**
     * Get or load value using provided loader function
     */
    public AsyncOperation<V> getOrLoad(K key, Function<K, AsyncOperation<V>> loader) {
        Objects.requireNonNull(key, "key cannot be null");
        Objects.requireNonNull(loader, "loader cannot be null");

        CompletableFuture<V> existing = inFlightLoads.get(key);
        if (existing != null) return AsyncOperation.from(existing);
        if (!reserveInFlightSlot()) {
            existing = inFlightLoads.get(key);
            if (existing != null) return AsyncOperation.from(existing);
            LOG.warn("Cache load coordination capacity reached: namespace={}", namespace);
            return loadWithoutCache(key, loader);
        }

        CompletableFuture<V> candidate = new CompletableFuture<>();
        existing = inFlightLoads.putIfAbsent(key, candidate);
        if (existing != null) {
            inFlightReservations.decrementAndGet();
            return AsyncOperation.from(existing);
        }

        CompletableFuture<V> operationFuture = new CompletableFuture<>();
        operationFuture.whenComplete((value, error) -> {
            if (error == null) candidate.complete(value);
            else candidate.completeExceptionally(error);
            inFlightLoads.remove(key, candidate);
            inFlightReservations.decrementAndGet();
        });

        try {
            AsyncOperation<Optional<V>> cacheRead = cachePort.get(key);
            cacheRead.whenComplete((cached, readError) -> {
                if (readError != null) {
                    LOG.warn("Cache get failed; loading from source: namespace={}, keyRef={}, causeType={}",
                            namespace, keyReference(key), failureType(readError));
                    completeFrom(loadWithoutCache(key, loader), operationFuture);
                } else if (cached != null && cached.isPresent()) {
                    operationFuture.complete(cached.get());
                } else {
                    completeFrom(loadAndCache(key, loader), operationFuture);
                }
            });
        } catch (RuntimeException cacheFailure) {
            LOG.warn("Cache get failed; loading from source: namespace={}, keyRef={}, causeType={}",
                    namespace, keyReference(key), failureType(cacheFailure));
            completeFrom(loadWithoutCache(key, loader), operationFuture);
        }
        return AsyncOperation.from(candidate).whenComplete((ignored, error) -> {
            if (error != null) {
                LOG.error("Cache load error: namespace={}, keyRef={}, causeType={}",
                        namespace, keyReference(key), failureType(error));
            }
        });
    }

    private boolean reserveInFlightSlot() {
        while (true) {
            int current = inFlightReservations.get();
            if (current >= MAX_IN_FLIGHT_KEYS) return false;
            if (inFlightReservations.compareAndSet(current, current + 1)) return true;
        }
    }

    private AsyncOperation<V> loadAndCache(K key, Function<K, AsyncOperation<V>> loader) {
        CompletableFuture<V> result = new CompletableFuture<>();
        loadWithoutCache(key, loader).whenComplete((value, loadError) -> {
            if (loadError != null) {
                result.completeExceptionally(loadError);
            } else if (value == null) {
                result.complete(null);
            } else {
                try {
                    cachePort.put(key, value, DEFAULT_TTL).whenComplete((ignored, putError) -> {
                        if (putError != null) LOG.warn(
                                "Cache put failed; returning source value: namespace={}, keyRef={}, causeType={}",
                                namespace, keyReference(key), failureType(putError));
                        result.complete(value);
                    });
                } catch (RuntimeException cacheFailure) {
                    LOG.warn("Cache put failed; returning source value: namespace={}, keyRef={}, causeType={}",
                            namespace, keyReference(key), failureType(cacheFailure));
                    result.complete(value);
                }
            }
        });
        return AsyncOperation.from(result);
    }

    private static <T> void completeFrom(AsyncOperation<T> operation, CompletableFuture<T> target) {
        operation.whenComplete((value, error) -> {
            if (error == null) target.complete(value);
            else target.completeExceptionally(error);
        });
    }

    private AsyncOperation<V> loadWithoutCache(K key, Function<K, AsyncOperation<V>> loader) {
        try {
            return Objects.requireNonNull(loader.apply(key), "loader returned null operation");
        } catch (RuntimeException loaderFailure) {
            return AsyncOperation.failure(loaderFailure);
        }
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
                    LOG.debug("Cache invalidate: namespace={}, keyRef={}", namespace, keyReference(key));
                } else {
                    LOG.error("Cache invalidate error: namespace={}, keyRef={}, causeType={}",
                            namespace, keyReference(key), failureType(error));
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
                LOG.error("Cache invalidate all error: namespace={}, causeType={}",
                        namespace, failureType(error));
            }
        });
    }
    
    /**
     * Build a collision-safe tenant/id cache key. The v2 format uses a
     * Shared-compatible hyphen separator and hashes the length-prefixed
     * UTF-16 code units of namespace, tenant and id, so separators inside any
     * value cannot alias another tuple. Old delimiter-format entries are
     * intentionally treated as misses; cache data is ephemeral and repopulates
     * from the source of truth.
     */
    public String buildKey(String tenantId, String id) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(id, "id cannot be null");
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            updateFramedUtf16(digest, namespace);
            updateFramedUtf16(digest, tenantId);
            updateFramedUtf16(digest, id);
            StringBuilder key = new StringBuilder("av2-");
            for (byte value : digest.digest()) {
                key.append(Character.forDigit((value >>> 4) & 0xf, 16))
                        .append(Character.forDigit(value & 0xf, 16));
            }
            return key.toString();
        } catch (java.security.NoSuchAlgorithmException failure) {
            throw new IllegalStateException("SHA-256 is unavailable", failure);
        }
    }

    private static void updateFramedUtf16(java.security.MessageDigest digest, String value) {
        digest.update(java.nio.ByteBuffer.allocate(Integer.BYTES).putInt(value.length()).array());
        for (int index = 0; index < value.length(); index++) {
            char codeUnit = value.charAt(index);
            digest.update((byte) (codeUnit >>> 8));
            digest.update((byte) codeUnit);
        }
    }

    private AsyncOperation<Void> observePut(AsyncOperation<Void> operation, K key, Duration ttl) {
        return operation.whenComplete((ignored, error) -> {
            if (error == null) {
                LOG.trace("Cache put: namespace={}, keyRef={}, ttl={}s",
                        namespace, keyReference(key), ttl.getSeconds());
            } else {
                LOG.error("Cache put error: namespace={}, keyRef={}, causeType={}",
                        namespace, keyReference(key), failureType(error));
            }
        });
    }

    private static Duration boundedTtl(Duration ttl) {
        if (ttl.isZero() || ttl.isNegative()) {
            throw new IllegalArgumentException("ttl must be positive");
        }
        return ttl.compareTo(DEFAULT_TTL) > 0 ? DEFAULT_TTL : ttl;
    }

    /** Never render backend exception messages or stack traces in cache diagnostics. */
    private static String failureType(Throwable failure) {
        return failure.getClass().getSimpleName();
    }
}
