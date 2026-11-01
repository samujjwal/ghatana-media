/**
 * @doc.type class
 * @doc.purpose Engine pooling for high-throughput audio/video inference
 * @doc.layer platform
 * @doc.pattern Pool
 */
package com.ghatana.media.common.pool;


import java.lang.ref.ReferenceQueue;
import java.lang.ref.WeakReference;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import java.util.function.Supplier;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.*;

/**
 * Generic engine pool for managing expensive inference engine instances.
 *
 * <p>Maintains a pool of reusable engine instances with:
 * <ul>
 *   <li>Minimum/maximum size bounds</li>
 *   <li>Idle timeout with automatic eviction</li>
 *   <li>Borrow timeout to prevent indefinite waits</li>
 *   <li>Health checking and stale instance replacement</li>
 *   <li>Metrics for pool utilization</li>
 * </ul>
 *
 * @param <T> engine type (SttEngine, TtsEngine, etc.)
 */
public class EnginePool<T> implements AutoCloseable {

    private static final Logger LOG = Logger.getLogger(EnginePool.class.getName());

    private final BlockingQueue<PooledEngine<T>> available;
    private final ConcurrentMap<IdentityKey<T>, PooledEngine<T>> inUse;
    private final Object lifecycleLock = new Object();
    private final Set<IdentityKey<T>> ownedEngines = ConcurrentHashMap.newKeySet();
    private final Map<IdentityKey<T>, Object> leaseTokens = new HashMap<>();
    private final Supplier<T> factory;
    private final Function<T, Boolean> healthCheck;
    private final Function<T, Void> destroyer;

    private final int minSize;
    private final int maxSize;
    private final Duration idleTimeout;
    private final Duration borrowTimeout;

    private final AtomicInteger totalCreated = new AtomicInteger(0);
    private final AtomicInteger totalDestroyed = new AtomicInteger(0);
    private final AtomicLong failedDestructions = new AtomicLong(0);
    private final AtomicInteger activeEngines = new AtomicInteger(0);
    private final AtomicLong totalBorrowed = new AtomicLong(0);
    private final AtomicLong totalReturned = new AtomicLong(0);
    private final AtomicLong failedHealthChecks = new AtomicLong(0);
    private final AtomicLong leakDetections = new AtomicLong(0);
    private final AtomicLong backpressureEvents = new AtomicLong(0);
    private final AtomicReference<ResourceUsageSnapshot> lastUsageSnapshot = new AtomicReference<>();

    // Leak detection tracking
    private final ConcurrentMap<IdentityWeakReference<T>, BorrowInfo> borrowTracking = new ConcurrentHashMap<>();
    private final ReferenceQueue<T> borrowTrackingQueue = new ReferenceQueue<>();
    private final Duration leakDetectionThreshold;
    private final long leakCheckIntervalMillis;
    private final ScheduledExecutorService leakDetectionExecutor;

    private final ScheduledExecutorService evictionExecutor;
    private volatile boolean closed = false;

