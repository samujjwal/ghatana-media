package com.ghatana.media.production.simulation.scenario;

import static com.ghatana.media.production.simulation.scenario.ScenarioGroundTruthTest.m;
import static com.ghatana.media.production.simulation.scenario.ScenarioGroundTruthTest.projectile;
import static com.ghatana.media.production.simulation.scenario.ScenarioGroundTruthTest.q;
import static com.ghatana.media.production.simulation.scenario.ScenarioGroundTruthTest.scenario;
import static com.ghatana.media.production.simulation.scenario.ScenarioGroundTruthTest.solver;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.production.simulation.scenario.ScenarioException.Kind;
import com.ghatana.media.production.simulation.scenario.ScenarioSolver.Abstained;
import com.ghatana.media.production.simulation.scenario.ScenarioSolver.Completed;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Typed refusals before any solver step, and typed abstentions (never a fabricated value) after one. */
class ScenarioFaultTest {
    private static Map<String, Object> spring(double mass, double k, double c, Map<String, Object> solver) {
        return scenario(m("type", "DAMPED_SPRING", "mass", q(mass, "kg"), "springConstant", q(k, "N/m"), "damping", q(c, "kg/s")),
                m("position", q(1.0, "m"), "velocity", q(0.0, "m/s")), solver);
    }

    private static Abstained abstained(Map<String, Object> raw) {
        var outcome = ScenarioSolver.solve(Scenario.parse(raw));
        assertThat(outcome).as("outcome %s", outcome).isInstanceOf(Abstained.class);
        return (Abstained) outcome;
    }

    private static void refused(Map<String, Object> raw, Kind kind, String path) {
        assertThatThrownBy(() -> Scenario.parse(raw)).as(path).isInstanceOfSatisfying(ScenarioException.class, e -> {
            assertThat(e.kind()).isEqualTo(kind);
            assertThat(e.path()).isEqualTo(path);
        });
    }

    private static Map<String, Object> goodSolver() {
        return solver(1.0, 0.05, 1e-6, 1000, "ADAPTIVE");
    }

    @Test
    void dimensionMismatchesAreRefusedWithThePathOfTheUnit() {
        refused(scenario(m("type", "DAMPED_SPRING", "mass", q(1, "m"), "springConstant", q(1, "N/m"), "damping", q(0, "kg/s")),
                m("position", q(1, "m"), "velocity", q(0, "m/s")), goodSolver()), Kind.UNIT_MISMATCH, "$.model.mass.unit");
        refused(scenario(m("type", "DAMPED_SPRING", "mass", q(1, "kg"), "springConstant", q(1, "N"), "damping", q(0, "kg/s")),
                m("position", q(1, "m"), "velocity", q(0, "m/s")), goodSolver()), Kind.UNIT_MISMATCH, "$.model.springConstant.unit");
        refused(scenario(m("type", "DAMPED_SPRING", "mass", q(1, "kg"), "springConstant", q(1, "N/m"), "damping", q(0, "kg/m")),
                m("position", q(1, "m"), "velocity", q(0, "m/s")), goodSolver()), Kind.UNIT_MISMATCH, "$.model.damping.unit");
        refused(scenario(m("type", "DAMPED_SPRING", "mass", q(1, "kg"), "springConstant", q(1, "N/m"), "damping", q(0, "kg/s")),
                m("position", q(1, "s"), "velocity", q(0, "m/s")), goodSolver()), Kind.UNIT_MISMATCH, "$.initial.position.unit");
        refused(scenario(projectile(1, "NONE", null, null),
                m("x", q(0, "m"), "y", q(0, "m"), "speed", q(1, "m/s"), "angle", q(45, "m")), goodSolver()), Kind.UNIT_MISMATCH,
                "$.initial.angle.unit");
        refused(scenario(m("type", "NEWTON_CONSTANT_FORCE", "mass", q(1, "stone"), "force", q(1, "N")),
                m("position", q(1, "m"), "velocity", q(0, "m/s")), goodSolver()), Kind.UNIT_MISMATCH, "$.model.mass.unit");
        Map<String, Object> badSolver = goodSolver();
        badSolver.put("duration", q(1, "kg"));
        refused(spring(1, 1, 0, badSolver), Kind.UNIT_MISMATCH, "$.solver.duration.unit");
    }

