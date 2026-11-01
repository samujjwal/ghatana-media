package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaProductionRunCoordinator.OriginClass;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.ProducedOutput;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.ProductionStep;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.StepAmbiguousException;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.ClaimResult;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.StepConflictException;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.StepOutcome;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.StepRecord;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.StepResult;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** H-07: sealed provenance, manual gates, UNKNOWN fencing — no duplicate effects. */
class MediaProductionRunCoordinatorTest {

    private static final class InMemoryLedger
            implements MediaProductionRunCoordinator.StepLedger {
        private final Map<String, StepRecord> records = new HashMap<>();
        @Override public Optional<StepRecord> find(String runId, String stepId) {
            return Optional.ofNullable(records.get(runId + "/" + stepId));
        }
        @Override public synchronized void record(String runId, StepRecord record) {
            records.put(runId + "/" + record.stepId(), record);
        }
        @Override public synchronized ClaimResult claim(String runId, StepRecord fence) {
            String key = runId + "/" + fence.stepId();
            if (records.containsKey(key)) return ClaimResult.ALREADY_CLAIMED;
            records.put(key, fence);
            return ClaimResult.CLAIMED;
        }
    }

    private static ProductionStep step(String id, OriginClass origin, boolean manual) {
        return new ProductionStep(id, origin, "src@v9", "rights/v1", manual);
    }

    @Test
    void producesOutputWithSealedProvenanceAndChecksum() {
        var coordinator = new MediaProductionRunCoordinator(new InMemoryLedger());
        StepResult result = coordinator.executeStep(
                "run-1", "sha256:" + "f".repeat(64),
                step("capture-0", OriginClass.REAL_CAPTURE, false),
                (id, s) -> "real-bytes".getBytes());
        assertThat(result.outcome()).isEqualTo(StepOutcome.PRODUCED);
        ProducedOutput output = result.output().orElseThrow();
        assertThat(output.originClass()).isEqualTo(OriginClass.REAL_CAPTURE);
        assertThat(output.sourceRevisionRef()).isEqualTo("src@v9");
        assertThat(output.planFingerprint()).startsWith("sha256:");
        assertThat(output.contentSha256()).matches("[a-f0-9]{64}");
        assertThat(output.byteCount()).isEqualTo(10);
    }

    @Test
    void manualGateNeverAutoExecutes() {
        var coordinator = new MediaProductionRunCoordinator(new InMemoryLedger());
        AtomicInteger executions = new AtomicInteger();
        StepResult result = coordinator.executeStep(
                "run-1", "sha256:" + "f".repeat(64),
                step("rights-review", OriginClass.DECLARATIVE_ANIMATION, true),
                (id, s) -> { executions.incrementAndGet(); return new byte[]{1}; });
        assertThat(result.outcome()).isEqualTo(StepOutcome.SKIPPED_MANUAL_GATE);
        assertThat(executions.get()).isZero();
    }

    @Test
    void ambiguousDispatchRecordsUnknownAndReplayNeverReExecutes() {
        var coordinator = new MediaProductionRunCoordinator(new InMemoryLedger());
        AtomicInteger executions = new AtomicInteger();
        var step = step("sim-0", OriginClass.MODEL_SIMULATION, false);
        var ambiguousExecutor = (MediaProductionRunCoordinator.StepExecutor) (id, s) -> {
            executions.incrementAndGet();
            throw new StepAmbiguousException("provider timeout after dispatch", null);
        };
        StepResult first = coordinator.executeStep(
                "run-1", "sha256:" + "f".repeat(64), step, ambiguousExecutor);
        assertThat(first.outcome()).isEqualTo(StepOutcome.OUTCOME_UNKNOWN);

        // Replay reads the recorded UNKNOWN — the executor is never re-run.
        StepResult replay = coordinator.executeStep(
                "run-1", "sha256:" + "f".repeat(64), step, ambiguousExecutor);
        assertThat(replay.outcome()).isEqualTo(StepOutcome.OUTCOME_UNKNOWN);
        assertThat(executions.get()).isEqualTo(1);
    }

    @Test
    void producedStepReplaysVerbatimWithoutReExecuting() {
        var coordinator = new MediaProductionRunCoordinator(new InMemoryLedger());
        AtomicInteger executions = new AtomicInteger();
        var step = step("anim-0", OriginClass.DECLARATIVE_ANIMATION, false);
        coordinator.executeStep("run-1", "sha256:" + "f".repeat(64), step,
                (id, s) -> { executions.incrementAndGet(); return new byte[]{9}; });
        StepResult replay = coordinator.executeStep(
                "run-1", "sha256:" + "f".repeat(64), step,
                (id, s) -> { executions.incrementAndGet(); return new byte[]{9}; });
        assertThat(replay.outcome()).isEqualTo(StepOutcome.PRODUCED);
        assertThat(executions.get()).isEqualTo(1);
    }

