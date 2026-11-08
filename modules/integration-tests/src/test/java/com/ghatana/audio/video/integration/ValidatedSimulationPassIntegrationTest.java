package com.ghatana.audio.video.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.production.simulation.PhysicalSimulation;
import com.ghatana.media.production.simulation.SimulationSemanticValidator;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Source-free J-15 scenario check for a constrained deterministic simulation
 * pass. This fixture is model output, not instrument or measurement evidence.
 */
class ValidatedSimulationPassIntegrationTest {
    private static final String SIMULATION_ONLY = "DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE";

    private static PhysicalSimulation.Quantity q(double value, PhysicalSimulation.Unit unit) {
        return new PhysicalSimulation.Quantity(value, unit);
    }

    private static PhysicalSimulation.Measurement m(double value, PhysicalSimulation.Unit unit) {
        return new PhysicalSimulation.Measurement(q(value, unit), q(0, unit));
    }

    private static PhysicalSimulation.Result deterministicPass() {
        // Constant force: a = 6 N / 2 kg = 3 m/s²; at 2 s, x = 6 m and v = 6 m/s.
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

    private static SimulationSemanticValidator.RunBinding binding() {
        return new SimulationSemanticValidator.RunBinding("j15-constrained-pass", List.of(
                new SimulationSemanticValidator.VersionedInput(SimulationSemanticValidator.InputRole.PHYSICAL_MODEL,
                        "model.constant-force", "v3", "a".repeat(64)),
                new SimulationSemanticValidator.VersionedInput(SimulationSemanticValidator.InputRole.INITIAL_CONDITIONS,
                        "initial.origin", "v2", "b".repeat(64)),
                new SimulationSemanticValidator.VersionedInput(SimulationSemanticValidator.InputRole.SOLVER,
                        "solver.velocity-verlet", "1.0.0", "c".repeat(64)),
                new SimulationSemanticValidator.VersionedInput(SimulationSemanticValidator.InputRole.SOLVER_POLICY,
                        "policy.precision", "v1", "d".repeat(64))),
                List.of(
                        new SimulationSemanticValidator.DeclaredInvariant("terminal-position",
                                SimulationSemanticValidator.Observable.POSITION,
                                q(6, PhysicalSimulation.Unit.METER), q(1e-8, PhysicalSimulation.Unit.METER)),
                        new SimulationSemanticValidator.DeclaredInvariant("terminal-velocity",
                                SimulationSemanticValidator.Observable.VELOCITY,
                                q(6, PhysicalSimulation.Unit.METER_PER_SECOND),
                                q(1e-8, PhysicalSimulation.Unit.METER_PER_SECOND)),
                        // For the constant-force model, total energy includes the
                        // force potential (-F*x), so the declared terminal value is 0 J.
                        new SimulationSemanticValidator.DeclaredInvariant("terminal-total-energy",
                                SimulationSemanticValidator.Observable.TOTAL_ENERGY,
                                q(0, PhysicalSimulation.Unit.JOULE),
                                q(1e-8, PhysicalSimulation.Unit.JOULE))),
                q(2, PhysicalSimulation.Unit.SECOND));
    }

    @Test
    void validatesConstrainedPassAndRejectsProtectedSemanticChange() {
        var result = deterministicPass();

        var valid = SimulationSemanticValidator.validate(binding(), result,
                input -> SimulationSemanticValidator.ReferenceStatus.CURRENT);

        assertThat(valid.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.VALID);
        assertThat(valid.findings()).isEmpty();
        assertThat(result.evidenceClass()).isEqualTo(SIMULATION_ONLY);
        assertThat(valid.evidenceClass()).isEqualTo(SIMULATION_ONLY);

        var changedObservations = new ArrayList<>(result.observations());
        var terminal = changedObservations.getLast();
        changedObservations.set(changedObservations.size() - 1, new PhysicalSimulation.Observation(
                terminal.timeSeconds(), terminal.positionMeters() + 1.0, terminal.velocityMetersPerSecond(),
                terminal.accelerationMetersPerSecondSquared(), terminal.totalEnergyJoules(), terminal.uncertainty()));
        var changedPass = new PhysicalSimulation.Result(changedObservations, result.acceptedSteps(),
                result.solverIterations(), result.finalLocalErrorRatio(), result.deterministic(), result.evidenceClass());

        var rejected = SimulationSemanticValidator.validate(binding(), changedPass,
                input -> SimulationSemanticValidator.ReferenceStatus.CURRENT);

        assertThat(rejected.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.REJECTED);
        assertThat(rejected.findings()).anySatisfy(finding ->
                assertThat(finding.reason())
                        .isEqualTo(SimulationSemanticValidator.Reason.SEMANTIC_INVARIANT_FAILED));
        assertThat(rejected.evidenceClass()).isEqualTo(SIMULATION_ONLY);
    }

    @Test
    void rejectsCandidateThatChangesProtectedTotalEnergy() {
        var result = deterministicPass();
        var changedObservations = new ArrayList<>(result.observations());
        var terminal = changedObservations.getLast();
        changedObservations.set(changedObservations.size() - 1, new PhysicalSimulation.Observation(
                terminal.timeSeconds(), terminal.positionMeters(), terminal.velocityMetersPerSecond(),
                terminal.accelerationMetersPerSecondSquared(), terminal.totalEnergyJoules() + 1.0,
                terminal.uncertainty()));
        var changedPass = new PhysicalSimulation.Result(changedObservations, result.acceptedSteps(),
                result.solverIterations(), result.finalLocalErrorRatio(), result.deterministic(), result.evidenceClass());

        var validation = SimulationSemanticValidator.validate(binding(), changedPass,
                input -> SimulationSemanticValidator.ReferenceStatus.CURRENT);

        assertThat(validation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.REJECTED);
        assertThat(validation.findings()).anySatisfy(finding -> {
            assertThat(finding.reason())
                    .isEqualTo(SimulationSemanticValidator.Reason.SEMANTIC_INVARIANT_FAILED);
            assertThat(finding.subject()).isEqualTo("terminal-total-energy");
        });
        assertThat(validation.evidenceClass()).isEqualTo(SIMULATION_ONLY);
    }

    @Test
    void abstainsWhenAProtectedInputReferenceIsNotKnownCurrent() {
        var validation = SimulationSemanticValidator.validate(binding(), deterministicPass(), input ->
                input.role() == SimulationSemanticValidator.InputRole.PHYSICAL_MODEL
                        ? SimulationSemanticValidator.ReferenceStatus.UNKNOWN
                        : SimulationSemanticValidator.ReferenceStatus.CURRENT);

        assertThat(validation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.ABSTAIN);
        assertThat(validation.resultKind())
                .isEqualTo(SimulationSemanticValidator.ResultKind.DETERMINISTIC_SIMULATION_ONLY);
        assertThat(validation.evidenceClass()).isEqualTo(SIMULATION_ONLY);
        assertThat(validation.findings()).anySatisfy(finding -> {
            assertThat(finding.reason())
                    .isEqualTo(SimulationSemanticValidator.Reason.INPUT_REFERENCE_NOT_CURRENT);
            assertThat(finding.subject()).isEqualTo("model.constant-force");
        });
    }

    @Test
    void abstainsWhenAnyRequiredPassInputReferenceIsStaleOrUnknown() {
        var requiredRoles = List.of(
                SimulationSemanticValidator.InputRole.PHYSICAL_MODEL,
                SimulationSemanticValidator.InputRole.INITIAL_CONDITIONS,
                SimulationSemanticValidator.InputRole.SOLVER,
                SimulationSemanticValidator.InputRole.SOLVER_POLICY);

        for (var unavailableRole : requiredRoles) {
            for (var unavailableStatus : List.of(
                    SimulationSemanticValidator.ReferenceStatus.STALE,
                    SimulationSemanticValidator.ReferenceStatus.UNKNOWN)) {
                var validation = SimulationSemanticValidator.validate(binding(), deterministicPass(), input ->
                        input.role() == unavailableRole
                                ? unavailableStatus
                                : SimulationSemanticValidator.ReferenceStatus.CURRENT);

                assertThat(validation.disposition())
                        .as("%s reference status %s", unavailableRole, unavailableStatus)
                        .isEqualTo(SimulationSemanticValidator.Disposition.ABSTAIN);
                assertThat(validation.findings()).anySatisfy(finding -> {
                    assertThat(finding.reason())
                            .isEqualTo(SimulationSemanticValidator.Reason.INPUT_REFERENCE_NOT_CURRENT);
                    assertThat(finding.subject()).isEqualTo(identityFor(unavailableRole));
                });
                assertThat(validation.evidenceClass()).isEqualTo(SIMULATION_ONLY);
            }
        }
    }

    private static String identityFor(SimulationSemanticValidator.InputRole role) {
        return switch (role) {
            case PHYSICAL_MODEL -> "model.constant-force";
            case INITIAL_CONDITIONS -> "initial.origin";
            case SOLVER -> "solver.velocity-verlet";
            case SOLVER_POLICY -> "policy.precision";
            case VISUAL_PRESENTATION -> throw new IllegalArgumentException("not a required pass input role");
        };
    }

    @Test
    void abstainsWhenDeclaredRunHorizonDiffersFromTheSolverTrace() {
        var complete = binding();
        var wrongHorizon = new SimulationSemanticValidator.RunBinding(complete.runIdentity(), complete.inputs(),
                complete.invariants(), q(1.5, PhysicalSimulation.Unit.SECOND));

        var validation = SimulationSemanticValidator.validate(wrongHorizon, deterministicPass(),
                input -> SimulationSemanticValidator.ReferenceStatus.CURRENT);

        assertThat(validation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.ABSTAIN);
        assertThat(validation.findings()).anySatisfy(finding ->
                assertThat(finding.reason()).isEqualTo(SimulationSemanticValidator.Reason.HORIZON_MISMATCH));
        assertThat(validation.resultKind())
                .isEqualTo(SimulationSemanticValidator.ResultKind.DETERMINISTIC_SIMULATION_ONLY);
        assertThat(validation.evidenceClass()).isEqualTo(SIMULATION_ONLY);
    }

    @Test
    void abstainsBeforeReferenceChecksWhenNoProtectedSemanticInvariantIsDeclared() {
        var complete = binding();
        var noProtectedProperties = new SimulationSemanticValidator.RunBinding(complete.runIdentity(),
                complete.inputs(), List.of(), complete.expectedDuration());
        var referenceChecks = new java.util.concurrent.atomic.AtomicInteger();

        var validation = SimulationSemanticValidator.validate(noProtectedProperties, deterministicPass(), input -> {
            referenceChecks.incrementAndGet();
            return SimulationSemanticValidator.ReferenceStatus.CURRENT;
        });

        assertThat(validation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.ABSTAIN);
        assertThat(validation.findings()).singleElement().satisfies(finding -> {
            assertThat(finding.reason()).isEqualTo(SimulationSemanticValidator.Reason.MISSING_DECLARED_INVARIANT);
            assertThat(finding.subject()).isEqualTo("invariants");
        });
        assertThat(referenceChecks).hasValue(0);
        assertThat(validation.resultKind())
                .isEqualTo(SimulationSemanticValidator.ResultKind.DETERMINISTIC_SIMULATION_ONLY);
        assertThat(validation.evidenceClass()).isEqualTo(SIMULATION_ONLY);
    }
}
