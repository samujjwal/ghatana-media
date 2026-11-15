package com.ghatana.media.launcher;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.InMemoryMediaRequestLedger;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Key;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class MediaDevRequestLedgerTest {
    private static final String LANE = "test.lane";

    private static final class MutableClock extends Clock {
        private volatile Instant now = Instant.parse("2026-11-14T00:00:00Z");
        @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
        void advance(Duration by) { now = now.plus(by); }
    }

    private static List<OutputRef> refs(String result) {
        return List.of(new OutputRef("result", result, "v1"));
    }

    private static final class Reused extends IllegalStateException { }

    private static String run(MediaDevRequestLedger ledger, String fingerprint, AtomicInteger runs, String output) {
        return ledger.run("t", "p", LANE, "req-1", fingerprint,
                outputs -> "replayed:" + outputs.getFirst().artifactId(),
                () -> { runs.incrementAndGet(); return output; },
                MediaDevRequestLedgerTest::refs, Reused::new);
    }

    @Test
    void aRetryAfterSuccessReplaysTheStoredOutputEvenWhenTheModelWouldProduceDifferentBytes() {
        MediaDevRequestLedger ledger = MediaDevRequestLedger.inMemory();
        AtomicInteger runs = new AtomicInteger();
        String fp = MediaDevRequestLedger.fingerprint("v1", "artifact", "v", 3);
        assertThat(run(ledger, fp, runs, "first-output")).isEqualTo("first-output");
        // The nondeterministic model would now answer differently; the ledger never asks it.
        assertThat(run(ledger, fp, runs, "different-output")).isEqualTo("replayed:first-output");
        assertThat(runs.get()).isEqualTo(1);
    }

    @Test
    void aDifferentFingerprintUnderTheSameRequestIdIsRefusedAndNothingRuns() {
        MediaDevRequestLedger ledger = MediaDevRequestLedger.inMemory();
        AtomicInteger runs = new AtomicInteger();
        run(ledger, MediaDevRequestLedger.fingerprint("v1", "a"), runs, "one");
        assertThatThrownBy(() -> run(ledger, MediaDevRequestLedger.fingerprint("v1", "b"), runs, "two"))
                .isInstanceOf(Reused.class);
        assertThat(runs.get()).isEqualTo(1);
    }

    @Test
    void aFailedRunReleasesTheClaimSoTheRetryRunsAgainAndNothingWasRecorded() {
        MediaDevRequestLedger ledger = MediaDevRequestLedger.inMemory();
        String fp = MediaDevRequestLedger.fingerprint("v1", "a");
        assertThatThrownBy(() -> ledger.run("t", "p", LANE, "req-1", fp, outputs -> "r",
                () -> { throw new IllegalStateException("model killed"); }, MediaDevRequestLedgerTest::refs, Reused::new))
                .isInstanceOf(IllegalStateException.class).hasMessage("model killed");
        AtomicInteger runs = new AtomicInteger();
        assertThat(run(ledger, fp, runs, "second-attempt")).isEqualTo("second-attempt");
        assertThat(runs.get()).isEqualTo(1);
    }

    @Test
    void aLiveLeaseIsReportedInProgressAfterTheBoundedWaitAndAStaleLeaseIsTakenOver() {
        MutableClock clock = new MutableClock();
        InMemoryMediaRequestLedger store = new InMemoryMediaRequestLedger(clock);
        MediaDevRequestLedger ledger = new MediaDevRequestLedger(store, Duration.ofSeconds(60), Duration.ZERO, false);
        String fp = MediaDevRequestLedger.fingerprint("v1", "a");
        // A crashed owner claimed the key and never completed it.
        store.claim(new Key("t", "p", LANE, "req-1"), fp, "crashed-launcher", Duration.ofSeconds(60));
        AtomicInteger runs = new AtomicInteger();
        assertThatThrownBy(() -> run(ledger, fp, runs, "x"))
                .isInstanceOfSatisfying(MediaDevRequestLedger.LedgerRefusedException.class, refused -> {
                    assertThat(refused.status()).isEqualTo(409);
                    assertThat(refused.code()).isEqualTo("REQUEST_IN_PROGRESS");
                });
        assertThat(runs.get()).isZero();
        clock.advance(Duration.ofSeconds(61));
        assertThat(run(ledger, fp, runs, "takeover-output")).isEqualTo("takeover-output");
        assertThat(runs.get()).isEqualTo(1);
        assertThat(run(ledger, fp, runs, "ignored")).isEqualTo("replayed:takeover-output");
        assertThat(runs.get()).isEqualTo(1);
    }

    @Test
    void concurrentCallsWithTheSameKeyRunTheModelExactlyOnceAndTheOthersReplayIt() throws Exception {
        MediaDevRequestLedger ledger = new MediaDevRequestLedger(new InMemoryMediaRequestLedger(),
                Duration.ofMinutes(5), Duration.ofSeconds(20), false);
        String fp = MediaDevRequestLedger.fingerprint("v1", "a");
        AtomicInteger runs = new AtomicInteger();
        int callers = 12;
        ExecutorService pool = Executors.newFixedThreadPool(callers);
        try {
            CountDownLatch start = new CountDownLatch(1);
            List<Future<String>> results = new ArrayList<>();
            for (int i = 0; i < callers; i++) {
                results.add(pool.submit(() -> {
                    start.await();
                    return ledger.run("t", "p", LANE, "req-1", fp, outputs -> "replayed",
                            () -> {
                                runs.incrementAndGet();
                                try { Thread.sleep(300); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                                return "produced";
                            }, MediaDevRequestLedgerTest::refs, Reused::new);
                }));
            }
            start.countDown();
            int produced = 0;
            int replayed = 0;
            for (Future<String> result : results) {
                String value = result.get();
                if ("produced".equals(value)) produced++;
                if ("replayed".equals(value)) replayed++;
            }
            assertThat(runs.get()).isEqualTo(1);
            assertThat(produced).isEqualTo(1);
            assertThat(replayed).isEqualTo(callers - 1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void theKeyIsScopedToTenantAndPrincipal() {
        MediaDevRequestLedger ledger = MediaDevRequestLedger.inMemory();
        String fp = MediaDevRequestLedger.fingerprint("v1", "a");
        AtomicInteger runs = new AtomicInteger();
        ledger.run("t", "p", LANE, "req-1", fp, o -> "replayed", () -> { runs.incrementAndGet(); return "one"; },
                MediaDevRequestLedgerTest::refs, Reused::new);
        assertThat(ledger.run("t", "other", LANE, "req-1", fp, o -> "replayed",
                () -> { runs.incrementAndGet(); return "two"; }, MediaDevRequestLedgerTest::refs, Reused::new))
                .isEqualTo("two");
        assertThat(ledger.run("other", "p", LANE, "req-1", fp, o -> "replayed",
                () -> { runs.incrementAndGet(); return "three"; }, MediaDevRequestLedgerTest::refs, Reused::new))
                .isEqualTo("three");
        assertThat(runs.get()).isEqualTo(3);
    }

    @Test
    void anUnreadableRegisteredOutputIsATypedRefusalNotARerun() {
        MediaDevRequestLedger ledger = MediaDevRequestLedger.inMemory();
        String fp = MediaDevRequestLedger.fingerprint("v1", "a");
        ledger.run("t", "p", LANE, "req-1", fp, o -> "r", () -> "first", MediaDevRequestLedgerTest::refs, Reused::new);
        AtomicInteger runs = new AtomicInteger();
        assertThatThrownBy(() -> ledger.run("t", "p", LANE, "req-1", fp,
                o -> { throw MediaDevRequestLedger.outputUnavailable(LANE); },
                () -> { runs.incrementAndGet(); return "second"; }, MediaDevRequestLedgerTest::refs, Reused::new))
                .isInstanceOfSatisfying(MediaDevRequestLedger.LedgerRefusedException.class,
                        refused -> assertThat(refused.code()).isEqualTo("REQUEST_OUTPUT_UNAVAILABLE"));
        assertThat(runs.get()).isZero();
    }

    @Test
    void fingerprintsAreLengthPrefixedSoPartBoundariesCannotCollide() {
        assertThat(MediaDevRequestLedger.fingerprint("v", "ab", "c")).isNotEqualTo(MediaDevRequestLedger.fingerprint("v", "a", "bc"));
        assertThat(MediaDevRequestLedger.fingerprint("v", "a")).isEqualTo(MediaDevRequestLedger.fingerprint("v", "a"));
        assertThat(MediaDevRequestLedger.fingerprint("v", (Object) null)).isNotEqualTo(MediaDevRequestLedger.fingerprint("v", "null"));
    }

    @Test
    void compositionHonoursTheBackendSelectorAndBounds() {
        assertThat(MediaDevRequestLedger.compose(Map.of(MediaDevRequestLedger.ENV_BACKEND, "memory")).durable()).isFalse();
        assertThat(MediaDevRequestLedger.compose(Map.of()).durable()).isFalse();
        assertThatThrownBy(() -> MediaDevRequestLedger.compose(Map.of(MediaDevRequestLedger.ENV_BACKEND, "mongo")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MediaDevRequestLedger.compose(Map.of(MediaDevRequestLedger.ENV_BACKEND, "memory",
                MediaDevRequestLedger.ENV_LEASE_SECONDS, "1")))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
