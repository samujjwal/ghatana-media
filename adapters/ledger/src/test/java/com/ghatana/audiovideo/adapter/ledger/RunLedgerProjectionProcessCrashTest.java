package com.ghatana.audiovideo.adapter.ledger;

import com.ghatana.core.lifecycle.ExecutionOutcome;
import com.ghatana.core.lifecycle.JobExecutionState;
import com.ghatana.datacloud.delivery.ledger.InputSnapshot;
import com.ghatana.datacloud.delivery.ledger.OutputSnapshot;
import com.ghatana.datacloud.delivery.ledger.RunLedger;
import com.ghatana.datacloud.delivery.ledger.WorkflowPolicySnapshot;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * LD-04 crash-phase verification: a process killed at the store-effect
 * boundary must leave a durable uncertainty fence that blocks any duplicate
 * dispatch after restart until authoritative readback reconciliation.
 */
class RunLedgerProjectionProcessCrashTest {

    @TempDir Path dir;

    private static RunLedger ledger(String runId, JobExecutionState state,
            ExecutionOutcome outcome, int attempt, long createdAt, long completedAt) {
        return new RunLedger(runId, "AV_PROCESSING_JOB", "ctx", state, outcome,
                createdAt, createdAt, completedAt,
                new InputSnapshot(Map.of("k", "v"), "body", Map.of("h", "1"), "system", createdAt),
                outcome == null ? null
                        : new OutputSnapshot(200, "resp", Map.of("h", "2"), 5L,
                                Map.of("latencyMs", 3), "result-1"),
                outcome == ExecutionOutcome.FAILED ? "BOOM" : null,
                Optional.of("trace-" + runId),
                attempt, 2, "EXPONENTIAL_BACKOFF", 0,
                "policy-1",
                Optional.of(new WorkflowPolicySnapshot("p1", true, "ok",
                        Set.of("BLOCKING_AUDIT_REQUIRED"), createdAt)),
                "audit-1", true,
                "trace-" + runId, "corr-" + runId, Map.of("tenant", "t1"));
    }

    private Process crashAtStoreBoundary(Path stateDir, RunLedger candidate) throws Exception {
        String classpath = System.getProperty("media.child.classpath", "");
        org.junit.jupiter.api.Assumptions.assumeTrue(!classpath.isBlank(),
                "media.child.classpath not provided by the test task");
        Path candidateFile = Files.writeString(
                dir.resolve("candidate-" + candidate.runId() + ".json"),
                RunLedgerJson.encode(candidate), StandardCharsets.UTF_8);
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        return new ProcessBuilder(java.toString(), "-cp", classpath,
                        RunLedgerProjectionCrashWorker.class.getName(),
                        stateDir.toString(), candidateFile.toString(), "42")
                .redirectErrorStream(true)
                .start();
    }

    @Test
    void crashAtEffectBoundaryLeavesDurableFenceThatBlocksRedispatch() throws Exception {
        Path stateDir = Files.createDirectory(dir.resolve("state"));
        RunLedger candidate = ledger("crash-run", JobExecutionState.RUNNING, null, 1, 100, 0);

        Process child = crashAtStoreBoundary(stateDir, candidate);
        assertThat(child.waitFor(60, TimeUnit.SECONDS)).isTrue();
        // Halted at the store boundary — no acknowledgement reached the caller.
        assertThat(child.exitValue()).isEqualTo(42);

        // The fence was persisted BEFORE the external store could execute.
        var stored = new FileRunLedgerProjectionState(stateDir).load("crash-run").orElseThrow();
        assertThat(stored.uncertain()).isEqualTo(candidate);
        assertThat(stored.latest()).isNull();

        // A restarted process must not dispatch the same or a conflicting
        // record while the effect outcome is unknown.
        AtomicBoolean redispatched = new AtomicBoolean(false);
        RunLedgerProjection restarted = new RunLedgerProjection(
                record -> redispatched.set(true), new FileRunLedgerProjectionState(stateDir));
        var blocked = restarted.project(candidate);
        assertThat(blocked.disposition()).isEqualTo(RunLedgerProjection.Disposition.PENDING_RECONCILIATION);
        assertThat(blocked.store()).isEqualTo(RunLedgerProjection.StoreResult.OUTCOME_UNKNOWN);
        assertThat(redispatched).isFalse();

        // Readback that cannot prove the exact record keeps the fence.
        assertThat(restarted.reconcile("crash-run", id -> Optional.empty()))
                .isEqualTo(RunLedgerProjection.ReconciliationResult.UNRESOLVED);
        // Exact authoritative readback confirms the effect and clears the fence.
        assertThat(restarted.reconcile("crash-run", id -> Optional.of(candidate)))
                .isEqualTo(RunLedgerProjection.ReconciliationResult.CONFIRMED);
        var reconciled = new FileRunLedgerProjectionState(stateDir).load("crash-run").orElseThrow();
        assertThat(reconciled.latest()).isEqualTo(candidate);
        assertThat(reconciled.uncertain()).isNull();

        // After reconciliation the same record replays idempotently — still
        // no duplicate sink call in this process.
        var replay = restarted.project(candidate);
        assertThat(replay.disposition()).isEqualTo(RunLedgerProjection.Disposition.REPLAYED);
        assertThat(redispatched).isFalse();
    }

    @Test
    void corruptProjectionStateFileFailsClosed() throws Exception {
        Path stateDir = Files.createDirectory(dir.resolve("corrupt-state"));
        FileRunLedgerProjectionState backing = new FileRunLedgerProjectionState(stateDir);
        RunLedger candidate = ledger("corrupt-run", JobExecutionState.RUNNING, null, 1, 100, 0);
        backing.save("corrupt-run", new RunLedgerProjection.ProjectionStateBacking.RunProjectionState(
                null, null, candidate));

        try (var files = Files.list(stateDir)) {
            for (Path file : files.filter(p -> p.toString().endsWith(".json")).toList()) {
                Files.writeString(file, "{not-json");
            }
        }
        assertThatThrownBy(() -> backing.load("corrupt-run"))
                .isInstanceOf(IllegalStateException.class);

        // A corrupt durable fence must propagate — never silently unfence a
        // dispatch that may already have produced an external effect.
        AtomicBoolean dispatched = new AtomicBoolean(false);
        RunLedgerProjection projection = new RunLedgerProjection(
                record -> dispatched.set(true), backing);
        assertThatThrownBy(() -> projection.project(candidate))
                .isInstanceOf(IllegalStateException.class);
        assertThat(dispatched).isFalse();
    }
}
