package com.ghatana.media.production.simulation;

import com.ghatana.media.runtime.MediaSimulationContracts;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Objects;

/** Bounded one-dimensional Newtonian simulation using adaptive velocity-Verlet integration. */
public final class PhysicalSimulation {
    private static final int MAX_CONFIGURED_STEPS = 100_000;
    private static final int MAX_CONFIGURED_ITERATIONS = 100_000;
    private static final int MAX_RESULT_OBSERVATIONS = MAX_CONFIGURED_STEPS / 2 + 1;

    private PhysicalSimulation() {}

    public enum Dimension {
        MASS(1, 0, 0), LENGTH(0, 1, 0), TIME(0, 0, 1),
        VELOCITY(0, 1, -1), ACCELERATION(0, 1, -2),
        FORCE(1, 1, -2), SPRING_CONSTANT(1, 0, -2), ENERGY(1, 2, -2);

        private final int mass;
        private final int length;
        private final int time;

        Dimension(int mass, int length, int time) {
            this.mass = mass;
            this.length = length;
            this.time = time;
        }
    }

    /** Supported units are converted to SI at the simulation boundary. */
    public enum Unit {
        KILOGRAM(Dimension.MASS, 1.0), GRAM(Dimension.MASS, 0.001),
        METER(Dimension.LENGTH, 1.0), CENTIMETER(Dimension.LENGTH, 0.01),
        SECOND(Dimension.TIME, 1.0), MILLISECOND(Dimension.TIME, 0.001),
        METER_PER_SECOND(Dimension.VELOCITY, 1.0),
        METER_PER_SECOND_SQUARED(Dimension.ACCELERATION, 1.0),
        NEWTON(Dimension.FORCE, 1.0), MILLINEWTON(Dimension.FORCE, 0.001),
        NEWTON_PER_METER(Dimension.SPRING_CONSTANT, 1.0),
        JOULE(Dimension.ENERGY, 1.0);

        private final Dimension dimension;
        private final double toSi;

        Unit(Dimension dimension, double toSi) {
            this.dimension = dimension;
            this.toSi = toSi;
        }
    }

    public record Quantity(double value, Unit unit) {
        public Quantity {
            Objects.requireNonNull(unit, "unit");
            requireFinite(value, "quantity");
        }

        public double si(Dimension expected, String label) {
            if (unit.dimension != expected) {
                throw new InvalidSimulationInputException(label + " requires " + expected + " but received " + unit.dimension);
            }
            double converted = value * unit.toSi;
            requireFinite(converted, label + " in SI");
            return converted;
        }
    }

    public record Measurement(Quantity value, Quantity standardUncertainty) {
        public Measurement {
            Objects.requireNonNull(value, "value");
            Objects.requireNonNull(standardUncertainty, "standardUncertainty");
            if (value.unit.dimension != standardUncertainty.unit.dimension) {
                throw new InvalidSimulationInputException("measurement uncertainty must have the same dimension as its value");
            }
            if (standardUncertainty.value < 0) {
                throw new InvalidSimulationInputException("measurement uncertainty must be non-negative");
            }
        }

        public double si(Dimension expected, String label) {
            return value.si(expected, label);
        }

        public double uncertaintySi(Dimension expected, String label) {
            return standardUncertainty.si(expected, label + " uncertainty");
        }
    }

    public sealed interface Model permits ConstantForce, HarmonicSpring {}

    /** A closed system acted on by a constant one-dimensional force. */
    public record ConstantForce(Measurement mass, Measurement force) implements Model {
        public ConstantForce {
            Objects.requireNonNull(mass, "mass");
            Objects.requireNonNull(force, "force");
        }
    }

    /** An ideal undamped spring, with displacement measured from equilibrium. */
    public record HarmonicSpring(Measurement mass, Measurement springConstant, Measurement equilibriumPosition)
            implements Model {
        public HarmonicSpring {
            Objects.requireNonNull(mass, "mass");
            Objects.requireNonNull(springConstant, "springConstant");
            Objects.requireNonNull(equilibriumPosition, "equilibriumPosition");
        }
    }

    public record InitialState(Measurement position, Measurement velocity) {
        public InitialState {
            Objects.requireNonNull(position, "position");
            Objects.requireNonNull(velocity, "velocity");
        }
    }

