package com.ghatana.media.production.simulation;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.runtime.MediaSimulationContracts;
import org.junit.jupiter.api.Test;

/** J-14 unit boundary: measured values and their same-dimension uncertainties convert independently to SI. */
class SimulationMeasurementUnitBoundaryTest {
    @Test
    void convertsMassAndForceUncertaintyUnitsBeforePropagation() {
        var mass = measurement(2.0, MediaSimulationContracts.Unit.KILOGRAM,
                1_000.0, MediaSimulationContracts.Unit.GRAM);
        var force = measurement(6_000.0, MediaSimulationContracts.Unit.MILLINEWTON,
                300.0, MediaSimulationContracts.Unit.MILLINEWTON);
        var initial = new MediaSimulationContracts.InitialState(
                measurement(0.0, MediaSimulationContracts.Unit.METER,
                        0.0, MediaSimulationContracts.Unit.METER),
                measurement(0.0, MediaSimulationContracts.Unit.METER_PER_SECOND,
                        0.0, MediaSimulationContracts.Unit.METER_PER_SECOND));
        var policy = new MediaSimulationContracts.SolverPolicy(
                quantity(2.0, MediaSimulationContracts.Unit.SECOND),
                quantity(0.25, MediaSimulationContracts.Unit.SECOND),
                quantity(1e-5, MediaSimulationContracts.Unit.SECOND),
                quantity(1e-8, MediaSimulationContracts.Unit.METER),
                quantity(1e-8, MediaSimulationContracts.Unit.METER_PER_SECOND),
                100, 1_000);

        var outcome = PhysicalSimulation.run(new MediaSimulationContracts.RunRequest(
                new MediaSimulationContracts.ConstantForce(mass, force), initial, policy));

        assertThat(outcome.status()).isEqualTo(MediaSimulationContracts.OutcomeStatus.COMPLETED);
        var terminal = outcome.trace().observations().getLast();
        assertThat(terminal.acceleration().si(MediaSimulationContracts.Dimension.ACCELERATION)).isEqualTo(3.0);
        assertThat(terminal.velocity().si(MediaSimulationContracts.Dimension.VELOCITY)).isCloseTo(6.0,
                org.assertj.core.data.Offset.offset(1e-10));
        // sigma_m = 1 kg, sigma_f = 0.3 N, t = 2 s; sigma_v = sqrt((t*sigma_f/m)^2 + (F*t*sigma_m/m^2)^2).
        assertThat(terminal.uncertainty().velocityStandardUncertainty()
                .si(MediaSimulationContracts.Dimension.VELOCITY)).isCloseTo(Math.sqrt(9.09),
                org.assertj.core.data.Offset.offset(1e-10));
        assertThat(outcome.trace().evidenceClass()).isEqualTo(MediaSimulationContracts.SIMULATION_ONLY_EVIDENCE);
    }

    @Test
    void nonzeroUncertaintyThatUnderflowsDuringSiConversionReturnsInvalidWithoutTrace() {
        var model = new MediaSimulationContracts.ConstantForce(
                measurement(2.0, MediaSimulationContracts.Unit.KILOGRAM,
                        Double.MIN_VALUE, MediaSimulationContracts.Unit.GRAM),
                measurement(6.0, MediaSimulationContracts.Unit.NEWTON,
                        0.0, MediaSimulationContracts.Unit.NEWTON));
        var initial = new MediaSimulationContracts.InitialState(
                measurement(0.0, MediaSimulationContracts.Unit.METER,
                        0.0, MediaSimulationContracts.Unit.METER),
                measurement(0.0, MediaSimulationContracts.Unit.METER_PER_SECOND,
                        0.0, MediaSimulationContracts.Unit.METER_PER_SECOND));
        var policy = new MediaSimulationContracts.SolverPolicy(
                quantity(2.0, MediaSimulationContracts.Unit.SECOND),
                quantity(0.25, MediaSimulationContracts.Unit.SECOND),
                quantity(1e-5, MediaSimulationContracts.Unit.SECOND),
                quantity(1e-8, MediaSimulationContracts.Unit.METER),
                quantity(1e-8, MediaSimulationContracts.Unit.METER_PER_SECOND),
                100, 1_000);

        var outcome = PhysicalSimulation.run(new MediaSimulationContracts.RunRequest(model, initial, policy));

        assertThat(outcome.status()).isEqualTo(MediaSimulationContracts.OutcomeStatus.INVALID_INPUT);
        assertThat(outcome.failureCode()).isEqualTo(MediaSimulationContracts.FailureCode.INVALID_SIMULATION_INPUT);
        assertThat(outcome.trace()).isNull();
    }

    private static MediaSimulationContracts.Measurement measurement(
            double value, MediaSimulationContracts.Unit valueUnit,
            double uncertainty, MediaSimulationContracts.Unit uncertaintyUnit) {
        return new MediaSimulationContracts.Measurement(quantity(value, valueUnit), quantity(uncertainty, uncertaintyUnit));
    }

    private static MediaSimulationContracts.Quantity quantity(double value, MediaSimulationContracts.Unit unit) {
        return new MediaSimulationContracts.Quantity(value, unit);
    }
}
