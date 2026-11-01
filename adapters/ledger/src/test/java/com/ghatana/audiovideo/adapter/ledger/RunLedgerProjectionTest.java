package com.ghatana.audiovideo.adapter.ledger;

import com.ghatana.core.lifecycle.ExecutionOutcome;
import com.ghatana.core.lifecycle.JobExecutionState;
import com.ghatana.datacloud.delivery.ledger.RunLedger;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * LD-04: replayed, out-of-order and stale ledger updates must never overwrite
 * newer truth; store outages report as UNAVAILABLE, never a false ACK; a
 * same-instant conflict is rejected rather than silently resolved.
 */
@DisplayName("RunLedger Projection Ordering Tests")
class RunLedgerProjectionTest {

    private static RunLedger ledger(String runId, JobExecutionState state,
            ExecutionOutcome outcome, int attempt, long createdAt, long completedAt) {
        return new RunLedger(runId, "AV_PROCESSING_JOB", "ctx", state, outcome,
                createdAt, createdAt, completedAt,
                new com.ghatana.datacloud.delivery.ledger.InputSnapshot(
                        java.util.Map.of(), null, java.util.Map.of(), "system", createdAt),
                outcome == null ? null
                        : new com.ghatana.datacloud.delivery.ledger.OutputSnapshot(
                                200, null, java.util.Map.of(), 0L, java.util.Map.of(), "r"),
                null, java.util.Optional.empty(),
                attempt, 0, "NONE", 0, null, java.util.Optional.empty(), null, false,
                "t", "c", java.util.Map.of());
    }

    @Test
    @DisplayName("Duplicate replay is idempotent and never re-writes the store")
    void replayDoesNotRewrite() {
        List<RunLedger> written = new ArrayList<>();
        RunLedgerProjection projection = new RunLedgerProjection(written::add);
        RunLedger first = ledger("r1", JobExecutionState.RUNNING, null, 1, 100, 0);

        assertThat(projection.project(first).store())
                .isEqualTo(RunLedgerProjection.StoreResult.ACKNOWLEDGED);
        var replay = projection.project(first);
        assertThat(replay.disposition()).isEqualTo(RunLedgerProjection.Disposition.REPLAYED);
        assertThat(replay.store()).isEqualTo(RunLedgerProjection.StoreResult.NOT_ATTEMPTED);
        assertThat(written).hasSize(1);
    }

    @Test
    @DisplayName("Stale and out-of-order records never overwrite newer truth")
    void staleNeverOverwrites() {
        List<RunLedger> written = new ArrayList<>();
        RunLedgerProjection projection = new RunLedgerProjection(written::add);

        projection.project(ledger("r1", JobExecutionState.RUNNING, null, 2, 200, 0));
        var olderAttempt = projection.project(
                ledger("r1", JobExecutionState.RUNNING, null, 1, 300, 0));
        assertThat(olderAttempt.disposition()).isEqualTo(RunLedgerProjection.Disposition.STALE);

        projection.project(ledger("r2", JobExecutionState.COMPLETED,
                ExecutionOutcome.SUCCEEDED, 1, 100, 150));
        var staleOpen = projection.project(ledger("r2", JobExecutionState.RUNNING, null, 1, 400, 0));
        assertThat(staleOpen.disposition()).isEqualTo(RunLedgerProjection.Disposition.STALE);

        var olderTimestamp = projection.project(ledger("r2", JobExecutionState.COMPLETED,
                ExecutionOutcome.SUCCEEDED, 1, 50, 60));
        assertThat(olderTimestamp.disposition()).isEqualTo(RunLedgerProjection.Disposition.STALE);
        assertThat(written).hasSize(2);
    }

    @Test
    @DisplayName("Terminal outcome supersedes an open view; conflict is rejected honestly")
    void finalityWinsAndConflictRejected() {
        List<RunLedger> written = new ArrayList<>();
        RunLedgerProjection projection = new RunLedgerProjection(written::add);

        projection.project(ledger("r1", JobExecutionState.RUNNING, null, 1, 100, 0));
        var terminal = projection.project(ledger("r1", JobExecutionState.COMPLETED,
                ExecutionOutcome.FAILED, 1, 100, 200));
        assertThat(terminal.disposition()).isEqualTo(RunLedgerProjection.Disposition.PROJECTED);

        List<RunLedger> written2 = new ArrayList<>();
        RunLedgerProjection conflicting = new RunLedgerProjection(written2::add);
        conflicting.project(ledger("rX", JobExecutionState.COMPLETED,
                ExecutionOutcome.SUCCEEDED, 1, 100, 150));
        var conflict = conflicting.project(ledger("rX", JobExecutionState.COMPLETED,
                ExecutionOutcome.FAILED, 1, 100, 150));
        // Same attempt, same instant, different terminal truth — ambiguous,
        // never silently resolved in either direction.
        assertThat(conflict.disposition()).isEqualTo(RunLedgerProjection.Disposition.CONFLICT);
    }

