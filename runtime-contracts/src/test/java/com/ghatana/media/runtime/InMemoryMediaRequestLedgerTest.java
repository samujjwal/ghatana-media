package com.ghatana.media.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.MediaRequestLedgerContracts.Acquired;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Claim;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.InProgress;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Key;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Mismatch;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Replay;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.State;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;

class InMemoryMediaRequestLedgerTest {
    private static final String FP_A = "a".repeat(64);
    private static final String FP_B = "b".repeat(64);
    private static final Duration LEASE = Duration.ofSeconds(60);
    private static final Key KEY = new Key("tenant-1", "principal-1", "speech.transcribe", "req-1");
    private static final List<OutputRef> OUT = List.of(new OutputRef("transcript", "artifact-1", "sha256:" + "c".repeat(64)));

    private static final class MutableClock extends Clock {
        private Instant now = Instant.parse("2026-11-14T00:00:00Z");
        @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
        void advance(Duration by) { now = now.plus(by); }
    }

    @Test
    void firstClaimAcquiresCompletionStoresTheOutputAndALaterClaimReplaysIt() {
        InMemoryMediaRequestLedger ledger = new InMemoryMediaRequestLedger();
        Claim first = ledger.claim(KEY, FP_A, "w1", LEASE);
        assertThat(first).isEqualTo(new Acquired(1, 1, false));
        assertThat(ledger.complete(KEY, 1, OUT)).isTrue();
        assertThat(ledger.claim(KEY, FP_A, "w2", LEASE)).isEqualTo(new Replay(OUT));
        assertThat(ledger.find(KEY).orElseThrow().state()).isEqualTo(State.COMPLETED);
    }

    @Test
    void aDifferentFingerprintIsAMismatchInEveryState() {
        InMemoryMediaRequestLedger ledger = new InMemoryMediaRequestLedger();
        ledger.claim(KEY, FP_A, "w1", LEASE);
        assertThat(ledger.claim(KEY, FP_B, "w2", LEASE)).isInstanceOf(Mismatch.class);
        ledger.complete(KEY, 1, OUT);
        assertThat(ledger.claim(KEY, FP_B, "w2", LEASE)).isInstanceOf(Mismatch.class);
        assertThat(ledger.claim(KEY, FP_A, "w2", LEASE)).isEqualTo(new Replay(OUT));
    }

    @Test
    void aLiveLeaseIsInProgressAndAStaleLeaseIsTakenOverUnderAHigherFence() {
        MutableClock clock = new MutableClock();
        InMemoryMediaRequestLedger ledger = new InMemoryMediaRequestLedger(clock);
        assertThat(ledger.claim(KEY, FP_A, "crashed", LEASE)).isEqualTo(new Acquired(1, 1, false));
        clock.advance(Duration.ofSeconds(30));
        assertThat(ledger.claim(KEY, FP_A, "other", LEASE)).isInstanceOf(InProgress.class);
        clock.advance(Duration.ofSeconds(31));
        assertThat(ledger.claim(KEY, FP_A, "other", LEASE)).isEqualTo(new Acquired(2, 2, true));
        // The superseded owner can neither complete nor release: nothing is recorded twice.
        assertThat(ledger.complete(KEY, 1, OUT)).isFalse();
        assertThat(ledger.release(KEY, 1, "late")).isFalse();
        assertThat(ledger.complete(KEY, 2, OUT)).isTrue();
        assertThat(ledger.claim(KEY, FP_A, "third", LEASE)).isEqualTo(new Replay(OUT));
    }

    @Test
    void aStaleLeaseCannotBeTakenOverByADifferentRequest() {
        MutableClock clock = new MutableClock();
        InMemoryMediaRequestLedger ledger = new InMemoryMediaRequestLedger(clock);
        ledger.claim(KEY, FP_A, "crashed", LEASE);
        clock.advance(Duration.ofSeconds(120));
        assertThat(ledger.claim(KEY, FP_B, "other", LEASE)).isInstanceOf(Mismatch.class);
    }

    @Test
    void aReleasedRunMayBeClaimedAgainWithAHigherFence() {
        InMemoryMediaRequestLedger ledger = new InMemoryMediaRequestLedger();
        ledger.claim(KEY, FP_A, "w1", LEASE);
        assertThat(ledger.release(KEY, 1, "SPEECH_OUTCOME_UNKNOWN")).isTrue();
        assertThat(ledger.claim(KEY, FP_A, "w1", LEASE)).isEqualTo(new Acquired(2, 2, false));
        assertThat(ledger.complete(KEY, 2, OUT)).isTrue();
    }

