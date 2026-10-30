package com.ghatana.audiovideo.adapter.ledger;

import com.ghatana.core.lifecycle.ExecutionOutcome;
import com.ghatana.core.lifecycle.JobExecutionState;
import com.ghatana.datacloud.delivery.ledger.RunLedger;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

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
            if (down.get()) throw new IllegalStateException("event plane unavailable");
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
}
