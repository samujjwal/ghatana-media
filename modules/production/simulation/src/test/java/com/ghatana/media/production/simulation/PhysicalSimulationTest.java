package com.ghatana.media.production.simulation;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.Test;

class PhysicalSimulationTest {
    private static PhysicalSimulation.Quantity q(double value, PhysicalSimulation.Unit unit) {
        return new PhysicalSimulation.Quantity(value, unit);
    }

    private static PhysicalSimulation.Measurement m(double value, PhysicalSimulation.Unit unit,
                                                     double uncertainty, PhysicalSimulation.Unit uncertaintyUnit) {
        return new PhysicalSimulation.Measurement(q(value, unit), q(uncertainty, uncertaintyUnit));
    }

    private static PhysicalSimulation.SolverPolicy policy(double maxStep, int maxSteps, int maxIterations) {
        return new PhysicalSimulation.SolverPolicy(q(2, PhysicalSimulation.Unit.SECOND),
                q(maxStep, PhysicalSimulation.Unit.SECOND), q(1e-5, PhysicalSimulation.Unit.SECOND),
                q(1e-8, PhysicalSimulation.Unit.METER), q(1e-8, PhysicalSimulation.Unit.METER_PER_SECOND),
                maxSteps, maxIterations);
    }

    private static PhysicalSimulation.InitialState origin() {
        return new PhysicalSimulation.InitialState(m(0, PhysicalSimulation.Unit.METER, 0, PhysicalSimulation.Unit.METER),
                m(0, PhysicalSimulation.Unit.METER_PER_SECOND, 0, PhysicalSimulation.Unit.METER_PER_SECOND));
    }

    @Test
    void solvesNewtonVectorWithTypedSIObservationsAndPropagatesMeasurementUncertainty() {
        var model = new PhysicalSimulation.ConstantForce(
                m(2, PhysicalSimulation.Unit.KILOGRAM, 0.01, PhysicalSimulation.Unit.KILOGRAM),
                m(6, PhysicalSimulation.Unit.NEWTON, 0.03, PhysicalSimulation.Unit.NEWTON));
        var result = PhysicalSimulation.simulate(model, origin(), policy(0.5, 100, 1000));
        var last = result.observations().get(result.observations().size() - 1);

        assertThat(last.timeSeconds()).isEqualTo(2.0);
        assertThat(last.accelerationMetersPerSecondSquared()).isCloseTo(3.0, org.assertj.core.data.Offset.offset(1e-11));
        assertThat(last.velocityMetersPerSecond()).isCloseTo(6.0, org.assertj.core.data.Offset.offset(1e-10));
        assertThat(last.positionMeters()).isCloseTo(6.0, org.assertj.core.data.Offset.offset(1e-10));
        assertThat(last.uncertainty().status()).isEqualTo(PhysicalSimulation.UncertaintyStatus.PROPAGATED_INDEPENDENT_GAUSSIAN);
        assertThat(last.uncertainty().positionMeters()).isGreaterThan(0);
        assertThat(result.evidenceClass()).isEqualTo("DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE");
    }

    @Test
    void convertsCompatibleUnitsToSiBeforeSolving() {
        var model = new PhysicalSimulation.ConstantForce(
                m(2000, PhysicalSimulation.Unit.GRAM, 0, PhysicalSimulation.Unit.GRAM),
                m(6000, PhysicalSimulation.Unit.MILLINEWTON, 0, PhysicalSimulation.Unit.MILLINEWTON));
        var state = new PhysicalSimulation.InitialState(
                m(0, PhysicalSimulation.Unit.CENTIMETER, 0, PhysicalSimulation.Unit.CENTIMETER),
                m(0, PhysicalSimulation.Unit.METER_PER_SECOND, 0, PhysicalSimulation.Unit.METER_PER_SECOND));
        var result = PhysicalSimulation.simulate(model, state, policy(1, 100, 1000));
        var last = result.observations().get(result.observations().size() - 1);
        assertThat(last.positionMeters()).isCloseTo(6.0, org.assertj.core.data.Offset.offset(1e-10));
    }

    @Test
    void harmonicSpringConvergesAsStepShrinksAndBoundsEnergyDrift() {
        var model = new PhysicalSimulation.HarmonicSpring(
                m(1, PhysicalSimulation.Unit.KILOGRAM, 0, PhysicalSimulation.Unit.KILOGRAM),
                m(4, PhysicalSimulation.Unit.NEWTON_PER_METER, 0, PhysicalSimulation.Unit.NEWTON_PER_METER),
                m(0, PhysicalSimulation.Unit.METER, 0, PhysicalSimulation.Unit.METER));
        var state = new PhysicalSimulation.InitialState(
                m(1, PhysicalSimulation.Unit.METER, 0, PhysicalSimulation.Unit.METER),
                m(0, PhysicalSimulation.Unit.METER_PER_SECOND, 0, PhysicalSimulation.Unit.METER_PER_SECOND));
        var coarse = PhysicalSimulation.simulate(model, state, policy(0.2, 100_000, 5000, 0.01));
        var fine = PhysicalSimulation.simulate(model, state, policy(0.1, 100_000, 5000, 0.01));
        var initialEnergy = coarse.observations().get(0).totalEnergyJoules();
        var coarseFinal = coarse.observations().get(coarse.observations().size() - 1);
        var fineFinal = fine.observations().get(fine.observations().size() - 1);
        double coarseEnergyDrift = Math.abs(coarseFinal.totalEnergyJoules() - initialEnergy);
        double fineEnergyDrift = Math.abs(fineFinal.totalEnergyJoules() - initialEnergy);

        assertThat(fineFinal.positionMeters()).isCloseTo(Math.cos(4.0), org.assertj.core.data.Offset.offset(0.02));
        assertThat(Math.abs(fineFinal.positionMeters() - Math.cos(4.0)))
                .isLessThan(Math.abs(coarseFinal.positionMeters() - Math.cos(4.0)));
        assertThat(fineEnergyDrift).isLessThan(coarseEnergyDrift);
        assertThat(fineFinal.uncertainty().status())
                .isEqualTo(PhysicalSimulation.UncertaintyStatus.NOT_ASSESSED_MODEL_DERIVATIVE_UNAVAILABLE);
        assertThat(fineFinal.uncertainty().positionMeters()).isNull();
        assertThat(fineFinal.uncertainty().velocityMetersPerSecond()).isNull();
    }