    @Test
    void nonFiniteAndOverflowingInputsAreRefusedBeforeAnySolverStep() {
        refused(spring(Double.POSITIVE_INFINITY, 1, 0, goodSolver()), Kind.NON_FINITE, "$.model.mass.value");
        refused(scenario(m("type", "NEWTON_CONSTANT_FORCE", "mass", q(1, "kg"), "force", q(Double.NaN, "N")),
                m("position", q(1, "m"), "velocity", q(0, "m/s")), goodSolver()), Kind.NON_FINITE, "$.model.force.value");
        refused(scenario(m("type", "NEWTON_CONSTANT_FORCE", "mass", q(1, "kg"), "force", q(1, "N")),
                m("position", q(1e308, "km"), "velocity", q(0, "m/s")), goodSolver()), Kind.NON_FINITE, "$.initial.position.value");
    }

    @Test
    void invalidStructureAndRangesAreRefusedWithPaths() {
        refused(spring(-1, 1, 0, goodSolver()), Kind.INVALID, "$.model.mass");
        refused(spring(1, 1, -0.5, goodSolver()), Kind.INVALID, "$.model.damping");
        Map<String, Object> extra = spring(1, 1, 0, goodSolver());
        extra.put("surprise", 1);
        refused(extra, Kind.INVALID, "$.surprise");
        Map<String, Object> wrongType = spring(1, 1, 0, goodSolver());
        ((Map<String, Object>) wrongType.get("solver")).put("maxAcceptedSteps", "ten");
        refused(wrongType, Kind.INVALID, "$.solver.maxAcceptedSteps");
        Map<String, Object> minAbove = spring(1, 1, 0, goodSolver());
        ((Map<String, Object>) minAbove.get("solver")).put("minStep", q(1, "s"));
        refused(minAbove, Kind.INVALID, "$.solver.minStep");
        Map<String, Object> noImpact = spring(1, 1, 0, goodSolver());
        ((Map<String, Object>) noImpact.get("solver")).put("terminateOnGroundImpact", true);
        refused(noImpact, Kind.INVALID, "$.solver.terminateOnGroundImpact");
        Map<String, Object> constraint = spring(1, 1, 0, goodSolver());
        constraint.put("constraints", List.of(m("id", "c1", "observable", "POSITION_X", "op", "LE", "limit", q(1, "kg"))));
        refused(constraint, Kind.UNIT_MISMATCH, "$.constraints[0].limit.unit");
        assertThatThrownBy(() -> Scenario.parse("not an object")).isInstanceOfSatisfying(ScenarioException.class,
                e -> assertThat(e.path()).isEqualTo("$"));
    }

    @Test
    void requestBudgetsAreCeilingsNotSolverOutcomes() {
        Map<String, Object> steps = spring(1, 1, 0, goodSolver());
        ((Map<String, Object>) steps.get("solver")).put("maxAcceptedSteps", 10_001);
        refused(steps, Kind.BUDGET, "$.solver.maxAcceptedSteps");
        Map<String, Object> ratio = spring(1, 1, 0, solver(100_000, 1.0, 1e-9, 1000, "ADAPTIVE"));
        refused(ratio, Kind.BUDGET, "$.solver.minStep");
        refused(spring(1, 1, 0, solver(100_001, 1.0, 1.0, 1000, "ADAPTIVE")), Kind.BUDGET, "$.solver.duration");
    }