    @Test
    void runStepIdentityCannotBeReboundToAnotherPlanSourceOrRights() {
        var coordinator = new MediaProductionRunCoordinator(new InMemoryLedger());
        AtomicInteger executions = new AtomicInteger();
        var original = step("capture-0", OriginClass.REAL_CAPTURE, false);
        var executor = (MediaProductionRunCoordinator.StepExecutor) (id, s) -> {
            executions.incrementAndGet();
            return new byte[] {1, 2, 3};
        };
        String fingerprint = "sha256:" + "f".repeat(64);
        coordinator.executeStep("run-1", fingerprint, original, executor);

        assertThatThrownBy(() -> coordinator.executeStep("run-1", "sha256:" + "e".repeat(64), original, executor))
                .isInstanceOf(StepConflictException.class);
        ProductionStep changedSource = new ProductionStep(
                "capture-0", OriginClass.REAL_CAPTURE, "src@v10", "rights/v1", false);
        assertThatThrownBy(() -> coordinator.executeStep("run-1", fingerprint, changedSource, executor))
                .isInstanceOf(StepConflictException.class);
        ProductionStep changedRights = new ProductionStep(
                "capture-0", OriginClass.REAL_CAPTURE, "src@v9", "rights/v2", false);
        assertThatThrownBy(() -> coordinator.executeStep("run-1", fingerprint, changedRights, executor))
                .isInstanceOf(StepConflictException.class);
        assertThat(executions.get()).isEqualTo(1);
    }

    @Test
    void unknownAndManualRecordsAreAlsoBoundToTheirOriginalStepIdentity() {
        var coordinator = new MediaProductionRunCoordinator(new InMemoryLedger());
        AtomicInteger executions = new AtomicInteger();
        String fingerprint = "sha256:" + "f".repeat(64);
        var ambiguous = step("capture-1", OriginClass.REAL_CAPTURE, false);
        var ambiguousExecutor = (MediaProductionRunCoordinator.StepExecutor) (id, s) -> {
            executions.incrementAndGet();
            throw new StepAmbiguousException("timeout after dispatch", null);
        };
        assertThat(coordinator.executeStep("run-1", fingerprint, ambiguous, ambiguousExecutor).outcome())
                .isEqualTo(StepOutcome.OUTCOME_UNKNOWN);
        ProductionStep changed = new ProductionStep(
                "capture-1", OriginClass.MODEL_SIMULATION, "src@v9", "rights/v1", false);
        assertThatThrownBy(() -> coordinator.executeStep("run-1", fingerprint, changed, ambiguousExecutor))
                .isInstanceOf(StepConflictException.class);

        var manual = step("rights-review", OriginClass.REAL_CAPTURE, true);
        coordinator.executeStep("run-2", fingerprint, manual, (id, s) -> new byte[] {1});
        ProductionStep bypassed = new ProductionStep(
                "rights-review", OriginClass.REAL_CAPTURE, "src@v9", "rights/v1", false);
        assertThatThrownBy(() -> coordinator.executeStep("run-2", fingerprint, bypassed, (id, s) -> new byte[] {1}))
                .isInstanceOf(StepConflictException.class);
        assertThat(executions.get()).isEqualTo(1);
    }

