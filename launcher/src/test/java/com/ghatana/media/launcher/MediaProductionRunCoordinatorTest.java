package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaProductionRunCoordinator.ClaimResult;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.OriginClass;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.ProducedOutput;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.ProductionStep;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.StepOutcome;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.StepRecord;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.StepResult;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** H-07 source-only candidate: unqualified production stays NOT_ADMITTED. */
class MediaProductionRunCoordinatorTest {

    private static final class FixtureLedger implements MediaProductionRunCoordinator.StepLedger {
        private final AtomicInteger reads = new AtomicInteger();
        private final AtomicInteger writes = new AtomicInteger();
        private final AtomicInteger claims = new AtomicInteger();

        @Override public Optional<StepRecord> find(String runId, String stepId) {
            reads.incrementAndGet();
            return Optional.empty();
        }
        @Override public void record(String runId, StepRecord record) { writes.incrementAndGet(); }
        @Override public ClaimResult claim(String runId, StepRecord fence) {
            claims.incrementAndGet();
            return ClaimResult.CLAIMED;
        }
    }

    private static ProductionStep step(String id, OriginClass origin, boolean manual) {
        return new ProductionStep(id, origin, "src@v9", "rights/v1", manual);
    }

    @Test
    void arbitraryReferencesAndBytesCannotAdmitProduction() {
        FixtureLedger ledger = new FixtureLedger();
        var coordinator = new MediaProductionRunCoordinator(ledger);
        AtomicInteger executions = new AtomicInteger();
        StepResult result = coordinator.executeStep(
                "run-1", "sha256:" + "f".repeat(64),
                step("capture-0", OriginClass.REAL_CAPTURE, false),
                (id, s) -> { executions.incrementAndGet(); return "fixture-bytes".getBytes(); });

        assertThat(result.outcome()).isEqualTo(StepOutcome.NOT_ADMITTED);
        assertThat(result.output()).isEmpty();
        assertThat(result.detail()).contains("source-bound rights", "process-fenced");
        assertThat(executions.get()).isZero();
        assertThat(ledger.claims.get()).isZero();
        assertThat(ledger.writes.get()).isZero();
    }

    @Test
    void manualGateNeverAutoExecutes() {
        var coordinator = new MediaProductionRunCoordinator(new FixtureLedger());
        AtomicInteger executions = new AtomicInteger();
        StepResult result = coordinator.executeStep(
                "run-1", "sha256:" + "f".repeat(64),
                step("rights-review", OriginClass.DECLARATIVE_ANIMATION, true),
                (id, s) -> { executions.incrementAndGet(); return new byte[]{1}; });

        assertThat(result.outcome()).isEqualTo(StepOutcome.SKIPPED_MANUAL_GATE);
        assertThat(executions.get()).isZero();
    }

    @Test
    void recreatedCoordinatorStillKeepsUnqualifiedRunNotAdmitted() {
        FixtureLedger ledger = new FixtureLedger();
        AtomicInteger executions = new AtomicInteger();
        var step = step("capture-restart", OriginClass.REAL_CAPTURE, false);
        var executor = (MediaProductionRunCoordinator.StepExecutor) (id, s) -> {
            executions.incrementAndGet();
            throw new AssertionError("unqualified executor must never run");
        };

        StepResult beforeRestart = new MediaProductionRunCoordinator(ledger).executeStep(
                "run-restart", "sha256:" + "f".repeat(64), step, executor);
        StepResult afterRestart = new MediaProductionRunCoordinator(ledger).executeStep(
                "run-restart", "sha256:" + "f".repeat(64), step, executor);

        assertThat(beforeRestart.outcome()).isEqualTo(StepOutcome.NOT_ADMITTED);
        assertThat(afterRestart.outcome()).isEqualTo(StepOutcome.NOT_ADMITTED);
        assertThat(executions.get()).isZero();
        assertThat(ledger.claims.get()).isZero();
    }

    @Test
    void sourcePlanAndIdentityInputsRemainStrictlyBounded() {
        var coordinator = new MediaProductionRunCoordinator(new FixtureLedger());
        var valid = step("valid-step", OriginClass.REAL_CAPTURE, false);
        assertThatThrownBy(() -> coordinator.executeStep("run/unsafe", "sha256:" + "f".repeat(64), valid,
                (id, s) -> new byte[]{1})).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> coordinator.executeStep("run-1", "not-a-fingerprint", valid,
                (id, s) -> new byte[]{1})).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> step("step/unsafe", OriginClass.REAL_CAPTURE, false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ProductionStep(
                "source-missing", OriginClass.REAL_CAPTURE, " ", "rights/v1", false))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void provenanceObjectRejectsMismatchedBoundSourceAndRights() {
        ProducedOutput fixtureOutput = new ProducedOutput(
                "capture-0", OriginClass.REAL_CAPTURE, "src@v9", "sha256:" + "f".repeat(64),
                "a".repeat(64), "rights/v1", 1);

        assertThatThrownBy(() -> new StepRecord("capture-0", "sha256:" + "f".repeat(64),
                step("capture-0", OriginClass.MODEL_SIMULATION, false),
                StepOutcome.PRODUCED, fixtureOutput))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("provenance");
        assertThatThrownBy(() -> new StepRecord("capture-0", "sha256:" + "f".repeat(64),
                new ProductionStep("capture-0", OriginClass.REAL_CAPTURE, "src@v9", "rights/v2", false),
                StepOutcome.PRODUCED, fixtureOutput))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("provenance");
    }

    @Test
    void boundLedgerCannotRelabelManualGateAsProduced() {
        ProductionStep manual = step("manual-review", OriginClass.DECLARATIVE_ANIMATION, true);
        ProducedOutput fabricated = new ProducedOutput(
                "manual-review", OriginClass.DECLARATIVE_ANIMATION, "src@v9",
                "sha256:" + "f".repeat(64), "a".repeat(64), "rights/v1", 1);

        assertThatThrownBy(() -> new StepRecord(
                "manual-review", "sha256:" + "f".repeat(64), manual,
                StepOutcome.PRODUCED, fabricated))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("manual-gate steps");
    }
}
