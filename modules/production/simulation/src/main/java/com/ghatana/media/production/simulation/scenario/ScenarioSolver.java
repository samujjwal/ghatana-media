package com.ghatana.media.production.simulation.scenario;

import com.ghatana.media.production.simulation.scenario.Scenario.Aggregate;
import com.ghatana.media.production.simulation.scenario.Scenario.Constraint;
import com.ghatana.media.production.simulation.scenario.Scenario.DampedSpring;
import com.ghatana.media.production.simulation.scenario.Scenario.DragLaw;
import com.ghatana.media.production.simulation.scenario.Scenario.Mode;
import com.ghatana.media.production.simulation.scenario.Scenario.Model;
import com.ghatana.media.production.simulation.scenario.Scenario.NewtonConstantForce;
import com.ghatana.media.production.simulation.scenario.Scenario.Op;
import com.ghatana.media.production.simulation.scenario.Scenario.Policy;
import com.ghatana.media.production.simulation.scenario.Scenario.Projectile;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Classical fourth-order Runge-Kutta integration of a {@link Scenario} with Richardson step doubling as the local error
 * estimate, followed by a semantic trust assessment. The outcome is either {@link Completed} (a trace that passed every
 * check) or {@link Abstained} (typed reasons and honest solver counters, never a value): non-convergence, an exhausted step
 * or iteration budget, divergence, non-finite state, an out-of-domain regime, an energy law that does not hold, or a
 * violated declared constraint. A trace that is not trustworthy is withheld rather than returned.
 *
 * <p>The state is (x, y, vx, vy) in SI; one-dimensional models keep y = vy = 0. {@link Mode#ADAPTIVE} adapts the step to the
 * declared position and velocity tolerances; {@link Mode#FIXED_STEP} uses {@code maxStep} throughout, still measuring the
 * error estimate and refusing to trust a pass whose estimate exceeds the tolerance.</p>
 */
public final class ScenarioSolver {
    public static final String SOLVER_ID = "rk4-step-doubling";
    public static final String SOLVER_VERSION = "1";
    public static final double SPEED_OF_SOUND = 340.29;
    public static final double NON_RELATIVISTIC_LIMIT = 2.99792458e7;
    public static final double DIVERGENCE_LIMIT = 1.0e12;
    private static final int IMPACT_SUBSTEPS = 32;

    private ScenarioSolver() { }

    /** One accepted solver sample: time, state, acceleration, speed and total mechanical energy, all SI. */
    public record Sample(double t, double x, double y, double vx, double vy, double ax, double ay, double speed, double energy) { }

    public record Impact(double timeSeconds, double rangeMeters, double speedMetersPerSecond) { }

    public record Reason(String code, String path, String message, Map<String, Object> details) {
        public Reason {
            details = details == null ? Map.of() : java.util.Collections.unmodifiableMap(new LinkedHashMap<>(details));
        }
    }

    /** Honest counters of a pass; none of these is a simulated physical value. */
    public record Diagnostics(int acceptedSteps, int iterations, double reachedTimeSeconds) { }

    public record EnergyCheck(String lawClass, double initialJoules, double finalJoules, double maxAbsDriftJoules,
                              double maxIncreaseJoules, double scaleJoules, double relativeDrift, double tolerance, boolean ok) { }

    public record ConstraintResult(String id, String observable, String aggregate, String op, double limit, double observed,
                                   boolean satisfied) { }

    public record Verification(int acceptedSteps, int iterations, double maxErrorRatio, double minStepSeconds,
                               double maxStepSeconds, String termination, Impact impact, EnergyCheck energy,
                               double maxSpeed, List<ConstraintResult> constraints) { }

    public sealed interface Outcome permits Completed, Abstained { }

    public record Completed(List<Sample> samples, Verification verification) implements Outcome { }

    public record Abstained(List<Reason> reasons, Diagnostics diagnostics) implements Outcome { }

    // ------------------------------------------------------------------ dynamics

    private static double[] derivative(Model model, double[] s) {
        double ax;
        double ay = 0.0;
        if (model instanceof NewtonConstantForce n) {
            ax = n.force() / n.mass();
        } else if (model instanceof DampedSpring d) {
            ax = -(d.springConstant() * (s[0] - d.equilibrium()) + d.damping() * s[2]) / d.mass();
        } else {
            Projectile p = (Projectile) model;
            double dx = 0.0;
            double dy = 0.0;
            if (p.law() == DragLaw.LINEAR) {
                dx = p.dragCoefficient() * s[2];
                dy = p.dragCoefficient() * s[3];
            } else if (p.law() == DragLaw.QUADRATIC) {
                double speed = Math.hypot(s[2], s[3]);
                dx = p.dragCoefficient() * speed * s[2];
                dy = p.dragCoefficient() * speed * s[3];
            }
            ax = -dx / p.mass();
            ay = -p.gravity() - dy / p.mass();
        }
        return new double[] {s[2], s[3], ax, ay};
    }

    private static double[] rk4(Model model, double[] s, double h) {
        double[] k1 = derivative(model, s);
        double[] k2 = derivative(model, add(s, k1, h / 2));
        double[] k3 = derivative(model, add(s, k2, h / 2));
        double[] k4 = derivative(model, add(s, k3, h));
        double[] out = new double[4];
        for (int i = 0; i < 4; i++) out[i] = s[i] + h / 6.0 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
        return out;
    }

    private static double[] add(double[] s, double[] k, double h) {
        double[] out = new double[4];
        for (int i = 0; i < 4; i++) out[i] = s[i] + h * k[i];
        return out;
    }

    private static double kinetic(Model model, double[] s) {
        return 0.5 * model.mass() * (s[2] * s[2] + s[3] * s[3]);
    }

    private static double potential(Model model, double[] s) {
        if (model instanceof NewtonConstantForce n) return -n.force() * s[0];
        if (model instanceof DampedSpring d) {
            double e = s[0] - d.equilibrium();
            return 0.5 * d.springConstant() * e * e;
        }
        Projectile p = (Projectile) model;
        return p.mass() * p.gravity() * s[1];
    }

    private static boolean dissipative(Model model) {
        if (model instanceof DampedSpring d) return d.damping() > 0;
        if (model instanceof Projectile p) return p.law() != DragLaw.NONE && p.dragCoefficient() > 0;
        return false;
    }

    private static boolean finite(double[] s) {
        for (double v : s) if (!Double.isFinite(v)) return false;
        return true;
    }

    private static boolean diverged(double[] s) {
        for (double v : s) if (Math.abs(v) > DIVERGENCE_LIMIT) return true;
        return false;
    }

    private static Sample sample(Model model, double t, double[] s) {
        double[] d = derivative(model, s);
        return new Sample(t, s[0], s[1], s[2], s[3], d[2], d[3], Math.hypot(s[2], s[3]), kinetic(model, s) + potential(model, s));
    }

    private static Reason domainReason(Model model, double speed, double t) {
        if (speed > NON_RELATIVISTIC_LIMIT) {
            return new Reason("OUT_OF_MODEL_DOMAIN", "$.model", "speed exceeds 10% of the speed of light; the Newtonian model is not valid",
                    Map.of("speedMetersPerSecond", speed, "limitMetersPerSecond", NON_RELATIVISTIC_LIMIT, "timeSeconds", t));
        }
        boolean drag = model instanceof Projectile p && p.law() != DragLaw.NONE;
        if (drag && speed > SPEED_OF_SOUND) {
            return new Reason("OUT_OF_MODEL_DOMAIN", "$.model.drag",
                    "speed exceeds the speed of sound; the constant-coefficient drag law is only valid for subsonic flow",
                    Map.of("speedMetersPerSecond", speed, "limitMetersPerSecond", SPEED_OF_SOUND, "timeSeconds", t));
        }
        return null;
    }

    private static Abstained abstain(String code, String path, String message, Map<String, Object> details, int accepted,
                                     int iterations, double t) {
        return new Abstained(List.of(new Reason(code, path, message, details)), new Diagnostics(accepted, iterations, t));
    }

    // ------------------------------------------------------------------ solve

    public static Outcome solve(Scenario scenario) {
        Model model = scenario.model();
        Policy policy = scenario.policy();
        double[] state = {scenario.initial().x(), scenario.initial().y(), scenario.initial().vx(), scenario.initial().vy()};
        List<Sample> samples = new ArrayList<>();
        Sample first = sample(model, 0.0, state);
        samples.add(first);
        Reason initialDomain = domainReason(model, first.speed(), 0.0);
        if (initialDomain != null) return new Abstained(List.of(initialDomain), new Diagnostics(0, 0, 0.0));

        double t = 0.0;
        double step = Math.min(policy.maxStep(), policy.duration());
        int accepted = 0;
        int iterations = 0;
        double maxRatio = 0.0;
        double minUsed = Double.POSITIVE_INFINITY;
        double maxUsed = 0.0;
        double maxSpeed = first.speed();
        double scale = Math.abs(first.energy());
        scale = Math.max(scale, kinetic(model, state) + Math.abs(potential(model, state)));
        double maxIncrease = 0.0;
        double maxDrift = 0.0;
        double e0 = first.energy();
        String termination = "HORIZON";
        Impact impact = null;
        boolean adaptive = policy.mode() == Mode.ADAPTIVE;

        while (t < policy.duration()) {
            if (++iterations > policy.maxIterations()) {
                return abstain("STEP_BUDGET_EXHAUSTED", "$.solver.maxIterations",
                        "the solver used its whole iteration budget before reaching the requested horizon",
                        Map.of("limit", policy.maxIterations(), "reachedTimeSeconds", t), accepted, iterations - 1, t);
            }
            double remaining = policy.duration() - t;
            double h = adaptive ? Math.min(step, Math.min(policy.maxStep(), remaining)) : Math.min(policy.maxStep(), remaining);
            boolean reaches = h >= remaining;
            if (adaptive && h < policy.minStep() && !reaches) {
                return abstain("NON_CONVERGENCE", "$.solver.minStep",
                        "the tolerances require a step below the configured minimum step",
                        Map.of("requiredStepSeconds", h, "minStepSeconds", policy.minStep(), "reachedTimeSeconds", t),
                        accepted, iterations, t);
            }
            double[] full = rk4(model, state, h);
            double[] half = rk4(model, state, h / 2);
            double[] twoHalf = rk4(model, half, h / 2);
            if (!finite(full) || !finite(twoHalf)) {
                return abstain("DIVERGED", "$.solver", "the integration produced a non-finite state",
                        Map.of("reachedTimeSeconds", t, "stepSeconds", h), accepted, iterations, t);
            }
            double xError = Math.max(Math.abs(twoHalf[0] - full[0]), Math.abs(twoHalf[1] - full[1])) / (15.0 * policy.positionTolerance());
            double vError = Math.max(Math.abs(twoHalf[2] - full[2]), Math.abs(twoHalf[3] - full[3])) / (15.0 * policy.velocityTolerance());
            double ratio = Math.max(xError, vError);
            if (adaptive && ratio > 1.0) {
                if (h <= policy.minStep() * (1 + 1e-12)) {
                    return abstain("NON_CONVERGENCE", "$.solver.minStep",
                            "the error estimate exceeds the tolerance at the minimum step; the pass cannot converge",
                            Map.of("errorRatio", ratio, "stepSeconds", h, "reachedTimeSeconds", t), accepted, iterations, t);
                }
                step = Math.max(policy.minStep(), h * Math.max(0.2, 0.9 * Math.pow(ratio, -0.2)));
                continue;
            }
            if (accepted >= policy.maxAcceptedSteps()) {
                return abstain("STEP_BUDGET_EXHAUSTED", "$.solver.maxAcceptedSteps",
                        "the solver used its whole accepted-step budget before reaching the requested horizon",
                        Map.of("limit", policy.maxAcceptedSteps(), "reachedTimeSeconds", t), accepted, iterations, t);
            }
            // Ground impact: refine inside the step from its start state, then end the pass there.
            if (policy.terminateOnGroundImpact() && twoHalf[1] < 0.0 && state[1] >= 0.0) {
                double[] hit = refineImpact(model, state, h);
                double tHit = t + hit[4];
                double[] at = {hit[0], hit[1], hit[2], hit[3]};
                accepted++;
                Sample impactSample = sample(model, tHit, at);
                samples.add(impactSample);
                impact = new Impact(tHit, at[0], impactSample.speed());
                termination = "GROUND_IMPACT";
                maxRatio = Math.max(maxRatio, ratio);
                minUsed = Math.min(minUsed, hit[4]);
                maxUsed = Math.max(maxUsed, hit[4]);
                double e = impactSample.energy();
                maxSpeed = Math.max(maxSpeed, impactSample.speed());
                scale = Math.max(scale, kinetic(model, at) + Math.abs(potential(model, at)));
                maxDrift = Math.max(maxDrift, Math.abs(e - e0));
                maxIncrease = Math.max(maxIncrease, e - samples.get(samples.size() - 2).energy());
                t = tHit;
                break;
            }
            double nextT;
            if (reaches) {
                nextT = policy.duration();
            } else {
                nextT = t + h;
                if (!(nextT > t) || nextT >= policy.duration()) {
                    return abstain("NON_CONVERGENCE", "$.solver",
                            "the step cannot resolve the remaining horizon at floating-point precision",
                            Map.of("reachedTimeSeconds", t), accepted, iterations, t);
                }
            }
            double previousEnergy = samples.get(samples.size() - 1).energy();
            state = twoHalf;
            t = nextT;
            accepted++;
            maxRatio = Math.max(maxRatio, ratio);
            minUsed = Math.min(minUsed, h);
            maxUsed = Math.max(maxUsed, h);
            if (diverged(state)) {
                return abstain("DIVERGED", "$.solver", "the state grew beyond any physical scale (|value| > 1e12 SI units)",
                        Map.of("reachedTimeSeconds", t, "limitSi", DIVERGENCE_LIMIT), accepted, iterations, t);
            }
            Sample current = sample(model, t, state);
            samples.add(current);
            maxSpeed = Math.max(maxSpeed, current.speed());
            Reason domain = domainReason(model, current.speed(), t);
            if (domain != null) return new Abstained(List.of(domain), new Diagnostics(accepted, iterations, t));
            scale = Math.max(scale, kinetic(model, state) + Math.abs(potential(model, state)));
            maxDrift = Math.max(maxDrift, Math.abs(current.energy() - e0));
            maxIncrease = Math.max(maxIncrease, current.energy() - previousEnergy);
            if (adaptive) {
                double factor = ratio == 0 ? 2.0 : 0.9 * Math.pow(ratio, -0.2);
                step = Math.max(policy.minStep(), Math.min(policy.maxStep(), h * Math.max(0.2, Math.min(2.0, factor))));
            }
        }
        if (accepted == 0) {
            return abstain("NON_CONVERGENCE", "$.solver", "no step was accepted", Map.of(), accepted, iterations, t);
        }

        // ---- trust assessment: every check must hold or the whole pass is withheld ----
        List<Reason> reasons = new ArrayList<>();
        if (!adaptive && maxRatio > 1.0) {
            reasons.add(new Reason("ERROR_ESTIMATE_EXCEEDS_TOLERANCE", "$.solver",
                    "the step-doubling error estimate of the fixed-step pass exceeds the declared tolerance",
                    Map.of("maxErrorRatio", maxRatio, "stepSeconds", policy.maxStep())));
        }
        boolean lossy = dissipative(model);
        double tolerance = scenario.energyRelativeTolerance();
        double floor = Math.max(scale, 1e-300);
        double relDrift = (lossy ? maxIncrease : maxDrift) / floor;
        boolean energyOk = relDrift <= tolerance;
        EnergyCheck energy = new EnergyCheck(lossy ? "DISSIPATIVE_NON_INCREASING" : "CONSERVATIVE", e0,
                samples.get(samples.size() - 1).energy(), maxDrift, Math.max(0.0, maxIncrease), scale, relDrift, tolerance, energyOk);
        if (!energyOk) {
            reasons.add(new Reason(lossy ? "ENERGY_INCREASED" : "ENERGY_NOT_CONSERVED", "$.solver",
                    lossy ? "total energy increased in a dissipative system beyond the tolerance"
                            : "total energy drifted in a conservative system beyond the tolerance",
                    Map.of("relativeDrift", relDrift, "tolerance", tolerance)));
        }
        List<ConstraintResult> results = new ArrayList<>();
        for (int i = 0; i < scenario.constraints().size(); i++) {
            Constraint c = scenario.constraints().get(i);
            double observed = observe(samples, c);
            boolean ok = c.op() == Op.LE ? observed <= c.limit() : observed >= c.limit();
            results.add(new ConstraintResult(c.id(), c.observable().name(), c.aggregate().name(), c.op().name(), c.limit(), observed, ok));
            if (!ok) {
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("constraintId", c.id());
                details.put("observable", c.observable().name());
                details.put("aggregate", c.aggregate().name());
                details.put("op", c.op().name());
                details.put("limitSi", c.limit());
                details.put("observedSi", observed);
                reasons.add(new Reason("CONSTRAINT_VIOLATED", "$.constraints[" + i + "]",
                        "the declared constraint does not hold for the solved pass", details));
            }
        }
        if (!reasons.isEmpty()) return new Abstained(reasons, new Diagnostics(accepted, iterations, t));
        return new Completed(List.copyOf(samples), new Verification(accepted, iterations, maxRatio,
                minUsed == Double.POSITIVE_INFINITY ? 0.0 : minUsed, maxUsed, termination, impact, energy, maxSpeed,
                List.copyOf(results)));
    }

    private static double observe(List<Sample> samples, Constraint c) {
        Sample last = samples.get(samples.size() - 1);
        if (c.aggregate() == Aggregate.FINAL) return value(last, c);
        double best = value(samples.get(0), c);
        for (Sample sample : samples) {
            double v = value(sample, c);
            best = c.aggregate() == Aggregate.MAX ? Math.max(best, v) : Math.min(best, v);
        }
        return best;
    }

    private static double value(Sample s, Constraint c) {
        return switch (c.observable()) {
            case POSITION_X -> s.x();
            case POSITION_Y -> s.y();
            case VELOCITY_X -> s.vx();
            case VELOCITY_Y -> s.vy();
            case SPEED -> s.speed();
            case TOTAL_ENERGY -> s.energy();
            case TIME -> s.t();
        };
    }

    /** Bisects the time inside one step at which y crosses zero; the state is re-integrated from the step start. */
    private static double[] refineImpact(Model model, double[] start, double h) {
        double lo = 0.0;
        double hi = h;
        for (int i = 0; i < 200; i++) {
            double mid = 0.5 * (lo + hi);
            if (mid == lo || mid == hi) break;
            if (integrate(model, start, mid)[1] >= 0.0) lo = mid; else hi = mid;
        }
        double[] at = integrate(model, start, hi);
        return new double[] {at[0], at[1], at[2], at[3], hi};
    }

    private static double[] integrate(Model model, double[] start, double span) {
        double[] s = start;
        double sub = span / IMPACT_SUBSTEPS;
        for (int i = 0; i < IMPACT_SUBSTEPS; i++) s = rk4(model, s, sub);
        return s;
    }
}
