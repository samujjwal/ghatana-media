package com.ghatana.audiovideo.adapter.ledger;

import com.ghatana.core.lifecycle.ExecutionOutcome;
import com.ghatana.core.lifecycle.JobExecutionState;
import com.ghatana.datacloud.delivery.ledger.InputSnapshot;
import com.ghatana.datacloud.delivery.ledger.OutputSnapshot;
import com.ghatana.datacloud.delivery.ledger.RunLedger;
import com.ghatana.datacloud.delivery.ledger.WorkflowPolicySnapshot;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * LD-04 durable backing: projection truth — replay guards, ordering floors,
 * uncertain fences and terminal parity — survives process restart on real
 * filesystem storage.
 */
class FileRunLedgerProjectionStateTest {

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

    private static RunLedgerProjection.StoreResult project(RunLedgerProjection p, RunLedger l) {
        return p.project(l).store();
    }

    @Test
    void codecRoundTripsFullFidelity() throws Exception {
        FileRunLedgerProjectionState backing = new FileRunLedgerProjectionState(dir);
        RunLedger rich = ledger("codec-1", JobExecutionState.COMPLETED,
                ExecutionOutcome.SUCCEEDED, 2, 1000, 2000);
        backing.save("codec-1", new RunLedgerProjection.ProjectionStateBacking.RunProjectionState(
                rich, null, null));

        Optional<RunLedgerProjection.ProjectionStateBacking.RunProjectionState> loaded =
                backing.load("codec-1");
        assertThat(loaded).isPresent();
        assertThat(loaded.get().latest()).isEqualTo(rich);
        assertThat(loaded.get().unavailable()).isNull();
        assertThat(loaded.get().uncertain()).isNull();

        // And through the raw codec for direct equality.
        assertThat(RunLedgerJson.decode(RunLedgerJson.encode(rich))).isEqualTo(rich);
    }

    @Test
    void replaySurvivesRestart() {
        FileRunLedgerProjectionState backing = new FileRunLedgerProjectionState(dir);
        List<RunLedger> written = new ArrayList<>();
        RunLedger first = ledger("r1", JobExecutionState.RUNNING, null, 1, 100, 0);

        RunLedgerProjection first1 = new RunLedgerProjection(written::add, backing);
        assertThat(project(first1, first)).isEqualTo(RunLedgerProjection.StoreResult.ACKNOWLEDGED);

        // Fresh projection instance over the same durable state = restart.
        List<RunLedger> written2 = new ArrayList<>();
        RunLedgerProjection restarted = new RunLedgerProjection(written2::add, backing);
        var replay = restarted.project(first);
        assertThat(replay.disposition()).isEqualTo(RunLedgerProjection.Disposition.REPLAYED);
        assertThat(replay.store()).isEqualTo(RunLedgerProjection.StoreResult.NOT_ATTEMPTED);
        assertThat(written2).isEmpty();
    }

    @Test
    void staleAndConflictSurviveRestart() {
        FileRunLedgerProjectionState backing = new FileRunLedgerProjectionState(dir);
        RunLedger newer = ledger("r2", JobExecutionState.COMPLETED,
                ExecutionOutcome.SUCCEEDED, 1, 100, 500);
        RunLedgerProjection p1 = new RunLedgerProjection(l -> { }, backing);
        p1.project(newer);

        RunLedgerProjection restarted = new RunLedgerProjection(l -> { }, backing);
        var stale = restarted.project(ledger("r2", JobExecutionState.RUNNING, null, 1, 400, 0));
        assertThat(stale.disposition()).isEqualTo(RunLedgerProjection.Disposition.STALE);

        // Same attempt, contradictory terminal truth at a later timestamp = CONFLICT.
        RunLedger conflicting = new RunLedger("r2", "AV_PROCESSING_JOB", "ctx",
                JobExecutionState.COMPLETED, ExecutionOutcome.FAILED,
                100, 100, 600,
                new InputSnapshot(Map.of(), null, Map.of(), "system", 100),
                new OutputSnapshot(500, null, Map.of(), 1L, Map.of(), "r"),
                "DIFFERENT", Optional.empty(), 1, 0, "NONE", 0, null,
                Optional.empty(), null, false, "t", "c2", Map.of());
        var conflict = restarted.project(conflicting);
        assertThat(conflict.disposition()).isEqualTo(RunLedgerProjection.Disposition.CONFLICT);
    }