    @Test
    void runAndStepIdsRejectDelimiterAmbiguityAndMalformedFingerprints() {
        var coordinator = new MediaProductionRunCoordinator(new InMemoryLedger());
        var step = step("valid-step", OriginClass.REAL_CAPTURE, false);
        assertThatThrownBy(() -> coordinator.executeStep("run/unsafe", "sha256:" + "f".repeat(64), step,
                (id, s) -> new byte[] {1})).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> coordinator.executeStep("run-1", "not-a-fingerprint", step,
                (id, s) -> new byte[] {1})).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> step("step/unsafe", OriginClass.REAL_CAPTURE, false))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void legacyStepRecordConstructorRemainsAvailableButCannotAuthorizeReplay() {
        InMemoryLedger ledger = new InMemoryLedger();
        StepRecord legacy = new StepRecord("capture-legacy", StepOutcome.OUTCOME_UNKNOWN, null);
        assertThat(legacy.isBound()).isFalse();
        ledger.record("run-legacy", legacy);
        var coordinator = new MediaProductionRunCoordinator(ledger);
        AtomicInteger executions = new AtomicInteger();

        assertThatThrownBy(() -> coordinator.executeStep("run-legacy", "sha256:" + "f".repeat(64),
                step("capture-legacy", OriginClass.REAL_CAPTURE, false),
                (id, s) -> { executions.incrementAndGet(); return new byte[] {1}; }))
                .isInstanceOf(StepConflictException.class)
                .hasMessageContaining("legacy step record is unbound");
        assertThat(executions.get()).isZero();
    }

    @Test
    void ambiguousProviderMessageIsNotReturnedInStepDetail() {
        var coordinator = new MediaProductionRunCoordinator(new InMemoryLedger());
        StepResult result = coordinator.executeStep("run-1", "sha256:" + "f".repeat(64),
                step("capture-secret", OriginClass.REAL_CAPTURE, false),
                (id, s) -> { throw new StepAmbiguousException("credential=secret-value", null); });

        assertThat(result.outcome()).isEqualTo(StepOutcome.OUTCOME_UNKNOWN);
        assertThat(result.detail()).isEqualTo("ambiguous effect; outcome requires reconciliation");
        assertThat(result.detail()).doesNotContain("secret-value");
    }

    @Test
    void emptyExecutorResultAfterClaimIsUnknownNotFakeFailure() {
        var coordinator = new MediaProductionRunCoordinator(new InMemoryLedger());
        StepResult result = coordinator.executeStep(
                "run-1", "sha256:" + "f".repeat(64),
                step("cap", OriginClass.REAL_CAPTURE, false),
                (id, s) -> new byte[0]);
        assertThat(result.outcome()).isEqualTo(StepOutcome.OUTCOME_UNKNOWN);
        assertThat(result.output()).isEmpty();
    }

    @Test
    void missingAtomicClaimCapabilityDoesNotDispatch() {
        MediaProductionRunCoordinator.StepLedger legacyLedger = new MediaProductionRunCoordinator.StepLedger() {
            @Override public Optional<StepRecord> find(String runId, String stepId) { return Optional.empty(); }
            @Override public void record(String runId, StepRecord record) { }
        };
        AtomicInteger executions = new AtomicInteger();
        StepResult result = new MediaProductionRunCoordinator(legacyLedger).executeStep(
                "run-no-claim", "sha256:" + "f".repeat(64), step("no-claim", OriginClass.REAL_CAPTURE, false),
                (id, s) -> { executions.incrementAndGet(); return new byte[] {1}; });
        assertThat(result.outcome()).isEqualTo(StepOutcome.NOT_ADMITTED);
        assertThat(executions.get()).isZero();
    }

    @Test
    void unrecognizedClaimResultDoesNotDispatch() {
        MediaProductionRunCoordinator.StepLedger invalidLedger = new MediaProductionRunCoordinator.StepLedger() {
            @Override public Optional<StepRecord> find(String runId, String stepId) { return Optional.empty(); }
            @Override public void record(String runId, StepRecord record) { }
            @Override public ClaimResult claim(String runId, StepRecord fence) { return null; }
        };
        AtomicInteger executions = new AtomicInteger();
        StepResult result = new MediaProductionRunCoordinator(invalidLedger).executeStep(
                "run-null-claim", "sha256:" + "f".repeat(64), step("null-claim", OriginClass.REAL_CAPTURE, false),
                (id, s) -> { executions.incrementAndGet(); return new byte[] {1}; });
        assertThat(result.outcome()).isEqualTo(StepOutcome.NOT_ADMITTED);
        assertThat(executions.get()).isZero();
    }

    @Test
    void concurrentAttemptCannotDispatchWhenFixtureClaimAlreadyExists() throws Exception {
        var ledger = new InMemoryLedger();
        var coordinator = new MediaProductionRunCoordinator(ledger);
        var step = step("concurrent", OriginClass.REAL_CAPTURE, false);
        CountDownLatch dispatched = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger executions = new AtomicInteger();
        var executor = (MediaProductionRunCoordinator.StepExecutor) (id, s) -> {
            executions.incrementAndGet();
            dispatched.countDown();
            try {
                if (!release.await(5, TimeUnit.SECONDS)) throw new StepAmbiguousException("timeout", null);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new StepAmbiguousException("interrupted", interrupted);
            }
            return new byte[] {7};
        };
        var pool = java.util.concurrent.Executors.newSingleThreadExecutor();
        try {
            var first = pool.submit(() -> coordinator.executeStep(
                    "run-race", "sha256:" + "f".repeat(64), step, executor));
            assertThat(dispatched.await(5, TimeUnit.SECONDS)).isTrue();
            StepResult competing = coordinator.executeStep(
                    "run-race", "sha256:" + "f".repeat(64), step, executor);
            assertThat(competing.outcome()).isEqualTo(StepOutcome.OUTCOME_UNKNOWN);
            release.countDown();
            assertThat(first.get(5, TimeUnit.SECONDS).outcome()).isEqualTo(StepOutcome.PRODUCED);
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
        assertThat(executions.get()).isEqualTo(1);
    }

    @Test
    void runtimeExceptionAfterDispatchIsUnknownAndNeverRetried() {
        var coordinator = new MediaProductionRunCoordinator(new InMemoryLedger());
        AtomicInteger executions = new AtomicInteger();
        var step = step("runtime-unknown", OriginClass.REAL_CAPTURE, false);
        var executor = (MediaProductionRunCoordinator.StepExecutor) (id, s) -> {
            executions.incrementAndGet();
            throw new IllegalStateException("provider failed after effect");
        };
        StepResult first = coordinator.executeStep("run-runtime", "sha256:" + "f".repeat(64), step, executor);
        StepResult replay = coordinator.executeStep("run-runtime", "sha256:" + "f".repeat(64), step, executor);
        assertThat(first.outcome()).isEqualTo(StepOutcome.OUTCOME_UNKNOWN);
        assertThat(replay.outcome()).isEqualTo(StepOutcome.OUTCOME_UNKNOWN);
        assertThat(executions.get()).isEqualTo(1);
    }
}
