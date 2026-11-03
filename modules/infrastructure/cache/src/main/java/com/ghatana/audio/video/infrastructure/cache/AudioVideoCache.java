package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.cache.CachePolicy;
import com.ghatana.cache.DistributedCachePort;
import com.ghatana.core.async.AsyncOperation;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.time.Duration;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

/**
 * @doc.type class
 * @doc.purpose Audio-video specific cache wrapper around platform DistributedCachePort
 * @doc.layer infrastructure
 * @doc.pattern Cache
 */
public class AudioVideoCache<K, V> {

    /**
     * Complete authorization and content identity supplied by the caller for a
     * protected cache entry. These values partition the key only; they do not
     * establish that a caller currently has rights to read the cached value.
     */
    public record CacheKeyScope(
            String tenantId,
            String authenticatedPrincipalId,
            String rightsScope,
            String purpose,
            String classification,
            String artifactId,
            String artifactRevision,
            String transcriptRevision,
            String sourceFingerprint) {
        public CacheKeyScope {
            requireScopeValue(tenantId, "tenantId");
            requireScopeValue(authenticatedPrincipalId, "authenticatedPrincipalId");
            requireScopeValue(rightsScope, "rightsScope");
            requireScopeValue(purpose, "purpose");
            requireScopeValue(classification, "classification");
            requireScopeValue(artifactId, "artifactId");
            requireScopeValue(artifactRevision, "artifactRevision");
            requireScopeValue(transcriptRevision, "transcriptRevision");
            requireScopeValue(sourceFingerprint, "sourceFingerprint");
        }

        private static void requireScopeValue(String value, String name) {
            if (value == null || value.isBlank()) {
                throw new IllegalArgumentException(name + " must be non-blank");
            }
            if (value.length() > CachePolicy.MAX_KEY_LENGTH) {
                throw new IllegalArgumentException(name + " exceeds supported length of "
                        + CachePolicy.MAX_KEY_LENGTH);
            }
        }
    }
    
    private static final Logger LOG = LoggerFactory.getLogger(AudioVideoCache.class);
    private static final Duration DEFAULT_TTL = Duration.ofMinutes(30);
    private static final Duration DEFAULT_CACHE_OPERATION_TIMEOUT = Duration.ofSeconds(5);
    private static final int MAX_IN_FLIGHT_KEYS = 1_024;
    /** Process-local key keeps low-entropy tenant and entity identifiers resistant to dictionary recovery. */
    private static final byte[] DIAGNOSTIC_REFERENCE_KEY = createDiagnosticReferenceKey();
    
    private final DistributedCachePort<K, V> cachePort;
    private final String namespace;
    private final long cacheOperationTimeoutNanos;
    private final Object mutationLock = new Object();
    /** Active per-key coordination only; entries are removed after readers and mutations settle. */
    private final ConcurrentMap<K, KeyState> keyStates = new ConcurrentHashMap<>();
    private long portScopeGeneration;
    private boolean portInvalidationPending;
    private int activeCacheHitDeliveries;
    /** Bounded, process-local coordination only; this is not a distributed lock. */
    private final ConcurrentMap<K, CompletableFuture<V>> inFlightLoads = new ConcurrentHashMap<>();
    private final AtomicInteger inFlightReservations = new AtomicInteger();
    /** Pending and timed-out writes stay marked until the port reports their actual outcome. */
    private final ConcurrentMap<K, Object> pendingCacheWrites = new ConcurrentHashMap<>();
    private final AtomicInteger pendingCacheWriteReservations = new AtomicInteger();
    
    public AudioVideoCache(DistributedCachePort<K, V> cachePort, String namespace) {
        this(cachePort, namespace, DEFAULT_CACHE_OPERATION_TIMEOUT);
    }

