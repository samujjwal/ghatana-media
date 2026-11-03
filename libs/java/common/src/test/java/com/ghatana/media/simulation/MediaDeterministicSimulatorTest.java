package com.ghatana.media.simulation;

import com.ghatana.media.simulation.MediaDeterministicSimulator.Checkpoint;
import com.ghatana.media.simulation.MediaDeterministicSimulator.InitialState;
import com.ghatana.media.simulation.MediaDeterministicSimulator.ModelSpec;
import com.ghatana.media.simulation.MediaDeterministicSimulator.BoundaryCondition;
import com.ghatana.media.simulation.MediaDeterministicSimulator.AdaptiveCheckpoint;
import com.ghatana.media.simulation.MediaDeterministicSimulator.SimulationModelIR;
import com.ghatana.media.simulation.MediaDeterministicSimulator.SimulationResult;
import com.ghatana.media.simulation.MediaDeterministicSimulator.Verdict;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

/** H-06: deterministic seeded simulation compared with fixed analytical references. */
class MediaDeterministicSimulatorTest {

    private static ModelSpec newtonModel(double stepSeconds) {
        // mass 2 kg, force 6 N → a = 3 m/s²
        return new ModelSpec("constant-force", "1.0.0", "SI", 2.0, 6.0, stepSeconds, 100, 1e-9);
    }

    @Test
    void newtonConstantForceFixtureMatchesAnalyticalSolution() {
        // t = 2 s at dt = 0.5 s → v = 6 m/s, x = 6 m
        SimulationResult result = new MediaDeterministicSimulator()
                .run(newtonModel(0.5), new InitialState(0.0, 0.0), 42L);
        assertThat(result.verdict()).isEqualTo(Verdict.CONVERGED);
        Checkpoint step3 = result.checkpoints().get(2); // t = 1.5 s
        Checkpoint step4 = result.checkpoints().get(3); // t = 2.0 s
        assertThat(step4.stepIndex()).isEqualTo(4);
        assertThat((step4.velocityMetersPerSecond() - step3.velocityMetersPerSecond()) / 0.5)
                .isCloseTo(3.0, within(1e-9));
        assertThat(step4.velocityMetersPerSecond()).isCloseTo(6.0, within(1e-9));
        assertThat(step4.positionMeters()).isCloseTo(6.0, within(1e-9));
    }

    @Test
    void adaptiveStepperProducesReproducibleNewtonObservablesAndErrorBounds() {
        var simulator = new MediaDeterministicSimulator();
        ModelSpec model = newtonModel(0.5);

        var ir = new SimulationModelIR(model, new InitialState(0, 0), BoundaryCondition.UNCONSTRAINED_1D);
        var first = simulator.runAdaptive(ir, 42L, 2.0, 0.01);
        var replay = simulator.runAdaptive(ir, 42L, 2.0, 0.01);

        assertThat(first.verdict()).isEqualTo(Verdict.CONVERGED);
        assertThat(first.samples()).isEqualTo(replay.samples());
        var finalSample = first.samples().get(first.samples().size() - 1);
        assertThat(finalSample.seed()).isEqualTo(42L);
        assertThat(finalSample.simulationTimeSeconds()).isEqualTo(2.0);
        assertThat(finalSample.accelerationMetersPerSecondSquared()).isCloseTo(3.0, within(1e-12));
        assertThat(finalSample.velocityMetersPerSecond()).isCloseTo(6.0, within(1e-9));
        assertThat(finalSample.positionMeters()).isCloseTo(6.0, within(1e-9));
        assertThat(finalSample.estimatedPositionErrorMeters()).isGreaterThanOrEqualTo(0.0);
        assertThat(finalSample.estimatedVelocityErrorMetersPerSecond()).isGreaterThanOrEqualTo(0.0);
        assertThat(finalSample.positionUncertaintyMeters()).isGreaterThanOrEqualTo(
                finalSample.estimatedPositionErrorMeters());
        assertThat(finalSample.velocityUncertaintyMetersPerSecond()).isGreaterThanOrEqualTo(
                finalSample.estimatedVelocityErrorMetersPerSecond());
        assertThat(first.checkpoint().simulationTimeSeconds()).isEqualTo(2.0);
        assertThat(first.checkpoint().seed()).isEqualTo(42L);
    }