    @Test
    void terminalParitySurvivesRestart() {
        FileRunLedgerProjectionState backing = new FileRunLedgerProjectionState(dir);
        RunLedger terminal = ledger("r3", JobExecutionState.COMPLETED,
                ExecutionOutcome.SUCCEEDED, 1, 100, 500);
        RunLedgerProjection p1 = new RunLedgerProjection(l -> { }, backing);
        p1.project(terminal);

        RunLedgerProjection restarted = new RunLedgerProjection(l -> { }, backing);
        // An open in-flight view can never displace recorded terminal truth.
        var open = restarted.project(ledger("r3", JobExecutionState.RUNNING, null, 1, 900, 0));
        assertThat(open.disposition()).isEqualTo(RunLedgerProjection.Disposition.STALE);
        // And the exact terminal replay is still idempotent.
        var replay = restarted.project(terminal);
        assertThat(replay.disposition()).isEqualTo(RunLedgerProjection.Disposition.REPLAYED);
    }

    @Test
    void uncertainFenceSurvivesRestartAndBlocksReprojection() {
        FileRunLedgerProjectionState backing = new FileRunLedgerProjectionState(dir);
        AtomicBoolean dispatched = new AtomicBoolean(false);
        RunLedger uncertain = ledger("r4", JobExecutionState.RUNNING, null, 1, 100, 0);

        // Store throws AFTER a possible effect: generic failure → OUTCOME_UNKNOWN.
        RunLedgerProjection p1 = new RunLedgerProjection(l -> {
            dispatched.set(true);
            throw new IllegalStateException("lost acknowledgement");
        }, backing);
        var first = p1.project(uncertain);
        assertThat(first.store()).isEqualTo(RunLedgerProjection.StoreResult.OUTCOME_UNKNOWN);
        assertThat(dispatched).isTrue();

        // After restart the durable fence still blocks any re-dispatch.
        AtomicBoolean dispatched2 = new AtomicBoolean(false);
        RunLedgerProjection restarted = new RunLedgerProjection(l -> dispatched2.set(true), backing);
        var second = restarted.project(uncertain);
        assertThat(second.disposition()).isEqualTo(RunLedgerProjection.Disposition.PENDING_RECONCILIATION);
        assertThat(second.store()).isEqualTo(RunLedgerProjection.StoreResult.OUTCOME_UNKNOWN);
        assertThat(dispatched2).isFalse();
    }

    @Test
    void reconcileClearsDurableFenceOnlyOnExactReadback() {
        FileRunLedgerProjectionState backing = new FileRunLedgerProjectionState(dir);
        RunLedger uncertain = ledger("r5", JobExecutionState.RUNNING, null, 1, 100, 0);
        RunLedgerProjection p1 = new RunLedgerProjection(l -> {
            throw new IllegalStateException("ambiguous");
        }, backing);
        p1.project(uncertain);

        RunLedgerProjection restarted = new RunLedgerProjection(l -> { }, backing);
        // Readback returning a different record cannot clear the fence.
        assertThat(restarted.reconcile("r5", id -> Optional.of(
                ledger("r5", JobExecutionState.RUNNING, null, 2, 200, 0))))
                .isEqualTo(RunLedgerProjection.ReconciliationResult.UNRESOLVED);
        // Exact record readback confirms and clears durably.
        assertThat(restarted.reconcile("r5", id -> Optional.of(uncertain)))
                .isEqualTo(RunLedgerProjection.ReconciliationResult.CONFIRMED);

        // A third instance sees the cleared fence and confirmed latest truth:
        // the same record replays idempotently without touching the store.
        List<RunLedger> written = new ArrayList<>();
        RunLedgerProjection third = new RunLedgerProjection(written::add, backing);
        var result = third.project(uncertain);
        assertThat(result.disposition()).isEqualTo(RunLedgerProjection.Disposition.REPLAYED);
        assertThat(written).isEmpty();
    }