    @Test
    void anExhaustedStepOrIterationBudgetAbstainsWithoutAValue() {
        Abstained steps = abstained(spring(1, 40, 0, solver(10.0, 0.1, 0.1, 5, "FIXED_STEP")));
        assertThat(steps.reasons()).extracting(ScenarioSolver.Reason::code).containsExactly("STEP_BUDGET_EXHAUSTED");
        assertThat(steps.diagnostics().acceptedSteps()).isEqualTo(5);
        assertThat(steps.diagnostics().reachedTimeSeconds()).isLessThan(10.0);
        Map<String, Object> iterations = spring(1, 40, 0, solver(10.0, 0.1, 0.1, 1000, "FIXED_STEP"));
        ((Map<String, Object>) iterations.get("solver")).put("maxIterations", 3);
        assertThat(abstained(iterations).reasons().get(0).code()).isEqualTo("STEP_BUDGET_EXHAUSTED");
    }

    @Test
    void aStiffSystemAtAFixedStepDivergesAndAnAdaptiveOneCannotConverge() {
        // omega = 1e6 rad/s: explicit RK4 is unstable at a 1 s step.
        Abstained diverged = abstained(spring(1, 1e12, 0, solver(100.0, 1.0, 1.0, 1000, "FIXED_STEP")));
        assertThat(diverged.reasons().get(0).code()).isEqualTo("DIVERGED");
        Abstained stuck = abstained(spring(1, 1e12, 0, solver(100.0, 1.0, 0.5, 1000, "ADAPTIVE")));
        assertThat(stuck.reasons().get(0).code()).isEqualTo("NON_CONVERGENCE");
        assertThat(stuck.reasons().get(0).details()).containsKey("reachedTimeSeconds");
    }

    @Test
    void anInaccurateFixedStepIsNotTrustedAndEnergyDriftIsCaught() {
        Map<String, Object> coarse = spring(1, 40, 0, solver(2.0, 0.2, 0.2, 1000, "FIXED_STEP"));
        Abstained estimate = abstained(coarse);
        assertThat(estimate.reasons()).extracting(ScenarioSolver.Reason::code).contains("ERROR_ESTIMATE_EXCEEDS_TOLERANCE");
        // a loose error tolerance isolates the energy law: the coarse RK4 pass visibly leaks energy
        Map<String, Object> loose = spring(1, 40, 0, solver(2.0, 0.2, 0.2, 1000, "FIXED_STEP"));
        ((Map<String, Object>) loose.get("solver")).put("positionTolerance", q(1.0, "m"));
        ((Map<String, Object>) loose.get("solver")).put("velocityTolerance", q(1.0, "m/s"));
        Abstained energy = abstained(loose);
        assertThat(energy.reasons()).extracting(ScenarioSolver.Reason::code).containsExactly("ENERGY_NOT_CONSERVED");
    }

    @Test
    void outOfDomainRegimesAbstain() {
        Map<String, Object> supersonic = scenario(projectile(1, "QUADRATIC", 0.01, "kg/m"),
                m("x", q(0, "m"), "y", q(0, "m"), "speed", q(400, "m/s"), "angle", q(45, "deg")), goodSolver());
        Abstained mach = abstained(supersonic);
        assertThat(mach.reasons().get(0).code()).isEqualTo("OUT_OF_MODEL_DOMAIN");
        assertThat(mach.reasons().get(0).path()).isEqualTo("$.model.drag");
        // the same speed without drag is inside the (drag-free, non-relativistic) domain
        Map<String, Object> ballistic = scenario(projectile(1, "NONE", null, null),
                m("x", q(0, "m"), "y", q(0, "m"), "speed", q(400, "m/s"), "angle", q(45, "deg")), goodSolver());
        assertThat(ScenarioSolver.solve(Scenario.parse(ballistic))).isInstanceOf(Completed.class);
        Map<String, Object> relativistic = scenario(projectile(1, "NONE", null, null),
                m("x", q(0, "m"), "y", q(0, "m"), "speed", q(5e7, "m/s"), "angle", q(0, "deg")), goodSolver());
        assertThat(abstained(relativistic).reasons().get(0).path()).isEqualTo("$.model");
    }

