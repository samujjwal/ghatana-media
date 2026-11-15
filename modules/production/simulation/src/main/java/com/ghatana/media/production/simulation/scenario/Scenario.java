package com.ghatana.media.production.simulation.scenario;

import com.ghatana.media.production.simulation.scenario.ScenarioException.Kind;
import com.ghatana.media.production.simulation.scenario.ScenarioUnits.Dim;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * A typed, unit-checked simulation scenario ({@code media.dev.simulation-scenario.v1}) already converted to SI. The parser
 * accepts plain decoded JSON (maps, lists, numbers, strings), rejects unknown fields and wrong types, checks the dimension
 * of every quantity against what its field requires, refuses non-finite values and out-of-range parameters, and enforces
 * the hard request budgets. Every refusal names the JSON path of the offending value and happens before any solver step.
 */
public record Scenario(Model model, Initial initial, Policy policy, List<Constraint> constraints, double energyRelativeTolerance,
                       boolean plot, boolean video, Map<String, Object> canonical) {
    public static final String SCHEMA = "media.dev.simulation-scenario.v1";
    public static final int MAX_ACCEPTED_STEPS = 10_000;
    public static final int MAX_ITERATIONS = 100_000;
    public static final long MAX_DURATION_OVER_MIN_STEP = 4_000_000L;
    public static final double MAX_DURATION_SECONDS = 100_000.0;
    public static final int MAX_CONSTRAINTS = 16;
    public static final double MAX_MAGNITUDE_SI = 1.0e12;
    public static final double DEFAULT_GRAVITY = 9.80665;
    public static final double DEFAULT_ENERGY_TOLERANCE = 1.0e-6;
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,63}");

    public enum DragLaw { NONE, LINEAR, QUADRATIC }
    public enum Mode { ADAPTIVE, FIXED_STEP }
    public enum Observable {
        POSITION_X(Dim.LENGTH), POSITION_Y(Dim.LENGTH), VELOCITY_X(Dim.VELOCITY), VELOCITY_Y(Dim.VELOCITY),
        SPEED(Dim.VELOCITY), TOTAL_ENERGY(Dim.ENERGY), TIME(Dim.TIME);

        final Dim dimension;
        Observable(Dim dimension) { this.dimension = dimension; }
        public Dim dimension() { return dimension; }
    }
    public enum Aggregate { FINAL, MAX, MIN }
    public enum Op { LE, GE }

    public sealed interface Model permits NewtonConstantForce, DampedSpring, Projectile {
        String type();
        double mass();
    }

    /** One-dimensional constant force on a mass (Newton's second law); position along x. */
    public record NewtonConstantForce(double mass, double force) implements Model {
        @Override public String type() { return "NEWTON_CONSTANT_FORCE"; }
    }

    /** Damped harmonic oscillator, x measured along x; {@code damping} is the viscous coefficient c in F = -k(x-xe) - c v. */
    public record DampedSpring(double mass, double springConstant, double damping, double equilibrium) implements Model {
        @Override public String type() { return "DAMPED_SPRING"; }
    }

    /** Planar projectile under uniform gravity with no, linear (F = -b v) or quadratic (F = -k |v| v) drag. */
    public record Projectile(double mass, double gravity, DragLaw law, double dragCoefficient) implements Model {
        @Override public String type() { return "PROJECTILE"; }
    }

    /** Initial state in SI: position (x, y) and velocity (vx, vy); one-dimensional models keep y = vy = 0. */
    public record Initial(double x, double y, double vx, double vy) { }

    public record Policy(double duration, double maxStep, double minStep, double positionTolerance, double velocityTolerance,
                         int maxAcceptedSteps, int maxIterations, Mode mode, boolean terminateOnGroundImpact) { }

    public record Constraint(String id, Observable observable, Aggregate aggregate, Op op, double limit) { }

    // ------------------------------------------------------------------ parsing

    private static ScenarioException invalid(String path, String message) {
        return new ScenarioException(Kind.INVALID, path, message);
    }

    public static Scenario parse(Object raw) {
        Map<String, Object> root = object(raw, "$");
        keys(root, "$", Set.of("model", "initial", "solver"), Set.of("constraints", "validation", "render"));
        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("schema", SCHEMA);

        Map<String, Object> modelMap = object(root.get("model"), "$.model");
        String type = string(modelMap.get("type"), "$.model.type");
        Model model;
        Map<String, Object> canonicalModel = new LinkedHashMap<>();
        canonicalModel.put("type", type);
        switch (type) {
            case "NEWTON_CONSTANT_FORCE" -> {
                keys(modelMap, "$.model", Set.of("type", "mass", "force"), Set.of());
                double mass = positive(quantity(modelMap.get("mass"), "$.model.mass", Dim.MASS), "$.model.mass");
                double force = bounded(quantity(modelMap.get("force"), "$.model.force", Dim.FORCE), "$.model.force");
                model = new NewtonConstantForce(mass, force);
                canonicalModel.put("massKg", mass);
                canonicalModel.put("forceN", force);
            }
            case "DAMPED_SPRING" -> {
                keys(modelMap, "$.model", Set.of("type", "mass", "springConstant", "damping"), Set.of("equilibrium"));
                double mass = positive(quantity(modelMap.get("mass"), "$.model.mass", Dim.MASS), "$.model.mass");
                double k = positive(quantity(modelMap.get("springConstant"), "$.model.springConstant", Dim.SPRING_CONSTANT),
                        "$.model.springConstant");
                double c = nonNegative(quantity(modelMap.get("damping"), "$.model.damping", Dim.LINEAR_DAMPING),
                        "$.model.damping", "a negative damping coefficient would add energy; it is not a physical damper");
                double equilibrium = modelMap.containsKey("equilibrium")
                        ? bounded(quantity(modelMap.get("equilibrium"), "$.model.equilibrium", Dim.LENGTH), "$.model.equilibrium") : 0.0;
                model = new DampedSpring(mass, k, c, equilibrium);
                canonicalModel.put("massKg", mass);
                canonicalModel.put("springConstantNPerM", k);
                canonicalModel.put("dampingKgPerS", c);
                canonicalModel.put("equilibriumM", equilibrium);
            }
            case "PROJECTILE" -> {
                keys(modelMap, "$.model", Set.of("type", "mass", "drag"), Set.of("gravity"));
                double mass = positive(quantity(modelMap.get("mass"), "$.model.mass", Dim.MASS), "$.model.mass");
                double gravity = modelMap.containsKey("gravity")
                        ? nonNegative(quantity(modelMap.get("gravity"), "$.model.gravity", Dim.ACCELERATION), "$.model.gravity",
                                "gravity must not be negative") : DEFAULT_GRAVITY;
                Map<String, Object> drag = object(modelMap.get("drag"), "$.model.drag");
                DragLaw law;
                try {
                    law = DragLaw.valueOf(string(drag.get("law"), "$.model.drag.law"));
                } catch (IllegalArgumentException unknown) {
                    throw invalid("$.model.drag.law", "drag law must be one of NONE, LINEAR, QUADRATIC");
                }
                double coefficient = 0.0;
                if (law == DragLaw.NONE) {
                    keys(drag, "$.model.drag", Set.of("law"), Set.of());
                } else {
                    keys(drag, "$.model.drag", Set.of("law", "coefficient"), Set.of());
                    Dim dim = law == DragLaw.LINEAR ? Dim.LINEAR_DAMPING : Dim.QUADRATIC_DRAG;
                    coefficient = nonNegative(quantity(drag.get("coefficient"), "$.model.drag.coefficient", dim),
                            "$.model.drag.coefficient", "a drag coefficient must not be negative");
                }
                model = new Projectile(mass, gravity, law, coefficient);
                canonicalModel.put("massKg", mass);
                canonicalModel.put("gravityMPerS2", gravity);
                canonicalModel.put("dragLaw", law.name());
                canonicalModel.put("dragCoefficientSi", coefficient);
            }
            default -> throw invalid("$.model.type", "model type must be NEWTON_CONSTANT_FORCE, DAMPED_SPRING or PROJECTILE");
        }
        canonical.put("model", canonicalModel);

        Map<String, Object> initialMap = object(root.get("initial"), "$.initial");
        Initial initial;
        Map<String, Object> canonicalInitial = new LinkedHashMap<>();
        if (model instanceof Projectile) {
            keys(initialMap, "$.initial", Set.of("x", "y", "speed", "angle"), Set.of());
            double x = bounded(quantity(initialMap.get("x"), "$.initial.x", Dim.LENGTH), "$.initial.x");
            double y = bounded(quantity(initialMap.get("y"), "$.initial.y", Dim.LENGTH), "$.initial.y");
            double speed = nonNegative(quantity(initialMap.get("speed"), "$.initial.speed", Dim.VELOCITY), "$.initial.speed",
                    "speed must not be negative; the direction is the angle");
            double angle = quantity(initialMap.get("angle"), "$.initial.angle", Dim.ANGLE);
            if (Math.abs(angle) > Math.PI + 1e-12) throw invalid("$.initial.angle", "angle must be within [-180 deg, 180 deg]");
            initial = new Initial(x, y, speed * Math.cos(angle), speed * Math.sin(angle));
            canonicalInitial.put("xM", x);
            canonicalInitial.put("yM", y);
            canonicalInitial.put("speedMPerS", speed);
            canonicalInitial.put("angleRad", angle);
        } else {
            keys(initialMap, "$.initial", Set.of("position", "velocity"), Set.of());
            double x = bounded(quantity(initialMap.get("position"), "$.initial.position", Dim.LENGTH), "$.initial.position");
            double v = bounded(quantity(initialMap.get("velocity"), "$.initial.velocity", Dim.VELOCITY), "$.initial.velocity");
            initial = new Initial(x, 0.0, v, 0.0);
            canonicalInitial.put("positionM", x);
            canonicalInitial.put("velocityMPerS", v);
        }
        canonical.put("initial", canonicalInitial);

        Map<String, Object> solverMap = object(root.get("solver"), "$.solver");
        keys(solverMap, "$.solver", Set.of("duration", "maxStep", "minStep", "positionTolerance", "velocityTolerance",
                "maxAcceptedSteps", "maxIterations"), Set.of("mode", "terminateOnGroundImpact"));
        double duration = positive(quantity(solverMap.get("duration"), "$.solver.duration", Dim.TIME), "$.solver.duration");
        if (duration > MAX_DURATION_SECONDS) {
            throw budget("$.solver.duration", "duration seconds", (long) MAX_DURATION_SECONDS, Math.round(duration));
        }
        double maxStep = positive(quantity(solverMap.get("maxStep"), "$.solver.maxStep", Dim.TIME), "$.solver.maxStep");
        double minStep = positive(quantity(solverMap.get("minStep"), "$.solver.minStep", Dim.TIME), "$.solver.minStep");
        if (minStep > maxStep) throw invalid("$.solver.minStep", "minStep must not exceed maxStep");
        double posTol = positive(quantity(solverMap.get("positionTolerance"), "$.solver.positionTolerance", Dim.LENGTH),
                "$.solver.positionTolerance");
        double velTol = positive(quantity(solverMap.get("velocityTolerance"), "$.solver.velocityTolerance", Dim.VELOCITY),
                "$.solver.velocityTolerance");
        int maxSteps = integer(solverMap.get("maxAcceptedSteps"), "$.solver.maxAcceptedSteps", 1);
        if (maxSteps > MAX_ACCEPTED_STEPS) throw budget("$.solver.maxAcceptedSteps", "maxAcceptedSteps", MAX_ACCEPTED_STEPS, maxSteps);
        int maxIterations = integer(solverMap.get("maxIterations"), "$.solver.maxIterations", 1);
        if (maxIterations > MAX_ITERATIONS) throw budget("$.solver.maxIterations", "maxIterations", MAX_ITERATIONS, maxIterations);
        double ratio = duration / minStep;
        if (!Double.isFinite(ratio) || ratio > MAX_DURATION_OVER_MIN_STEP) {
            throw budget("$.solver.minStep", "duration / minStep", MAX_DURATION_OVER_MIN_STEP,
                    Double.isFinite(ratio) ? Math.round(ratio) : Long.MAX_VALUE);
        }
        Mode mode = Mode.ADAPTIVE;
        if (solverMap.containsKey("mode")) {
            try {
                mode = Mode.valueOf(string(solverMap.get("mode"), "$.solver.mode"));
            } catch (IllegalArgumentException unknown) {
                throw invalid("$.solver.mode", "mode must be ADAPTIVE or FIXED_STEP");
            }
        }
        boolean terminate = false;
        if (solverMap.containsKey("terminateOnGroundImpact")) {
            if (!(solverMap.get("terminateOnGroundImpact") instanceof Boolean flag)) {
                throw invalid("$.solver.terminateOnGroundImpact", "must be a boolean");
            }
            terminate = flag;
            if (terminate && !(model instanceof Projectile)) {
                throw invalid("$.solver.terminateOnGroundImpact", "ground impact only exists for the PROJECTILE model");
            }
            if (terminate && initial.y() < 0) throw invalid("$.initial.y", "the projectile must start at or above the ground (y >= 0)");
            if (terminate && initial.y() == 0 && initial.vy() <= 0) {
                throw invalid("$.initial", "a projectile that starts on the ground must be launched upward");
            }
        }
        Policy policy = new Policy(duration, maxStep, minStep, posTol, velTol, maxSteps, maxIterations, mode, terminate);
        Map<String, Object> canonicalSolver = new LinkedHashMap<>();
        canonicalSolver.put("durationS", duration);
        canonicalSolver.put("maxStepS", maxStep);
        canonicalSolver.put("minStepS", minStep);
        canonicalSolver.put("positionToleranceM", posTol);
        canonicalSolver.put("velocityToleranceMPerS", velTol);
        canonicalSolver.put("maxAcceptedSteps", maxSteps);
        canonicalSolver.put("maxIterations", maxIterations);
        canonicalSolver.put("mode", mode.name());
        canonicalSolver.put("terminateOnGroundImpact", terminate);
        canonical.put("solver", canonicalSolver);

        List<Constraint> constraints = new ArrayList<>();
        List<Object> rawConstraints = root.containsKey("constraints") ? list(root.get("constraints"), "$.constraints") : List.of();
        if (rawConstraints.size() > MAX_CONSTRAINTS) {
            throw budget("$.constraints", "constraints", MAX_CONSTRAINTS, rawConstraints.size());
        }
        Set<String> ids = new HashSet<>();
        List<Object> canonicalConstraints = new ArrayList<>();
        for (int i = 0; i < rawConstraints.size(); i++) {
            String path = "$.constraints[" + i + "]";
            Map<String, Object> c = object(rawConstraints.get(i), path);
            keys(c, path, Set.of("id", "observable", "op", "limit"), Set.of("aggregate"));
            String id = string(c.get("id"), path + ".id");
            if (!ID.matcher(id).matches()) throw invalid(path + ".id", "id must be a 1-64 character opaque id");
            if (!ids.add(id)) throw invalid(path + ".id", "constraint ids must be unique");
            Observable observable = enumValue(Observable.class, c.get("observable"), path + ".observable");
            Aggregate aggregate = c.containsKey("aggregate") ? enumValue(Aggregate.class, c.get("aggregate"), path + ".aggregate")
                    : Aggregate.FINAL;
            Op op = enumValue(Op.class, c.get("op"), path + ".op");
            if (observable == Observable.TIME && aggregate != Aggregate.FINAL) {
                throw invalid(path + ".aggregate", "TIME is only meaningful as FINAL (the terminal time)");
            }
            double limit = quantity(c.get("limit"), path + ".limit", observable.dimension);
            constraints.add(new Constraint(id, observable, aggregate, op, limit));
            Map<String, Object> cc = new LinkedHashMap<>();
            cc.put("id", id);
            cc.put("observable", observable.name());
            cc.put("aggregate", aggregate.name());
            cc.put("op", op.name());
            cc.put("limitSi", limit);
            canonicalConstraints.add(cc);
        }
        canonical.put("constraints", canonicalConstraints);

        double energyTolerance = DEFAULT_ENERGY_TOLERANCE;
        if (root.containsKey("validation")) {
            Map<String, Object> validation = object(root.get("validation"), "$.validation");
            keys(validation, "$.validation", Set.of(), Set.of("energyRelativeTolerance"));
            if (validation.containsKey("energyRelativeTolerance")) {
                energyTolerance = number(validation.get("energyRelativeTolerance"), "$.validation.energyRelativeTolerance");
                if (!(energyTolerance > 0) || energyTolerance > 0.1) {
                    throw invalid("$.validation.energyRelativeTolerance", "must be within (0, 0.1]");
                }
            }
        }
        canonical.put("energyRelativeTolerance", energyTolerance);

        boolean plot = true;
        boolean video = false;
        if (root.containsKey("render")) {
            Map<String, Object> render = object(root.get("render"), "$.render");
            keys(render, "$.render", Set.of(), Set.of("plot", "video"));
            if (render.containsKey("plot")) plot = bool(render.get("plot"), "$.render.plot");
            if (render.containsKey("video")) video = bool(render.get("video"), "$.render.video");
            if (video && !plot) throw invalid("$.render.video", "a video needs the plot (it animates it)");
        }
        canonical.put("render", Map.of("plot", plot, "video", video));
        return new Scenario(model, initial, policy, List.copyOf(constraints), energyTolerance, plot, video,
                java.util.Collections.unmodifiableMap(canonical));
    }

    // ------------------------------------------------------------------ helpers

    static ScenarioException budget(String path, String limit, long ceiling, long requested) {
        return new ScenarioException(Kind.BUDGET, path, limit + " exceeds its ceiling; nothing was solved",
                Map.of("limit", limit, "ceiling", ceiling, "requested", requested));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object raw, String path) {
        if (!(raw instanceof Map<?, ?> map)) throw invalid(path, "must be an object");
        for (Object key : map.keySet()) if (!(key instanceof String)) throw invalid(path, "object keys must be strings");
        return (Map<String, Object>) map;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> list(Object raw, String path) {
        if (!(raw instanceof List<?> list)) throw invalid(path, "must be an array");
        return (List<Object>) list;
    }

    private static void keys(Map<String, Object> map, String path, Set<String> required, Set<String> optional) {
        for (String key : required) if (!map.containsKey(key)) throw invalid(path + "." + key, "is required");
        for (String key : map.keySet()) {
            if (!required.contains(key) && !optional.contains(key)) throw invalid(path + "." + key, "is not a known field");
        }
    }

    private static String string(Object raw, String path) {
        if (!(raw instanceof String text) || text.isBlank()) throw invalid(path, "must be a non-empty string");
        return text;
    }

    private static boolean bool(Object raw, String path) {
        if (!(raw instanceof Boolean flag)) throw invalid(path, "must be a boolean");
        return flag;
    }

    private static <E extends Enum<E>> E enumValue(Class<E> type, Object raw, String path) {
        String text = string(raw, path);
        try {
            return Enum.valueOf(type, text);
        } catch (IllegalArgumentException unknown) {
            throw invalid(path, "must be one of " + java.util.Arrays.toString(type.getEnumConstants()));
        }
    }

    private static double number(Object raw, String path) {
        if (!(raw instanceof Number number)) throw invalid(path, "must be a number");
        double value = number.doubleValue();
        if (!Double.isFinite(value)) throw new ScenarioException(Kind.NON_FINITE, path, "value must be finite");
        return value;
    }

    private static int integer(Object raw, String path, int min) {
        if (!(raw instanceof Integer || raw instanceof Long || raw instanceof java.math.BigInteger)) {
            throw invalid(path, "must be an integer");
        }
        java.math.BigInteger value = raw instanceof java.math.BigInteger big ? big : java.math.BigInteger.valueOf(((Number) raw).longValue());
        if (value.compareTo(java.math.BigInteger.valueOf(min)) < 0) throw invalid(path, "must be at least " + min);
        if (value.compareTo(java.math.BigInteger.valueOf(Integer.MAX_VALUE)) > 0) {
            throw budget(path, path.substring(path.lastIndexOf('.') + 1), Integer.MAX_VALUE, Long.MAX_VALUE);
        }
        return value.intValueExact();
    }

    private static double quantity(Object raw, String path, Dim expected) {
        Map<String, Object> map = object(raw, path);
        keys(map, path, Set.of("value", "unit"), Set.of());
        if (!(map.get("value") instanceof Number number)) throw invalid(path + ".value", "must be a number");
        if (!(map.get("unit") instanceof String unit)) throw invalid(path + ".unit", "must be a unit symbol string");
        return ScenarioUnits.toSi(number.doubleValue(), unit, expected, path);
    }

    private static double bounded(double si, String path) {
        if (Math.abs(si) > MAX_MAGNITUDE_SI) throw invalid(path, "magnitude exceeds the supported range of 1e12 SI units");
        return si;
    }

    private static double positive(double si, String path) {
        if (!(si > 0)) throw invalid(path, "must be greater than zero");
        return bounded(si, path);
    }

    private static double nonNegative(double si, String path, String message) {
        if (si < 0) throw invalid(path, message);
        return bounded(si, path);
    }
}
