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
}
