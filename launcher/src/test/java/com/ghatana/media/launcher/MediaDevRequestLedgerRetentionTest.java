package com.ghatana.media.launcher;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.InMemoryMediaRequestLedger;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Acquired;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Erased;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Key;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.State;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Retention policy of the DEV_ONLY request ledger: which rows are pruned, the batch bound, the env parsing, and the
 * meaning of a retry after a prune. Runs against the in-memory store; the PostgreSQL store has its own Testcontainers
 * test with the same policy.
 */
class MediaDevRequestLedgerRetentionTest {
    private static final String FP_A = "a".repeat(64);
    private static final String FP_B = "b".repeat(64);
    private static final Duration LEASE = Duration.ofMinutes(15);
    private static final Duration RETENTION = Duration.ofDays(30);
    private static final Instant T0 = Instant.parse("2026-10-01T00:00:00Z");
    private static final String TENANT = "tenant-1";
    private static final List<OutputRef> OUT = List.of(
            new OutputRef("audio", "artifact-1", "sha256:" + "1".repeat(64)));

    private static final class MutableClock extends Clock {
        private Instant now = T0;
        @Override public ZoneId getZone() { return ZoneId.of("UTC"); }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
        void advance(Duration by) { now = now.plus(by); }
    }

    private static final class Harness {
        final MutableClock clock = new MutableClock();
        final InMemoryMediaRequestLedger store = new InMemoryMediaRequestLedger(clock);
        final MediaDevRequestLedger ledger = new MediaDevRequestLedger(store, LEASE, Duration.ZERO, false, RETENTION);
    }

    private static Key key(String requestId) {
        return new Key(TENANT, "principal-1", "speech.transcribe", requestId);
    }

    private static void completeNow(InMemoryMediaRequestLedger store, Key key, String fingerprint) {
        assertThat(store.claim(key, fingerprint, "owner", LEASE)).isEqualTo(new Acquired(1, 1, false));
        assertThat(store.complete(key, 1, OUT)).isTrue();
    }

    @Test
    void oldCompletedAndReleasedRowsArePrunedWhileRecentTerminalRowsAreKept() {
        Harness h = new Harness();
        completeNow(h.store, key("old-completed"), FP_A);
        assertThat(h.store.claim(key("old-released"), FP_A, "owner", LEASE)).isEqualTo(new Acquired(1, 1, false));
        assertThat(h.store.release(key("old-released"), 1, "backend-failed")).isTrue();

        h.clock.advance(Duration.ofDays(25));
        completeNow(h.store, key("recent-completed"), FP_A);
        h.clock.advance(Duration.ofDays(6));

        assertThat(h.ledger.pruneOnce(h.clock.instant())).isEqualTo(2);
        assertThat(h.store.find(key("old-completed"))).isEmpty();
        assertThat(h.store.find(key("old-released"))).isEmpty();
        assertThat(h.store.find(key("recent-completed")).orElseThrow().state()).isEqualTo(State.COMPLETED);
    }

    @Test
    void inProgressRowsAreNeverPrunedWhateverTheirAgeIncludingAnExpiredLease() {
        Harness h = new Harness();
        assertThat(h.store.claim(key("live"), FP_A, "owner", LEASE)).isEqualTo(new Acquired(1, 1, false));
        h.clock.advance(Duration.ofDays(400));
        assertThat(h.store.claim(key("expired"), FP_A, "owner", LEASE)).isEqualTo(new Acquired(1, 1, false));
        h.clock.advance(Duration.ofDays(400));

        assertThat(h.ledger.pruneOnce(h.clock.instant())).isZero();
        assertThat(h.store.find(key("live")).orElseThrow().state()).isEqualTo(State.IN_PROGRESS);
        assertThat(h.store.find(key("expired")).orElseThrow().state()).isEqualTo(State.IN_PROGRESS);
    }

