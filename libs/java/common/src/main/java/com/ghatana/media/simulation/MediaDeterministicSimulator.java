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

    /** An immutable state checkpoint — resuming reproduces the trajectory. */
    public record Checkpoint(
            int stepIndex,
            double positionMeters,
            double velocityMetersPerSecond,
            long seed) {
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
                    || !withinTolerance(nextVelocity, analyticVelocity, model.tolerance())
                    || !withinTolerance(nextPosition, analyticPosition, model.tolerance())) {
                return new SimulationResult(Verdict.ABSTAIN, List.copyOf(checkpoints),
                        "solver diverged from closed form at step " + step);
            }
            position = nextPosition;
            velocity = nextVelocity;
            checkpoints.add(new Checkpoint(step, position, velocity, seed));
        }
        return new SimulationResult(Verdict.CONVERGED, checkpoints, null);
    }

    /** Resumes a trajectory from a checkpoint — the same run continues. */
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
        double a = model.forceN() / model.massKg();
        double dt = model.stepSeconds();
        double position = from.positionMeters();
        double velocity = from.velocityMetersPerSecond();

        List<Checkpoint> checkpoints = new ArrayList<>();
        for (int step = from.stepIndex() + 1; step <= from.stepIndex() + additionalSteps; step++) {
            double nextVelocity = velocity + a * dt;
            double nextPosition = position + (velocity + nextVelocity) / 2.0 * dt;
            if (!Double.isFinite(nextPosition) || !Double.isFinite(nextVelocity)) {
                return new SimulationResult(Verdict.ABSTAIN, List.copyOf(checkpoints),
                        "non-finite state at step " + step);
            }
            position = nextPosition;
            velocity = nextVelocity;
            checkpoints.add(new Checkpoint(step, position, velocity, from.seed()));
        }
        return new SimulationResult(Verdict.CONVERGED, checkpoints, null);
    }

    private static boolean withinTolerance(double actual, double expected, double tolerance) {
        double scale = Math.max(1.0, Math.abs(expected));
        return Math.abs(actual - expected) <= tolerance * scale;
    }
}
