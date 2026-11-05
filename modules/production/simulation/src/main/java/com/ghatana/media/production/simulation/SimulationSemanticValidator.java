package com.ghatana.media.production.simulation;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * Checks a deterministic physical simulation pass against versioned inputs and
 * caller-declared invariants. It never promotes simulated values to measurements.
 */
public final class SimulationSemanticValidator {
    private static final String SIMULATION_EVIDENCE = "DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE";
    private static final String SHA256 = "^[a-fA-F0-9]{64}$";

    private SimulationSemanticValidator() {}

    public enum InputRole { PHYSICAL_MODEL, INITIAL_CONDITIONS, SOLVER, SOLVER_POLICY, VISUAL_PRESENTATION }
    public enum Observable { POSITION, VELOCITY, TOTAL_ENERGY }
    public enum Disposition { VALID, REJECTED, ABSTAIN }
    public enum ResultKind { DETERMINISTIC_SIMULATION_ONLY }
    public enum ReferenceStatus { CURRENT, STALE, UNKNOWN }
    public enum Reason {
        INCOMPLETE_INPUT_REFERENCES,
        INPUT_REFERENCE_NOT_CURRENT,
        REFERENCE_AUTHORITY_UNAVAILABLE,
        DUPLICATE_INPUT_ROLE,
        INVALID_INPUT_REFERENCE,
        DUPLICATE_INVARIANT_ID,
        VISUAL_PRESENTATION_IS_NOT_PHYSICAL_MODEL,
        MISSING_DECLARED_INVARIANT,
        SOLVER_NOT_DETERMINISTIC,
        SOLVER_STABILITY_UNPROVEN,
        INVALID_OBSERVATION_TRACE,
        MODEL_OUTPUT_LABEL_MISMATCH,
        HORIZON_MISMATCH,
        INCOMPATIBLE_UNITS,
        SEMANTIC_INVARIANT_FAILED,
        REPLAY_INPUTS_DIFFER,
        NON_REPEATABLE_RESULT
    }

    /** An exact, content-addressed model/input/tool reference used by one pass. */
    public record VersionedInput(InputRole role, String identity, String version, String sha256) {
        public VersionedInput {
            Objects.requireNonNull(role, "role");
            identity = identity == null ? "" : identity.trim();
            version = version == null ? "" : version.trim();
            sha256 = sha256 == null ? "" : sha256.trim();
        }

        private boolean complete() {
            return !identity.isBlank() && !version.isBlank() && sha256.matches(SHA256);
        }
    }

    /** A numeric invariant over the exact terminal observation of a pass. */
    public record DeclaredInvariant(
            String invariantId,
            Observable observable,
            PhysicalSimulation.Quantity expected,
            PhysicalSimulation.Quantity absoluteTolerance) {
        public DeclaredInvariant {
            invariantId = invariantId == null ? "" : invariantId.trim();
            Objects.requireNonNull(observable, "observable");
            Objects.requireNonNull(expected, "expected");
            Objects.requireNonNull(absoluteTolerance, "absoluteTolerance");
        }
    }

    /** Immutable identity and declared semantics for one proposed solver pass. */
    public record RunBinding(
            String runIdentity,
            List<VersionedInput> inputs,
            List<DeclaredInvariant> invariants,
            PhysicalSimulation.Quantity expectedDuration) {
        public RunBinding {
            runIdentity = runIdentity == null ? "" : runIdentity.trim();
            inputs = List.copyOf(Objects.requireNonNull(inputs, "inputs"));
            invariants = List.copyOf(Objects.requireNonNull(invariants, "invariants"));
            Objects.requireNonNull(expectedDuration, "expectedDuration");
        }
    }

    /** Resolves each exact reference against its owning source of version/currentness. */
    @FunctionalInterface
    public interface InputReferenceVerifier {
        ReferenceStatus verify(VersionedInput input);
    }

    public record Finding(Reason reason, String subject, String detail) {
        public Finding {
            Objects.requireNonNull(reason, "reason");
            subject = subject == null ? "" : subject;
            detail = detail == null ? "" : detail;
        }
    }

    /** Evidence is always simulation-only, regardless of whether validation succeeds. */
    public record Validation(Disposition disposition, List<Finding> findings, ResultKind resultKind,
                             String evidenceClass) {
        public Validation {
            Objects.requireNonNull(disposition, "disposition");
            findings = List.copyOf(findings);
            Objects.requireNonNull(resultKind, "resultKind");
            Objects.requireNonNull(evidenceClass, "evidenceClass");
            if (!SIMULATION_EVIDENCE.equals(evidenceClass)) {
                throw new IllegalArgumentException("simulation validation cannot emit measurement evidence");
            }
        }
    }

    public static Validation validate(RunBinding binding, PhysicalSimulation.Result result) {
        return validate(binding, result, null);
    }

