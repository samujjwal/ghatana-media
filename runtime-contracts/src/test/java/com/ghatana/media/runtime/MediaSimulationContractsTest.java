package com.ghatana.media.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.Test;

class MediaSimulationContractsTest {
    @Test
    void rejectsUnitMismatchesAndNegativeInputUncertaintyAtTheBoundary() {
        var mass = measurement(2, MediaSimulationContracts.Unit.KILOGRAM, 0,
                MediaSimulationContracts.Unit.KILOGRAM);
        var length = measurement(6, MediaSimulationContracts.Unit.METER, 0,
                MediaSimulationContracts.Unit.METER);
        assertThatThrownBy(() -> new MediaSimulationContracts.ConstantForce(mass, length))
                .isInstanceOf(MediaSimulationContracts.InvalidQuantityException.class)
                .hasMessageContaining("force requires FORCE");
        assertThatThrownBy(() -> measurement(2, MediaSimulationContracts.Unit.KILOGRAM, -0.1,
                MediaSimulationContracts.Unit.KILOGRAM))
                .isInstanceOf(MediaSimulationContracts.InvalidQuantityException.class)
                .hasMessageContaining("non-negative");
    }

    @Test
    void outcomesDoNotCarryPartialTraceOrMeasurementEvidence() {
        var observation = new MediaSimulationContracts.Observation(
                quantity(0, MediaSimulationContracts.Unit.SECOND),
                quantity(0, MediaSimulationContracts.Unit.METER),
                quantity(0, MediaSimulationContracts.Unit.METER_PER_SECOND),
                quantity(3, MediaSimulationContracts.Unit.METER_PER_SECOND_SQUARED),
                quantity(0, MediaSimulationContracts.Unit.JOULE),
                new MediaSimulationContracts.StateUncertainty(null, null,
                        MediaSimulationContracts.UncertaintyStatus.NOT_ASSESSED_MODEL_DERIVATIVE_UNAVAILABLE));
        var trace = new MediaSimulationContracts.Trace(List.of(observation), 2, 1, 0.5, true,
                MediaSimulationContracts.VELOCITY_VERLET_SOLVER_V1,
                MediaSimulationContracts.SIMULATION_ONLY_EVIDENCE);
        assertThat(MediaSimulationContracts.Outcome.completed(trace).status())
                .isEqualTo(MediaSimulationContracts.OutcomeStatus.COMPLETED);
        assertThatThrownBy(() -> new MediaSimulationContracts.Trace(List.of(observation), 2, 1, 0.5,
                true, MediaSimulationContracts.VELOCITY_VERLET_SOLVER_V1, "MEASUREMENT"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("cannot be labeled as measurement");
        assertThatThrownBy(() -> new MediaSimulationContracts.Outcome(
                MediaSimulationContracts.OutcomeStatus.ABSTAINED,
                MediaSimulationContracts.FailureCode.SOLVER_LIMIT_REACHED, trace))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("partial trace");
    }

    private static MediaSimulationContracts.Quantity quantity(double value, MediaSimulationContracts.Unit unit) {
        return new MediaSimulationContracts.Quantity(value, unit);
    }

    private static MediaSimulationContracts.Measurement measurement(
            double value, MediaSimulationContracts.Unit unit,
            double uncertainty, MediaSimulationContracts.Unit uncertaintyUnit) {
        return new MediaSimulationContracts.Measurement(quantity(value, unit), quantity(uncertainty, uncertaintyUnit));
    }
}
