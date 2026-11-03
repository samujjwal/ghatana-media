package com.ghatana.media.simulation;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * H-06: a deterministic seeded constant-force simulator producing
 * checkpointed, reproducible observables.
 *
 * <p>Determinism is structural: the stepper integrates with the exact
 * trapezoidal rule (exact for constant acceleration), so identical
 * (model, seed, steps) yields bit-identical state. Checkpoints are immutable
 * snapshots; resuming from one reproduces the same trajectory.
 *
 * <p>Two honest failure modes produce {@link Verdict#ABSTAIN}: a units
 * registry other than the declared SI set, and a per-step numeric result
 * diverging from the closed-form solution beyond the declared tolerance —
 * the solver-integrity guard, never a softened error.
 *
 * <p>Reference fixture (analytical Newton check): mass 2 kg, force 6 N,
 * t = 2 s ⇒ a = 3 m/s², v = 6 m/s, x = 6 m.
 *
 * @doc.type class
 * @doc.purpose Deterministic seeded simulation stepper with checkpoints
 * @doc.layer product
 * @doc.pattern Simulator
 */
public final class MediaDeterministicSimulator {

    /** The only units registry this stepper binds. */
    public static final String SI_UNITS = "SI";

    /** The verdict of a simulation run. */
    public enum Verdict { CONVERGED, STEP_LIMIT_REACHED, ABSTAIN }

    /** Initial state for a one-dimensional constant-force body. */
    public record InitialState(
            double positionMeters,
            double velocityMetersPerSecond) {
        public InitialState {
            if (!Double.isFinite(positionMeters) || !Double.isFinite(velocityMetersPerSecond)) {
                throw new IllegalArgumentException("initial state must be finite");
            }
        }
    }

    /** Boundary condition explicitly supported by this narrow reference model. */
    public enum BoundaryCondition { UNCONSTRAINED_1D }

    /** Closed typed input for the bounded one-dimensional reference solver. */
    public record SimulationModelIR(
            ModelSpec model,
            InitialState initialState,
            BoundaryCondition boundaryCondition) {
        public SimulationModelIR {
            Objects.requireNonNull(model, "model");
            Objects.requireNonNull(initialState, "initialState");
            Objects.requireNonNull(boundaryCondition, "boundaryCondition");
        }
    }

    /** Model identity — solver family + exact parameters + unit registry. */
    public record ModelSpec(
            String solverId,
            String solverVersion,
            String unitsRegistry,
            double massKg,
            double forceN,
            double stepSeconds,
            int maxSteps,
            /** Relative error ceiling vs the closed-form solution; beyond it ABSTAIN. */
            double tolerance) {
        public ModelSpec {
            for (String field : List.of(solverId, solverVersion, unitsRegistry)) {
                if (field == null || field.isBlank() || field.length() > 128) {
                    throw new IllegalArgumentException("model identity fields are required and bounded");
                }
            }
            if (!Double.isFinite(massKg) || massKg <= 0
                    || !Double.isFinite(forceN)
                    || !Double.isFinite(stepSeconds) || stepSeconds <= 0 || stepSeconds > 60
                    || maxSteps < 1 || maxSteps > 1_000_000
                    || !Double.isFinite(tolerance) || tolerance <= 0) {
                throw new IllegalArgumentException("model parameters are outside declared bounds");
            }
        }
    }

    /** An immutable state checkpoint bound to the exact numerical model identity. */
    public record Checkpoint(
            int stepIndex,
            double positionMeters,
            double velocityMetersPerSecond,
            long seed,
            String modelFingerprint) {
        public Checkpoint {
            if (stepIndex < 0 || !Double.isFinite(positionMeters)
                    || !Double.isFinite(velocityMetersPerSecond)
                    || modelFingerprint == null || modelFingerprint.length() > 512) {
                throw new IllegalArgumentException("checkpoint step and state must be valid and finite");
            }
        }

        /** Compatibility constructor for checkpoints without verifiable model binding. */
        public Checkpoint(int stepIndex, double positionMeters, double velocityMetersPerSecond, long seed) {
            this(stepIndex, positionMeters, velocityMetersPerSecond, seed, "");
        }
    }

    /** One run's outcome. */
    public record SimulationResult(
            Verdict verdict,
            List<Checkpoint> checkpoints,
            String abstainReason) {
        public SimulationResult {
            checkpoints = List.copyOf(checkpoints);
        }
    }

    /** A reproducible sample from the bounded adaptive constant-force stepper. */
    public record AdaptiveSample(
            int acceptedStep,
            long seed,
            double simulationTimeSeconds,
            double positionMeters,
            double velocityMetersPerSecond,
            double accelerationMetersPerSecondSquared,
            double estimatedPositionErrorMeters,
            double estimatedVelocityErrorMetersPerSecond,
            double positionUncertaintyMeters,
            double velocityUncertaintyMetersPerSecond) {
        public AdaptiveSample {
            if (acceptedStep < 1 || !Double.isFinite(simulationTimeSeconds)
                    || !Double.isFinite(positionMeters) || !Double.isFinite(velocityMetersPerSecond)
                    || !Double.isFinite(accelerationMetersPerSecondSquared)
                    || !Double.isFinite(estimatedPositionErrorMeters)
                    || !Double.isFinite(estimatedVelocityErrorMetersPerSecond)
                    || !Double.isFinite(positionUncertaintyMeters)
                    || !Double.isFinite(velocityUncertaintyMetersPerSecond)) {
                throw new IllegalArgumentException("adaptive sample values must be finite and non-negative");
            }
            if (estimatedPositionErrorMeters < 0 || estimatedVelocityErrorMetersPerSecond < 0
                    || positionUncertaintyMeters < 0 || velocityUncertaintyMetersPerSecond < 0) {
                throw new IllegalArgumentException("adaptive error and uncertainty must be non-negative");
            }
        }
    }

    /** Immutable restart state for an adaptive run, bound to its exact model IR and seed. */
    public record AdaptiveCheckpoint(
            int acceptedStep,
            double simulationTimeSeconds,
            double positionMeters,
            double velocityMetersPerSecond,
            long seed,
            double nextStepSizeSeconds,
            double minimumStepSeconds,
            String modelFingerprint) {
        public AdaptiveCheckpoint {
            if (acceptedStep < 0 || !Double.isFinite(simulationTimeSeconds) || simulationTimeSeconds < 0
                    || !Double.isFinite(positionMeters) || !Double.isFinite(velocityMetersPerSecond)
                    || !Double.isFinite(nextStepSizeSeconds) || nextStepSizeSeconds <= 0
                    || !Double.isFinite(minimumStepSeconds) || minimumStepSeconds <= 0
                    || minimumStepSeconds > nextStepSizeSeconds
                    || modelFingerprint == null || modelFingerprint.isBlank() || modelFingerprint.length() > 1024) {
                throw new IllegalArgumentException("adaptive checkpoint fields are invalid or outside bounds");
            }
        }
    }

    /** Result of integrating to an explicit simulation-time boundary. */
    public record AdaptiveResult(
            Verdict verdict,
            List<AdaptiveSample> samples,
            AdaptiveCheckpoint checkpoint,
            String abstainReason) {
        public AdaptiveResult {
            samples = List.copyOf(samples);
        }
    }

    /**
     * Runs the seeded constant-force integration. The trapezoidal rule is
     * exact for constant acceleration; each step is additionally checked
     * against the closed form — a divergence beyond tolerance abstains
     * rather than publishing indefensible numbers.
     */
    public SimulationResult run(ModelSpec model, InitialState initial, long seed) {
        Objects.requireNonNull(model, "model");
        Objects.requireNonNull(initial, "initial");
        if (!SI_UNITS.equals(model.unitsRegistry())) {
            return new SimulationResult(Verdict.ABSTAIN, List.of(),
                    "mismatched units registry: " + model.unitsRegistry());
        }
        if (!supportsSolver(model)) {
            return new SimulationResult(Verdict.ABSTAIN, List.of(), "unsupported solver identity or version");
        }
        double a = model.forceN() / model.massKg();
        double dt = model.stepSeconds();
        double position = initial.positionMeters();
        double velocity = initial.velocityMetersPerSecond();

        List<Checkpoint> checkpoints = new ArrayList<>();
        for (int step = 1; step <= model.maxSteps(); step++) {
            // Exact trapezoid for constant acceleration: x += v*dt + a*dt²/2, v += a*dt.
            double nextVelocity = velocity + a * dt;
            double nextPosition = position + (velocity + nextVelocity) / 2.0 * dt;
            // Solver-integrity guard vs the closed form at t = step*dt.
            double t = step * dt;
            double analyticVelocity = initial.velocityMetersPerSecond() + a * t;
            double analyticPosition = initial.positionMeters()
                    + initial.velocityMetersPerSecond() * t + 0.5 * a * t * t;
            if (!Double.isFinite(nextPosition) || !Double.isFinite(nextVelocity)
                    || !Double.isFinite(analyticPosition) || !Double.isFinite(analyticVelocity)
                    || !withinTolerance(nextVelocity, analyticVelocity, model.tolerance())
                    || !withinTolerance(nextPosition, analyticPosition, model.tolerance())) {
                return new SimulationResult(Verdict.ABSTAIN, List.copyOf(checkpoints),
                        "solver diverged from closed form at step " + step);
            }
            position = nextPosition;
            velocity = nextVelocity;
            checkpoints.add(new Checkpoint(step, position, velocity, seed, modelFingerprint(model)));
        }
        return new SimulationResult(Verdict.CONVERGED, checkpoints, null);
    }

    /**
     * Integrates to an explicit simulation-time boundary with bounded step
     * doubling. The one-step and two-half-step solutions provide a local error
     * estimate; accepted states are checked against the constant-force analytic
     * solution. The reported uncertainty is a conservative round-off allowance
     * plus the embedded local error estimate. This method is only applicable to
     * the source-bounded constant-force model and makes no claim about other
     * physical model families.
     *
     * @param model stepSeconds is the maximum adaptive step and maxSteps bounds
     *              accepted steps
     * @param initial complete 1-D initial state
     * @param seed retained on every sample's replay context by the caller; this
     *             deterministic equation does not consume random numbers
     * @param durationSeconds requested simulation duration, independent of wall time
     * @param minStepSeconds smallest permitted adaptive step
     */
    public AdaptiveResult runAdaptive(
            SimulationModelIR modelIr,
            long seed,
            double durationSeconds,
            double minStepSeconds) {
        Objects.requireNonNull(modelIr, "modelIr");
        ModelSpec model = modelIr.model();
        validateAdaptiveRequest(modelIr, durationSeconds, minStepSeconds);
        return integrateAdaptive(modelIr, seed, durationSeconds, minStepSeconds,
                0, modelIr.initialState().positionMeters(), modelIr.initialState().velocityMetersPerSecond(),
                0, model.stepSeconds());
    }

    /** Resumes an adaptive integration from an immutable checkpoint. */
    public AdaptiveResult resumeAdaptive(
            SimulationModelIR modelIr,
            AdaptiveCheckpoint from,
            long expectedSeed,
            double durationSeconds) {
        Objects.requireNonNull(modelIr, "modelIr");
        Objects.requireNonNull(from, "from");
        ModelSpec model = modelIr.model();
        if (from.seed() != expectedSeed) {
            return new AdaptiveResult(Verdict.ABSTAIN, List.of(), from,
                    "checkpoint seed does not match requested replay seed");
        }
        if (!adaptiveFingerprint(modelIr).equals(from.modelFingerprint())) {
            return new AdaptiveResult(Verdict.ABSTAIN, List.of(), from,
                    "checkpoint model binding does not match requested model IR");
        }
        if (!Double.isFinite(durationSeconds) || durationSeconds <= from.simulationTimeSeconds()) {
            throw new IllegalArgumentException("resume duration must be finite and after checkpoint time");
        }
        if (from.acceptedStep() > model.maxSteps()
                || from.nextStepSizeSeconds() > model.stepSeconds()
                || from.nextStepSizeSeconds() < from.minimumStepSeconds()
                || from.minimumStepSeconds() > model.stepSeconds()) {
            return new AdaptiveResult(Verdict.ABSTAIN, List.of(), from,
                    "checkpoint step state is outside requested model bounds");
        }
        if (!SI_UNITS.equals(model.unitsRegistry())) {
            return new AdaptiveResult(Verdict.ABSTAIN, List.of(), from,
                    "mismatched units registry: " + model.unitsRegistry());
        }
        if (!supportsSolver(model) || modelIr.boundaryCondition() != BoundaryCondition.UNCONSTRAINED_1D) {
            return new AdaptiveResult(Verdict.ABSTAIN, List.of(), from,
                    "unsupported solver identity or boundary condition");
        }
        return integrateAdaptive(modelIr, expectedSeed, durationSeconds, from.minimumStepSeconds(),
                from.simulationTimeSeconds(), from.positionMeters(), from.velocityMetersPerSecond(),
                from.acceptedStep(), from.nextStepSizeSeconds());
    }

    private static void validateAdaptiveRequest(
            SimulationModelIR modelIr, double durationSeconds, double minStepSeconds) {
        ModelSpec model = modelIr.model();
        if (!Double.isFinite(durationSeconds) || durationSeconds <= 0
                || !Double.isFinite(minStepSeconds) || minStepSeconds <= 0
                || minStepSeconds > model.stepSeconds()) {
            throw new IllegalArgumentException("duration and minimum step must be finite, positive and bounded");
        }
    }

    private AdaptiveResult integrateAdaptive(
            SimulationModelIR modelIr,
            long seed,
            double durationSeconds,
            double minStepSeconds,
            double time,
            double position,
            double velocity,
            int acceptedStep,
            double stepSize) {
        ModelSpec model = modelIr.model();
        AdaptiveCheckpoint checkpoint = new AdaptiveCheckpoint(acceptedStep, time, position, velocity, seed,
                stepSize, minStepSeconds, adaptiveFingerprint(modelIr));
        if (!SI_UNITS.equals(model.unitsRegistry())) {
            return new AdaptiveResult(Verdict.ABSTAIN, List.of(), checkpoint,
                    "mismatched units registry: " + model.unitsRegistry());
        }
        if (!supportsSolver(model)) {
            return new AdaptiveResult(Verdict.ABSTAIN, List.of(), checkpoint,
                    "unsupported solver identity or version");
        }
        if (modelIr.boundaryCondition() != BoundaryCondition.UNCONSTRAINED_1D) {
            return new AdaptiveResult(Verdict.ABSTAIN, List.of(), checkpoint, "unsupported boundary condition");
        }
        double acceleration = model.forceN() / model.massKg();
        if (!Double.isFinite(acceleration)) {
            return new AdaptiveResult(Verdict.ABSTAIN, List.of(), checkpoint,
                    "solver diverged: non-finite acceleration");
        }
        List<AdaptiveSample> samples = new ArrayList<>();
        while (time < durationSeconds && acceptedStep < model.maxSteps()) {
            double dt = Math.min(stepSize, durationSeconds - time);
            if (dt < minStepSeconds && durationSeconds - time > Math.ulp(durationSeconds)) {
                return new AdaptiveResult(Verdict.ABSTAIN, samples, checkpoint,
                        "adaptive solver reached minimum step before satisfying tolerance");
            }
            double fullVelocity = velocity + acceleration * dt;
            double fullPosition = position + velocity * dt + 0.5 * acceleration * dt * dt;
            double halfDt = dt / 2.0;
            double middleVelocity = velocity + acceleration * halfDt;
            double halfVelocity = middleVelocity + acceleration * halfDt;
            double halfPosition = position + velocity * halfDt + 0.5 * acceleration * halfDt * halfDt;
            double twoHalfPosition = halfPosition + middleVelocity * halfDt
                    + 0.5 * acceleration * halfDt * halfDt;
            double positionError = Math.abs(twoHalfPosition - fullPosition);
            double velocityError = Math.abs(halfVelocity - fullVelocity);
            double positionScale = Math.max(1.0, Math.abs(twoHalfPosition));
            double velocityScale = Math.max(1.0, Math.abs(halfVelocity));
            double normalizedError = Math.max(positionError / positionScale, velocityError / velocityScale);
            if (!Double.isFinite(twoHalfPosition) || !Double.isFinite(halfVelocity)
                    || !Double.isFinite(normalizedError)) {
                return new AdaptiveResult(Verdict.ABSTAIN, samples, checkpoint,
                        "solver diverged from finite state at adaptive step " + (acceptedStep + 1));
            }
            if (normalizedError > model.tolerance()) {
                if (dt / 2.0 < minStepSeconds) {
                    return new AdaptiveResult(Verdict.ABSTAIN, samples, checkpoint,
                            "adaptive solver error exceeds tolerance at minimum step");
                }
                stepSize = dt / 2.0;
                continue;
            }
            double nextTime = time + dt;
            double analyticVelocity = modelIr.initialState().velocityMetersPerSecond() + acceleration * nextTime;
            double analyticPosition = modelIr.initialState().positionMeters()
                    + modelIr.initialState().velocityMetersPerSecond() * nextTime
                    + 0.5 * acceleration * nextTime * nextTime;
            if (!withinTolerance(halfVelocity, analyticVelocity, model.tolerance())
                    || !withinTolerance(twoHalfPosition, analyticPosition, model.tolerance())) {
                return new AdaptiveResult(Verdict.ABSTAIN, samples, checkpoint,
                        "solver diverged from closed form at adaptive step " + (acceptedStep + 1));
            }
            double positionUncertainty = positionError + 2.0 * Math.ulp(twoHalfPosition);
            double velocityUncertainty = velocityError + 2.0 * Math.ulp(halfVelocity);
            acceptedStep++;
            samples.add(new AdaptiveSample(acceptedStep, seed, nextTime, twoHalfPosition, halfVelocity,
                    acceleration, positionError, velocityError, positionUncertainty, velocityUncertainty));
            position = twoHalfPosition;
            velocity = halfVelocity;
            time = nextTime;
            if (normalizedError < model.tolerance() / 16.0) {
                stepSize = Math.min(model.stepSeconds(), dt * 2.0);
            } else {
                stepSize = dt;
            }
            stepSize = Math.max(minStepSeconds, stepSize);
            checkpoint = new AdaptiveCheckpoint(acceptedStep, time, position, velocity, seed,
                    stepSize, minStepSeconds, adaptiveFingerprint(modelIr));
        }
        if (time < durationSeconds) {
            return new AdaptiveResult(Verdict.STEP_LIMIT_REACHED, samples, checkpoint,
                    "adaptive solver accepted-step limit reached before requested simulation time");
        }
        return new AdaptiveResult(Verdict.CONVERGED, samples, checkpoint, null);
    }

    /**
     * Continues from a checkpoint with a matching numerical model binding. The caller
     * remains responsible for checkpoint authenticity and source provenance.
     */
    public SimulationResult resume(
            ModelSpec model, Checkpoint from, int additionalSteps) {
        Objects.requireNonNull(model, "model");
        Objects.requireNonNull(from, "from");
        if (additionalSteps < 1) {
            throw new IllegalArgumentException("additionalSteps must be >= 1");
        }
        if (!SI_UNITS.equals(model.unitsRegistry())) {
            return new SimulationResult(Verdict.ABSTAIN, List.of(),
                    "mismatched units registry: " + model.unitsRegistry());
        }
        if (!supportsSolver(model)) {
            return new SimulationResult(Verdict.ABSTAIN, List.of(), "unsupported solver identity or version");
        }
        if (!modelFingerprint(model).equals(from.modelFingerprint())) {
            return new SimulationResult(Verdict.ABSTAIN, List.of(),
                    "checkpoint model binding does not match requested model");
        }
        long finalStep = (long) from.stepIndex() + additionalSteps;
        if (finalStep > model.maxSteps()) {
            return new SimulationResult(Verdict.STEP_LIMIT_REACHED, List.of(),
                    "requested continuation exceeds model step limit");
        }
        double a = model.forceN() / model.massKg();
        double dt = model.stepSeconds();
        double position = from.positionMeters();
        double velocity = from.velocityMetersPerSecond();

        List<Checkpoint> checkpoints = new ArrayList<>();
        for (int step = from.stepIndex() + 1; step <= finalStep; step++) {
            double nextVelocity = velocity + a * dt;
            double nextPosition = position + (velocity + nextVelocity) / 2.0 * dt;
            double elapsed = (step - from.stepIndex()) * dt;
            double analyticVelocity = from.velocityMetersPerSecond() + a * elapsed;
            double analyticPosition = from.positionMeters() + from.velocityMetersPerSecond() * elapsed
                    + 0.5 * a * elapsed * elapsed;
            if (!Double.isFinite(nextPosition) || !Double.isFinite(nextVelocity)
                    || !Double.isFinite(analyticPosition) || !Double.isFinite(analyticVelocity)
                    || !withinTolerance(nextVelocity, analyticVelocity, model.tolerance())
                    || !withinTolerance(nextPosition, analyticPosition, model.tolerance())) {
                return new SimulationResult(Verdict.ABSTAIN, List.copyOf(checkpoints),
                        "solver diverged from closed form at step " + step);
            }
            position = nextPosition;
            velocity = nextVelocity;
            checkpoints.add(new Checkpoint(step, position, velocity, from.seed(), from.modelFingerprint()));
        }
        return new SimulationResult(Verdict.CONVERGED, checkpoints, null);
    }

    private static boolean supportsSolver(ModelSpec model) {
        return "constant-force".equals(model.solverId()) && "1.0.0".equals(model.solverVersion());
    }

    /** Stable exact parameter binding; hexadecimal doubles avoid locale/rounding ambiguity. */
    private static String modelFingerprint(ModelSpec model) {
        return model.solverId() + "@" + model.solverVersion() + "|" + model.unitsRegistry()
                + "|m=" + Double.toHexString(model.massKg())
                + "|f=" + Double.toHexString(model.forceN())
                + "|dt=" + Double.toHexString(model.stepSeconds())
                + "|steps=" + model.maxSteps()
                + "|tol=" + Double.toHexString(model.tolerance());
    }

    private static String adaptiveFingerprint(SimulationModelIR modelIr) {
        InitialState initial = modelIr.initialState();
        return modelFingerprint(modelIr.model())
                + "|boundary=" + modelIr.boundaryCondition().name()
                + "|x0=" + Double.toHexString(initial.positionMeters())
                + "|v0=" + Double.toHexString(initial.velocityMetersPerSecond());
    }

    private static boolean withinTolerance(double actual, double expected, double tolerance) {
        double scale = Math.max(1.0, Math.abs(expected));
        return Math.abs(actual - expected) <= tolerance * scale;
    }
}
