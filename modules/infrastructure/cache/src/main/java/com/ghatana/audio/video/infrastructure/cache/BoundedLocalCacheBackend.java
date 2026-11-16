package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.cache.backend.AsyncCacheBackend;
import com.ghatana.cache.backend.CacheOperationResult;
import com.ghatana.core.async.AsyncOperation;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.github.benmanes.caffeine.cache.Expiry;
import com.github.benmanes.caffeine.cache.RemovalCause;
import com.github.benmanes.caffeine.cache.Ticker;

import java.time.Duration;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Process-local {@link AsyncCacheBackend} bounded by total bytes and entry count, with a per-entry TTL clamp.
 *
 * <p>It is an in-memory optimisation store only: it starts empty after every process start (a restart is always
 * cold) and it never decides who may read an entry. Every operation completes synchronously.</p>
 *
 * @doc.type class
 * @doc.purpose Bounded in-process cache backend for the rights-aware content cache
 * @doc.layer infrastructure
 * @doc.pattern Adapter
 */
public final class BoundedLocalCacheBackend implements AsyncCacheBackend {
    private record Entry(String value, long ttlNanos) { }

    private final Cache<String, Entry> entries;
    private final long maxBytes;
    private final int maxEntries;
    private final long maxTtlNanos;
    private final AtomicLong sizeEvictions = new AtomicLong();
    private final AtomicLong expirations = new AtomicLong();

    public BoundedLocalCacheBackend(long maxBytes, int maxEntries, Duration maxTtl) {
        this(maxBytes, maxEntries, maxTtl, Ticker.systemTicker());
    }

    BoundedLocalCacheBackend(long maxBytes, int maxEntries, Duration maxTtl, Ticker ticker) {
        if (maxBytes < 1 || maxEntries < 1) throw new IllegalArgumentException("maxBytes and maxEntries must be positive");
        Objects.requireNonNull(maxTtl, "maxTtl");
        if (maxTtl.isZero() || maxTtl.isNegative()) throw new IllegalArgumentException("maxTtl must be positive");
        this.maxBytes = maxBytes;
        this.maxEntries = maxEntries;
        this.maxTtlNanos = maxTtl.toNanos();
        // Every entry weighs at least maxBytes/maxEntries, so the byte bound also bounds the entry count.
        long minimumWeight = Math.max(1L, maxBytes / maxEntries);
        this.entries = Caffeine.newBuilder()
                .maximumWeight(maxBytes)
                .weigher((String key, Entry entry) ->
                        (int) Math.min(Integer.MAX_VALUE, Math.max(minimumWeight, (long) key.length() + entry.value().length())))
                .expireAfter(new Expiry<String, Entry>() {
                    @Override public long expireAfterCreate(String key, Entry value, long currentTime) { return value.ttlNanos(); }
                    @Override public long expireAfterUpdate(String key, Entry value, long currentTime, long currentDuration) { return value.ttlNanos(); }
                    @Override public long expireAfterRead(String key, Entry value, long currentTime, long currentDuration) { return currentDuration; }
                })
                .ticker(ticker)
                .executor(Runnable::run)
                .removalListener((String key, Entry value, RemovalCause cause) -> {
                    if (cause == RemovalCause.SIZE) sizeEvictions.incrementAndGet();
                    else if (cause == RemovalCause.EXPIRED) expirations.incrementAndGet();
                })
                .build();
    }

    @Override public AsyncOperation<String> getValue(String key) {
        Entry entry = entries.getIfPresent(key);
        return AsyncOperation.success(entry == null ? null : entry.value());
    }

    @Override public AsyncOperation<Void> setValue(String key, String value, long ttlSeconds) {
        return setValueMillis(key, value, Math.multiplyExact(ttlSeconds, 1_000L));
    }

    @Override public AsyncOperation<Void> setValueMillis(String key, String value, long ttlMillis) {
        if (ttlMillis <= 0) return AsyncOperation.failure(new IllegalArgumentException("ttl must be positive"));
        long ttlNanos = Math.min(maxTtlNanos, Math.multiplyExact(ttlMillis, 1_000_000L));
        entries.put(key, new Entry(value, ttlNanos));
        return AsyncOperation.success(null);
    }

    @Override public AsyncOperation<Void> deleteKey(String key) {
        entries.invalidate(key);
        return AsyncOperation.success(null);
    }

    /** A literal pattern deletes one key; a terminal {@code *} deletes every key with that prefix. */
    @Override public AsyncOperation<CacheOperationResult<Integer>> deletePattern(String pattern) {
        long started = System.nanoTime();
        int[] removed = {0};
        long[] scanned = {0};
        if (pattern.endsWith("*")) {
            String prefix = pattern.substring(0, pattern.length() - 1);
            for (String key : entries.asMap().keySet()) {
                scanned[0]++;
                if (key.startsWith(prefix) && entries.asMap().remove(key) != null) removed[0]++;
            }
        } else {
            scanned[0] = 1;
            if (entries.asMap().remove(pattern) != null) removed[0] = 1;
        }
        return AsyncOperation.success(CacheOperationResult.complete(removed[0], scanned[0],
                (System.nanoTime() - started) / 1_000_000L));
    }

    @Override public AsyncOperation<CacheOperationResult<Long>> getKeyCount(String pattern) {
        entries.cleanUp();
        long count = entries.asMap().keySet().stream().filter(key -> matches(pattern, key)).count();
        return AsyncOperation.success(CacheOperationResult.complete(count, entries.estimatedSize(), 0));
    }

    @Override public AsyncOperation<CacheOperationResult<Long>> getCacheSize(String pattern) {
        entries.cleanUp();
        long bytes = entries.asMap().entrySet().stream().filter(e -> matches(pattern, e.getKey()))
                .mapToLong(e -> e.getKey().length() + e.getValue().value().length()).sum();
        return AsyncOperation.success(CacheOperationResult.complete(bytes, entries.estimatedSize(), 0));
    }

    private static boolean matches(String pattern, String key) {
        return pattern.endsWith("*") ? key.startsWith(pattern.substring(0, pattern.length() - 1)) : key.equals(pattern);
    }

    boolean contains(String key) { return entries.getIfPresent(key) != null; }

    public long entryCount() { entries.cleanUp(); return entries.estimatedSize(); }

    public long sizeEvictions() { entries.cleanUp(); return sizeEvictions.get(); }

    public long expirations() { entries.cleanUp(); return expirations.get(); }

    public long maxBytes() { return maxBytes; }

    public int maxEntries() { return maxEntries; }

    /** Sum of the stored key and value lengths. */
    public long storedBytes() {
        entries.cleanUp();
        return entries.asMap().entrySet().stream().mapToLong(e -> e.getKey().length() + e.getValue().value().length()).sum();
    }

    @Override public void close() { entries.invalidateAll(); }
}
