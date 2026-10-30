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
    void invalidModelParametersAreRejectedBeforeAnyStep() {
        assertThatThrownBy(() -> new ModelSpec("s", "1", "SI", -1.0, 6.0, 0.5, 10, 1e-9))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ModelSpec("s", "1", "SI", 2.0, 6.0, 0.0, 10, 1e-9))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new InitialState(Double.NaN, 0))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
