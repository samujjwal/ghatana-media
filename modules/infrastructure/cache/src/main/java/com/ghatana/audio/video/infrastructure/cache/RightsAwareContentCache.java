package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.audio.video.infrastructure.cache.AudioVideoCache.CacheKeyScope;
import com.ghatana.audio.video.infrastructure.cache.AudioVideoCache.ScopedAuthorityResult;
import com.ghatana.cache.DistributedCacheService;
import com.ghatana.core.async.AsyncOperation;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Rights-aware cache of verified, immutable artifact bytes, composed over {@link AudioVideoCache} (scoped authority
 * readback, single-flight, epoch fencing) and a {@link BoundedLocalCacheBackend}.
 *
 * <p>The cache is an optimisation and never an authority:</p>
 * <ul>
 *   <li>every entry is keyed by tenant, authenticated principal, exact artifact version and digest, and the rights
 *       state of that version (a monotonically increasing rights epoch plus a fingerprint of the statements that
 *       are live at read time), so a new source version or any rights change addresses a different key;</li>
 *   <li>every call, hit or miss, first reads the owning authority; a rejected or unreachable authority fails closed
 *       (no cached bytes are returned and no source is read), and the authority is read again immediately before
 *       disclosure, so a revocation that lands during a load or between lookup and release is not served;</li>
 *   <li>concurrent misses for one key load once; every waiter has passed its own authority readback and is
 *       re-checked before it receives the shared result;</li>
 *   <li>memory is bounded by total bytes and entry count, and entries expire after a short TTL;</li>
 *   <li>a restart starts empty; {@link #invalidateArtifact}, {@link #invalidateTenant} drop entries eagerly.</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Tenant, principal, version and rights-epoch scoped cache of verified artifact content
 * @doc.layer infrastructure
 * @doc.pattern Cache
 */
public final class RightsAwareContentCache implements AutoCloseable {
    /** Raw payloads are stored as base64 text, which the Shared cache policy bounds at 1 MiB of characters. */
    public static final int MAX_ENTRY_BYTES = (com.ghatana.cache.CachePolicy.MAX_VALUE_LENGTH / 4) * 3;

    /** Exact authority-owned identity of one cacheable read. */
    public record Scope(String tenantId, String principalId, String artifactId, String artifactVersion,
                        String sha256, long sizeBytes, long rightsEpoch, String rightsFingerprint) {
        public Scope {
            Objects.requireNonNull(tenantId, "tenantId");
            Objects.requireNonNull(principalId, "principalId");
            Objects.requireNonNull(artifactId, "artifactId");
            Objects.requireNonNull(artifactVersion, "artifactVersion");
            Objects.requireNonNull(sha256, "sha256");
            Objects.requireNonNull(rightsFingerprint, "rightsFingerprint");
            if (sizeBytes < 0 || rightsEpoch < 0) throw new IllegalArgumentException("size and epoch must not be negative");
        }
    }

    /** Reads the current owning-authority view of the requested source; empty means no longer visible. */
    @FunctionalInterface
    public interface Authority { Optional<Scope> readCurrent() throws Exception; }

    /** Reads and verifies the source bytes (called only on a miss, once per key across concurrent callers). */
    @FunctionalInterface
    public interface Loader { byte[] load() throws IOException; }

    public enum Disposition { HIT, MISS, BYPASS }

    public record Result(byte[] bytes, Disposition disposition) { }

    /** The owning authority no longer exposes this source to the caller. */
    public static final class AuthorityRejectedException extends RuntimeException {
        public AuthorityRejectedException(String message) { super(message, null, false, false); }
    }

    /** The owning authority could not be read; the cache never stands in for it. */
    public static final class AuthorityUnavailableException extends RuntimeException {
        public AuthorityUnavailableException(String message, Throwable cause) { super(message, cause, false, false); }
    }

    public record Stats(long requests, long hits, long misses, long bypasses, long rejected, long unavailable,
                        long loadFailures, long entries, long storedBytes, long sizeEvictions, long expirations) { }

    public record Config(long maxBytes, int maxEntries, Duration ttl, Duration authorityTimeout) {
        public Config {
            if (maxBytes < 1 || maxEntries < 1) throw new IllegalArgumentException("maxBytes and maxEntries must be positive");
            Objects.requireNonNull(ttl, "ttl");
            Objects.requireNonNull(authorityTimeout, "authorityTimeout");
        }
    }

    private static final String NAMESPACE = "artifact-content";
    private static final Duration LOAD_WAIT = Duration.ofSeconds(120);

    private final Config config;
    private final Clock clock;
    private final BoundedLocalCacheBackend backend;
    private final ConcurrentHashMap<String, AudioVideoCache<String, String>> tenantCaches = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, DistributedCacheService> tenantServices = new ConcurrentHashMap<>();
    /** Key to exact scope, so eager invalidation can name the scoped keys; pruned against the backend. */
    private final ConcurrentHashMap<String, Indexed> index = new ConcurrentHashMap<>();
    private final ExecutorService loadExecutor = Executors.newFixedThreadPool(4, runnable -> {
        Thread thread = new Thread(runnable, "media-content-cache-load");
        thread.setDaemon(true);
        return thread;
    });
    private final AtomicLong requests = new AtomicLong();
    private final AtomicLong hits = new AtomicLong();
    private final AtomicLong misses = new AtomicLong();
    private final AtomicLong bypasses = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();
    private final AtomicLong unavailable = new AtomicLong();
    private final AtomicLong loadFailures = new AtomicLong();

    private record Indexed(String tenantId, String artifactId, CacheKeyScope scope, String backendKey) { }

    public RightsAwareContentCache(Config config) {
        this(config, Clock.systemUTC());
    }

    RightsAwareContentCache(Config config, Clock clock) {
        this.config = Objects.requireNonNull(config, "config");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.backend = new BoundedLocalCacheBackend(config.maxBytes(), config.maxEntries(), config.ttl());
    }

    /**
     * Returns the verified bytes of the source the authority currently exposes.
     *
     * @throws AuthorityRejectedException   the source is no longer visible to the caller or its authority changed
     * @throws AuthorityUnavailableException the authority could not be read
     * @throws IOException                  the loader failed (nothing is cached)
     */
    public Result get(Authority authority, Loader loader) throws IOException {
        Objects.requireNonNull(authority, "authority");
        Objects.requireNonNull(loader, "loader");
        requests.incrementAndGet();
        Scope current = readAuthority(authority);
        CacheKeyScope keyScope = keyScope(current);
        if (current.sizeBytes() > MAX_ENTRY_BYTES) {
            bypasses.incrementAndGet();
            byte[] bytes = loader.load();
            requireUnchanged(authority, current);
            return new Result(bytes, Disposition.BYPASS);
        }
        AudioVideoCache<String, String> cache = cacheFor(current.tenantId());
        String backendKey = backendKey(current.tenantId(), cache.buildScopedKey(keyScope));
        index.put(backendKey, new Indexed(current.tenantId(), current.artifactId(), keyScope, backendKey));
        AtomicBoolean loaded = new AtomicBoolean();
        AtomicBoolean authorityUnknown = new AtomicBoolean();
        AsyncOperation<String> operation = cache.getOrLoadScopedWithAuthority(keyScope,
                requested -> scopedAuthority(authority, requested, authorityUnknown),
                key -> {
                    loaded.set(true);
                    CompletableFuture<String> future = new CompletableFuture<>();
                    try {
                        loadExecutor.execute(() -> {
                            try {
                                future.complete(Base64.getEncoder().encodeToString(loader.load()));
                            } catch (Throwable failure) {
                                future.completeExceptionally(failure);
                            }
                        });
                    } catch (RuntimeException saturated) {
                        future.completeExceptionally(saturated);
                    }
                    return AsyncOperation.from(future);
                });
        CompletableFuture<String> outcome = new CompletableFuture<>();
        operation.whenComplete((value, failure) -> {
            if (failure == null) outcome.complete(value);
            else outcome.completeExceptionally(failure);
        });
        try {
            String encoded = outcome.get(LOAD_WAIT.toMillis(), TimeUnit.MILLISECONDS);
            if (encoded == null) throw new IOException("cache load produced no content");
            Disposition disposition = loaded.get() ? Disposition.MISS : Disposition.HIT;
            (loaded.get() ? misses : hits).incrementAndGet();
            pruneIndex();
            return new Result(Base64.getDecoder().decode(encoded), disposition);
        } catch (ExecutionException failure) {
            Throwable cause = rootCause(failure);
            if (cause instanceof SecurityException) {
                if (authorityUnknown.get()) {
                    unavailable.incrementAndGet();
                    throw new AuthorityUnavailableException("owning authority could not be read", cause);
                }
                rejected.incrementAndGet();
                throw new AuthorityRejectedException("owning authority no longer exposes this source");
            }
            loadFailures.incrementAndGet();
            index.remove(backendKey);
            if (cause instanceof IOException io) throw new IOException(io.getMessage(), io);
            if (cause instanceof RuntimeException runtime) throw runtime;
            throw new IOException("cache load failed", cause);
        } catch (TimeoutException timeout) {
            loadFailures.incrementAndGet();
            throw new IOException("cache load timed out", timeout);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("cache read interrupted", interrupted);
        }
    }

    /** Drops every entry of one artifact. Returns the number of keys dropped; fails if one cannot be dropped. */
    public int invalidateArtifact(String tenantId, String artifactId) {
        int dropped = 0;
        for (Indexed entry : index.values()) {
            if (!entry.tenantId().equals(tenantId) || !entry.artifactId().equals(artifactId)) continue;
            retry(() -> await(cacheFor(tenantId).invalidateScoped(entry.scope())));
            index.remove(entry.backendKey());
            dropped++;
        }
        return dropped;
    }

    /** Drops every entry of one tenant (used by erasure). Throws when the tenant could not be cleared. */
    public void invalidateTenant(String tenantId) {
        retry(() -> await(cacheFor(tenantId).invalidateAll()));
        index.values().removeIf(entry -> entry.tenantId().equals(tenantId));
    }

    public Stats stats() {
        return new Stats(requests.get(), hits.get(), misses.get(), bypasses.get(), rejected.get(), unavailable.get(),
                loadFailures.get(), backend.entryCount(), backend.storedBytes(), backend.sizeEvictions(),
                backend.expirations());
    }

    BoundedLocalCacheBackend backend() { return backend; }

    @Override public void close() {
        loadExecutor.shutdownNow();
        backend.close();
        tenantServices.values().forEach(DistributedCacheService::close);
    }

    private Scope readAuthority(Authority authority) {
        final Optional<Scope> current;
        try {
            current = authority.readCurrent();
        } catch (Exception failure) {
            unavailable.incrementAndGet();
            throw new AuthorityUnavailableException("owning authority could not be read", failure);
        }
        if (current == null || current.isEmpty()) {
            rejected.incrementAndGet();
            throw new AuthorityRejectedException("owning authority does not expose this source");
        }
        return current.get();
    }

    private void requireUnchanged(Authority authority, Scope expected) {
        Scope again = readAuthority(authority);
        if (!expected.equals(again)) {
            rejected.incrementAndGet();
            throw new AuthorityRejectedException("owning authority changed before disclosure");
        }
    }

    private AsyncOperation<ScopedAuthorityResult> scopedAuthority(
            Authority authority, CacheKeyScope requested, AtomicBoolean authorityUnknown) {
        try {
            Optional<Scope> current = authority.readCurrent();
            if (current == null || current.isEmpty()) return AsyncOperation.success(ScopedAuthorityResult.rejected(null));
            CacheKeyScope currentScope = keyScope(current.get());
            return AsyncOperation.success(ScopedAuthorityResult.current(currentScope,
                    clock.instant().plus(config.authorityTimeout())));
        } catch (Exception failure) {
            authorityUnknown.set(true);
            return AsyncOperation.success(ScopedAuthorityResult.unknown());
        }
    }

    private static CacheKeyScope keyScope(Scope scope) {
        return new CacheKeyScope(scope.tenantId(), scope.principalId(), "owner-read", "artifact-content-read",
                "dev-artifact", scope.artifactId(), scope.artifactVersion(), "n/a", scope.sha256(),
                scope.rightsFingerprint(), "n/a", scope.rightsEpoch());
    }

    private AudioVideoCache<String, String> cacheFor(String tenantId) {
        return tenantCaches.computeIfAbsent(tenantId, tenant -> {
            String cacheTenant = "t" + sha256Hex(tenant).substring(0, 32);
            DistributedCacheService service = new DistributedCacheService(backend, cacheTenant,
                    DistributedCacheService.BackendOwnership.BORROWED);
            tenantServices.put(tenant, service);
            return new AudioVideoCache<>(service, NAMESPACE, config.authorityTimeout().multipliedBy(2), clock);
        });
    }

    private String backendKey(String tenantId, String scopedKey) {
        return "tenant:t" + sha256Hex(tenantId).substring(0, 32) + ":" + scopedKey;
    }

    private void pruneIndex() {
        if (index.size() <= config.maxEntries() * 2L) return;
        for (Map.Entry<String, Indexed> entry : index.entrySet()) {
            if (!backend.contains(entry.getKey())) index.remove(entry.getKey(), entry.getValue());
        }
    }

    private static void await(AsyncOperation<Void> operation) {
        CompletableFuture<Void> done = new CompletableFuture<>();
        operation.whenComplete((ignored, failure) -> {
            if (failure == null) done.complete(null);
            else done.completeExceptionally(failure);
        });
        try {
            done.get(10, TimeUnit.SECONDS);
        } catch (ExecutionException | TimeoutException | InterruptedException failure) {
            if (failure instanceof InterruptedException) Thread.currentThread().interrupt();
            throw new IllegalStateException("cache invalidation did not complete", failure);
        }
    }

    /** Invalidation can briefly collide with an active load or write of the same key; retry before failing. */
    private static void retry(Runnable invalidation) {
        IllegalStateException last = null;
        for (int attempt = 0; attempt < 40; attempt++) {
            try {
                invalidation.run();
                return;
            } catch (IllegalStateException failure) {
                last = failure;
                try { Thread.sleep(50); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); break; }
            }
        }
        throw last == null ? new IllegalStateException("cache invalidation interrupted") : last;
    }

    private static Throwable rootCause(Throwable failure) {
        Throwable cause = failure;
        while ((cause instanceof ExecutionException || cause instanceof java.util.concurrent.CompletionException)
                && cause.getCause() != null) {
            cause = cause.getCause();
        }
        return cause;
    }

    private static String sha256Hex(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