    public record SolverPolicy(
            Quantity duration,
            Quantity maxStep,
            Quantity minStep,
            Quantity absolutePositionTolerance,
            Quantity absoluteVelocityTolerance,
            int maxAcceptedSteps,
            int maxIterations) {
        public SolverPolicy {
            Objects.requireNonNull(duration, "duration");
            Objects.requireNonNull(maxStep, "maxStep");
            Objects.requireNonNull(minStep, "minStep");
            Objects.requireNonNull(absolutePositionTolerance, "absolutePositionTolerance");
            Objects.requireNonNull(absoluteVelocityTolerance, "absoluteVelocityTolerance");
            if (maxAcceptedSteps < 1 || maxAcceptedSteps > MAX_CONFIGURED_STEPS) {
                throw new InvalidSimulationInputException("maxAcceptedSteps must be between 1 and " + MAX_CONFIGURED_STEPS);
            }
            if (maxIterations < 1 || maxIterations > MAX_CONFIGURED_ITERATIONS) {
                throw new InvalidSimulationInputException("maxIterations must be between 1 and " + MAX_CONFIGURED_ITERATIONS);
            }
        }
    }

    public enum UncertaintyStatus { PROPAGATED_INDEPENDENT_GAUSSIAN, NOT_ASSESSED_MODEL_DERIVATIVE_UNAVAILABLE }

    public record StateUncertainty(Double positionMeters, Double velocityMetersPerSecond,
                                   UncertaintyStatus status) {
        public StateUncertainty {
            Objects.requireNonNull(status, "status");
            if (status == UncertaintyStatus.PROPAGATED_INDEPENDENT_GAUSSIAN) {
                Objects.requireNonNull(positionMeters, "propagated position uncertainty");
                Objects.requireNonNull(velocityMetersPerSecond, "propagated velocity uncertainty");
                requireFinite(positionMeters, "position uncertainty");
                requireFinite(velocityMetersPerSecond, "velocity uncertainty");
                if (positionMeters < 0 || velocityMetersPerSecond < 0) {
                    throw new IllegalArgumentException("output uncertainty must be non-negative");
                }
            } else if (positionMeters != null || velocityMetersPerSecond != null) {
                throw new IllegalArgumentException("unassessed uncertainty must remain absent, not zero-filled");
            }
        }
    }

    public record Observation(double timeSeconds, double positionMeters, double velocityMetersPerSecond,
                              double accelerationMetersPerSecondSquared, double totalEnergyJoules,
                              StateUncertainty uncertainty) {
        public Observation {
            requireFinite(timeSeconds, "time");
            requireFinite(positionMeters, "position");
            requireFinite(velocityMetersPerSecond, "velocity");
            requireFinite(accelerationMetersPerSecondSquared, "acceleration");
            requireFinite(totalEnergyJoules, "energy");
            Objects.requireNonNull(uncertainty, "uncertainty");
        }
    }

    public record Result(List<Observation> observations, int acceptedSteps, int solverIterations,
                         double finalLocalErrorRatio, boolean deterministic, String evidenceClass) {
        public Result {
            observations = boundedObservationCopy(observations);
            if (observations.size() < 2) {
                throw new IllegalArgumentException("result needs an initial and terminal observation");
            }
            if (acceptedSteps < 1 || acceptedSteps > MAX_CONFIGURED_STEPS
                    || solverIterations < 1 || solverIterations > MAX_CONFIGURED_ITERATIONS) {
                throw new IllegalArgumentException("solver counters are outside configured bounds");
            }
            long traceAcceptedSteps = 2L * (observations.size() - 1);
            if (acceptedSteps != traceAcceptedSteps || solverIterations < observations.size() - 1) {
                throw new IllegalArgumentException("solver counters do not match the accepted observation trace");
            }
            requireFinite(finalLocalErrorRatio, "final error ratio");
            Objects.requireNonNull(evidenceClass, "evidenceClass");
        }
    }

    private static List<Observation> boundedObservationCopy(List<Observation> source) {
        Objects.requireNonNull(source, "observations");
        List<Observation> copy = new ArrayList<>();
        Iterator<Observation> iterator = Objects.requireNonNull(source.iterator(), "observation iterator");
        while (iterator.hasNext()) {
            if (copy.size() >= MAX_RESULT_OBSERVATIONS) {
                throw new IllegalArgumentException("result observation trace exceeds configured solver bound");
            }
            copy.add(Objects.requireNonNull(iterator.next(), "observation"));
        }
        return List.copyOf(copy);
    }