    @Test
    @DisplayName("Store outage is UNAVAILABLE and never marks the record as projected")
    void outageIsExplicitAndRetryable() {
        java.util.concurrent.atomic.AtomicBoolean down = new java.util.concurrent.atomic.AtomicBoolean(true);
        List<RunLedger> written = new ArrayList<>();
        RunLedgerProjection projection = new RunLedgerProjection(ledger -> {
            if (down.get()) throw new RunLedgerProjection.StoreNotDispatchedException("event plane unavailable");
            written.add(ledger);
        });
        RunLedger record = ledger("r1", JobExecutionState.RUNNING, null, 1, 100, 0);

        var failed = projection.project(record);
        assertThat(failed.store()).isEqualTo(RunLedgerProjection.StoreResult.UNAVAILABLE);

        // The failed projection must not poison ordering — a retry delivers it.
        down.set(false);
        var retried = projection.project(record);
        assertThat(retried.disposition()).isEqualTo(RunLedgerProjection.Disposition.PROJECTED);
        assertThat(retried.store()).isEqualTo(RunLedgerProjection.StoreResult.ACKNOWLEDGED);
        assertThat(written).hasSize(1);
    }

    @Test
    @DisplayName("Lost store acknowledgement fences retries until exact authoritative readback")
    void ambiguousStoreOutcomeRequiresReadback() {
        var persisted = new java.util.concurrent.atomic.AtomicReference<RunLedger>();
        var attempts = new java.util.concurrent.atomic.AtomicInteger();
        RunLedgerProjection projection = new RunLedgerProjection(record -> {
            attempts.incrementAndGet();
            persisted.set(record); // effect committed, response then lost
            throw new IllegalStateException("response lost");
        });
        RunLedger record = ledger("uncertain-run", JobExecutionState.RUNNING, null, 1, 100, 0);
        assertThat(projection.project(record).store())
                .isEqualTo(RunLedgerProjection.StoreResult.OUTCOME_UNKNOWN);
        assertThat(projection.project(record).disposition())
                .isEqualTo(RunLedgerProjection.Disposition.PENDING_RECONCILIATION);
        assertThat(attempts).hasValue(1);
        assertThat(projection.reconcile("uncertain-run", id -> java.util.Optional.empty()))
                .isEqualTo(RunLedgerProjection.ReconciliationResult.UNRESOLVED);
        assertThat(projection.reconcile("uncertain-run", id -> java.util.Optional.of(
                ledger("uncertain-run", JobExecutionState.RUNNING, null, 1, 101, 0))))
                .isEqualTo(RunLedgerProjection.ReconciliationResult.UNRESOLVED);
        assertThat(projection.reconcile("uncertain-run", id -> { throw new IllegalStateException("read failed"); }))
                .isEqualTo(RunLedgerProjection.ReconciliationResult.UNRESOLVED);
        assertThat(projection.project(record).store())
                .isEqualTo(RunLedgerProjection.StoreResult.OUTCOME_UNKNOWN);
        assertThat(attempts).hasValue(1);
        assertThat(projection.reconcile("uncertain-run", id -> java.util.Optional.of(persisted.get())))
                .isEqualTo(RunLedgerProjection.ReconciliationResult.CONFIRMED);
        assertThat(projection.project(record).disposition())
                .isEqualTo(RunLedgerProjection.Disposition.REPLAYED);
        assertThat(attempts).hasValue(1);
    }

