package com.ghatana.audio.video.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.MediaSimulationContracts;
import com.ghatana.media.production.simulation.PhysicalSimulation;
import com.ghatana.media.production.simulation.SimulationSemanticValidator;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Source-free J-14 scenario check: exact input currentness must be established
 * before deterministic simulation output can receive a valid scientific pass.
 * The authored fixture is simulation-only and is not measured evidence.
 */
class ScientificSimulationCurrentnessIntegrationTest {
    private static final String SIMULATION_ONLY = "DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE";

    private static PhysicalSimulation.Quantity q(double value, PhysicalSimulation.Unit unit) {
        return new PhysicalSimulation.Quantity(value, unit);
    }

    private static PhysicalSimulation.Measurement m(double value, PhysicalSimulation.Unit unit) {
        return new PhysicalSimulation.Measurement(q(value, unit), q(0, unit));
    }

    private static PhysicalSimulation.Result deterministicFixture() {
        var model = new PhysicalSimulation.ConstantForce(
                m(2, PhysicalSimulation.Unit.KILOGRAM), m(6, PhysicalSimulation.Unit.NEWTON));
        var initial = new PhysicalSimulation.InitialState(
                m(0, PhysicalSimulation.Unit.METER), m(0, PhysicalSimulation.Unit.METER_PER_SECOND));
        var policy = new PhysicalSimulation.SolverPolicy(q(2, PhysicalSimulation.Unit.SECOND),
                q(0.25, PhysicalSimulation.Unit.SECOND), q(1e-5, PhysicalSimulation.Unit.SECOND),
                q(1e-8, PhysicalSimulation.Unit.METER), q(1e-8, PhysicalSimulation.Unit.METER_PER_SECOND),
                100, 1000);
        return PhysicalSimulation.simulate(model, initial, policy);
    }

    private static SimulationSemanticValidator.RunBinding exactBinding() {
        return new SimulationSemanticValidator.RunBinding("j14-source-free-run", List.of(
                new SimulationSemanticValidator.VersionedInput(SimulationSemanticValidator.InputRole.PHYSICAL_MODEL,
                        "model.constant-force", "v3", "a".repeat(64)),
                new SimulationSemanticValidator.VersionedInput(SimulationSemanticValidator.InputRole.INITIAL_CONDITIONS,
                        "initial.origin", "v2", "b".repeat(64)),
                new SimulationSemanticValidator.VersionedInput(SimulationSemanticValidator.InputRole.SOLVER,
                        "solver.velocity-verlet", "1.0.0", "c".repeat(64)),
                new SimulationSemanticValidator.VersionedInput(SimulationSemanticValidator.InputRole.SOLVER_POLICY,
                        "policy.precision", "v1", "d".repeat(64))),
                List.of(new SimulationSemanticValidator.DeclaredInvariant("terminal-position",
                        SimulationSemanticValidator.Observable.POSITION,
                        q(6, PhysicalSimulation.Unit.METER), q(1e-8, PhysicalSimulation.Unit.METER))),
                q(2, PhysicalSimulation.Unit.SECOND));
    }