    private record State(double position, double velocity) {}

    public static final class InvalidSimulationInputException extends IllegalArgumentException {
        public InvalidSimulationInputException(String message) { super(message); }
    }

    public static final class SolverLimitException extends IllegalStateException {
        public SolverLimitException(String message) { super(message); }
    }

    /** Runs a typed runtime-contract request and reports invalid input/solver abstention without partial output. */
    public static MediaSimulationContracts.Outcome run(MediaSimulationContracts.RunRequest request) {
        if (request == null) return MediaSimulationContracts.Outcome.invalidInput();
        try {
            Model model = modelFromContract(request.model());
            InitialState initial = new InitialState(
                    measurementFromContract(request.initialState().position()),
                    measurementFromContract(request.initialState().velocity()));
            SolverPolicy policy = policyFromContract(request.solverPolicy());
            return MediaSimulationContracts.Outcome.completed(toContractTrace(simulate(model, initial, policy)));
        } catch (SolverLimitException limited) {
            return MediaSimulationContracts.Outcome.abstained();
        } catch (InvalidSimulationInputException | MediaSimulationContracts.InvalidQuantityException invalid) {
            return MediaSimulationContracts.Outcome.invalidInput();
        } catch (IllegalArgumentException invalid) {
            // Physical constructors and runtime-bound values use IllegalArgumentException for
            // malformed dimensions/ranges; unexpected runtime failures are not converted.
            return MediaSimulationContracts.Outcome.invalidInput();
        }
    }

    private static Model modelFromContract(MediaSimulationContracts.ModelParameters model) {
        if (model instanceof MediaSimulationContracts.ConstantForce constant) {
            return new ConstantForce(measurementFromContract(constant.mass()),
                    measurementFromContract(constant.force()));
        }
        if (model instanceof MediaSimulationContracts.HarmonicSpring spring) {
            return new HarmonicSpring(measurementFromContract(spring.mass()),
                    measurementFromContract(spring.springConstant()),
                    measurementFromContract(spring.equilibriumPosition()));
        }
        throw new InvalidSimulationInputException("unsupported physical model");
    }

    private static Measurement measurementFromContract(MediaSimulationContracts.Measurement value) {
        return new Measurement(quantityFromContract(value.value()), quantityFromContract(value.standardUncertainty()));
    }

    private static Quantity quantityFromContract(MediaSimulationContracts.Quantity value) {
        return new Quantity(value.value(), Unit.valueOf(value.unit().name()));
    }

    private static SolverPolicy policyFromContract(MediaSimulationContracts.SolverPolicy value) {
        return new SolverPolicy(quantityFromContract(value.duration()), quantityFromContract(value.maximumStep()),
                quantityFromContract(value.minimumStep()), quantityFromContract(value.absolutePositionTolerance()),
                quantityFromContract(value.absoluteVelocityTolerance()), value.maxAcceptedSteps(), value.maxIterations());
    }

    private static MediaSimulationContracts.Trace toContractTrace(Result result) {
        List<MediaSimulationContracts.Observation> observations = result.observations().stream()
                .map(PhysicalSimulation::toContractObservation).toList();
        return new MediaSimulationContracts.Trace(observations, result.acceptedSteps(), result.solverIterations(),
                result.finalLocalErrorRatio(), result.deterministic(), MediaSimulationContracts.VELOCITY_VERLET_SOLVER_V1,
                result.evidenceClass());
    }