    @Test
    void reclaimIsACompareAndSetOnTheNamedOwnerAndFence() {
        InMemoryMediaRequestLedger ledger = new InMemoryMediaRequestLedger();
        ledger.claim(KEY, FP_A, "dead-owner", LEASE);
        // Wrong owner or wrong fence: behaves as a plain claim, i.e. the live lease holds.
        assertThat(ledger.reclaim(KEY, FP_A, "someone-else", 1, "me", LEASE)).isInstanceOf(InProgress.class);
        assertThat(ledger.reclaim(KEY, FP_A, "dead-owner", 7, "me", LEASE)).isInstanceOf(InProgress.class);
        assertThat(ledger.reclaim(KEY, FP_B, "dead-owner", 1, "me", LEASE)).isInstanceOf(Mismatch.class);
        assertThat(ledger.reclaim(KEY, FP_A, "dead-owner", 1, "me", LEASE)).isEqualTo(new Acquired(2, 2, true));
        assertThat(ledger.complete(KEY, 1, OUT)).isFalse();
        assertThat(ledger.complete(KEY, 2, OUT)).isTrue();
        InMemoryMediaRequestLedger other = new InMemoryMediaRequestLedger();
        other.claim(KEY, FP_A, "first", LEASE);
        InProgress shown = (InProgress) other.claim(KEY, FP_A, "second", LEASE);
        assertThat(shown.leaseOwner()).isEqualTo("first");
        assertThat(shown.fence()).isEqualTo(1);
    }

    @Test
    void theKeyIncludesTenantPrincipalAndLane() {
        InMemoryMediaRequestLedger ledger = new InMemoryMediaRequestLedger();
        ledger.claim(KEY, FP_A, "w1", LEASE);
        ledger.complete(KEY, 1, OUT);
        for (Key other : List.of(new Key("tenant-2", "principal-1", "speech.transcribe", "req-1"),
                new Key("tenant-1", "principal-2", "speech.transcribe", "req-1"),
                new Key("tenant-1", "principal-1", "speech.synthesize", "req-1"))) {
            assertThat(ledger.claim(other, FP_B, "w", LEASE)).isEqualTo(new Acquired(1, 1, false));
        }
    }

    @Test
    void concurrentClaimsOfOneKeyGiveTheRunToExactlyOneCaller() throws Exception {
        InMemoryMediaRequestLedger ledger = new InMemoryMediaRequestLedger();
        int callers = 16;
        ExecutorService pool = Executors.newFixedThreadPool(callers);
        try {
            CountDownLatch start = new CountDownLatch(1);
            List<Future<Claim>> results = new ArrayList<>();
            for (int i = 0; i < callers; i++) {
                String owner = "w" + i;
                results.add(pool.submit(() -> {
                    start.await();
                    return ledger.claim(KEY, FP_A, owner, LEASE);
                }));
            }
            start.countDown();
            int acquired = 0;
            int inProgress = 0;
            for (Future<Claim> result : results) {
                Claim claim = result.get();
                if (claim instanceof Acquired) acquired++;
                if (claim instanceof InProgress) inProgress++;
            }
            assertThat(acquired).isEqualTo(1);
            assertThat(inProgress).isEqualTo(callers - 1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void invalidInputsAreRefused() {
        InMemoryMediaRequestLedger ledger = new InMemoryMediaRequestLedger();
        assertThatThrownBy(() -> ledger.claim(KEY, "not-a-digest", "w", LEASE)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ledger.claim(KEY, FP_A, "w", Duration.ZERO)).isInstanceOf(IllegalArgumentException.class);
        ledger.claim(KEY, FP_A, "w", LEASE);
        assertThatThrownBy(() -> ledger.complete(KEY, 1, List.of())).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Key("", "p", "l", "r")).isInstanceOf(IllegalArgumentException.class);
        ledger.close();
        assertThat(ledger.ready()).isFalse();
        assertThatThrownBy(() -> ledger.claim(KEY, FP_A, "w", LEASE)).isInstanceOf(IllegalStateException.class);
    }
}
