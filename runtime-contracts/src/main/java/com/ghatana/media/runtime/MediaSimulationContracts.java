package com.ghatana.media.runtime;

import java.util.List;
import java.util.Objects;

/** Typed SI input and deterministic-output contracts for bounded Media simulations. */
public final class MediaSimulationContracts {
    public static final String SIMULATION_ONLY_EVIDENCE = "DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE";
    public static final String VELOCITY_VERLET_SOLVER_V1 = "velocity-verlet.step-doubling/v1";

    private MediaSimulationContracts() { }

    public enum Dimension {
        MASS, LENGTH, TIME, VELOCITY, ACCELERATION, FORCE, SPRING_CONSTANT, ENERGY
    }

    /** Units accepted at the typed simulation boundary; all output values use SI units. */
    public enum Unit {
        KILOGRAM(Dimension.MASS, 1.0), GRAM(Dimension.MASS, 0.001),
        METER(Dimension.LENGTH, 1.0), CENTIMETER(Dimension.LENGTH, 0.01),
        SECOND(Dimension.TIME, 1.0), MILLISECOND(Dimension.TIME, 0.001),
        METER_PER_SECOND(Dimension.VELOCITY, 1.0),
        METER_PER_SECOND_SQUARED(Dimension.ACCELERATION, 1.0),
        NEWTON(Dimension.FORCE, 1.0), MILLINEWTON(Dimension.FORCE, 0.001),
        NEWTON_PER_METER(Dimension.SPRING_CONSTANT, 1.0), JOULE(Dimension.ENERGY, 1.0);

        private final Dimension dimension;
        private final double toSi;

        Unit(Dimension dimension, double toSi) {
            this.dimension = dimension;
            this.toSi = toSi;
        }

        public Dimension dimension() { return dimension; }
        public double toSi(double value) { return finite(value, "quantity") * toSi; }
    }

    public record Quantity(double value, Unit unit) {
        public Quantity {
            finite(value, "quantity");
            Objects.requireNonNull(unit, "unit");
        }

        public double si(Dimension expected) {
            if (unit.dimension() != expected) {
                throw new InvalidQuantityException("expected " + expected + " but received " + unit.dimension());
            }
            return finite(unit.toSi(value), "SI quantity");
        }
    }

    public record Measurement(Quantity value, Quantity standardUncertainty) {
        public Measurement {
            Objects.requireNonNull(value, "value");
            Objects.requireNonNull(standardUncertainty, "standardUncertainty");
            if (value.unit().dimension() != standardUncertainty.unit().dimension()) {
                throw new InvalidQuantityException("measurement uncertainty must have the value's dimension");
            }
            if (standardUncertainty.value() < 0) {
                throw new InvalidQuantityException("measurement uncertainty must be non-negative");
            }
        }
    }

    public sealed interface ModelParameters permits ConstantForce, HarmonicSpring { }

    public record ConstantForce(Measurement mass, Measurement force) implements ModelParameters {
        public ConstantForce {
            Objects.requireNonNull(mass, "mass");
            Objects.requireNonNull(force, "force");
            requireDimension(mass, Dimension.MASS, "mass");
            requireDimension(force, Dimension.FORCE, "force");
        }
    }

    public record HarmonicSpring(
            Measurement mass, Measurement springConstant, Measurement equilibriumPosition)
            implements ModelParameters {
        public HarmonicSpring {
            Objects.requireNonNull(mass, "mass");
            Objects.requireNonNull(springConstant, "springConstant");
            Objects.requireNonNull(equilibriumPosition, "equilibriumPosition");
            requireDimension(mass, Dimension.MASS, "mass");
            requireDimension(springConstant, Dimension.SPRING_CONSTANT, "springConstant");
            requireDimension(equilibriumPosition, Dimension.LENGTH, "equilibriumPosition");
        }
    }

    public record InitialState(Measurement position, Measurement velocity) {
        public InitialState {
            Objects.requireNonNull(position, "position");
            Objects.requireNonNull(velocity, "velocity");
            requireDimension(position, Dimension.LENGTH, "position");
            requireDimension(velocity, Dimension.VELOCITY, "velocity");
        }
    }

    public record SolverPolicy(
            Quantity duration,
            Quantity maximumStep,
            Quantity minimumStep,
            Quantity absolutePositionTolerance,
            Quantity absoluteVelocityTolerance,
            int maxAcceptedSteps,
            int maxIterations) {
        public SolverPolicy {
            Objects.requireNonNull(duration, "duration");
            Objects.requireNonNull(maximumStep, "maximumStep");
            Objects.requireNonNull(minimumStep, "minimumStep");
            Objects.requireNonNull(absolutePositionTolerance, "absolutePositionTolerance");
            Objects.requireNonNull(absoluteVelocityTolerance, "absoluteVelocityTolerance");
            requireDimension(duration, Dimension.TIME, "duration");
            requireDimension(maximumStep, Dimension.TIME, "maximumStep");
            requireDimension(minimumStep, Dimension.TIME, "minimumStep");
            requireDimension(absolutePositionTolerance, Dimension.LENGTH, "absolutePositionTolerance");
            requireDimension(absoluteVelocityTolerance, Dimension.VELOCITY, "absoluteVelocityTolerance");
            if (maxAcceptedSteps < 1 || maxIterations < 1) {
                throw new InvalidQuantityException("solver work bounds must be positive");
            }
        }
    }

    /** Immutable call boundary. Invalid dimensions are rejected at construction, before solver work. */
    public record RunRequest(ModelParameters model, InitialState initialState, SolverPolicy solverPolicy) {
        public RunRequest {
            Objects.requireNonNull(model, "model");
            Objects.requireNonNull(initialState, "initialState");
            Objects.requireNonNull(solverPolicy, "solverPolicy");
        }
    }