    @Test
    void declaredConstraintsAbstainWhenViolatedAndAreReportedWhenSatisfied() {
        Map<String, Object> shot = scenario(projectile(1, "NONE", null, null),
                m("x", q(0, "m"), "y", q(0, "m"), "speed", q(20, "m/s"), "angle", q(90, "deg")), solver(4.0, 0.05, 1e-6, 1000, "ADAPTIVE"));
        // apex = v^2 / 2g = 20.39 m
        Map<String, Object> violated = new LinkedHashMap<>(shot);
        violated.put("constraints", List.of(m("id", "ceiling", "observable", "POSITION_Y", "aggregate", "MAX", "op", "LE", "limit", q(15, "m"))));
        Abstained abstain = abstained(violated);
        assertThat(abstain.reasons().get(0).code()).isEqualTo("CONSTRAINT_VIOLATED");
        assertThat(abstain.reasons().get(0).details()).containsEntry("constraintId", "ceiling");
        assertThat((double) abstain.reasons().get(0).details().get("observedSi")).isBetween(20.0, 20.5);
        Map<String, Object> met = new LinkedHashMap<>(shot);
        met.put("constraints", List.of(m("id", "ceiling", "observable", "POSITION_Y", "aggregate", "MAX", "op", "LE", "limit", q(25, "m")),
                m("id", "floor", "observable", "POSITION_Y", "aggregate", "MIN", "op", "GE", "limit", q(-1, "m"))));
        Completed done = (Completed) ScenarioSolver.solve(Scenario.parse(met));
        assertThat(done.verification().constraints()).allMatch(ScenarioSolver.ConstraintResult::satisfied);
    }

    @Test
    void groundImpactTimeAndRangeMatchTheClosedForm() {
        double vx0 = 12, vy0 = 20, y0 = 5, g = 9.80665;
        Map<String, Object> raw = scenario(projectile(0.5, "NONE", null, null),
                m("x", q(0, "m"), "y", q(y0, "m"), "speed", q(Math.hypot(vx0, vy0), "m/s"), "angle", q(Math.atan2(vy0, vx0), "rad")),
                solver(10.0, 0.1, 1e-5, 1000, "ADAPTIVE"));
        ((Map<String, Object>) raw.get("solver")).put("terminateOnGroundImpact", true);
        Completed done = (Completed) ScenarioSolver.solve(Scenario.parse(raw));
        double tImpact = (vy0 + Math.sqrt(vy0 * vy0 + 2 * g * y0)) / g;
        assertThat(done.verification().termination()).isEqualTo("GROUND_IMPACT");
        assertThat(done.verification().impact().timeSeconds()).isCloseTo(tImpact, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(done.verification().impact().rangeMeters()).isCloseTo(vx0 * tImpact, org.assertj.core.data.Offset.offset(1e-8));
        assertThat(done.samples().get(done.samples().size() - 1).y()).isCloseTo(0.0, org.assertj.core.data.Offset.offset(1e-9));
        System.out.printf("GT impact t=%.12f vs closed form %.12f (err %.2e); range err %.2e%n", done.verification().impact().timeSeconds(),
                tImpact, Math.abs(done.verification().impact().timeSeconds() - tImpact),
                Math.abs(done.verification().impact().rangeMeters() - vx0 * tImpact));
    }

    @Test
    void theSameScenarioInDifferentUnitsHasTheSameCanonicalForm() {
        Map<String, Object> a = spring(2, 3, 0, goodSolver());
        Map<String, Object> b = scenario(m("type", "DAMPED_SPRING", "mass", q(2000, "g"), "springConstant", q(3, "N/m"), "damping", q(0, "N*s/m")),
                m("position", q(100, "cm"), "velocity", q(0, "m/s")), goodSolver());
        assertThat(Scenario.parse(a).canonical()).isEqualTo(Scenario.parse(b).canonical());
    }
}