    @Test
    void adaptiveUncertaintyBoundsAccumulatedNumericalResidualForLongTrajectory() {
        var simulator = new MediaDeterministicSimulator();
        var ir = new SimulationModelIR(
                new ModelSpec("constant-force", "1.0.0", "SI", 2.0, 6.0, 0.01, 20_000, 1e-9),
                new InitialState(0, 0), BoundaryCondition.UNCONSTRAINED_1D);

        var result = simulator.runAdaptive(ir, 42L, 100.0, 0.01);

        assertThat(result.verdict()).isEqualTo(Verdict.CONVERGED);
        var sample = result.samples().get(result.samples().size() - 1);
        double exactPosition = 0.5 * 3.0 * sample.simulationTimeSeconds() * sample.simulationTimeSeconds();
        double exactVelocity = 3.0 * sample.simulationTimeSeconds();
        assertThat(sample.positionUncertaintyMeters())
                .isGreaterThanOrEqualTo(Math.abs(sample.positionMeters() - exactPosition));
        assertThat(sample.velocityUncertaintyMetersPerSecond())
                .isGreaterThanOrEqualTo(Math.abs(sample.velocityMetersPerSecond() - exactVelocity));
    }

    @Test
    void adaptiveCheckpointResumeMatchesUninterruptedRunExactly() {
        var simulator = new MediaDeterministicSimulator();
        var ir = new SimulationModelIR(
                newtonModel(0.5), new InitialState(0, 0), BoundaryCondition.UNCONSTRAINED_1D);
        var uninterrupted = simulator.runAdaptive(ir, 42L, 2.0, 0.01);
        var stopped = simulator.runAdaptive(ir, 42L, 1.0, 0.01);

        var resumed = simulator.resumeAdaptive(ir, stopped.checkpoint(), 42L, 2.0);

        assertThat(stopped.verdict()).isEqualTo(Verdict.CONVERGED);
        assertThat(resumed.verdict()).isEqualTo(Verdict.CONVERGED);
        assertThat(resumed.checkpoint().simulationTimeSeconds()).isEqualTo(2.0);
        assertThat(resumed.checkpoint().acceptedStep()).isEqualTo(uninterrupted.checkpoint().acceptedStep());
        assertThat(resumed.checkpoint().positionMeters()).isEqualTo(uninterrupted.checkpoint().positionMeters());
        assertThat(resumed.checkpoint().velocityMetersPerSecond())
                .isEqualTo(uninterrupted.checkpoint().velocityMetersPerSecond());
        assertThat(resumed.samples().get(resumed.samples().size() - 1))
                .isEqualTo(uninterrupted.samples().get(uninterrupted.samples().size() - 1));
    }

    @Test
    void adaptiveResumeRejectsMismatchedSeedModelAndStepBounds() {
        var simulator = new MediaDeterministicSimulator();
        var ir = new SimulationModelIR(
                newtonModel(0.5), new InitialState(0, 0), BoundaryCondition.UNCONSTRAINED_1D);
        var checkpoint = simulator.runAdaptive(ir, 42L, 1.0, 0.01).checkpoint();

        var wrongSeed = simulator.resumeAdaptive(ir, checkpoint, 43L, 2.0);
        var wrongModel = simulator.resumeAdaptive(new SimulationModelIR(
                new ModelSpec("constant-force", "1.0.0", "SI", 2, 8, 0.5, 100, 1e-9),
                new InitialState(0, 0), BoundaryCondition.UNCONSTRAINED_1D), checkpoint, 42L, 2.0);
        var invalidBounds = new AdaptiveCheckpoint(checkpoint.acceptedStep(), checkpoint.simulationTimeSeconds(),
                checkpoint.positionMeters(), checkpoint.velocityMetersPerSecond(), checkpoint.seed(), 0.75,
                checkpoint.minimumStepSeconds(), checkpoint.modelFingerprint());

        assertThat(wrongSeed.verdict()).isEqualTo(Verdict.ABSTAIN);
        assertThat(wrongSeed.abstainReason()).contains("seed");
        assertThat(wrongModel.verdict()).isEqualTo(Verdict.ABSTAIN);
        assertThat(wrongModel.abstainReason()).contains("model binding");
        assertThat(simulator.resumeAdaptive(ir, invalidBounds, 42L, 2.0).verdict()).isEqualTo(Verdict.ABSTAIN);
    }