    /**
     * Creates a new engine pool.
     *
     * @param factory creates new engine instances
     * @param healthCheck validates engine health (returns false if unhealthy)
     * @param destroyer cleanup function for destroyed engines
     * @param config pool configuration
     */
    public EnginePool(
            Supplier<T> factory,
            Function<T, Boolean> healthCheck,
            Function<T, Void> destroyer,
            PoolConfig config) {

        Objects.requireNonNull(config, "config");
        config.validate();
        this.factory = Objects.requireNonNull(factory, "factory");
        this.healthCheck = Objects.requireNonNull(healthCheck, "healthCheck");
        this.destroyer = Objects.requireNonNull(destroyer, "destroyer");
        this.minSize = config.minSize;
        this.maxSize = config.maxSize;
        this.idleTimeout = config.idleTimeout;
        this.borrowTimeout = config.borrowTimeout;
        this.leakDetectionThreshold = config.leakDetectionThreshold;
        this.leakCheckIntervalMillis = computeLeakCheckIntervalMillis(config.leakDetectionThreshold);

        this.available = new LinkedBlockingQueue<>(maxSize);
        this.inUse = new ConcurrentHashMap<>();

        // Pre-populate minimum size
        for (int i = 0; i < minSize; i++) {
            T engine = createEngineIfCapacity();
            if (engine != null) {
                available.offer(new PooledEngine<>(engine, Instant.now()));
            }
        }

        // Start eviction thread
        this.evictionExecutor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "engine-pool-eviction");
            t.setDaemon(true);
            return t;
        });

        evictionExecutor.scheduleAtFixedRate(
            this::evictIdleEngines,
            idleTimeout.toMillis(),
            idleTimeout.toMillis() / 2,
            TimeUnit.MILLISECONDS
        );

        // Start leak detection thread
        this.leakDetectionExecutor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "engine-pool-leak-detection");
            t.setDaemon(true);
            return t;
        });

        leakDetectionExecutor.scheduleAtFixedRate(
            this::detectLeaks,
            leakCheckIntervalMillis,
            leakCheckIntervalMillis,
            TimeUnit.MILLISECONDS
        );

        LOG.info("Engine pool created: min=" + minSize + ", max=" + maxSize + ", leak detection enabled");
    }

    /**
     * Borrows an engine from the pool.
     *
     * @return engine instance
     * @throws PoolExhaustedException if no engines available within timeout
     * @throws IllegalStateException if pool is closed
     */
    public T borrow() throws PoolExhaustedException {
        return borrowInternal(null);
    }

    private T borrowInternal(Object leaseToken) throws PoolExhaustedException {
        if (closed) {
            throw new IllegalStateException("Pool is closed");
        }

        totalBorrowed.incrementAndGet();

        // Check for pool exhaustion and apply backpressure
        if (inUse.size() >= maxSize && available.isEmpty()) {
            backpressureEvents.incrementAndGet();
            LOG.warning("Pool exhaustion detected. In use: " + inUse.size() + ", Max: " + maxSize);
        }

        // Try to get from available queue
        PooledEngine<T> pooled = available.poll();
        boolean createdFresh = false;

        // If none available and under max, create new
        if (pooled == null) {
            T engine = createEngineIfCapacity();
            if (engine != null) {
                pooled = new PooledEngine<>(engine, Instant.now());
                createdFresh = true;
            }
        }

        // If still none, wait with timeout
        if (pooled == null) {
            long waitNanos = borrowTimeout.toNanos();
            long started = System.nanoTime();
            try {
                while (pooled == null && !closed && waitNanos > 0) {
                    pooled = available.poll(Math.min(waitNanos, TimeUnit.MILLISECONDS.toNanos(100)),
                            TimeUnit.NANOSECONDS);
                    if (pooled == null && !closed) {
                        T replacement = createEngineIfCapacity();
                        if (replacement != null) {
                            pooled = new PooledEngine<>(replacement, Instant.now());
                            createdFresh = true;
                        }
                    }
                    waitNanos = borrowTimeout.toNanos() - (System.nanoTime() - started);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new PoolExhaustedException("Interrupted while waiting for engine");
            }
        }
        if (pooled == null && closed) {
            throw new IllegalStateException("Pool is closed");
        }

        if (pooled == null) {
            throw new PoolExhaustedException(
                "No engines available within " + borrowTimeout.toMillis() + "ms. " +
                "In use: " + inUse.size() + ", Available: " + available.size()
            );
        }

        // Health check
        if (!isHealthy(pooled.engine)) {
            // Replace unhealthy engine
            destroyEngine(pooled.engine);
            T replacement = createEngineIfCapacity();
            if (replacement == null) {
                throw new PoolExhaustedException("Failed to create replacement engine");
            }
            pooled = new PooledEngine<>(replacement, Instant.now());
            createdFresh = true;
        }

        synchronized (lifecycleLock) {
            IdentityKey<T> key = new IdentityKey<>(pooled.engine);
            if (inUse.containsKey(key)) {
                // A broken factory returned an already borrowed instance. Never
                // destroy it: that would terminate another borrower's engine.
                if (createdFresh) activeEngines.decrementAndGet();
                throw new IllegalStateException("Engine factory returned an already borrowed instance");
            }
            if (!closed) {
                pooled.lastBorrowed = Instant.now();
                inUse.put(key, pooled);
                if (leaseToken != null) leaseTokens.put(key, leaseToken);
                cleanupCollectedBorrowEntries();
                borrowTracking.put(new IdentityWeakReference<>(pooled.engine, borrowTrackingQueue), new BorrowInfo(
                    pooled.engine, Instant.now(), Thread.currentThread().getStackTrace()));
                return pooled.engine;
            }
        }
        // Destroyer is caller-supplied and must not hold the lifecycle lock.
        destroyEngine(pooled.engine);
        throw new IllegalStateException("Pool is closed");
    }

    /**
     * Returns an engine to the pool.
     *
     * @param engine engine to return
     *
     * <p>The legacy API carries no lease token: a stale caller holding the same
     * raw engine reference after it has been returned and reborrowed cannot be
     * distinguished from the current borrower. Callers must return each borrow
     * exactly once; use of this API does not establish cross-worker fencing.
     */
    public void returnEngine(T engine) {
        returnBorrow(engine, null);
    }

    private void returnBorrow(T engine, Object token) {
        if (engine == null) return;
        final PooledEngine<T> pooled;
        synchronized (lifecycleLock) {
            IdentityKey<T> key = new IdentityKey<>(engine);
            Object currentToken = leaseTokens.get(key);
            if (token == null && currentToken != null) {
                throw new IllegalStateException("Engine belongs to a tokenized lease; close the lease instead");
            }
            if (token != null && currentToken != token) return;
            if (token != null) leaseTokens.remove(key);
            pooled = inUse.remove(key);
            if (pooled == null) {
                LOG.warning("Returning engine not currently borrowed from this pool");
                return;
            }
            cleanupCollectedBorrowEntries();
            borrowTracking.remove(new IdentityWeakReference<>(engine));
            totalReturned.incrementAndGet();
        }
        // Health checks and destruction may block or call external code. A
        // returning engine is neither available nor borrowed while checked.
        boolean healthy = !closed && isHealthy(engine);
        boolean destroy;
        synchronized (lifecycleLock) {
            destroy = closed || !healthy;
            if (!destroy) {
                pooled.lastReturned = Instant.now();
                destroy = !available.offer(pooled);
            }
        }
        if (destroy) destroyEngine(engine);
    }

    /**
     * Borrows an engine through an idempotent tokenized lease. Raw returns of a
     * leased handle are rejected; closing a stale lease cannot return a later borrow.
     */
    public Lease<T> borrowLease() throws PoolExhaustedException {
        Object token = new Object();
        // Register the token in the same critical section as the borrow, so a
        // stale raw holder cannot return this engine before its lease is bound.
        T engine = borrowInternal(token);
        return new Lease<>(engine, () -> releaseLease(engine, token));
    }

    private void releaseLease(T engine, Object token) {
        returnBorrow(engine, token);
    }

    /**
     * A single borrow; close returns it at most once. The holder must finish
     * using the engine before closing it; a retained raw reference is not fenced.
     */
    public static final class Lease<T> implements AutoCloseable {
        private final T engine;
        private final Runnable release;
        private final java.util.concurrent.atomic.AtomicBoolean returned = new java.util.concurrent.atomic.AtomicBoolean();

        private Lease(T engine, Runnable release) {
            this.engine = engine;
            this.release = release;
        }

        public T engine() {
            if (returned.get()) throw new IllegalStateException("Engine lease is closed");
            return engine;
        }

        @Override public void close() {
            if (returned.compareAndSet(false, true)) release.run();
        }
    }

    /**
     * Execute a function with a borrowed engine.
     * Automatically returns the engine after execution.
     *
     * @param action function to execute
     * @param <R> return type
     * @return result of the action
     * @throws PoolExhaustedException if no engines available
     */
    public <R> R execute(Function<T, R> action) throws PoolExhaustedException {
        try (Lease<T> lease = borrowLease()) {
            return action.apply(lease.engine());
        }
    }

    /**
     * Get current pool statistics.
     */
    public PoolStats getStats() {
        return new PoolStats(
            available.size(),
            inUse.size(),
            totalCreated.get(),
            totalDestroyed.get(),
            totalBorrowed.get(),
            totalReturned.get(),
            failedHealthChecks.get(),
            leakDetections.get(),
            backpressureEvents.get(),
            closed
        );
    }

    /** Number of engine destruction attempts that failed and retained their capacity reservation. */
    public long getFailedDestructionCount() {
        return failedDestructions.get();
    }

    /**
     * Get detailed resource usage snapshot.
     */
    public ResourceUsageSnapshot getResourceUsage() {
        cleanupCollectedBorrowEntries();
        ResourceUsageSnapshot snapshot = new ResourceUsageSnapshot(
            available.size(),
            inUse.size(),
            maxSize,
            (double) inUse.size() / maxSize,
            borrowTracking.size(),
            leakDetections.get(),
            backpressureEvents.get(),
            Instant.now()
        );
        lastUsageSnapshot.set(snapshot);
        return snapshot;
    }

    /**
     * Get list of potentially leaked engines.
     */
    public List<LeakInfo> getPotentialLeaks() {
        cleanupCollectedBorrowEntries();
        List<LeakInfo> leaks = new ArrayList<>();
        Instant threshold = Instant.now().minus(leakDetectionThreshold);

        for (BorrowInfo info : borrowTracking.values()) {
            if (!info.borrowTime.isAfter(threshold)) {
                leaks.add(new LeakInfo(
                    info.engineRef.get(),
                    info.borrowTime,
                    Duration.between(info.borrowTime, Instant.now()),
                    info.stackTrace
                ));
            }
        }

        return leaks;
    }

    @Override
    public void close() {
        List<PooledEngine<T>> idle = new ArrayList<>();
        synchronized (lifecycleLock) {
            if (closed) return;
            closed = true;
            available.drainTo(idle);
        }
        evictionExecutor.shutdown();
        leakDetectionExecutor.shutdown();
        // Borrowed engines remain usable until their owner returns them. Their
        // eventual return destroys them because the pool is already closed.
        idle.forEach(p -> destroyEngine(p.engine));

        try {
            if (!evictionExecutor.awaitTermination(5, TimeUnit.SECONDS)) evictionExecutor.shutdownNow();
            if (!leakDetectionExecutor.awaitTermination(5, TimeUnit.SECONDS)) leakDetectionExecutor.shutdownNow();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            evictionExecutor.shutdownNow();
            leakDetectionExecutor.shutdownNow();
        }
        if (!inUse.isEmpty()) {
            LOG.warning("Pool closed with " + inUse.size() + " engines still borrowed; cleanup deferred until return");
        }
        LOG.info("Engine pool closed. Total created: " + totalCreated.get());
    }

    private T createEngine() {
        try {
            T engine = factory.get();
            if (engine == null) return null;
            if (!ownedEngines.add(new IdentityKey<>(engine))) {
                LOG.warning("Engine factory returned an instance already owned by this pool");
                return null;
            }
            totalCreated.incrementAndGet();
            return engine;
        } catch (Exception e) {
            LOG.severe("Failed to create engine: " + e.getMessage());
            return null;
        }
    }

    private T createEngineIfCapacity() {
        while (true) {
            int current = activeEngines.get();
            if (current >= maxSize) {
                return null;
            }
            if (activeEngines.compareAndSet(current, current + 1)) {
                break;
            }
        }

        try {
            T engine = createEngine();
            if (engine != null) return engine;
            activeEngines.decrementAndGet();
            return null;
        } catch (Error fatal) {
            // No engine was admitted to the pool; release only the reservation
            // and preserve the fatal failure for the caller.
            activeEngines.decrementAndGet();
            throw fatal;
        }
    }

    private void destroyEngine(T engine) {
        try {
            destroyer.apply(engine);
            ownedEngines.remove(new IdentityKey<>(engine));
            totalDestroyed.incrementAndGet();
            activeEngines.updateAndGet(current -> Math.max(0, current - 1));
        } catch (Exception e) {
            // Destruction is unconfirmed. Keep the capacity reservation rather
            // than creating another engine over a potentially live resource.
            failedDestructions.incrementAndGet();
            LOG.warning("Engine destruction failed; capacity remains reserved");
        }
    }

    private boolean isHealthy(T engine) {
        try {
            boolean healthy = healthCheck.apply(engine);
            if (!healthy) {
                failedHealthChecks.incrementAndGet();
            }
            return healthy;
        } catch (Exception e) {
            failedHealthChecks.incrementAndGet();
            return false;
        }
    }

    private void evictIdleEngines() {
        if (closed) return;

        Instant cutoff = Instant.now().minus(idleTimeout);
        int evicted = 0;

        // Keep minimum size, evict rest that are idle too long
        while (available.size() > minSize) {
            PooledEngine<T> pooled = available.peek();
            if (pooled == null || pooled.lastReturned.isAfter(cutoff)) {
                break; // No more idle engines to evict
            }

            // Actually remove and destroy
            pooled = available.poll();
            if (pooled != null) {
                destroyEngine(pooled.engine);
                evicted++;
            }
        }

        if (evicted > 0) {
            LOG.fine("Evicted " + evicted + " idle engines. Pool size: " +
                     (available.size() + inUse.size()));
        }
    }

    private void detectLeaks() {
        if (closed) return;
        cleanupCollectedBorrowEntries();

        Instant now = Instant.now();
        Instant threshold = now.minus(leakDetectionThreshold);
        List<BorrowInfo> leakedBorrows = new ArrayList<>();

        for (BorrowInfo info : borrowTracking.values()) {
            if (!info.borrowTime.isAfter(threshold)) {
                leakedBorrows.add(info);
            }
        }

        if (!leakedBorrows.isEmpty()) {
            leakDetections.addAndGet(leakedBorrows.size());
            LOG.log(Level.SEVERE,
                "Detected " + leakedBorrows.size() + " potential resource leaks. " +
                "Engines borrowed for > " + leakDetectionThreshold.toMinutes() + " minutes");

            // Log stack traces for debugging
            for (BorrowInfo info : leakedBorrows) {
                RuntimeException leakTrace = new RuntimeException("Borrow stack trace");
                leakTrace.setStackTrace(info.stackTrace);
                LOG.log(Level.SEVERE, "Leaked engine borrowed at:", leakTrace);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private void cleanupCollectedBorrowEntries() {
        IdentityWeakReference<T> reference;
        reference = (IdentityWeakReference<T>) borrowTrackingQueue.poll();
        while (reference != null) {
            borrowTracking.remove(reference);
            reference = (IdentityWeakReference<T>) borrowTrackingQueue.poll();
        }
    }

    private static long computeLeakCheckIntervalMillis(Duration threshold) {
        long thresholdMillis = Math.max(1L, threshold.toMillis());
        return Math.max(250L, Math.min(thresholdMillis / 4L, 30_000L));
    }

    private static class BorrowInfo {
        final WeakReference<Object> engineRef;
        final Instant borrowTime;
        final StackTraceElement[] stackTrace;

        BorrowInfo(Object engine, Instant borrowTime, StackTraceElement[] stackTrace) {
            this.engineRef = new WeakReference<>(engine);
            this.borrowTime = borrowTime;
            this.stackTrace = stackTrace;
        }
    }

    private static final class IdentityKey<T> {
        private final T value;
        private IdentityKey(T value) { this.value = value; }
        @Override public int hashCode() { return System.identityHashCode(value); }
        @Override public boolean equals(Object other) {
            return other instanceof IdentityKey<?> key && value == key.value;
        }
    }

    private static final class IdentityWeakReference<T> extends WeakReference<T> {
        private final int identityHash;

        IdentityWeakReference(T referent, ReferenceQueue<T> queue) {
            super(referent, queue);
            this.identityHash = System.identityHashCode(referent);
        }

        IdentityWeakReference(T referent) {
            super(referent);
            this.identityHash = System.identityHashCode(referent);
        }

        @Override
        public int hashCode() {
            return identityHash;
        }

        @Override
        public boolean equals(Object obj) {
            if (this == obj) {
                return true;
            }
            if (!(obj instanceof IdentityWeakReference<?> other)) {
                return false;
            }
            Object referent = get();
            Object otherReferent = other.get();
            return referent != null && referent == otherReferent;
        }
    }

    private static class PooledEngine<T> {
        final T engine;
        final Instant created;
        volatile Instant lastBorrowed;
        volatile Instant lastReturned;

        PooledEngine(T engine, Instant created) {
            this.engine = engine;
            this.created = created;
            this.lastBorrowed = created;
            this.lastReturned = created;
        }
    }

    /**
     * Pool configuration.
     */
    public static class PoolConfig {
        private int minSize = 2;
        private int maxSize = 10;
        private Duration idleTimeout = Duration.ofMinutes(5);
        private Duration borrowTimeout = Duration.ofSeconds(30);
        private Duration leakDetectionThreshold = Duration.ofMinutes(10);

        public PoolConfig minSize(int min) {
            this.minSize = min;
            return this;
        }

        public PoolConfig maxSize(int max) {
            this.maxSize = max;
            return this;
        }

        public PoolConfig idleTimeout(Duration timeout) {
            this.idleTimeout = timeout;
            return this;
        }

        public PoolConfig borrowTimeout(Duration timeout) {
            this.borrowTimeout = timeout;
            return this;
        }

        public PoolConfig leakDetectionThreshold(Duration threshold) {
            this.leakDetectionThreshold = threshold;
            return this;
        }

        private void validate() {
            if (minSize < 0 || maxSize <= 0 || minSize > maxSize) {
                throw new IllegalArgumentException("pool size must satisfy 0 <= min <= max and max > 0");
            }
            try {
                if (idleTimeout == null || idleTimeout.toMillis() < 2
                        || borrowTimeout == null || borrowTimeout.toNanos() <= 0
                        || leakDetectionThreshold == null || leakDetectionThreshold.toMillis() < 1) {
                    throw new IllegalArgumentException("pool timeouts must be positive and schedulable");
                }
            } catch (ArithmeticException overflow) {
                throw new IllegalArgumentException("pool timeout exceeds supported range", overflow);
            }
        }

        public static PoolConfig defaults() {
            return new PoolConfig();
        }
    }

    /**
     * Pool statistics snapshot.
     */
    public static class PoolStats {
        public final int available;
        public final int inUse;
        public final int totalCreated;
        public final int totalDestroyed;
        public final long totalBorrowed;
        public final long totalReturned;
        public final long failedHealthChecks;
        public final long leakDetections;
        public final long backpressureEvents;
        public final boolean closed;

        public PoolStats(int available, int inUse, int totalCreated, int totalDestroyed,
                        long totalBorrowed, long totalReturned, long failedHealthChecks,
                        long leakDetections, long backpressureEvents, boolean closed) {
            this.available = available;
            this.inUse = inUse;
            this.totalCreated = totalCreated;
            this.totalDestroyed = totalDestroyed;
            this.totalBorrowed = totalBorrowed;
            this.totalReturned = totalReturned;
            this.failedHealthChecks = failedHealthChecks;
            this.leakDetections = leakDetections;
            this.backpressureEvents = backpressureEvents;
            this.closed = closed;
        }

        public int getTotalSize() { return available + inUse; }
        public double getUtilization() {
            int total = getTotalSize();
            return total > 0 ? (double) inUse / total : 0.0;
        }

        @Override
        public String toString() {
            return String.format(
                "PoolStats{available=%d, inUse=%d, total=%d, created=%d, destroyed=%d, " +
                "borrowed=%d, returned=%d, failedHealth=%d, leaks=%d, backpressure=%d, " +
                "closed=%b, utilization=%.2f%%}",
                available, inUse, getTotalSize(), totalCreated, totalDestroyed,
                totalBorrowed, totalReturned, failedHealthChecks, leakDetections,
                backpressureEvents, closed, getUtilization() * 100
            );
        }
    }

    /**
     * Resource usage snapshot.
     */
    public static class ResourceUsageSnapshot {
        public final int available;
        public final int inUse;
        public final int maxSize;
        public final double utilizationPercent;
        public final int trackedBorrows;
        public final long totalLeaks;
        public final long totalBackpressure;
        public final Instant timestamp;

        public ResourceUsageSnapshot(int available, int inUse, int maxSize,
                                    double utilizationPercent, int trackedBorrows,
                                    long totalLeaks, long totalBackpressure, Instant timestamp) {
            this.available = available;
            this.inUse = inUse;
            this.maxSize = maxSize;
            this.utilizationPercent = utilizationPercent;
            this.trackedBorrows = trackedBorrows;
            this.totalLeaks = totalLeaks;
            this.totalBackpressure = totalBackpressure;
            this.timestamp = timestamp;
        }

        public boolean isExhausted() {
            return available == 0 && inUse >= maxSize;
        }

        public boolean hasLeaks() {
            return totalLeaks > 0;
        }

        @Override
        public String toString() {
            return String.format(
                "ResourceUsage{available=%d, inUse=%d, max=%d, utilization=%.2f%%, " +
                "tracked=%d, leaks=%d, backpressure=%d, exhausted=%b, timestamp=%s}",
                available, inUse, maxSize, utilizationPercent * 100,
                trackedBorrows, totalLeaks, totalBackpressure, isExhausted(), timestamp
            );
        }
    }

    /**
     * Information about a potential resource leak.
     */
    public static class LeakInfo {
        public final Object engine;
        public final Instant borrowTime;
        public final Duration heldDuration;
        public final StackTraceElement[] borrowStackTrace;

        public LeakInfo(Object engine, Instant borrowTime, Duration heldDuration,
                       StackTraceElement[] borrowStackTrace) {
            this.engine = engine;
            this.borrowTime = borrowTime;
            this.heldDuration = heldDuration;
            this.borrowStackTrace = borrowStackTrace;
        }

        @Override
        public String toString() {
            return String.format(
                "LeakInfo{borrowTime=%s, heldFor=%s minutes}",
                borrowTime, heldDuration.toMinutes()
            );
        }
    }

    /**
     * Exception thrown when pool is exhausted.
     */
    public static class PoolExhaustedException extends Exception {
        public PoolExhaustedException(String message) {
            super(message);
        }
    }
}