    @Test
    void unavailableFloorSurvivesRestart() {
        FileRunLedgerProjectionState backing = new FileRunLedgerProjectionState(dir);
        RunLedger refused = ledger("r6", JobExecutionState.RUNNING, null, 1, 100, 0);
        RunLedgerProjection p1 = new RunLedgerProjection(l -> {
            throw new RunLedgerProjection.StoreNotDispatchedException("pre-dispatch refusal");
        }, backing);
        var result = p1.project(refused);
        assertThat(result.store()).isEqualTo(RunLedgerProjection.StoreResult.UNAVAILABLE);

        // After restart, an older/weaker record still cannot pass the floor,
        // while the exact refused record retries as PROJECTED.
        RunLedgerProjection restarted = new RunLedgerProjection(l -> { }, backing);
        var older = restarted.project(ledger("r6", JobExecutionState.RUNNING, null, 0, 50, 0));
        assertThat(older.disposition()).isNotEqualTo(RunLedgerProjection.Disposition.PROJECTED);
        var retry = restarted.project(refused);
        assertThat(retry.disposition()).isEqualTo(RunLedgerProjection.Disposition.PROJECTED);
    }

    @Test
    void durableUncertaintyFenceIsWrittenBeforeExternalStoreCanExecute() {
        FileRunLedgerProjectionState backing = new FileRunLedgerProjectionState(dir);
        RunLedger candidate = ledger("pre-dispatch-fence", JobExecutionState.RUNNING, null, 1, 100, 0);
        AtomicBoolean restartedDispatch = new AtomicBoolean(false);
        RunLedgerProjection original = new RunLedgerProjection(record -> {
            // This callback is at the effect boundary. A fresh process must
            // already see the uncertainty fence, not an absent record.
            var stored = backing.load(record.runId()).orElseThrow();
            assertThat(stored.uncertain()).isEqualTo(record);
            var restarted = new RunLedgerProjection(other -> restartedDispatch.set(true), backing);
            assertThat(restarted.project(record).disposition())
                    .isEqualTo(RunLedgerProjection.Disposition.PENDING_RECONCILIATION);
        }, backing);

        assertThat(original.project(candidate).store()).isEqualTo(RunLedgerProjection.StoreResult.ACKNOWLEDGED);
        assertThat(restartedDispatch).isFalse();
        assertThat(backing.load(candidate.runId()).orElseThrow().latest()).isEqualTo(candidate);
        assertThat(backing.load(candidate.runId()).orElseThrow().uncertain()).isNull();
    }

    @Test
    void transientReadFailureCannotMarkProjectionAsHydrated() {
        RunLedger candidate = ledger("load-failure", JobExecutionState.RUNNING, null, 1, 100, 0);
        java.util.concurrent.atomic.AtomicInteger reads = new java.util.concurrent.atomic.AtomicInteger();
        var backing = new RunLedgerProjection.ProjectionStateBacking() {
            @Override public Optional<RunProjectionState> load(String runId) {
                if (reads.getAndIncrement() == 0) throw new IllegalStateException("transient read failure");
                return Optional.of(new RunProjectionState(null, null, candidate));
            }
            @Override public void save(String runId, RunProjectionState state) { }
        };
        AtomicBoolean dispatched = new AtomicBoolean(false);
        RunLedgerProjection projection = new RunLedgerProjection(record -> dispatched.set(true), backing);
        assertThatThrownBy(() -> projection.project(candidate))
                .isInstanceOf(IllegalStateException.class);
        assertThat(projection.project(candidate).disposition())
                .isEqualTo(RunLedgerProjection.Disposition.PENDING_RECONCILIATION);
        assertThat(reads).hasValue(2);
        assertThat(dispatched).isFalse();
    }

