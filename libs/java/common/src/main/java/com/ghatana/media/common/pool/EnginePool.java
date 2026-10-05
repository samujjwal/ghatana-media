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
    private final ConcurrentMap<T, PooledEngine<T>> inUse;
    private final Supplier<T> factory;
    private final Function<T, Boolean> healthCheck;
    private final Function<T, Void> destroyer;

    private final int minSize;
    private final int maxSize;
    private final Duration idleTimeout;
    private final Duration borrowTimeout;

    private final AtomicInteger totalCreated = new AtomicInteger(0);
    private final AtomicInteger totalDestroyed = new AtomicInteger(0);
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

        this.factory = factory;
        this.healthCheck = healthCheck;
        this.destroyer = destroyer;
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

        // If none available and under max, create new
        if (pooled == null) {
            T engine = createEngineIfCapacity();
            if (engine != null) {
                pooled = new PooledEngine<>(engine, Instant.now());
            }
        }

        // If still none, wait with timeout
        if (pooled == null) {
            try {
                pooled = available.poll(borrowTimeout.toMillis(), TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new PoolExhaustedException("Interrupted while waiting for engine");
            }
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
        }

        pooled.lastBorrowed = Instant.now();
        inUse.put(pooled.engine, pooled);
        cleanupCollectedBorrowEntries();

        // Track borrow for leak detection
        borrowTracking.put(new IdentityWeakReference<>(pooled.engine, borrowTrackingQueue), new BorrowInfo(
            pooled.engine,
            Instant.now(),
            Thread.currentThread().getStackTrace()
        ));

        return pooled.engine;
    }

    /**
     * Returns an engine to the pool.
     *
     * @param engine engine to return
     */
    public void returnEngine(T engine) {
        if (engine == null) return;

        PooledEngine<T> pooled = inUse.remove(engine);
        if (pooled == null) {
            LOG.warning("Returning engine not from this pool");
            destroyEngine(engine);
            return;
        }

        // Remove from leak tracking
        cleanupCollectedBorrowEntries();
        borrowTracking.remove(new IdentityWeakReference<>(engine));

        totalReturned.incrementAndGet();

        if (closed || !isHealthy(engine)) {
            destroyEngine(engine);
            return;
        }

        pooled.lastReturned = Instant.now();
        available.offer(pooled);
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
        T engine = borrow();
        try {
            return action.apply(engine);
        } finally {
            returnEngine(engine);
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
        closed = true;
        evictionExecutor.shutdown();
        leakDetectionExecutor.shutdown();

        // Destroy all engines
        available.forEach(p -> destroyEngine(p.engine));
        inUse.keySet().forEach(this::destroyEngine);

        available.clear();
        inUse.clear();

        try {
            if (!evictionExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                evictionExecutor.shutdownNow();
            }
            if (!leakDetectionExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                leakDetectionExecutor.shutdownNow();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            evictionExecutor.shutdownNow();
            leakDetectionExecutor.shutdownNow();
        }

        // Log any remaining leaks
        if (!borrowTracking.isEmpty()) {
            LOG.warning("Pool closed with " + borrowTracking.size() + " engines still borrowed (potential leaks)");
        }

        borrowTracking.clear();

        LOG.info("Engine pool closed. Total created: " + totalCreated.get());
    }

    private T createEngine() {
        try {
            T engine = factory.get();
            if (engine != null) {
                totalCreated.incrementAndGet();
            }
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

        T engine = createEngine();
        if (engine != null) {
            return engine;
        }

        activeEngines.decrementAndGet();
        return null;
    }

    private void destroyEngine(T engine) {
        try {
            destroyer.apply(engine);
            totalDestroyed.incrementAndGet();
            activeEngines.updateAndGet(current -> Math.max(0, current - 1));
        } catch (Exception e) {
            LOG.warning("Error destroying engine: " + e.getMessage());
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