    @Test
    void erasedTombstonesAreKeptForeverSoAnErasedOutputIsNeverProducedAgain() {
        Harness h = new Harness();
        completeNow(h.store, key("erased"), FP_A);
        assertThat(h.ledger.eraseOutputs(TENANT, Set.of("artifact-1"))).isEqualTo(1);
        h.clock.advance(Duration.ofDays(400));

        assertThat(h.ledger.pruneOnce(h.clock.instant())).isZero();
        assertThat(h.store.claim(key("erased"), FP_B, "owner", LEASE)).isInstanceOf(Erased.class);
    }

    @Test
    void thePruneBatchIsBoundedAndTheBacklogDrainsAcrossPasses() {
        Harness h = new Harness();
        for (int i = 0; i < 1_200; i++) completeNow(h.store, key("req-" + i), FP_A);
        h.clock.advance(Duration.ofDays(31));

        assertThat(MediaDevRequestLedger.MAX_PRUNE_BATCH).isEqualTo(500);
        assertThat(h.ledger.pruneOnce(h.clock.instant())).isEqualTo(500);
        assertThat(h.ledger.pruneOnce(h.clock.instant())).isEqualTo(500);
        assertThat(h.ledger.pruneOnce(h.clock.instant())).isEqualTo(200);
        assertThat(h.ledger.pruneOnce(h.clock.instant())).isZero();
    }

    @Test
    void aPrunedRequestIsClaimedAsANewRequestNotAReplayAndNotAMismatch() {
        Harness h = new Harness();
        completeNow(h.store, key("req"), FP_A);
        h.clock.advance(Duration.ofDays(31));
        assertThat(h.ledger.pruneOnce(h.clock.instant())).isEqualTo(1);

        assertThat(h.store.claim(key("req"), FP_B, "owner", LEASE)).isEqualTo(new Acquired(1, 1, false));
        assertThat(h.store.find(key("req")).orElseThrow().fingerprint()).isEqualTo(FP_B);
    }

    @Test
    void retentionDefaultsToThirtyDaysAndAcceptsTheWholeRange() {
        assertThat(MediaDevRequestLedger.retention(Map.of())).isEqualTo(Duration.ofDays(30));
        assertThat(MediaDevRequestLedger.retention(Map.of("MEDIA_DEV_REQUEST_LEDGER_RETENTION_DAYS", " ")))
                .isEqualTo(Duration.ofDays(30));
        assertThat(MediaDevRequestLedger.retention(Map.of("MEDIA_DEV_REQUEST_LEDGER_RETENTION_DAYS", "1")))
                .isEqualTo(Duration.ofDays(1));
        assertThat(MediaDevRequestLedger.retention(Map.of("MEDIA_DEV_REQUEST_LEDGER_RETENTION_DAYS", " 3650 ")))
                .isEqualTo(Duration.ofDays(3650));
    }

    @Test
    void aMalformedOrOutOfRangeRetentionIsRefused() {
        for (String malformed : List.of("0", "3651", "-1", "forever", "1.5", "30d")) {
            assertThatThrownBy(() -> MediaDevRequestLedger.retention(
                    Map.of("MEDIA_DEV_REQUEST_LEDGER_RETENTION_DAYS", malformed)))
                    .as(malformed)
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("MEDIA_DEV_REQUEST_LEDGER_RETENTION_DAYS must be an integer within [1, 3650]");
        }
    }

    @Test
    void composeRefusesAMalformedRetentionAtStartupAndAcceptsAValidOneWithItsPruneSchedule() {
        assertThatThrownBy(() -> MediaDevRequestLedger.compose(Map.of(
                "MEDIA_DEV_REQUEST_LEDGER", "memory", "MEDIA_DEV_REQUEST_LEDGER_RETENTION_DAYS", "zero")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("MEDIA_DEV_REQUEST_LEDGER_RETENTION_DAYS");

        try (MediaDevRequestLedger composed = MediaDevRequestLedger.compose(Map.of(
                "MEDIA_DEV_REQUEST_LEDGER", "memory", "MEDIA_DEV_REQUEST_LEDGER_RETENTION_DAYS", "7"))) {
            assertThat(composed.retention()).isEqualTo(Duration.ofDays(7));
        }
    }
}
