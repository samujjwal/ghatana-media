package com.ghatana.media.production.simulation;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class SimulationSemanticValidatorTest {
    private static final SimulationSemanticValidator.InputReferenceVerifier CURRENT_INPUTS =
            input -> SimulationSemanticValidator.ReferenceStatus.CURRENT;

    private static PhysicalSimulation.Quantity q(double value, PhysicalSimulation.Unit unit) {
        return new PhysicalSimulation.Quantity(value, unit);
    }

    private static PhysicalSimulation.Measurement m(double value, PhysicalSimulation.Unit unit) {
        return new PhysicalSimulation.Measurement(q(value, unit), q(0, unit));
    }

    private static PhysicalSimulation.Result result() {
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
        return new SimulationSemanticValidator.RunBinding("run-17", List.of(
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
                                q(1e-8, PhysicalSimulation.Unit.METER_PER_SECOND))),
                q(2, PhysicalSimulation.Unit.SECOND));
    }

    @Test
    void acceptsOnlyCompleteVersionedPhysicsPassAndKeepsEvidenceSimulationOnly() {
        var validation = SimulationSemanticValidator.validate(binding(), result(), CURRENT_INPUTS);

        assertThat(validation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.VALID);
        assertThat(validation.findings()).isEmpty();
        assertThat(validation.resultKind()).isEqualTo(SimulationSemanticValidator.ResultKind.DETERMINISTIC_SIMULATION_ONLY);
        assertThat(validation.evidenceClass()).isEqualTo("DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE");
    }

    @Test
    void abstainsWhenExactModelInputOrSolverReferenceIsMissing() {
        var complete = binding();
        var incomplete = new SimulationSemanticValidator.RunBinding(complete.runIdentity(),
                complete.inputs().stream().filter(input -> input.role() != SimulationSemanticValidator.InputRole.SOLVER).toList(),
                complete.invariants(), complete.expectedDuration());

        var validation = SimulationSemanticValidator.validate(incomplete, result(), CURRENT_INPUTS);

        assertThat(validation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.ABSTAIN);
        assertThat(validation.findings()).anySatisfy(finding ->
                assertThat(finding.reason()).isEqualTo(SimulationSemanticValidator.Reason.INCOMPLETE_INPUT_REFERENCES));
    }

    @Test
    void doesNotTreatRenderedPresentationAsPhysicalModelEvidence() {
        var complete = binding();
        var visualOnly = new SimulationSemanticValidator.RunBinding(complete.runIdentity(), List.of(
                new SimulationSemanticValidator.VersionedInput(SimulationSemanticValidator.InputRole.VISUAL_PRESENTATION,
                        "scene-anim.preview", "rev9", "e".repeat(64)),
                complete.inputs().get(1), complete.inputs().get(2), complete.inputs().get(3)),
                complete.invariants(), complete.expectedDuration());

        var validation = SimulationSemanticValidator.validate(visualOnly, result(), CURRENT_INPUTS);

        assertThat(validation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.ABSTAIN);
        assertThat(validation.findings()).anySatisfy(finding ->
                assertThat(finding.reason()).isEqualTo(
                        SimulationSemanticValidator.Reason.VISUAL_PRESENTATION_IS_NOT_PHYSICAL_MODEL));
    }

    @Test
    void resultBoundaryRejectsUnstableOrMisclassifiedSolverOutputBeforeValidation() {
        var stable = result();
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new PhysicalSimulation.Result(
                stable.observations(), stable.acceptedSteps(), stable.solverIterations(), 1.25,
                true, stable.evidenceClass()))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("error ratio");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new PhysicalSimulation.Result(
                stable.observations(), stable.acceptedSteps(), stable.solverIterations(),
                stable.finalLocalErrorRatio(), true, "MEASURED_RESULT"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("simulation-only evidence class");
    }

    @Test
    void rejectsIncompatibleUnitsAndInvariantViolations() {
        var complete = binding();
        var incompatible = new SimulationSemanticValidator.DeclaredInvariant("position-as-force",
                SimulationSemanticValidator.Observable.POSITION,
                q(6, PhysicalSimulation.Unit.NEWTON), q(0.1, PhysicalSimulation.Unit.NEWTON));
        var wrongUnits = new SimulationSemanticValidator.RunBinding(complete.runIdentity(), complete.inputs(),
                List.of(incompatible), complete.expectedDuration());

        var unitValidation = SimulationSemanticValidator.validate(wrongUnits, result(), CURRENT_INPUTS);
        assertThat(unitValidation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.REJECTED);
        assertThat(unitValidation.findings()).anySatisfy(finding ->
                assertThat(finding.reason()).isEqualTo(SimulationSemanticValidator.Reason.INCOMPATIBLE_UNITS));

        var falseClaim = new SimulationSemanticValidator.DeclaredInvariant("wrong-position",
                SimulationSemanticValidator.Observable.POSITION,
                q(650, PhysicalSimulation.Unit.CENTIMETER), q(1, PhysicalSimulation.Unit.CENTIMETER));
        var falseBinding = new SimulationSemanticValidator.RunBinding(complete.runIdentity(), complete.inputs(),
                List.of(falseClaim), complete.expectedDuration());
        var falseValidation = SimulationSemanticValidator.validate(falseBinding, result(), CURRENT_INPUTS);
        assertThat(falseValidation.disposition())
                .isEqualTo(SimulationSemanticValidator.Disposition.REJECTED);
        assertThat(falseValidation.findings()).anySatisfy(finding ->
                assertThat(finding.reason()).isEqualTo(SimulationSemanticValidator.Reason.SEMANTIC_INVARIANT_FAILED));
    }

    @Test
    void deterministicReplayRequiresIdenticalVersionedInputsAndExactOutput() {
        var firstBinding = binding();
        var first = result();
        assertThat(SimulationSemanticValidator.validateRepeatability(
                firstBinding, first, binding(), result(), CURRENT_INPUTS).disposition())
                .isEqualTo(SimulationSemanticValidator.Disposition.VALID);

        var changedBinding = new SimulationSemanticValidator.RunBinding("run-17", firstBinding.inputs(),
                firstBinding.invariants(), q(1, PhysicalSimulation.Unit.SECOND));
        assertThat(SimulationSemanticValidator.validateRepeatability(
                firstBinding, first, changedBinding, first, CURRENT_INPUTS).disposition())
                .isEqualTo(SimulationSemanticValidator.Disposition.ABSTAIN);

        var changedObservations = new ArrayList<>(first.observations());
        var last = changedObservations.getLast();
        changedObservations.set(changedObservations.size() - 1, new PhysicalSimulation.Observation(
                last.timeSeconds(), last.positionMeters() + 0.1, last.velocityMetersPerSecond(),
                last.accelerationMetersPerSecondSquared(), last.totalEnergyJoules(), last.uncertainty()));
        var nonRepeatable = new PhysicalSimulation.Result(changedObservations, first.acceptedSteps(),
                first.solverIterations(), first.finalLocalErrorRatio(), true, first.evidenceClass());
        assertThat(SimulationSemanticValidator.validateRepeatability(
                firstBinding, first, binding(), nonRepeatable, CURRENT_INPUTS).disposition())
                .isEqualTo(SimulationSemanticValidator.Disposition.REJECTED);
    }

    @Test
    void abstainsWhenNoOwnerReferenceVerifierCanEstablishCurrentness() {
        var validation = SimulationSemanticValidator.validate(binding(), result());
        assertThat(validation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.ABSTAIN);
        assertThat(validation.findings()).anySatisfy(finding ->
                assertThat(finding.reason()).isEqualTo(
                        SimulationSemanticValidator.Reason.REFERENCE_AUTHORITY_UNAVAILABLE));
    }

    @Test
    void abstainsWhenOwnerReferenceVerifierFails() {
        var validation = SimulationSemanticValidator.validate(binding(), result(), input -> {
            throw new IllegalStateException("reference authority unavailable");
        });

        assertThat(validation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.ABSTAIN);
        assertThat(validation.findings()).hasSize(binding().inputs().size())
                .allSatisfy(finding -> assertThat(finding.reason()).isEqualTo(
                        SimulationSemanticValidator.Reason.REFERENCE_AUTHORITY_UNAVAILABLE));
        assertThat(validation.resultKind())
                .isEqualTo(SimulationSemanticValidator.ResultKind.DETERMINISTIC_SIMULATION_ONLY);
        assertThat(validation.evidenceClass()).isEqualTo("DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE");
    }

    @Test
    void abstainsWhenAnyVersionedInputIsStaleOrUnknown() {
        var validation = SimulationSemanticValidator.validate(binding(), result(), input ->
                input.role() == SimulationSemanticValidator.InputRole.PHYSICAL_MODEL
                        ? SimulationSemanticValidator.ReferenceStatus.STALE
                        : SimulationSemanticValidator.ReferenceStatus.CURRENT);

        assertThat(validation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.ABSTAIN);
        assertThat(validation.findings()).anySatisfy(finding ->
                assertThat(finding.reason()).isEqualTo(SimulationSemanticValidator.Reason.INPUT_REFERENCE_NOT_CURRENT));
    }

    @Test
    void abstainsWhenCompletedTraceExceedsTheVersionedRunHorizon() {
        var complete = binding();
        var shortHorizon = new SimulationSemanticValidator.RunBinding(complete.runIdentity(), complete.inputs(),
                complete.invariants(), q(1, PhysicalSimulation.Unit.SECOND));

        var validation = SimulationSemanticValidator.validate(shortHorizon, result(), CURRENT_INPUTS);

        assertThat(validation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.ABSTAIN);
        assertThat(validation.findings()).anySatisfy(finding ->
                assertThat(finding.reason()).isEqualTo(SimulationSemanticValidator.Reason.HORIZON_MISMATCH));
        assertThat(validation.findings()).anySatisfy(finding ->
                assertThat(finding.reason()).isEqualTo(SimulationSemanticValidator.Reason.INVALID_OBSERVATION_TRACE));
    }

    @Test
    void abstainsWhenInvariantIdsAreMissingOrDuplicated() {
        var complete = binding();
        var repeated = complete.invariants().getFirst();
        var duplicateIds = new SimulationSemanticValidator.RunBinding(complete.runIdentity(), complete.inputs(),
                List.of(repeated, new SimulationSemanticValidator.DeclaredInvariant(repeated.invariantId(),
                        SimulationSemanticValidator.Observable.VELOCITY,
                        q(6, PhysicalSimulation.Unit.METER_PER_SECOND),
                        q(1e-8, PhysicalSimulation.Unit.METER_PER_SECOND))), complete.expectedDuration());

        var duplicateValidation = SimulationSemanticValidator.validate(duplicateIds, result(), CURRENT_INPUTS);
        assertThat(duplicateValidation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.ABSTAIN);
        assertThat(duplicateValidation.findings()).anySatisfy(finding ->
                assertThat(finding.reason()).isEqualTo(SimulationSemanticValidator.Reason.DUPLICATE_INVARIANT_ID));

        var blankId = new SimulationSemanticValidator.RunBinding(complete.runIdentity(), complete.inputs(),
                List.of(new SimulationSemanticValidator.DeclaredInvariant(" ",
                        SimulationSemanticValidator.Observable.POSITION,
                        q(6, PhysicalSimulation.Unit.METER), q(1e-8, PhysicalSimulation.Unit.METER))),
                complete.expectedDuration());
        var blankValidation = SimulationSemanticValidator.validate(blankId, result(), CURRENT_INPUTS);
        assertThat(blankValidation.disposition()).isEqualTo(SimulationSemanticValidator.Disposition.ABSTAIN);
        assertThat(blankValidation.findings()).anySatisfy(finding ->
                assertThat(finding.reason()).isEqualTo(SimulationSemanticValidator.Reason.MISSING_DECLARED_INVARIANT));
    }
}