    private static MediaSimulationContracts.RunRequest contractRequest(
            double mass, MediaSimulationContracts.Unit massUnit,
            double force, MediaSimulationContracts.Unit forceUnit,
            MediaSimulationContracts.SolverPolicy policy) {
        var massMeasurement = new MediaSimulationContracts.Measurement(
                new MediaSimulationContracts.Quantity(mass, massUnit),
                new MediaSimulationContracts.Quantity(0, massUnit));
        var forceMeasurement = new MediaSimulationContracts.Measurement(
                new MediaSimulationContracts.Quantity(force, forceUnit),
                new MediaSimulationContracts.Quantity(0, forceUnit));
        var initial = new MediaSimulationContracts.InitialState(
                new MediaSimulationContracts.Measurement(
                        new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.METER),
                        new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.METER)),
                new MediaSimulationContracts.Measurement(
                        new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.METER_PER_SECOND),
                        new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.METER_PER_SECOND)));
        return new MediaSimulationContracts.RunRequest(
                new MediaSimulationContracts.ConstantForce(massMeasurement, forceMeasurement), initial, policy);
    }

    private static MediaSimulationContracts.SolverPolicy contractPolicy(
            double duration, double maximumStep, double minimumStep, int maxAcceptedSteps, int maxIterations) {
        return new MediaSimulationContracts.SolverPolicy(
                new MediaSimulationContracts.Quantity(duration, MediaSimulationContracts.Unit.SECOND),
                new MediaSimulationContracts.Quantity(maximumStep, MediaSimulationContracts.Unit.SECOND),
                new MediaSimulationContracts.Quantity(minimumStep, MediaSimulationContracts.Unit.SECOND),
                new MediaSimulationContracts.Quantity(1e-8, MediaSimulationContracts.Unit.METER),
                new MediaSimulationContracts.Quantity(1e-8, MediaSimulationContracts.Unit.METER_PER_SECOND),
                maxAcceptedSteps, maxIterations);
    }

    @Test
    void unknownExactModelCurrentnessCannotProduceValidScientificPass() {
        var result = deterministicFixture();

        var validation = SimulationSemanticValidator.validate(exactBinding(), result, input ->
                input.role() == SimulationSemanticValidator.InputRole.PHYSICAL_MODEL
                        ? SimulationSemanticValidator.ReferenceStatus.UNKNOWN
                        : SimulationSemanticValidator.ReferenceStatus.CURRENT);

        assertThat(result.evidenceClass()).isEqualTo(SIMULATION_ONLY);
        assertThat(validation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.ABSTAIN);
        assertThat(validation.disposition()).isNotEqualTo(SimulationSemanticValidator.Disposition.VALID);
        assertThat(validation.resultKind())
                .isEqualTo(SimulationSemanticValidator.ResultKind.DETERMINISTIC_SIMULATION_ONLY);
        assertThat(validation.evidenceClass()).isEqualTo(SIMULATION_ONLY);
        assertThat(validation.findings()).anySatisfy(finding -> {
            assertThat(finding.reason()).isEqualTo(SimulationSemanticValidator.Reason.INPUT_REFERENCE_NOT_CURRENT);
            assertThat(finding.subject()).isEqualTo("model.constant-force");
            assertThat(finding.detail()).contains("currentness is unknown");
        });
    }

    @Test
    void missingOwnerReferenceAuthorityCannotAdmitFixtureAsScientificPass() {
        var result = deterministicFixture();

        var validation = SimulationSemanticValidator.validate(exactBinding(), result);

        assertThat(result.evidenceClass()).isEqualTo(SIMULATION_ONLY);
        assertThat(validation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.ABSTAIN);
        assertThat(validation.disposition()).isNotEqualTo(SimulationSemanticValidator.Disposition.VALID);
        assertThat(validation.resultKind())
                .isEqualTo(SimulationSemanticValidator.ResultKind.DETERMINISTIC_SIMULATION_ONLY);
        assertThat(validation.evidenceClass()).isEqualTo(SIMULATION_ONLY);
        assertThat(validation.findings()).anySatisfy(finding -> {
            assertThat(finding.reason())
                    .isEqualTo(SimulationSemanticValidator.Reason.REFERENCE_AUTHORITY_UNAVAILABLE);
            assertThat(finding.subject()).isEqualTo("inputs");
            assertThat(finding.detail()).contains("no owner reference verifier");
        });
    }

    @Test
    void dimensionMismatchIsRejectedBeforeSolverAndNeverProducesAResult() {
        var invalidMass = new MediaSimulationContracts.Measurement(
                new MediaSimulationContracts.Quantity(2, MediaSimulationContracts.Unit.METER),
                new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.METER));
        var force = new MediaSimulationContracts.Measurement(
                new MediaSimulationContracts.Quantity(6, MediaSimulationContracts.Unit.NEWTON),
                new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.NEWTON));

        assertThatThrownBy(() -> new MediaSimulationContracts.ConstantForce(invalidMass, force))
                .isInstanceOf(MediaSimulationContracts.InvalidQuantityException.class)
                .hasMessageContaining("mass requires MASS");
    }

    @Test
    void solverBudgetExhaustionAbstainsWithoutPartialNumericOutput() {
        var mass = new MediaSimulationContracts.Measurement(
                new MediaSimulationContracts.Quantity(2, MediaSimulationContracts.Unit.KILOGRAM),
                new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.KILOGRAM));
        var force = new MediaSimulationContracts.Measurement(
                new MediaSimulationContracts.Quantity(6, MediaSimulationContracts.Unit.NEWTON),
                new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.NEWTON));
        var zeroPosition = new MediaSimulationContracts.Measurement(
                new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.METER),
                new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.METER));
        var zeroVelocity = new MediaSimulationContracts.Measurement(
                new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.METER_PER_SECOND),
                new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.METER_PER_SECOND));
        var request = new MediaSimulationContracts.RunRequest(
                new MediaSimulationContracts.ConstantForce(mass, force),
                new MediaSimulationContracts.InitialState(zeroPosition, zeroVelocity),
                new MediaSimulationContracts.SolverPolicy(
                        new MediaSimulationContracts.Quantity(2, MediaSimulationContracts.Unit.SECOND),
                        new MediaSimulationContracts.Quantity(0.25, MediaSimulationContracts.Unit.SECOND),
                        new MediaSimulationContracts.Quantity(0.01, MediaSimulationContracts.Unit.SECOND),
                        new MediaSimulationContracts.Quantity(1e-8, MediaSimulationContracts.Unit.METER),
                        new MediaSimulationContracts.Quantity(1e-8, MediaSimulationContracts.Unit.METER_PER_SECOND),
                        100, 1));

        var outcome = PhysicalSimulation.run(request);

        assertThat(outcome.status()).isEqualTo(MediaSimulationContracts.OutcomeStatus.ABSTAINED);
        assertThat(outcome.failureCode()).isEqualTo(MediaSimulationContracts.FailureCode.SOLVER_LIMIT_REACHED);
        assertThat(outcome.trace()).isNull();
    }

    @Test
    void sourceFreeOutcomeExposesUnitCorrectDeterministicDynamicsAndInstrumentValues() {
        // Test-authored constant-force case: m=2 kg, F=6 N, x0=v0=0, t=2 s.
        // The closed-form terminal values are x=6 m, v=6 m/s, a=3 m/s^2.
        var request = contractRequest(2000, MediaSimulationContracts.Unit.GRAM,
                6000, MediaSimulationContracts.Unit.MILLINEWTON,
                contractPolicy(2, 0.25, 1e-5, 100, 1000));

        var first = PhysicalSimulation.run(request);
        var repeated = PhysicalSimulation.run(request);

        assertThat(first).isEqualTo(repeated);
        assertThat(first.status()).isEqualTo(MediaSimulationContracts.OutcomeStatus.COMPLETED);
        assertThat(first.failureCode()).isNull();
        assertThat(first.trace().deterministic()).isTrue();
        assertThat(first.trace().solverId()).isEqualTo(MediaSimulationContracts.VELOCITY_VERLET_SOLVER_V1);
        assertThat(first.trace().evidenceClass()).isEqualTo(SIMULATION_ONLY);
        assertThat(first.trace().observations()).hasSizeGreaterThan(2);
        assertThat(first.trace().observations().getFirst().time().si(MediaSimulationContracts.Dimension.TIME)).isEqualTo(0);
        var terminal = first.trace().observations().getLast();
        assertThat(terminal.time().si(MediaSimulationContracts.Dimension.TIME)).isEqualTo(2.0);
        assertThat(terminal.position().si(MediaSimulationContracts.Dimension.LENGTH)).isCloseTo(6.0,
                org.assertj.core.data.Offset.offset(1e-10));
        assertThat(terminal.velocity().si(MediaSimulationContracts.Dimension.VELOCITY)).isCloseTo(6.0,
                org.assertj.core.data.Offset.offset(1e-10));
        assertThat(terminal.acceleration().si(MediaSimulationContracts.Dimension.ACCELERATION)).isEqualTo(3.0);
        assertThat(terminal.totalEnergy().si(MediaSimulationContracts.Dimension.ENERGY)).isCloseTo(0.0,
                org.assertj.core.data.Offset.offset(1e-10));
        assertThat(terminal.uncertainty().status())
                .isEqualTo(MediaSimulationContracts.UncertaintyStatus.PROPAGATED_INDEPENDENT_GAUSSIAN);
        assertThat(terminal.uncertainty().positionStandardUncertainty()
                .si(MediaSimulationContracts.Dimension.LENGTH)).isEqualTo(0.0);
        assertThat(terminal.uncertainty().velocityStandardUncertainty()
                .si(MediaSimulationContracts.Dimension.VELOCITY)).isEqualTo(0.0);
    }

    @Test
    void sourceFreeOutcomeConvertsValueAndUncertaintyUnitsIndependently() {
        // Test-authored values: 2 kg +/- 1000 g, 6 N +/- 300 mN, and
        // initial position 100 cm +/- 2 cm. These are simulation estimates only.
        var mass = new MediaSimulationContracts.Measurement(
                new MediaSimulationContracts.Quantity(2, MediaSimulationContracts.Unit.KILOGRAM),
                new MediaSimulationContracts.Quantity(1000, MediaSimulationContracts.Unit.GRAM));
        var force = new MediaSimulationContracts.Measurement(
                new MediaSimulationContracts.Quantity(6_000, MediaSimulationContracts.Unit.MILLINEWTON),
                new MediaSimulationContracts.Quantity(300, MediaSimulationContracts.Unit.MILLINEWTON));
        var initial = new MediaSimulationContracts.InitialState(
                new MediaSimulationContracts.Measurement(
                        new MediaSimulationContracts.Quantity(100, MediaSimulationContracts.Unit.CENTIMETER),
                        new MediaSimulationContracts.Quantity(2, MediaSimulationContracts.Unit.CENTIMETER)),
                new MediaSimulationContracts.Measurement(
                        new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.METER_PER_SECOND),
                        new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.METER_PER_SECOND)));
        var request = new MediaSimulationContracts.RunRequest(
                new MediaSimulationContracts.ConstantForce(mass, force), initial,
                contractPolicy(2, 0.25, 1e-5, 100, 1000));

        var outcome = PhysicalSimulation.run(request);

        assertThat(outcome.status()).isEqualTo(MediaSimulationContracts.OutcomeStatus.COMPLETED);
        assertThat(outcome.trace().evidenceClass()).isEqualTo(SIMULATION_ONLY);
        var terminal = outcome.trace().observations().getLast();
        assertThat(terminal.position().si(MediaSimulationContracts.Dimension.LENGTH)).isCloseTo(7.0,
                org.assertj.core.data.Offset.offset(1e-10));
        // sigma_v^2 = (t*sigma_F/m)^2 + (F*t*sigma_m/m^2)^2 = 0.3^2 + 3^2.
        assertThat(terminal.uncertainty().velocityStandardUncertainty()
                .si(MediaSimulationContracts.Dimension.VELOCITY)).isCloseTo(Math.sqrt(9.09),
                org.assertj.core.data.Offset.offset(1e-10));
        // Position propagation also includes the converted initial-position uncertainty.
        assertThat(terminal.uncertainty().positionStandardUncertainty()
                .si(MediaSimulationContracts.Dimension.LENGTH)).isCloseTo(Math.sqrt(9.0904),
                org.assertj.core.data.Offset.offset(1e-10));
    }

    @Test
    void invalidPhysicalConstraintAndInconsistentStepBoundsReturnNoNumericOutcome() {
        var invalidMass = PhysicalSimulation.run(contractRequest(-1, MediaSimulationContracts.Unit.KILOGRAM,
                6, MediaSimulationContracts.Unit.NEWTON, contractPolicy(2, 0.25, 1e-5, 100, 1000)));
        assertThat(invalidMass.status()).isEqualTo(MediaSimulationContracts.OutcomeStatus.INVALID_INPUT);
        assertThat(invalidMass.failureCode()).isEqualTo(MediaSimulationContracts.FailureCode.INVALID_SIMULATION_INPUT);
        assertThat(invalidMass.trace()).isNull();

        var inconsistentPolicy = contractPolicy(2, 0.1, 0.2, 100, 1000);
        var invalidBounds = PhysicalSimulation.run(contractRequest(2, MediaSimulationContracts.Unit.KILOGRAM,
                6, MediaSimulationContracts.Unit.NEWTON, inconsistentPolicy));
        assertThat(invalidBounds.status()).isEqualTo(MediaSimulationContracts.OutcomeStatus.INVALID_INPUT);
        assertThat(invalidBounds.failureCode()).isEqualTo(MediaSimulationContracts.FailureCode.INVALID_SIMULATION_INPUT);
        assertThat(invalidBounds.trace()).isNull();
    }
}