    public static Validation validate(
            RunBinding binding, PhysicalSimulation.Result result, InputReferenceVerifier referenceVerifier) {
        Objects.requireNonNull(binding, "binding");
        Objects.requireNonNull(result, "result");
        List<Finding> findings = new ArrayList<>();
        if (binding.runIdentity().isBlank()) {
            findings.add(new Finding(Reason.INCOMPLETE_INPUT_REFERENCES, "runIdentity", "pass identity is absent"));
        }
        EnumMap<InputRole, VersionedInput> byRole = new EnumMap<>(InputRole.class);
        Set<InputRole> duplicates = new HashSet<>();
        for (VersionedInput input : binding.inputs()) {
            if (!input.complete()) {
                findings.add(new Finding(Reason.INVALID_INPUT_REFERENCE, input.role().name(),
                        "input identity, exact version, and SHA-256 digest are required"));
            }
            if (byRole.putIfAbsent(input.role(), input) != null) duplicates.add(input.role());
            if (input.role() == InputRole.VISUAL_PRESENTATION) {
                findings.add(new Finding(Reason.VISUAL_PRESENTATION_IS_NOT_PHYSICAL_MODEL, input.identity(),
                        "rendered appearance cannot supply a scientific model or solver input"));
            }
        }
        for (InputRole role : List.of(InputRole.PHYSICAL_MODEL, InputRole.INITIAL_CONDITIONS,
                InputRole.SOLVER, InputRole.SOLVER_POLICY)) {
            if (!byRole.containsKey(role)) {
                findings.add(new Finding(Reason.INCOMPLETE_INPUT_REFERENCES, role.name(),
                        "exact versioned input reference is required"));
            }
        }
        for (InputRole role : duplicates) {
            findings.add(new Finding(Reason.DUPLICATE_INPUT_ROLE, role.name(),
                    "one exact reference per pass input role is required"));
        }
        if (binding.invariants().isEmpty()) {
            findings.add(new Finding(Reason.MISSING_DECLARED_INVARIANT, "invariants",
                    "a pass requires at least one declared semantic invariant"));
        }
        Set<String> invariantIds = new HashSet<>();
        for (DeclaredInvariant invariant : binding.invariants()) {
            if (invariant.invariantId().isBlank()) {
                findings.add(new Finding(Reason.MISSING_DECLARED_INVARIANT, "invariants",
                        "every declared invariant requires a stable identity"));
            } else if (!invariantIds.add(invariant.invariantId())) {
                findings.add(new Finding(Reason.DUPLICATE_INVARIANT_ID, invariant.invariantId(),
                        "invariant identities must be unique within a pass"));
            }
        }
        if (!findings.isEmpty()) return validation(Disposition.ABSTAIN, findings);

        if (referenceVerifier == null) {
            return validation(Disposition.ABSTAIN, List.of(new Finding(Reason.REFERENCE_AUTHORITY_UNAVAILABLE,
                    "inputs", "no owner reference verifier is available for exact pass input versions")));
        }
        for (VersionedInput input : binding.inputs()) {
            final ReferenceStatus referenceStatus;
            try {
                referenceStatus = Objects.requireNonNull(referenceVerifier.verify(input), "reference status");
            } catch (RuntimeException unavailable) {
                findings.add(new Finding(Reason.REFERENCE_AUTHORITY_UNAVAILABLE, input.identity(),
                        "owner could not resolve the exact pass input reference"));
                continue;
            }
            if (referenceStatus != ReferenceStatus.CURRENT) {
                findings.add(new Finding(Reason.INPUT_REFERENCE_NOT_CURRENT, input.identity(),
                        "pass input is stale or currentness is unknown"));
            }
        }
        if (!findings.isEmpty()) return validation(Disposition.ABSTAIN, findings);

        if (!result.deterministic()) {
            findings.add(new Finding(Reason.SOLVER_NOT_DETERMINISTIC, "solver", "declared solver output is not deterministic"));
        }
        if (result.finalLocalErrorRatio() > 1.0 || result.finalLocalErrorRatio() < 0.0
                || result.observations().isEmpty()) {
            findings.add(new Finding(Reason.SOLVER_STABILITY_UNPROVEN, "solver",
                    "solver error bound or observation trace is incomplete"));
        }
        if (!SIMULATION_EVIDENCE.equals(result.evidenceClass())) {
            findings.add(new Finding(Reason.MODEL_OUTPUT_LABEL_MISMATCH, "evidenceClass",
                    "solver output is not labeled as simulation-only evidence"));
        }
        double expectedDuration;
        try {
            expectedDuration = binding.expectedDuration().si(PhysicalSimulation.Dimension.TIME, "expected duration");
        } catch (PhysicalSimulation.InvalidSimulationInputException incompatible) {
            findings.add(new Finding(Reason.INCOMPATIBLE_UNITS, "expectedDuration", incompatible.getMessage()));
            expectedDuration = Double.NaN;
        }
        if (!Double.isFinite(expectedDuration) || !(expectedDuration > 0)
                || Math.abs(result.observations().getLast().timeSeconds() - expectedDuration)
                        > Math.max(1e-12, Math.ulp(expectedDuration) * 8)) {
            findings.add(new Finding(Reason.HORIZON_MISMATCH, "expectedDuration",
                    "terminal observation does not match the versioned run horizon"));
        }
        if (Double.isFinite(expectedDuration)) {
            double timeTolerance = Math.max(1e-12, Math.ulp(expectedDuration) * 8);
            List<PhysicalSimulation.Observation> observations = result.observations();
            if (observations.size() < 2 || Math.abs(observations.getFirst().timeSeconds()) > timeTolerance) {
                findings.add(new Finding(Reason.INVALID_OBSERVATION_TRACE, "observations",
                        "a simulation trace must start at zero and contain a terminal observation"));
            }
            double previousTime = -1;
            for (PhysicalSimulation.Observation observation : observations) {
                double sampleTime = observation.timeSeconds();
                if (sampleTime < 0 || sampleTime > expectedDuration + timeTolerance || sampleTime <= previousTime) {
                    findings.add(new Finding(Reason.INVALID_OBSERVATION_TRACE, "observations",
                            "simulation sample times must be strictly increasing within the declared horizon"));
                    break;
                }
                previousTime = sampleTime;
            }
        }
        if (!findings.isEmpty()) return validation(Disposition.ABSTAIN, findings);

        for (DeclaredInvariant invariant : binding.invariants()) {
            PhysicalSimulation.Dimension dimension = dimension(invariant.observable());
            final double expected;
            final double tolerance;
            try {
                expected = invariant.expected().si(dimension, invariant.invariantId() + " expected");
                tolerance = invariant.absoluteTolerance().si(dimension, invariant.invariantId() + " tolerance");
            } catch (PhysicalSimulation.InvalidSimulationInputException incompatible) {
                findings.add(new Finding(Reason.INCOMPATIBLE_UNITS, invariant.invariantId(), incompatible.getMessage()));
                continue;
            }
            if (invariant.invariantId().isBlank() || !Double.isFinite(tolerance) || tolerance < 0) {
                findings.add(new Finding(Reason.MISSING_DECLARED_INVARIANT, invariant.invariantId(),
                        "invariant identity and finite non-negative tolerance are required"));
                continue;
            }
            double actual = observable(result.observations().getLast(), invariant.observable());
            if (Math.abs(actual - expected) > tolerance) {
                findings.add(new Finding(Reason.SEMANTIC_INVARIANT_FAILED, invariant.invariantId(),
                        "terminal simulation value is outside the declared tolerance"));
            }
        }
        return validation(findings.isEmpty() ? Disposition.VALID : Disposition.REJECTED, findings);
    }

