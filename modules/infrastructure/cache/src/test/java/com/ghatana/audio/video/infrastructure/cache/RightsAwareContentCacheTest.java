package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.audio.video.infrastructure.cache.RightsAwareContentCache.AuthorityRejectedException;
import com.ghatana.audio.video.infrastructure.cache.RightsAwareContentCache.AuthorityUnavailableException;
import com.ghatana.audio.video.infrastructure.cache.RightsAwareContentCache.Disposition;
import com.ghatana.audio.video.infrastructure.cache.RightsAwareContentCache.Scope;
import com.github.benmanes.caffeine.cache.Ticker;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RightsAwareContentCacheTest {
    private static final String SHA = "a".repeat(64);
    private RightsAwareContentCache cache;

    @BeforeEach
    void open() {
        cache = new RightsAwareContentCache(new RightsAwareContentCache.Config(
                4 * 1024 * 1024, 64, Duration.ofMinutes(5), Duration.ofSeconds(5)));
    }

    @AfterEach
    void close() { cache.close(); }

    private static Scope scope(String tenant, String principal, String artifact, String version, long epoch, String fp, long size) {
        return new Scope(tenant, principal, artifact, version, version.substring(version.length() - 8), size, epoch, fp);
    }

    private static Scope scope(String tenant, String principal, String artifact) {
        return scope(tenant, principal, artifact, "sha256:" + SHA, 0, "none", 5);
    }

    private static RightsAwareContentCache.Loader counting(AtomicInteger loads, String text) {
        return () -> { loads.incrementAndGet(); return text.getBytes(); };
    }

    @Test
    void secondReadIsServedFromCacheAndLoaderRunsOnce() throws Exception {
        AtomicInteger loads = new AtomicInteger();
        var first = cache.get(() -> Optional.of(scope("t1", "p1", "a1")), counting(loads, "hello"));
        var second = cache.get(() -> Optional.of(scope("t1", "p1", "a1")), counting(loads, "hello"));
        assertThat(first.disposition()).isEqualTo(Disposition.MISS);
        assertThat(second.disposition()).isEqualTo(Disposition.HIT);
        assertThat(second.bytes()).isEqualTo("hello".getBytes());
        assertThat(loads).hasValue(1);
        assertThat(cache.stats().hits()).isEqualTo(1);
    }

    @Test
    void otherTenantOrPrincipalNeverHitsAnEntryAndEvenIdenticalIdsAreSeparate() throws Exception {
        AtomicInteger loads = new AtomicInteger();
        cache.get(() -> Optional.of(scope("t1", "p1", "a1")), counting(loads, "tenant-one"));
        var otherTenant = cache.get(() -> Optional.of(scope("t2", "p1", "a1")), counting(loads, "tenant-two"));
        var otherPrincipal = cache.get(() -> Optional.of(scope("t1", "p2", "a1")), counting(loads, "principal-two"));
        assertThat(otherTenant.disposition()).isEqualTo(Disposition.MISS);
        assertThat(new String(otherTenant.bytes())).isEqualTo("tenant-two");
        assertThat(otherPrincipal.disposition()).isEqualTo(Disposition.MISS);
        assertThat(new String(otherPrincipal.bytes())).isEqualTo("principal-two");
        assertThat(loads).hasValue(3);
        // The first scope still reads its own bytes.
        assertThat(new String(cache.get(() -> Optional.of(scope("t1", "p1", "a1")), counting(loads, "x")).bytes()))
                .isEqualTo("tenant-one");
    }

    @Test
    void newSourceVersionNeverServesTheOldEntry() throws Exception {
        AtomicInteger loads = new AtomicInteger();
        String v1 = "sha256:" + "1".repeat(64);
        String v2 = "sha256:" + "2".repeat(64);
        cache.get(() -> Optional.of(scope("t1", "p1", "a1", v1, 0, "none", 2)), counting(loads, "v1"));
        var next = cache.get(() -> Optional.of(scope("t1", "p1", "a1", v2, 0, "none", 2)), counting(loads, "v2"));
        assertThat(next.disposition()).isEqualTo(Disposition.MISS);
        assertThat(new String(next.bytes())).isEqualTo("v2");
    }

    @Test
    void rightsEpochAdvanceOrFingerprintChangeMissesAndEagerInvalidationDropsTheOldEntry() throws Exception {
        AtomicInteger loads = new AtomicInteger();
        String v = "sha256:" + SHA;
        cache.get(() -> Optional.of(scope("t1", "p1", "a1", v, 1, "live:att-1", 3)), counting(loads, "old"));
        assertThat(cache.stats().entries()).isEqualTo(1);
        // The rights writer invalidates synchronously, before the revoke call returns.
        assertThat(cache.invalidateArtifact("t1", "a1")).isEqualTo(1);
        assertThat(cache.stats().entries()).isZero();
        var afterRevoke = cache.get(() -> Optional.of(scope("t1", "p1", "a1", v, 2, "live:", 3)), counting(loads, "new"));
        assertThat(afterRevoke.disposition()).isEqualTo(Disposition.MISS);
        assertThat(new String(afterRevoke.bytes())).isEqualTo("new");
        // Even without eager invalidation a fingerprint change alone addresses a different key (time-based expiry).
        var expired = cache.get(() -> Optional.of(scope("t1", "p1", "a1", v, 2, "live:expired", 3)), counting(loads, "again"));
        assertThat(expired.disposition()).isEqualTo(Disposition.MISS);
    }

    @Test
    void rejectedAuthorityNeverServesCachedBytesAndDoesNotReadTheSource() throws Exception {
        AtomicInteger loads = new AtomicInteger();
        cache.get(() -> Optional.of(scope("t1", "p1", "a1")), counting(loads, "secret"));
        AtomicBoolean visible = new AtomicBoolean(true);
        RightsAwareContentCache.Authority authority = () -> visible.get()
                ? Optional.of(scope("t1", "p1", "a1")) : Optional.empty();
        assertThat(cache.get(authority, counting(loads, "secret")).disposition()).isEqualTo(Disposition.HIT);
        visible.set(false);
        assertThatThrownBy(() -> cache.get(authority, counting(loads, "secret")))
                .isInstanceOf(AuthorityRejectedException.class);
        assertThat(loads).hasValue(1);
    }

    @Test
    void authorityOutageFailsClosedAndTheCacheIsNeverTheFallbackAuthority() throws Exception {
        AtomicInteger loads = new AtomicInteger();
        cache.get(() -> Optional.of(scope("t1", "p1", "a1")), counting(loads, "cached"));
        AtomicBoolean down = new AtomicBoolean(true);
        RightsAwareContentCache.Authority authority = () -> {
            if (down.get()) throw new java.sql.SQLException("rights authority unreachable");
            return Optional.of(scope("t1", "p1", "a1"));
        };
        assertThatThrownBy(() -> cache.get(authority, counting(loads, "cached")))
                .isInstanceOf(AuthorityUnavailableException.class);
        assertThat(loads).hasValue(1);
        down.set(false);
        assertThat(cache.get(authority, counting(loads, "cached")).disposition()).isEqualTo(Disposition.HIT);
        assertThat(cache.stats().unavailable()).isEqualTo(1);
    }

    @Test
    void authorityOutageDuringTheReadBeforeDisclosureAlsoFailsClosed() throws Exception {
        AtomicInteger reads = new AtomicInteger();
        AtomicInteger loads = new AtomicInteger();
        // Read 1 (scope), read 2 (initial readback) succeed; every later read (before write/disclosure) fails.
        RightsAwareContentCache.Authority authority = () -> {
            if (reads.incrementAndGet() > 2) throw new java.sql.SQLException("down");
            return Optional.of(scope("t1", "p1", "a1"));
        };
        assertThatThrownBy(() -> cache.get(authority, counting(loads, "bytes")))
                .isInstanceOf(AuthorityUnavailableException.class);
    }

    @Test
    void revocationLandingWhileTheSourceLoadsIsNotDisclosed() throws Exception {
        CountDownLatch loadStarted = new CountDownLatch(1);
        CountDownLatch revoked = new CountDownLatch(1);
        AtomicLong epoch = new AtomicLong(1);
        RightsAwareContentCache.Authority authority = () ->
                Optional.of(scope("t1", "p1", "a1", "sha256:" + SHA, epoch.get(), "live", 6));
        RightsAwareContentCache.Loader slow = () -> {
            loadStarted.countDown();
            try { revoked.await(5, TimeUnit.SECONDS); } catch (InterruptedException e) { throw new IOException(e); }
            return "secret".getBytes();
        };
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<?> reader = pool.submit(() -> cache.get(authority, slow));
            assertThat(loadStarted.await(5, TimeUnit.SECONDS)).isTrue();
            epoch.incrementAndGet();
            revoked.countDown();
            assertThatThrownBy(reader::get).hasRootCauseInstanceOf(AuthorityRejectedException.class);
        } finally {
            pool.shutdownNow();
        }
        // The stale write is dropped: the next read under the new epoch loads again, and nothing old remains.
        AtomicInteger loads = new AtomicInteger();
        var next = cache.get(authority, counting(loads, "secret"));
        assertThat(next.disposition()).isEqualTo(Disposition.MISS);
        assertThat(loads).hasValue(1);
    }

    @Test
    void restartStartsCold() throws Exception {
        AtomicInteger loads = new AtomicInteger();
        cache.get(() -> Optional.of(scope("t1", "p1", "a1")), counting(loads, "x"));
        cache.close();
        cache = new RightsAwareContentCache(new RightsAwareContentCache.Config(
                4 * 1024 * 1024, 64, Duration.ofMinutes(5), Duration.ofSeconds(5)));
        assertThat(cache.get(() -> Optional.of(scope("t1", "p1", "a1")), counting(loads, "x")).disposition())
                .isEqualTo(Disposition.MISS);
        assertThat(loads).hasValue(2);
    }

    @Test
    void evictionIsBoundedByEntriesAndBytes() throws Exception {
        cache.close();
        cache = new RightsAwareContentCache(new RightsAwareContentCache.Config(
                100_000, 5, Duration.ofMinutes(5), Duration.ofSeconds(5)));
        AtomicInteger loads = new AtomicInteger();
        for (int i = 0; i < 30; i++) {
            String id = "a" + i;
            byte[] payload = new byte[10_000];
            java.util.Arrays.fill(payload, (byte) i);
            cache.get(() -> Optional.of(scope("t1", "p1", id, "sha256:" + SHA, 0, "none", 10_000)),
                    () -> { loads.incrementAndGet(); return payload; });
        }
        var stats = cache.stats();
        assertThat(stats.entries()).isLessThanOrEqualTo(5);
        assertThat(stats.storedBytes()).isLessThanOrEqualTo(100_000);
        assertThat(stats.sizeEvictions()).isGreaterThanOrEqualTo(25);
        // An evicted entry is reloaded, never lost or wrong.
        var again = cache.get(() -> Optional.of(scope("t1", "p1", "a0", "sha256:" + SHA, 0, "none", 10_000)),
                () -> { loads.incrementAndGet(); return new byte[10_000]; });
        assertThat(again.disposition()).isEqualTo(Disposition.MISS);
    }

    @Test
    void ttlExpiresEntries() throws Exception {
        AtomicLong nanos = new AtomicLong();
        Ticker ticker = nanos::get;
        BoundedLocalCacheBackend backend = new BoundedLocalCacheBackend(1_000_000, 10, Duration.ofSeconds(30), ticker);
        backend.setValue("k", "v", 3600).whenComplete((a, b) -> { });
        assertThat(backend.contains("k")).isTrue();
        nanos.addAndGet(Duration.ofSeconds(29).toNanos());
        assertThat(backend.contains("k")).isTrue();
        nanos.addAndGet(Duration.ofSeconds(2).toNanos());
        assertThat(backend.contains("k")).as("the TTL is clamped to the configured maximum, not the requested hour").isFalse();
        assertThat(backend.expirations()).isEqualTo(1);
    }

    @Test
    void stampedeLoadsOnceAndEveryAuthorizedWaiterGetsTheSameBytes() throws Exception {
        int callers = 24;
        AtomicInteger loads = new AtomicInteger();
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch loading = new CountDownLatch(1);
        RightsAwareContentCache.Loader slow = () -> {
            loads.incrementAndGet();
            loading.countDown();
            try { release.await(10, TimeUnit.SECONDS); } catch (InterruptedException e) { throw new IOException(e); }
            return "shared".getBytes();
        };
        ExecutorService pool = Executors.newFixedThreadPool(callers);
        try {
            List<Future<RightsAwareContentCache.Result>> futures = new ArrayList<>();
            futures.add(pool.submit(() -> cache.get(() -> Optional.of(scope("t1", "p1", "a1")), slow)));
            assertThat(loading.await(5, TimeUnit.SECONDS)).isTrue();
            for (int i = 1; i < callers; i++) {
                futures.add(pool.submit(() -> cache.get(() -> Optional.of(scope("t1", "p1", "a1")), slow)));
            }
            Thread.sleep(300);
            release.countDown();
            for (var future : futures) assertThat(new String(future.get(10, TimeUnit.SECONDS).bytes())).isEqualTo("shared");
        } finally {
            pool.shutdownNow();
        }
        assertThat(loads).as("N concurrent misses for one key compute once").hasValue(1);
        assertThat(cache.stats().misses()).isEqualTo(1);
        assertThat(cache.stats().hits()).isEqualTo(callers - 1);
    }

    @Test
    void anUnauthorizedWaiterNeverReceivesAnotherCallersInFlightResult() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch loading = new CountDownLatch(1);
        AtomicInteger loads = new AtomicInteger();
        RightsAwareContentCache.Loader slow = () -> {
            loads.incrementAndGet();
            loading.countDown();
            try { release.await(10, TimeUnit.SECONDS); } catch (InterruptedException e) { throw new IOException(e); }
            return "owner-secret".getBytes();
        };
        ExecutorService pool = Executors.newFixedThreadPool(4);
        try {
            Future<RightsAwareContentCache.Result> owner = pool.submit(
                    () -> cache.get(() -> Optional.of(scope("t1", "owner", "a1")), slow));
            assertThat(loading.await(5, TimeUnit.SECONDS)).isTrue();
            // A second principal (same tenant, same artifact id) whose authority rejects, and another tenant.
            Future<?> denied = pool.submit(() -> cache.get(Optional::empty, slow));
            Future<RightsAwareContentCache.Result> otherTenant = pool.submit(() ->
                    cache.get(() -> Optional.of(scope("t2", "owner", "a1")), () -> "other-tenant".getBytes()));
            assertThatThrownBy(() -> denied.get(5, TimeUnit.SECONDS)).hasRootCauseInstanceOf(AuthorityRejectedException.class);
            assertThat(new String(otherTenant.get(5, TimeUnit.SECONDS).bytes())).isEqualTo("other-tenant");
            release.countDown();
            assertThat(new String(owner.get(5, TimeUnit.SECONDS).bytes())).isEqualTo("owner-secret");
        } finally {
            pool.shutdownNow();
        }
        assertThat(loads).hasValue(1);
    }

    @Test
    void invalidateTenantDropsOnlyThatTenant() throws Exception {
        AtomicInteger loads = new AtomicInteger();
        cache.get(() -> Optional.of(scope("t1", "p1", "a1")), counting(loads, "one"));
        cache.get(() -> Optional.of(scope("t1", "p1", "a2")), counting(loads, "two"));
        cache.get(() -> Optional.of(scope("t2", "p1", "a1")), counting(loads, "other"));
        assertThat(cache.stats().entries()).isEqualTo(3);
        cache.invalidateTenant("t1");
        assertThat(cache.stats().entries()).isEqualTo(1);
        assertThat(cache.get(() -> Optional.of(scope("t2", "p1", "a1")), counting(loads, "other")).disposition())
                .isEqualTo(Disposition.HIT);
        assertThat(cache.get(() -> Optional.of(scope("t1", "p1", "a1")), counting(loads, "one")).disposition())
                .isEqualTo(Disposition.MISS);
    }

    @Test
    void sourceFailureCachesNothingAndOversizedSourcesBypass() throws Exception {
        assertThatThrownBy(() -> cache.get(() -> Optional.of(scope("t1", "p1", "a1")),
                () -> { throw new IOException("source integrity failed"); })).isInstanceOf(IOException.class);
        assertThat(cache.stats().entries()).isZero();
        AtomicInteger loads = new AtomicInteger();
        long big = RightsAwareContentCache.MAX_ENTRY_BYTES + 1L;
        var first = cache.get(() -> Optional.of(scope("t1", "p1", "big", "sha256:" + SHA, 0, "none", big)),
                counting(loads, "payload"));
        var second = cache.get(() -> Optional.of(scope("t1", "p1", "big", "sha256:" + SHA, 0, "none", big)),
                counting(loads, "payload"));
        assertThat(first.disposition()).isEqualTo(Disposition.BYPASS);
        assertThat(second.disposition()).isEqualTo(Disposition.BYPASS);
        assertThat(loads).hasValue(2);
        assertThat(cache.stats().entries()).isZero();
    }

    @Test
    void returnedBytesAreACopy() throws Exception {
        AtomicReference<byte[]> source = new AtomicReference<>("abc".getBytes());
        var first = cache.get(() -> Optional.of(scope("t1", "p1", "a1")), source::get);
        first.bytes()[0] = 'z';
        var second = cache.get(() -> Optional.of(scope("t1", "p1", "a1")), source::get);
        assertThat(new String(second.bytes())).isEqualTo("abc");
    }
}