    @Test
    @DisplayName("Unknown and fatal store outcomes fence only the affected run")
    void uncertainEffectDoesNotBlockIndependentRunAndFatalRemainsFenced() {
        var writes = new java.util.concurrent.atomic.AtomicInteger();
        RunLedgerProjection projection = new RunLedgerProjection(record -> {
            writes.incrementAndGet();
            if (record.runId().equals("unknown")) throw new IllegalStateException("response lost");
            if (record.runId().equals("fatal")) throw new AssertionError("fatal after dispatch");
        });
        RunLedger unknown = ledger("unknown", JobExecutionState.RUNNING, null, 1, 100, 0);
        RunLedger other = ledger("other", JobExecutionState.RUNNING, null, 1, 100, 0);
        RunLedger fatal = ledger("fatal", JobExecutionState.RUNNING, null, 1, 100, 0);
        assertThat(projection.project(unknown).store()).isEqualTo(RunLedgerProjection.StoreResult.OUTCOME_UNKNOWN);
        assertThat(projection.project(other).store()).isEqualTo(RunLedgerProjection.StoreResult.ACKNOWLEDGED);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> projection.project(fatal))
                .isInstanceOf(AssertionError.class);
        assertThat(projection.project(fatal).disposition())
                .isEqualTo(RunLedgerProjection.Disposition.PENDING_RECONCILIATION);
        assertThat(writes).hasValue(3);
    }

    @Test
    @DisplayName("Concurrent updates for one run serialize compare, store, and latest-truth update")
    void concurrentUpdatesCannotBothPassAgainstTheSamePreviousTruth() throws Exception {
        CountDownLatch firstStoreEntered = new CountDownLatch(1);
        CountDownLatch releaseFirstStore = new CountDownLatch(1);
        CountDownLatch secondCallStarted = new CountDownLatch(1);
        CountDownLatch secondCallFinished = new CountDownLatch(1);
        List<RunLedger> written = new CopyOnWriteArrayList<>();
        RunLedgerProjection projection = new RunLedgerProjection(record -> {
            written.add(record);
            if (record.createdAtMs() == 100) {
                firstStoreEntered.countDown();
                if (!releaseFirstStore.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("test did not release first store call");
                }
            }
        });

        var executor = Executors.newFixedThreadPool(2);
        try {
            var first = ledger("same-run", JobExecutionState.RUNNING, null, 1, 100, 0);
            var newer = ledger("same-run", JobExecutionState.RUNNING, null, 1, 200, 0);
            var firstResult = executor.submit(() -> projection.project(first));
            assertThat(firstStoreEntered.await(5, TimeUnit.SECONDS)).isTrue();

            var secondResult = executor.submit(() -> {
                secondCallStarted.countDown();
                try {
                    return projection.project(newer);
                } finally {
                    secondCallFinished.countDown();
                }
            });
            assertThat(secondCallStarted.await(5, TimeUnit.SECONDS)).isTrue();
            // The second same-run update must wait until the first store ACK is
            // reflected in the latest-truth guard before evaluating freshness.
            assertThat(secondCallFinished.await(100, TimeUnit.MILLISECONDS)).isFalse();

            releaseFirstStore.countDown();
            assertThat(firstResult.get(5, TimeUnit.SECONDS).store())
                    .isEqualTo(RunLedgerProjection.StoreResult.ACKNOWLEDGED);
            assertThat(secondResult.get(5, TimeUnit.SECONDS).disposition())
                    .isEqualTo(RunLedgerProjection.Disposition.PROJECTED);
            assertThat(written).containsExactly(first, newer);
        } finally {
            releaseFirstStore.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    @DisplayName("Concurrent stale update is rejected after newer truth is acknowledged")
    void concurrentStaleUpdateCannotReachStoreAfterNewerAck() throws Exception {
        CountDownLatch newerStoreEntered = new CountDownLatch(1);
        CountDownLatch releaseNewerStore = new CountDownLatch(1);
        CountDownLatch staleCallStarted = new CountDownLatch(1);
        CountDownLatch staleCallFinished = new CountDownLatch(1);
        List<RunLedger> written = new CopyOnWriteArrayList<>();
        RunLedgerProjection projection = new RunLedgerProjection(record -> {
            written.add(record);
            if (record.createdAtMs() == 200) {
                newerStoreEntered.countDown();
                if (!releaseNewerStore.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("test did not release newer store call");
                }
            }
        });

        var executor = Executors.newFixedThreadPool(2);
        try {
            var newer = ledger("same-run-stale-race", JobExecutionState.RUNNING, null, 1, 200, 0);
            var stale = ledger("same-run-stale-race", JobExecutionState.RUNNING, null, 1, 100, 0);
            var newerResult = executor.submit(() -> projection.project(newer));
            assertThat(newerStoreEntered.await(5, TimeUnit.SECONDS)).isTrue();

            var staleResult = executor.submit(() -> {
                staleCallStarted.countDown();
                try {
                    return projection.project(stale);
                } finally {
                    staleCallFinished.countDown();
                }
            });
            assertThat(staleCallStarted.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(staleCallFinished.await(100, TimeUnit.MILLISECONDS)).isFalse();

            releaseNewerStore.countDown();
            assertThat(newerResult.get(5, TimeUnit.SECONDS).store())
                    .isEqualTo(RunLedgerProjection.StoreResult.ACKNOWLEDGED);
            assertThat(staleResult.get(5, TimeUnit.SECONDS).disposition())
                    .isEqualTo(RunLedgerProjection.Disposition.STALE);
            assertThat(staleResult.get(5, TimeUnit.SECONDS).store())
                    .isEqualTo(RunLedgerProjection.StoreResult.NOT_ATTEMPTED);
            assertThat(written).containsExactly(newer);
        } finally {
            releaseNewerStore.countDown();
            executor.shutdownNow();
        }
    }
}