    /** Checks deterministic replay only when both runs claim the same versioned input set. */
    public static Validation validateRepeatability(
            RunBinding firstBinding, PhysicalSimulation.Result first,
            RunBinding replayBinding, PhysicalSimulation.Result replay) {
        return validateRepeatability(firstBinding, first, replayBinding, replay, null);
    }

    public static Validation validateRepeatability(
            RunBinding firstBinding, PhysicalSimulation.Result first,
            RunBinding replayBinding, PhysicalSimulation.Result replay,
            InputReferenceVerifier referenceVerifier) {
        Objects.requireNonNull(firstBinding, "firstBinding");
        Objects.requireNonNull(first, "first");
        Objects.requireNonNull(replayBinding, "replayBinding");
        Objects.requireNonNull(replay, "replay");
        if (!firstBinding.equals(replayBinding)) {
            return validation(Disposition.ABSTAIN, List.of(new Finding(Reason.REPLAY_INPUTS_DIFFER,
                    "runBinding", "replay does not use the exact same versioned inputs and invariants")));
        }
        if (!first.equals(replay)) {
            return validation(Disposition.REJECTED, List.of(new Finding(Reason.NON_REPEATABLE_RESULT,
                    "observations", "same versioned pass inputs produced different solver output")));
        }
        return validate(firstBinding, first, referenceVerifier);
    }

    private static PhysicalSimulation.Dimension dimension(Observable observable) {
        return switch (observable) {
            case POSITION -> PhysicalSimulation.Dimension.LENGTH;
            case VELOCITY -> PhysicalSimulation.Dimension.VELOCITY;
            case TOTAL_ENERGY -> PhysicalSimulation.Dimension.ENERGY;
        };
    }

    private static double observable(PhysicalSimulation.Observation observation, Observable observable) {
        return switch (observable) {
            case POSITION -> observation.positionMeters();
            case VELOCITY -> observation.velocityMetersPerSecond();
            case TOTAL_ENERGY -> observation.totalEnergyJoules();
        };
    }

    private static Validation validation(Disposition disposition, List<Finding> findings) {
        return new Validation(disposition, findings, ResultKind.DETERMINISTIC_SIMULATION_ONLY, SIMULATION_EVIDENCE);
    }
}