    @Test
    void adaptiveStepperReportsStepLimitAndRejectsInvalidDurationBounds() {
        var simulator = new MediaDeterministicSimulator();
        var oneStepModel = new ModelSpec("constant-force", "1.0.0", "SI", 2.0, 6.0, 0.5, 1, 1e-9);

        var ir = new SimulationModelIR(oneStepModel, new InitialState(0, 0), BoundaryCondition.UNCONSTRAINED_1D);
        var limited = simulator.runAdaptive(ir, 1L, 2.0, 0.01);

        assertThat(limited.verdict()).isEqualTo(Verdict.STEP_LIMIT_REACHED);
        assertThat(limited.samples()).hasSize(1);
        assertThatThrownBy(() -> simulator.runAdaptive(
                new SimulationModelIR(newtonModel(0.5), new InitialState(0, 0), BoundaryCondition.UNCONSTRAINED_1D),
                1L, 2.0, 0.6))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void adaptiveStepperAbstainsForUnitMismatchAndUnstableSolver() {
        var simulator = new MediaDeterministicSimulator();
        var initial = new InitialState(0, 0);
        var imperial = new SimulationModelIR(
                new ModelSpec("constant-force", "1.0.0", "imperial", 2, 6, 0.5, 10, 1e-9),
                initial,
                BoundaryCondition.UNCONSTRAINED_1D);
        var unstable = new SimulationModelIR(
                new ModelSpec("constant-force", "1.0.0", "SI", Double.MIN_VALUE,
                        Double.MAX_VALUE, 0.5, 10, 1e-9),
                initial,
                BoundaryCondition.UNCONSTRAINED_1D);

        assertThat(simulator.runAdaptive(imperial, 1L, 2.0, 0.01).verdict()).isEqualTo(Verdict.ABSTAIN);
        var unstableResult = simulator.runAdaptive(unstable, 1L, 2.0, 0.01);
        assertThat(unstableResult.verdict()).isEqualTo(Verdict.ABSTAIN);
        assertThat(unstableResult.abstainReason()).contains("non-finite acceleration");
    }

    @Test
    void adaptiveStepperAbstainsWhenAnalyticalReferenceOverflows() {
        var simulator = new MediaDeterministicSimulator();
        var ir = new SimulationModelIR(
                newtonModel(0.5), new InitialState(-1.0e308, 1.0e308),
                BoundaryCondition.UNCONSTRAINED_1D);

        var result = simulator.runAdaptive(ir, 1L, 2.0, 0.01);

        assertThat(result.verdict()).isEqualTo(Verdict.ABSTAIN);
        assertThat(result.abstainReason()).contains("closed form");
        assertThat(result.checkpoint().simulationTimeSeconds()).isLessThan(2.0);
    }

    @Test
    void identicalInputsYieldBitIdenticalTrajectory() {
        var simulator = new MediaDeterministicSimulator();
        SimulationResult a = simulator.run(newtonModel(0.25), new InitialState(0, 0), 7L);
        SimulationResult b = simulator.run(newtonModel(0.25), new InitialState(0, 0), 7L);
        assertThat(a.checkpoints()).isEqualTo(b.checkpoints());
        assertThat(a.verdict()).isEqualTo(b.verdict());
    }

    @Test
    void resumeFromCheckpointReproducesTheSameTrajectory() {
        var simulator = new MediaDeterministicSimulator();
        ModelSpec model = newtonModel(0.5);
        SimulationResult full = simulator.run(model, new InitialState(0, 0), 9L);
        SimulationResult resumed = simulator.resume(model, full.checkpoints().get(1), 2);
        // Steps 3..4 resumed equal the full run's steps 3..4 exactly.
        assertThat(resumed.checkpoints().get(0).positionMeters())
                .isEqualTo(full.checkpoints().get(2).positionMeters());
        assertThat(resumed.checkpoints().get(1).velocityMetersPerSecond())
                .isEqualTo(full.checkpoints().get(3).velocityMetersPerSecond());
    }

    @Test
    void resumeAbstainsForCheckpointBoundToDifferentModelParameters() {
        var simulator = new MediaDeterministicSimulator();
        var sourceModel = newtonModel(0.5);
        var changedForce = new ModelSpec("constant-force", "1.0.0", "SI", 2.0, 8.0, 0.5, 100, 1e-9);
        Checkpoint checkpoint = simulator.run(sourceModel, new InitialState(0, 0), 42L)
                .checkpoints().get(1);

        SimulationResult resumed = simulator.resume(changedForce, checkpoint, 1);

        assertThat(resumed.verdict()).isEqualTo(Verdict.ABSTAIN);
        assertThat(resumed.abstainReason()).contains("model binding");
        assertThat(resumed.checkpoints()).isEmpty();
    }

    @Test
    void resumeAbstainsForLegacyCheckpointWithoutModelBinding() {
        var simulator = new MediaDeterministicSimulator();
        Checkpoint unbound = new Checkpoint(1, 0, 0, 42L);

        SimulationResult resumed = simulator.resume(newtonModel(0.5), unbound, 1);

        assertThat(resumed.verdict()).isEqualTo(Verdict.ABSTAIN);
        assertThat(resumed.abstainReason()).contains("model binding");
        assertThat(resumed.checkpoints()).isEmpty();
    }

    @Test
    void mismatchedUnitsRegistryAbstainsBeforeAnyStep() {
        var simulator = new MediaDeterministicSimulator();
        ModelSpec imperial = new ModelSpec(
                "constant-force", "1.0.0", "imperial", 2.0, 6.0, 0.5, 100, 1e-9);
        SimulationResult result = simulator.run(imperial, new InitialState(0, 0), 1L);
        assertThat(result.verdict()).isEqualTo(Verdict.ABSTAIN);
        assertThat(result.abstainReason()).contains("units registry");
        assertThat(result.checkpoints()).isEmpty();
    }

    @Test
    void unstableFiniteModelAbstainsBeforePublishingNonFiniteState() {
        var simulator = new MediaDeterministicSimulator();
        ModelSpec overflowingAcceleration = new ModelSpec(
                "constant-force", "1.0.0", "SI", Double.MIN_VALUE,
                Double.MAX_VALUE, 0.5, 10, 1e-9);

        SimulationResult result = simulator.run(
                overflowingAcceleration, new InitialState(0, 0), 17L);

        assertThat(result.verdict()).isEqualTo(Verdict.ABSTAIN);
        assertThat(result.abstainReason()).contains("solver diverged");
        assertThat(result.checkpoints()).isEmpty();
    }

    @Test
    void invalidModelParametersAreRejectedBeforeAnyStep() {
        assertThatThrownBy(() -> new ModelSpec("s", "1", "SI", -1.0, 6.0, 0.5, 10, 1e-9))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ModelSpec("s", "1", "SI", 2.0, 6.0, 0.0, 10, 1e-9))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new InitialState(Double.NaN, 0))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void unsupportedSolverIdentityNeverClaimsAValidSimulation() {
        var simulator = new MediaDeterministicSimulator();
        var unknown = new ModelSpec("different-solver", "1.0.0", "SI", 2, 6, 0.5, 10, 1e-9);
        assertThat(simulator.run(unknown, new InitialState(0, 0), 1).verdict()).isEqualTo(Verdict.ABSTAIN);
        assertThat(simulator.resume(unknown, new Checkpoint(1, 0, 0, 1), 1).verdict()).isEqualTo(Verdict.ABSTAIN);
    }

    @Test
    void resumePreservesStepLimitAndRejectsMalformedCheckpoints() {
        var simulator = new MediaDeterministicSimulator();
        var model = new ModelSpec("constant-force", "1.0.0", "SI", 2.0, 6.0, 0.5, 2, 1e-9);
        Checkpoint finalCheckpoint = simulator.run(model, new InitialState(0, 0), 1L)
                .checkpoints().get(1);
        assertThat(simulator.resume(model, finalCheckpoint, 1).verdict())
                .isEqualTo(Verdict.STEP_LIMIT_REACHED);
        assertThat(simulator.resume(model, new Checkpoint(Integer.MAX_VALUE, 0, 0, 1), Integer.MAX_VALUE)
                .verdict()).isEqualTo(Verdict.ABSTAIN);
        assertThatThrownBy(() -> new Checkpoint(-1, 0, 0, 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Checkpoint(1, Double.NaN, 0, 1)).isInstanceOf(IllegalArgumentException.class);
    }
}