    AudioVideoCache(
            DistributedCachePort<K, V> cachePort,
            String namespace,
            Duration cacheOperationTimeout) {
        this.cachePort = Objects.requireNonNull(cachePort, "cachePort cannot be null");
        this.namespace = Objects.requireNonNull(namespace, "namespace cannot be null");
        Duration operationTimeout = Objects.requireNonNull(
                cacheOperationTimeout, "cacheOperationTimeout cannot be null");
        if (operationTimeout.isZero() || operationTimeout.isNegative()) {
            throw new IllegalArgumentException("cacheOperationTimeout must be positive");
        }
        try {
            this.cacheOperationTimeoutNanos = operationTimeout.toNanos();
        } catch (ArithmeticException overflow) {
            throw new IllegalArgumentException("cacheOperationTimeout is too large", overflow);
        }
    }
    
    /**
     * Bounded, redacted key reference for diagnostics. Cache keys can embed
     * tenant, principal, artifact or transcript identity, so the raw key is
     * never written to logs or metrics; a process-keyed, fixed-length HMAC
     * keeps entries correlatable within this process without exposing a
     * dictionary-testable hash of low-entropy identifiers.
     */
    static String keyReference(Object key) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(DIAGNOSTIC_REFERENCE_KEY, "HmacSHA256"));
            byte[] digest = mac.doFinal(String.valueOf(key)
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder ref = new StringBuilder("hmac256:");
            for (int i = 0; i < 12; i++) {
                ref.append(Character.forDigit((digest[i] >> 4) & 0xf, 16))
                        .append(Character.forDigit(digest[i] & 0xf, 16));
            }
            return ref.toString();
        } catch (java.security.GeneralSecurityException failure) {
            throw new IllegalStateException("HMAC-SHA256 is unavailable", failure);
        }
    }

    private static byte[] createDiagnosticReferenceKey() {
        byte[] key = new byte[32];
        new java.security.SecureRandom().nextBytes(key);
        return key;
    }

    private String namespaceReference() {
        return keyReference(namespace);
    }

    /**
     * Get value from cache
     */
    public AsyncOperation<Optional<V>> get(K key) {
        Objects.requireNonNull(key, "key cannot be null");
        EpochSnapshot capturedEpoch;
        synchronized (mutationLock) {
            if (portInvalidationPending || pendingCacheWrites.containsKey(key)) {
                return AsyncOperation.success(Optional.empty());
            }
            capturedEpoch = acquireEpochSnapshot(key);
            if (capturedEpoch == null) return AsyncOperation.success(Optional.empty());
        }
        CompletableFuture<Optional<V>> result = new CompletableFuture<>();
        AtomicBoolean settled = new AtomicBoolean();
        try {
            AsyncOperation<Optional<V>> cacheRead = cachePort.get(key);
            cacheRead.whenComplete((opt, error) -> {
                if (!settled.compareAndSet(false, true)) return;
                Optional<Optional<V>> accepted;
                Throwable failure = null;
                boolean deliveryReserved = false;
                synchronized (mutationLock) {
                    if (!epochCurrent(key, capturedEpoch) || portInvalidationPending
                            || pendingCacheWrites.containsKey(key)) {
                        accepted = Optional.of(Optional.empty());
                    } else if (error != null) {
                        LOG.error("Cache get error: namespaceRef={}, keyRef={}, causeType={}",
                                namespaceReference(), keyReference(key), failureType(error));
                        accepted = Optional.empty();
                        failure = error;
                    } else if (opt == null) {
                        accepted = Optional.empty();
                        failure = new IllegalStateException("Cache read returned no outcome");
                    } else {
                        boolean withinValueLimit = opt.isEmpty()
                                || isCacheValueWithinSharedLimit(opt.get());
                        if (!withinValueLimit) {
                            LOG.warn("Cache entry exceeded Shared value limit; treating as miss: namespaceRef={}, keyRef={}",
                                    namespaceReference(), keyReference(key));
                        } else if (opt.isPresent()) {
                            LOG.trace("Cache hit: namespaceRef={}, keyRef={}", namespaceReference(), keyReference(key));
                        } else {
                            LOG.trace("Cache miss: namespaceRef={}, keyRef={}", namespaceReference(), keyReference(key));
                        }
                        accepted = Optional.of(withinValueLimit ? opt : Optional.empty());
                        capturedEpoch.state.deliveries++;
                        activeCacheHitDeliveries++;
                        deliveryReserved = true;
                    }
                }
                releaseReadSnapshot(key, capturedEpoch);
                try {
                    if (failure != null) result.completeExceptionally(failure);
                    else result.complete(accepted.orElse(Optional.empty()));
                } finally {
                    if (deliveryReserved) releaseDelivery(key, capturedEpoch.state);
                }
            });
            if (!result.isDone()) {
                CompletableFuture.delayedExecutor(cacheOperationTimeoutNanos, TimeUnit.NANOSECONDS)
                        .execute(() -> {
                            if (!settled.compareAndSet(false, true)) return;
                            LOG.warn("Cache get timed out: namespaceRef={}, keyRef={}",
                                    namespaceReference(), keyReference(key));
                            releaseReadSnapshot(key, capturedEpoch);
                            result.completeExceptionally(new java.util.concurrent.TimeoutException("Cache read timed out"));
                        });
            }
        } catch (RuntimeException failure) {
            if (settled.compareAndSet(false, true)) {
                LOG.error("Cache get error: namespaceRef={}, keyRef={}, causeType={}",
                        namespaceReference(), keyReference(key), failureType(failure));
                releaseReadSnapshot(key, capturedEpoch);
                result.completeExceptionally(failure);
            }
        }
        return AsyncOperation.from(result);
    }
    
    /**
     * Put value in cache with default TTL
     */
    public AsyncOperation<Void> put(K key, V value) {
        Objects.requireNonNull(key, "key cannot be null");
        Objects.requireNonNull(value, "value cannot be null");
        validateCacheValue(value);
        return putTracked(key, value, DEFAULT_TTL);
    }
    
    /**
     * Put value with custom TTL
     */
    public AsyncOperation<Void> put(K key, V value, Duration ttl) {
        Objects.requireNonNull(key, "key cannot be null");
        Objects.requireNonNull(value, "value cannot be null");
        Objects.requireNonNull(ttl, "ttl cannot be null");
        validateCacheValue(value);
        Duration boundedTtl = boundedTtl(ttl);
        return putTracked(key, value, boundedTtl);
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
            LOG.warn("Cache load coordination capacity reached: namespaceRef={}", namespaceReference());
            return AsyncOperation.failure(new IllegalStateException(
                    "Cache load coordination capacity reached"));
        }

        CompletableFuture<V> candidate = new CompletableFuture<>();
        existing = inFlightLoads.putIfAbsent(key, candidate);
        if (existing != null) {
            inFlightReservations.decrementAndGet();
            return AsyncOperation.from(existing);
        }

        CompletableFuture<V> operationFuture = new CompletableFuture<>();
        AtomicReference<KeyState> heldKeyState = new AtomicReference<>();
        operationFuture.whenComplete((value, error) -> {
            KeyState state = heldKeyState.getAndSet(null);
            if (state != null) releaseReadState(key, state);
            if (error == null) candidate.complete(value);
            else candidate.completeExceptionally(error);
            inFlightLoads.remove(key, candidate);
            inFlightReservations.decrementAndGet();
        });

        EpochSnapshot capturedEpoch;
        boolean cacheMutationPending;
        synchronized (mutationLock) {
            capturedEpoch = acquireEpochSnapshot(key);
            cacheMutationPending = portInvalidationPending || pendingCacheWrites.containsKey(key);
            if (capturedEpoch != null) heldKeyState.set(capturedEpoch.state);
        }
        if (capturedEpoch == null || cacheMutationPending) {
            if (capturedEpoch != null) {
                heldKeyState.set(null);
                releaseReadState(key, capturedEpoch.state);
            }
            completeFrom(loadWithoutCache(key, loader), operationFuture);
            return observeLoad(candidate, key);
        }

        AtomicBoolean readSettled = new AtomicBoolean();
        try {
            AsyncOperation<Optional<V>> cacheRead = cachePort.get(key);
            cacheRead.whenComplete((cached, readError) -> {
                if (!readSettled.compareAndSet(false, true)) return;
                if (!cacheEpochCurrent(key, capturedEpoch)) {
                    completeFrom(loadWithoutCache(key, loader), operationFuture);
                } else if (readError != null) {
                    LOG.warn("Cache get failed; loading from source: namespaceRef={}, keyRef={}, causeType={}",
                            namespaceReference(), keyReference(key), failureType(readError));
                    completeFrom(loadWithoutCache(key, loader), operationFuture);
                } else if (cached != null && cached.isPresent()
                        && !isCacheValueWithinSharedLimit(cached.get())) {
                    LOG.warn("Cache entry exceeded Shared value limit; loading from source: namespaceRef={}, keyRef={}",
                            namespaceReference(), keyReference(key));
                    completeFrom(loadWithoutCache(key, loader), operationFuture);
                } else if (cached != null && cached.isPresent()) {
                    if (!completeFromCacheIfCurrent(key, capturedEpoch, cached.get(), operationFuture)) {
                        completeFrom(loadWithoutCache(key, loader), operationFuture);
                    }
                } else {
                    completeFrom(loadAndCache(key, loader, candidate, capturedEpoch), operationFuture);
                }
            });
            if (!operationFuture.isDone()) {
                CompletableFuture.delayedExecutor(
                        cacheOperationTimeoutNanos, TimeUnit.NANOSECONDS)
                        .execute(() -> {
                            if (!readSettled.compareAndSet(false, true)) return;
                            LOG.warn("Cache get timed out; loading from source: namespaceRef={}, keyRef={}",
                                    namespaceReference(), keyReference(key));
                            completeFrom(loadWithoutCache(key, loader), operationFuture);
                        });
            }
        } catch (RuntimeException cacheFailure) {
            if (!readSettled.compareAndSet(false, true)) {
                return AsyncOperation.from(candidate);
            }
            LOG.warn("Cache get failed; loading from source: namespaceRef={}, keyRef={}, causeType={}",
                    namespaceReference(), keyReference(key), failureType(cacheFailure));
            completeFrom(loadWithoutCache(key, loader), operationFuture);
        }
        return observeLoad(candidate, key);
    }

    private AsyncOperation<V> observeLoad(CompletableFuture<V> candidate, K key) {
        return AsyncOperation.from(candidate).whenComplete((ignored, error) -> {
            if (error != null) {
                LOG.error("Cache load error: namespaceRef={}, keyRef={}, causeType={}",
                        namespaceReference(), keyReference(key), failureType(error));
            }
        });
    }

    private AsyncOperation<Void> putTracked(K key, V value, Duration ttl) {
        Object marker = reservePendingCacheWrite(key);
        if (marker == null) {
            return AsyncOperation.failure(new IllegalStateException(
                    "Cache write is already pending or coordination capacity is full"));
        }
        CompletableFuture<Void> result = new CompletableFuture<>();
        try {
            AsyncOperation<Void> operation = cachePort.put(key, value, ttl);
            operation.whenComplete((ignored, error) -> {
                settlePendingCacheWrite(key, marker, error == null);
                if (error != null) result.completeExceptionally(error);
                else result.complete(null);
            });
            if (!result.isDone()) {
                CompletableFuture.delayedExecutor(cacheOperationTimeoutNanos, TimeUnit.NANOSECONDS)
                        .execute(() -> result.completeExceptionally(new java.util.concurrent.TimeoutException(
                                "Cache write timed out; outcome unknown")));
            }
        } catch (RuntimeException failure) {
            // A synchronous throw may occur after a backend dispatched the write. Retain the
            // bounded marker because this port contract gives us no completion to fence it.
            result.completeExceptionally(failure);
        }
        return observePut(AsyncOperation.from(result), key, ttl);
    }

    private Object reservePendingCacheWrite(K key) {
        return reservePendingCacheWrite(key, null);
    }

    private Object reservePendingCacheWrite(K key, EpochSnapshot expectedEpoch) {
        synchronized (mutationLock) {
            if (portInvalidationPending || pendingCacheWrites.containsKey(key)
                    || pendingCacheWriteReservations.get() >= MAX_IN_FLIGHT_KEYS) {
                return null;
            }
            KeyState state;
            if (expectedEpoch == null) {
                state = acquireKeyState(key);
                if (state == null) return null;
            } else {
                if (!epochCurrent(key, expectedEpoch)) return null;
                state = expectedEpoch.state;
                state.references++;
            }
            if (state.deliveries > 0) {
                releaseKeyState(key, state);
                return null;
            }
            Object marker = new Object();
            pendingCacheWrites.put(key, marker);
            pendingCacheWriteReservations.incrementAndGet();
            state.generation++;
            return marker;
        }
    }

    private void settlePendingCacheWrite(K key, Object marker, boolean releaseOnSuccess) {
        synchronized (mutationLock) {
            KeyState state = keyStates.get(key);
            if (state == null) return;
            state.generation++;
            if (releaseOnSuccess && pendingCacheWrites.remove(key, marker)) {
                pendingCacheWriteReservations.decrementAndGet();
                releaseKeyState(key, state);
            }
        }
    }

    private boolean cacheEpochCurrent(K key, EpochSnapshot expectedEpoch) {
        synchronized (mutationLock) {
            return epochCurrent(key, expectedEpoch) && !portInvalidationPending
                    && !pendingCacheWrites.containsKey(key);
        }
    }

    private EpochSnapshot acquireEpochSnapshot(K key) {
        KeyState state = acquireKeyState(key);
        return state == null ? null : new EpochSnapshot(state, state.generation, portScopeGeneration);
    }

    private boolean epochCurrent(K key, EpochSnapshot expected) {
        return keyStates.get(key) == expected.state
                && expected.state.generation == expected.keyGeneration
                && portScopeGeneration == expected.portScopeGeneration;
    }

    private KeyState acquireKeyState(K key) {
        KeyState state = keyStates.get(key);
        if (state == null) {
            if (keyStates.size() >= MAX_IN_FLIGHT_KEYS) return null;
            state = new KeyState();
            keyStates.put(key, state);
        }
        state.references++;
        return state;
    }

    private void releaseReadSnapshot(K key, EpochSnapshot snapshot) {
        synchronized (mutationLock) {
            releaseKeyState(key, snapshot.state);
        }
    }

    private void releaseReadState(K key, KeyState state) {
        synchronized (mutationLock) {
            releaseKeyState(key, state);
        }
    }

    private void releaseDelivery(K key, KeyState state) {
        synchronized (mutationLock) {
            state.deliveries--;
            activeCacheHitDeliveries--;
            cleanupKeyState(key, state);
        }
    }

    private void releaseKeyState(K key, KeyState state) {
        state.references--;
        cleanupKeyState(key, state);
    }

    private void cleanupKeyState(K key, KeyState state) {
        if (state.references == 0 && state.deliveries == 0 && !pendingCacheWrites.containsKey(key)) {
            keyStates.remove(key, state);
        }
    }

    private static final class KeyState {
        private long generation;
        private int references;
        private int deliveries;
    }

    private static final class EpochSnapshot {
        private final KeyState state;
        private final long keyGeneration;
        private final long portScopeGeneration;

        private EpochSnapshot(KeyState state, long keyGeneration, long portScopeGeneration) {
            this.state = state;
            this.keyGeneration = keyGeneration;
            this.portScopeGeneration = portScopeGeneration;
        }
    }

    private boolean completeFromCacheIfCurrent(
            K key, EpochSnapshot expectedEpoch, V value, CompletableFuture<V> target) {
        KeyState state;
        synchronized (mutationLock) {
            if (!epochCurrent(key, expectedEpoch) || portInvalidationPending
                    || pendingCacheWrites.containsKey(key)) {
                return false;
            }
            state = expectedEpoch.state;
            state.deliveries++;
            activeCacheHitDeliveries++;
        }
        try {
            target.complete(value);
        } finally {
            releaseDelivery(key, state);
        }
        return true;
    }

    int activeKeyCoordinationCount() {
        synchronized (mutationLock) {
            return keyStates.size();
        }
    }

    private boolean reserveInFlightSlot() {
        while (true) {
            int current = inFlightReservations.get();
            if (current >= MAX_IN_FLIGHT_KEYS) return false;
            if (inFlightReservations.compareAndSet(current, current + 1)) return true;
        }
    }

    private AsyncOperation<V> loadAndCache(
            K key, Function<K, AsyncOperation<V>> loader,
            CompletableFuture<V> callerResult, EpochSnapshot capturedEpoch) {
        CompletableFuture<V> result = new CompletableFuture<>();
        loadWithoutCache(key, loader).whenComplete((value, loadError) -> {
            if (loadError != null) {
                result.completeExceptionally(loadError);
            } else if (value == null) {
                callerResult.complete(null);
                result.complete(null);
            } else if (!isCacheValueWithinSharedLimit(value)) {
                LOG.warn("Source value exceeded Shared cache value limit; returning without caching: namespaceRef={}, keyRef={}",
                        namespaceReference(), keyReference(key));
                callerResult.complete(value);
                result.complete(value);
            } else {
                Object marker = reservePendingCacheWrite(key, capturedEpoch);
                if (marker == null) {
                    callerResult.complete(value);
                    result.complete(value);
                    return;
                }
                try {
                    AsyncOperation<Void> cacheWrite = cachePort.put(key, value, DEFAULT_TTL);
                    cacheWrite.whenComplete((ignored, putError) -> {
                        settlePendingCacheWrite(key, marker, putError == null);
                        if (putError != null) LOG.warn(
                                "Cache put failed; returning source value: namespaceRef={}, keyRef={}, causeType={}",
                                namespaceReference(), keyReference(key), failureType(putError));
                        result.complete(value);
                    });
                    if (!result.isDone()) {
                        CompletableFuture.delayedExecutor(
                                cacheOperationTimeoutNanos, TimeUnit.NANOSECONDS)
                                .execute(() -> result.complete(value));
                    }
                    // Dispatch and completion observation precede caller callbacks. The marker
                    // stays until the port reports the actual write outcome, even after timeout.
                    callerResult.complete(value);
                } catch (RuntimeException cacheFailure) {
                    LOG.warn("Cache put failed; returning source value: namespaceRef={}, keyRef={}, causeType={}",
                            namespaceReference(), keyReference(key), failureType(cacheFailure));
                    result.complete(value);
                    callerResult.complete(value);
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
            Object marker = reservePendingCacheWrite(key);
            if (marker == null) {
                return AsyncOperation.failure(new IllegalStateException(
                        "Cache key has an active mutation or coordination capacity is full"));
            }
            CompletableFuture<Void> result = new CompletableFuture<>();
            try {
                service.invalidateAsync(stringKey).whenComplete((ignored, error) -> {
                    settlePendingCacheWrite(key, marker, error == null);
                    if (error != null) {
                        LOG.error("Cache invalidate error: namespaceRef={}, keyRef={}, causeType={}",
                                namespaceReference(), keyReference(key), failureType(error));
                        result.completeExceptionally(error);
                    } else {
                        LOG.debug("Cache invalidate: namespaceRef={}, keyRef={}", namespaceReference(), keyReference(key));
                        result.complete(null);
                    }
                });
                if (!result.isDone()) {
                    CompletableFuture.delayedExecutor(cacheOperationTimeoutNanos, TimeUnit.NANOSECONDS)
                            .execute(() -> result.completeExceptionally(new java.util.concurrent.TimeoutException(
                                    "Cache invalidation timed out; outcome unknown")));
                }
            } catch (RuntimeException failure) {
                result.completeExceptionally(failure);
            }
            return AsyncOperation.from(result);
        }
        return AsyncOperation.failure(new UnsupportedOperationException(
                "The configured cache port does not provide single-key invalidation"));
    }
    
    /**
     * Invalidate the configured cache-port scope
     */
    public AsyncOperation<Void> invalidateAll() {
        synchronized (mutationLock) {
            if (portInvalidationPending || pendingCacheWriteReservations.get() != 0
                    || activeCacheHitDeliveries != 0) {
                return AsyncOperation.failure(new IllegalStateException(
                        "Port-scope invalidation cannot overlap active cache mutations"));
            }
            portInvalidationPending = true;
            portScopeGeneration++;
        }

        CompletableFuture<Void> result = new CompletableFuture<>();
        try {
            cachePort.invalidateAll().whenComplete((outcome, error) -> {
                boolean complete = error == null && outcome != null && outcome.isComplete();
                synchronized (mutationLock) {
                    portScopeGeneration++;
                    if (complete) portInvalidationPending = false;
                }
                if (error != null) {
                    LOG.error("Cache invalidate all error: namespaceRef={}, causeType={}",
                            namespaceReference(), failureType(error));
                    result.completeExceptionally(error);
                } else if (outcome == null) {
                    result.completeExceptionally(new IllegalStateException(
                            "Cache port-scope invalidation returned no outcome"));
                } else if (!outcome.isComplete()) {
                    result.completeExceptionally(new IllegalStateException(
                            "Cache port-scope invalidation was incomplete"));
                } else {
                    LOG.info("Cache invalidate all: namespaceRef={}", namespaceReference());
                    result.complete(null);
                }
            });
            if (!result.isDone()) {
                CompletableFuture.delayedExecutor(cacheOperationTimeoutNanos, TimeUnit.NANOSECONDS)
                        .execute(() -> result.completeExceptionally(new java.util.concurrent.TimeoutException(
                                "Cache port-scope invalidation timed out; outcome unknown")));
            }
        } catch (RuntimeException failure) {
            result.completeExceptionally(failure);
        }
        return AsyncOperation.from(result);
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

    /**
     * Build an isolated key for protected content. Callers must supply every
     * scope dimension used by their authorization and source versioning path;
     * no value here is a substitute for rechecking current rights before reads.
     */
    public String buildScopedKey(CacheKeyScope scope) {
        Objects.requireNonNull(scope, "scope cannot be null");
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            updateFramedUtf16(digest, namespace);
            updateFramedUtf16(digest, scope.tenantId());
            updateFramedUtf16(digest, scope.authenticatedPrincipalId());
            updateFramedUtf16(digest, scope.rightsScope());
            updateFramedUtf16(digest, scope.purpose());
            updateFramedUtf16(digest, scope.classification());
            updateFramedUtf16(digest, scope.artifactId());
            updateFramedUtf16(digest, scope.artifactRevision());
            updateFramedUtf16(digest, scope.transcriptRevision());
            updateFramedUtf16(digest, scope.sourceFingerprint());
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
                LOG.trace("Cache put: namespaceRef={}, keyRef={}, ttl={}s",
                        namespaceReference(), keyReference(key), ttl.getSeconds());
            } else {
                LOG.error("Cache put error: namespaceRef={}, keyRef={}, causeType={}",
                        namespaceReference(), keyReference(key), failureType(error));
            }
        });
    }

    private static Duration boundedTtl(Duration ttl) {
        if (ttl.isZero() || ttl.isNegative()) {
            throw new IllegalArgumentException("ttl must be positive");
        }
        return ttl.compareTo(DEFAULT_TTL) > 0 ? DEFAULT_TTL : ttl;
    }

    /** Applies Shared's payload bound to strings while preserving generic port values. */
    private static boolean isCacheValueWithinSharedLimit(Object value) {
        return !(value instanceof String text) || text.length() <= CachePolicy.MAX_VALUE_LENGTH;
    }

    private static void validateCacheValue(Object value) {
        if (value instanceof String text) CachePolicy.validateValue(text);
    }

    /** Never render backend exception messages or stack traces in cache diagnostics. */
    private static String failureType(Throwable failure) {
        return failure.getClass().getSimpleName();
    }
}