    @Test
    void persistedProjectionCannotContainAnotherRunIdentity() {
        FileRunLedgerProjectionState backing = new FileRunLedgerProjectionState(dir);
        RunLedger unrelated = ledger("different-run", JobExecutionState.RUNNING, null, 1, 100, 0);
        assertThatThrownBy(() -> backing.save("expected-run",
                new RunLedgerProjection.ProjectionStateBacking.RunProjectionState(unrelated, null, null)))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void filenamesAreDigests() throws Exception {
        FileRunLedgerProjectionState backing = new FileRunLedgerProjectionState(dir);
        backing.save("run-sensitive-id", new RunLedgerProjection.ProjectionStateBacking.RunProjectionState(
                ledger("run-sensitive-id", JobExecutionState.RUNNING, null, 1, 1, 0), null, null));
        try (Stream<Path> files = Files.list(dir)) {
            assertThat(files.map(p -> p.getFileName().toString()).toList())
                    .noneMatch(n -> n.contains("run-sensitive"));
        }
    }

    @Test
    void exclusiveWriterRejectsConcurrentOwnerOnSharedStorage() throws Exception {
        Path stateDir = Files.createDirectory(dir.resolve("exclusive"));
        FileRunLedgerProjectionState first = FileRunLedgerProjectionState.forExclusiveWriter(stateDir);
        assertThat(first.exclusiveWriter()).isTrue();
        assertThatThrownBy(() -> FileRunLedgerProjectionState.forExclusiveWriter(stateDir))
                .isInstanceOf(FileRunLedgerProjectionState.ProjectionWriterConflictException.class);
        first.close();
    }

    @Test
    void exclusiveWriterOwnershipReverifiedOnEveryLoadAndSave() throws Exception {
        Path stateDir = Files.createDirectory(dir.resolve("reverify"));
        FileRunLedgerProjectionState first = FileRunLedgerProjectionState.forExclusiveWriter(stateDir);
        RunLedger candidate = ledger("reverify-run", JobExecutionState.RUNNING, null, 1, 100, 0);
        first.save("reverify-run", new RunLedgerProjection.ProjectionStateBacking.RunProjectionState(
                null, null, candidate));
        // A successor force-reclaims the fence: the previous holder must fail
        // closed instead of dispatching a stale write.
        Files.delete(stateDir.resolve("writer.lock"));
        FileRunLedgerProjectionState second = FileRunLedgerProjectionState.forExclusiveWriter(stateDir);
        assertThatThrownBy(() -> first.save("reverify-run",
                new RunLedgerProjection.ProjectionStateBacking.RunProjectionState(candidate, null, null)))
                .isInstanceOf(FileRunLedgerProjectionState.ProjectionWriterLostException.class);
        assertThatThrownBy(() -> first.load("reverify-run"))
                .isInstanceOf(FileRunLedgerProjectionState.ProjectionWriterLostException.class);
        // The succeeding owner still projects normally.
        second.save("reverify-run", new RunLedgerProjection.ProjectionStateBacking.RunProjectionState(
                candidate, null, null));
        assertThat(second.load("reverify-run").orElseThrow().latest()).isEqualTo(candidate);
        second.close();
    }

    @Test
    void closeReleasesWriterFenceOnlyForMatchingOwner() throws Exception {
        Path stateDir = Files.createDirectory(dir.resolve("release"));
        FileRunLedgerProjectionState first = FileRunLedgerProjectionState.forExclusiveWriter(stateDir);
        first.close();
        assertThatThrownBy(() -> first.save("any-run",
                new RunLedgerProjection.ProjectionStateBacking.RunProjectionState(null, null, null)))
                .isInstanceOf(FileRunLedgerProjectionState.ProjectionWriterLostException.class);
        FileRunLedgerProjectionState second = FileRunLedgerProjectionState.forExclusiveWriter(stateDir);
        // Closing the released instance again must not delete the new owner's fence.
        first.close();
        assertThat(Files.exists(stateDir.resolve("writer.lock"))).isTrue();
        second.save("any-run", new RunLedgerProjection.ProjectionStateBacking.RunProjectionState(null, null, null));
        second.close();
    }

    @Test
    void independentProcessesRaceForExactlyOneWriterClaim() throws Exception {
        String classpath = System.getProperty("media.child.classpath", "");
        org.junit.jupiter.api.Assumptions.assumeTrue(!classpath.isBlank(),
                "media.child.classpath not provided by the test task");
        Path stateDir = Files.createDirectory(dir.resolve("process-race"));
        Path goFile = dir.resolve("go.marker");
        Path javaBin = Path.of(System.getProperty("java.home"), "bin", "java");
        List<Process> children = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            children.add(new ProcessBuilder(javaBin.toString(), "-cp", classpath,
                            RunLedgerProjectionWriterClaimWorker.class.getName(),
                            stateDir.toString(), goFile.toString())
                    .redirectErrorStream(true)
                    .start());
        }
        // Release all claimants together so the fence is genuinely contested.
        Files.writeString(goFile, "go");
        int claimed = 0;
        for (Process child : children) {
            String output = new String(child.getInputStream().readAllBytes());
            assertThat(child.waitFor(60, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            if (output.contains("CLAIMED")) {
                claimed++;
            } else {
                assertThat(output).contains("CONFLICT");
                assertThat(child.exitValue()).isEqualTo(3);
            }
        }
        assertThat(claimed).as("exactly one projector may hold the writer fence").isEqualTo(1);
    }
}
