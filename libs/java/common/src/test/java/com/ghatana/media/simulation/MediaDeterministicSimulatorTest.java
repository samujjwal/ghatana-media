package com.ghatana.media.simulation;

import com.ghatana.media.simulation.MediaDeterministicSimulator.Checkpoint;
import com.ghatana.media.simulation.MediaDeterministicSimulator.InitialState;
import com.ghatana.media.simulation.MediaDeterministicSimulator.ModelSpec;
import com.ghatana.media.simulation.MediaDeterministicSimulator.SimulationResult;
import com.ghatana.media.simulation.MediaDeterministicSimulator.Verdict;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

/** H-06: deterministic seeded simulation; analytical Newton fixture validates the solver. */
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
        Checkpoint step4 = result.checkpoints().get(3); // t = 2.0 s
        assertThat(step4.stepIndex()).isEqualTo(4);
        assertThat(step4.velocityMetersPerSecond()).isCloseTo(6.0, within(1e-9));
        assertThat(step4.positionMeters()).isCloseTo(6.0, within(1e-9));
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