    private static MediaSimulationContracts.Observation toContractObservation(Observation value) {
        MediaSimulationContracts.StateUncertainty uncertainty = new MediaSimulationContracts.StateUncertainty(
                value.uncertainty().positionMeters() == null ? null
                        : new MediaSimulationContracts.Quantity(value.uncertainty().positionMeters(), MediaSimulationContracts.Unit.METER),
                value.uncertainty().velocityMetersPerSecond() == null ? null
                        : new MediaSimulationContracts.Quantity(value.uncertainty().velocityMetersPerSecond(),
                                MediaSimulationContracts.Unit.METER_PER_SECOND),
                MediaSimulationContracts.UncertaintyStatus.valueOf(value.uncertainty().status().name()));
        return new MediaSimulationContracts.Observation(
                new MediaSimulationContracts.Quantity(value.timeSeconds(), MediaSimulationContracts.Unit.SECOND),
                new MediaSimulationContracts.Quantity(value.positionMeters(), MediaSimulationContracts.Unit.METER),
                new MediaSimulationContracts.Quantity(value.velocityMetersPerSecond(), MediaSimulationContracts.Unit.METER_PER_SECOND),
                new MediaSimulationContracts.Quantity(value.accelerationMetersPerSecondSquared(),
                        MediaSimulationContracts.Unit.METER_PER_SECOND_SQUARED),
                new MediaSimulationContracts.Quantity(value.totalEnergyJoules(), MediaSimulationContracts.Unit.JOULE),
                uncertainty);
    }

    /**
     * Runs a deterministic 1-D mechanical model. Instrument samples are emitted
     * at accepted solver steps; the final record is exactly at requested duration.
     */
    public static Result simulate(Model model, InitialState initial, SolverPolicy policy) {
        Objects.requireNonNull(model, "model");
        Objects.requireNonNull(initial, "initial");
        Objects.requireNonNull(policy, "policy");

        double mass = model instanceof ConstantForce constant
                ? constant.mass().si(Dimension.MASS, "mass")
                : ((HarmonicSpring) model).mass().si(Dimension.MASS, "mass");
        if (!(mass > 0)) throw new InvalidSimulationInputException("mass must be greater than zero");

        double force = 0;
        double spring = 0;
        double equilibrium = 0;
        if (model instanceof ConstantForce constant) {
            force = constant.force().si(Dimension.FORCE, "force");
        } else if (model instanceof HarmonicSpring oscillator) {
            spring = oscillator.springConstant().si(Dimension.SPRING_CONSTANT, "spring constant");
            equilibrium = oscillator.equilibriumPosition().si(Dimension.LENGTH, "equilibrium position");
            if (!(spring > 0)) throw new InvalidSimulationInputException("spring constant must be greater than zero");
        } else {
            throw new InvalidSimulationInputException("unsupported physical model");
        }

        double x0 = initial.position().si(Dimension.LENGTH, "initial position");
        double v0 = initial.velocity().si(Dimension.VELOCITY, "initial velocity");
        double duration = policy.duration().si(Dimension.TIME, "duration");
        double maxStep = policy.maxStep().si(Dimension.TIME, "maximum step");
        double minStep = policy.minStep().si(Dimension.TIME, "minimum step");
        double xTolerance = policy.absolutePositionTolerance().si(Dimension.LENGTH, "position tolerance");
        double vTolerance = policy.absoluteVelocityTolerance().si(Dimension.VELOCITY, "velocity tolerance");
        if (!(duration > 0) || !(maxStep > 0) || !(minStep > 0) || minStep > maxStep) {
            throw new InvalidSimulationInputException("duration and step bounds must be positive with minStep <= maxStep");
        }
        if (!(xTolerance > 0) || !(vTolerance > 0)) {
            throw new InvalidSimulationInputException("absolute tolerances must be positive");
        }
        if (!Double.isFinite(duration / minStep) || duration / minStep > MAX_CONFIGURED_STEPS * 4.0) {
            throw new InvalidSimulationInputException("duration/minStep exceeds the hard solver budget");
        }

        double modelMass = mass;
        double modelForce = force;
        double modelSpring = spring;
        double modelEquilibrium = equilibrium;
        java.util.function.DoubleUnaryOperator acceleration = position -> model instanceof ConstantForce
                ? modelForce / modelMass
                : -modelSpring * (position - modelEquilibrium) / modelMass;

        List<Observation> observations = new ArrayList<>();
        State state = new State(x0, v0);
        double time = 0;
        double step = Math.min(maxStep, duration);
        double lastErrorRatio = 0;
        int acceptedSteps = 0;
        int iterations = 0;
        observations.add(observe(model, initial, state, 0, mass, force, spring, equilibrium));

        while (time < duration) {
            if (++iterations > policy.maxIterations()) {
                throw new SolverLimitException("solver exhausted maxIterations before reaching requested duration");
            }
            step = Math.min(step, Math.min(maxStep, duration - time));
            if (step < minStep && duration - time > Math.ulp(duration) * 4) {
                throw new SolverLimitException("required solver step fell below configured minStep");
            }

            State full = verlet(state, step, acceleration);
            State half = verlet(state, step * 0.5, acceleration);
            State twoHalf = verlet(half, step * 0.5, acceleration);
            double xError = Math.abs(twoHalf.position - full.position) / (3.0 * xTolerance);
            double vError = Math.abs(twoHalf.velocity - full.velocity) / (3.0 * vTolerance);
            double errorRatio = Math.max(xError, vError);
            lastErrorRatio = errorRatio;

            if (errorRatio <= 1.0) {
                if (acceptedSteps > policy.maxAcceptedSteps() - 2) {
                    throw new SolverLimitException("solver exhausted maxAcceptedSteps before reaching requested duration");
                }
                state = twoHalf;
                time += step;
                if (duration - time <= Math.ulp(duration) * 4) time = duration;
                acceptedSteps += 2;
                observations.add(observe(model, initial, state, time, mass, force, spring, equilibrium));
            }

            double factor = errorRatio == 0 ? 2.0 : 0.9 * Math.pow(errorRatio, -1.0 / 3.0);
            factor = Math.max(0.2, Math.min(2.0, factor));
            step = Math.max(minStep, Math.min(maxStep, step * factor));
        }
        return new Result(observations, acceptedSteps, iterations, lastErrorRatio, true,
                "DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE");
    }