    public enum OutcomeStatus { COMPLETED, ABSTAINED, INVALID_INPUT }
    public enum FailureCode { SOLVER_LIMIT_REACHED, INVALID_SIMULATION_INPUT }
    public enum UncertaintyStatus { PROPAGATED_INDEPENDENT_GAUSSIAN, NOT_ASSESSED_MODEL_DERIVATIVE_UNAVAILABLE }

    public record StateUncertainty(Quantity positionStandardUncertainty,
                                   Quantity velocityStandardUncertainty,
                                   UncertaintyStatus status) {
        public StateUncertainty {
            Objects.requireNonNull(status, "status");
            if (status == UncertaintyStatus.PROPAGATED_INDEPENDENT_GAUSSIAN) {
                Objects.requireNonNull(positionStandardUncertainty, "positionStandardUncertainty");
                Objects.requireNonNull(velocityStandardUncertainty, "velocityStandardUncertainty");
                if (positionStandardUncertainty.si(Dimension.LENGTH) < 0
                        || velocityStandardUncertainty.si(Dimension.VELOCITY) < 0) {
                    throw new IllegalArgumentException("propagated uncertainties must be non-negative");
                }
            } else if (positionStandardUncertainty != null || velocityStandardUncertainty != null) {
                throw new IllegalArgumentException("unassessed uncertainty must remain absent, not zero-filled");
            }
        }
    }

    public record Observation(Quantity time, Quantity position, Quantity velocity,
                              Quantity acceleration, Quantity totalEnergy,
                              StateUncertainty uncertainty) {
        public Observation {
            requireDimension(time, Dimension.TIME, "time");
            requireDimension(position, Dimension.LENGTH, "position");
            requireDimension(velocity, Dimension.VELOCITY, "velocity");
            requireDimension(acceleration, Dimension.ACCELERATION, "acceleration");
            requireDimension(totalEnergy, Dimension.ENERGY, "totalEnergy");
            Objects.requireNonNull(uncertainty, "uncertainty");
        }
    }

    public record Trace(List<Observation> observations, int acceptedSteps, int solverIterations,
                        double finalLocalErrorRatio, boolean deterministic,
                        String solverId, String evidenceClass) {
        public Trace {
            observations = List.copyOf(Objects.requireNonNull(observations, "observations"));
            if (observations.isEmpty() || acceptedSteps < 1 || solverIterations < 1) {
                throw new IllegalArgumentException("simulation trace is incomplete");
            }
            finite(finalLocalErrorRatio, "finalLocalErrorRatio");
            solverId = required(solverId, "solverId");
            evidenceClass = required(evidenceClass, "evidenceClass");
            if (!SIMULATION_ONLY_EVIDENCE.equals(evidenceClass)) {
                throw new IllegalArgumentException("simulation output cannot be labeled as measurement evidence");
            }
        }
    }

    /** Completed carries a deterministic model trace; failures never carry partial numeric output. */
    public record Outcome(OutcomeStatus status, FailureCode failureCode, Trace trace) {
        public Outcome {
            Objects.requireNonNull(status, "status");
            if (status == OutcomeStatus.COMPLETED) {
                Objects.requireNonNull(trace, "trace");
                if (failureCode != null) throw new IllegalArgumentException("completed outcome cannot have a failure code");
            } else {
                Objects.requireNonNull(failureCode, "failureCode");
                if (trace != null) throw new IllegalArgumentException("failed outcome cannot carry a partial trace");
                if (status == OutcomeStatus.ABSTAINED && failureCode != FailureCode.SOLVER_LIMIT_REACHED) {
                    throw new IllegalArgumentException("abstention must identify a solver limit");
                }
                if (status == OutcomeStatus.INVALID_INPUT && failureCode != FailureCode.INVALID_SIMULATION_INPUT) {
                    throw new IllegalArgumentException("invalid input outcome must identify invalid simulation input");
                }
            }
        }

        public static Outcome completed(Trace trace) { return new Outcome(OutcomeStatus.COMPLETED, null, trace); }
        public static Outcome abstained() { return new Outcome(OutcomeStatus.ABSTAINED, FailureCode.SOLVER_LIMIT_REACHED, null); }
        public static Outcome invalidInput() {
            return new Outcome(OutcomeStatus.INVALID_INPUT, FailureCode.INVALID_SIMULATION_INPUT, null);
        }
    }

    public static final class InvalidQuantityException extends IllegalArgumentException {
        public InvalidQuantityException(String message) { super(message); }
    }

    private static void requireDimension(Measurement measurement, Dimension dimension, String label) {
        if (measurement.value().unit().dimension() != dimension) {
            throw new InvalidQuantityException(label + " requires " + dimension);
        }
        if (measurement.standardUncertainty().unit().dimension() != dimension) {
            throw new InvalidQuantityException(label + " uncertainty requires " + dimension);
        }
    }

    private static void requireDimension(Quantity quantity, Dimension dimension, String label) {
        Objects.requireNonNull(quantity, label);
        if (quantity.unit().dimension() != dimension) throw new InvalidQuantityException(label + " requires " + dimension);
    }

    private static double finite(double value, String label) {
        if (!Double.isFinite(value)) throw new InvalidQuantityException(label + " must be finite");
        return value;
    }

    private static String required(String value, String label) {
        if (value == null || value.isBlank() || !value.equals(value.trim())) {
            throw new IllegalArgumentException(label + " must be present and canonical");
        }
        return value;
    }
}