    private static PhysicalSimulation.SolverPolicy policy(double maxStep, int maxSteps, int maxIterations,
                                                          double absoluteTolerance) {
        return new PhysicalSimulation.SolverPolicy(q(2, PhysicalSimulation.Unit.SECOND),
                q(maxStep, PhysicalSimulation.Unit.SECOND), q(1e-5, PhysicalSimulation.Unit.SECOND),
                q(absoluteTolerance, PhysicalSimulation.Unit.METER),
                q(absoluteTolerance, PhysicalSimulation.Unit.METER_PER_SECOND), maxSteps, maxIterations);
    }

    @Test
    void repeatedInputsProduceIdenticalInstrumentTrace() {
        var model = new PhysicalSimulation.ConstantForce(m(2, PhysicalSimulation.Unit.KILOGRAM, 0, PhysicalSimulation.Unit.KILOGRAM),
                m(6, PhysicalSimulation.Unit.NEWTON, 0, PhysicalSimulation.Unit.NEWTON));
        var first = PhysicalSimulation.simulate(model, origin(), policy(0.25, 100, 1000));
        var second = PhysicalSimulation.simulate(model, origin(), policy(0.25, 100, 1000));
        assertThat(first).isEqualTo(second);
    }

    @Test
    void rejectsIncompatibleDimensionsNegativeMassAndIncompleteOrUnboundedSolverInputs() {
        var wrongForceDimension = new PhysicalSimulation.ConstantForce(
                m(2, PhysicalSimulation.Unit.KILOGRAM, 0, PhysicalSimulation.Unit.KILOGRAM),
                m(6, PhysicalSimulation.Unit.METER, 0, PhysicalSimulation.Unit.METER));
        assertThatThrownBy(() -> PhysicalSimulation.simulate(wrongForceDimension, origin(), policy(0.5, 100, 1000)))
                .isInstanceOf(PhysicalSimulation.InvalidSimulationInputException.class)
                .hasMessageContaining("force requires FORCE");
        var negativeMass = new PhysicalSimulation.ConstantForce(
                m(-2, PhysicalSimulation.Unit.KILOGRAM, 0, PhysicalSimulation.Unit.KILOGRAM),
                m(6, PhysicalSimulation.Unit.NEWTON, 0, PhysicalSimulation.Unit.NEWTON));
        assertThatThrownBy(() -> PhysicalSimulation.simulate(negativeMass, origin(), policy(0.5, 100, 1000)))
                .isInstanceOf(PhysicalSimulation.InvalidSimulationInputException.class)
                .hasMessageContaining("mass must be greater than zero");
        var noWorkBudget = new PhysicalSimulation.SolverPolicy(q(2, PhysicalSimulation.Unit.SECOND),
                q(0.5, PhysicalSimulation.Unit.SECOND), q(1e-5, PhysicalSimulation.Unit.SECOND),
                q(1e-8, PhysicalSimulation.Unit.METER), q(1e-8, PhysicalSimulation.Unit.METER_PER_SECOND), 2, 10);
        assertThatThrownBy(() -> PhysicalSimulation.simulate(
                new PhysicalSimulation.HarmonicSpring(m(1, PhysicalSimulation.Unit.KILOGRAM, 0, PhysicalSimulation.Unit.KILOGRAM),
                        m(100, PhysicalSimulation.Unit.NEWTON_PER_METER, 0, PhysicalSimulation.Unit.NEWTON_PER_METER),
                        m(0, PhysicalSimulation.Unit.METER, 0, PhysicalSimulation.Unit.METER)),
                new PhysicalSimulation.InitialState(m(1, PhysicalSimulation.Unit.METER, 0, PhysicalSimulation.Unit.METER),
                        m(0, PhysicalSimulation.Unit.METER_PER_SECOND, 0, PhysicalSimulation.Unit.METER_PER_SECOND)), noWorkBudget))
                .isInstanceOf(PhysicalSimulation.SolverLimitException.class);
        assertThatThrownBy(() -> new PhysicalSimulation.SolverPolicy(q(2, PhysicalSimulation.Unit.SECOND),
                q(1, PhysicalSimulation.Unit.SECOND), q(0.1, PhysicalSimulation.Unit.SECOND),
                q(1e-8, PhysicalSimulation.Unit.METER), q(1e-8, PhysicalSimulation.Unit.METER_PER_SECOND),
                Integer.MAX_VALUE, 10)).isInstanceOf(PhysicalSimulation.InvalidSimulationInputException.class);
        assertThatThrownBy(() -> PhysicalSimulation.simulate(null, origin(), policy(0.5, 100, 1000)))
                .isInstanceOf(NullPointerException.class);
    }
}