    private static State verlet(State state, double step, java.util.function.DoubleUnaryOperator acceleration) {
        double a0 = acceleration.applyAsDouble(state.position);
        double velocityHalf = state.velocity + 0.5 * step * a0;
        double position = state.position + step * velocityHalf;
        double velocity = velocityHalf + 0.5 * step * acceleration.applyAsDouble(position);
        requireFinite(position, "integrated position");
        requireFinite(velocity, "integrated velocity");
        return new State(position, velocity);
    }

    private static Observation observe(Model model, InitialState initial, State state, double time,
                                      double mass, double force, double spring, double equilibrium) {
        double acceleration = model instanceof ConstantForce
                ? force / mass
                : -spring * (state.position - equilibrium) / mass;
        double potential = model instanceof ConstantForce
                ? -force * state.position
                : 0.5 * spring * Math.pow(state.position - equilibrium, 2);
        double energy = 0.5 * mass * state.velocity * state.velocity + potential;
        StateUncertainty uncertainty = model instanceof ConstantForce constant
                ? propagate(constant, initial, time, mass, force)
                : new StateUncertainty(null, null, UncertaintyStatus.NOT_ASSESSED_MODEL_DERIVATIVE_UNAVAILABLE);
        return new Observation(time, state.position, state.velocity, acceleration, energy, uncertainty);
    }

    private static StateUncertainty propagate(ConstantForce model, InitialState initial,
                                               double time, double mass, double force) {
        double sigmaX0 = initial.position().uncertaintySi(Dimension.LENGTH, "initial position");
        double sigmaV0 = initial.velocity().uncertaintySi(Dimension.VELOCITY, "initial velocity");
        double sigmaM = model.mass().uncertaintySi(Dimension.MASS, "mass");
        double sigmaF = model.force().uncertaintySi(Dimension.FORCE, "force");
        double forcePositionDerivative = 0.5 * time * time / mass;
        double massPositionDerivative = -0.5 * force * time * time / (mass * mass);
        double forceVelocityDerivative = time / mass;
        double massVelocityDerivative = -force * time / (mass * mass);
        double position = Math.sqrt(square(sigmaX0) + square(time * sigmaV0)
                + square(forcePositionDerivative * sigmaF) + square(massPositionDerivative * sigmaM));
        double velocity = Math.sqrt(square(sigmaV0) + square(forceVelocityDerivative * sigmaF)
                + square(massVelocityDerivative * sigmaM));
        return new StateUncertainty(position, velocity, UncertaintyStatus.PROPAGATED_INDEPENDENT_GAUSSIAN);
    }

    private static double square(double value) { return value * value; }

    private static void requireFinite(double value, String label) {
        if (!Double.isFinite(value)) throw new InvalidSimulationInputException(label + " must be finite");
    }
}
