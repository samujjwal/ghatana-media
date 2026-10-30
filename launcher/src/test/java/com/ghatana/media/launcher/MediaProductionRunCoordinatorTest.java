package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaProductionRunCoordinator.OriginClass;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.ProducedOutput;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.ProductionStep;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.StepAmbiguousException;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.StepOutcome;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.StepRecord;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.StepResult;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/** H-07: sealed provenance, manual gates, UNKNOWN fencing — no duplicate effects. */
class MediaProductionRunCoordinatorTest {

    private static final class InMemoryLedger
            implements MediaProductionRunCoordinator.StepLedger {
        private final Map<String, StepRecord> records = new HashMap<>();
        @Override public Optional<StepRecord> find(String runId, String stepId) {
            return Optional.ofNullable(records.get(runId + "/" + stepId));
        }
        @Override public void record(String runId, StepRecord record) {
            records.put(runId + "/" + record.stepId(), record);
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
    void emptyExecutorResultIsFailureNotFakeOutput() {
        var coordinator = new MediaProductionRunCoordinator(new InMemoryLedger());
        StepResult result = coordinator.executeStep(
                "run-1", "sha256:" + "f".repeat(64),
                step("cap", OriginClass.REAL_CAPTURE, false),
                (id, s) -> new byte[0]);
        assertThat(result.outcome()).isEqualTo(StepOutcome.FAILED);
        assertThat(result.output()).isEmpty();
    }
}
