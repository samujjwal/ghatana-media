package com.ghatana.media.production.simulation.scenario;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.production.simulation.scenario.ScenarioSolver.Completed;
import com.ghatana.media.production.simulation.scenario.ScenarioSolver.Sample;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The solver measured against INDEPENDENT truth: closed-form analytic solutions (undamped/under/critically/over-damped
 * spring, drag-free and linear-drag projectile, vertical fall under quadratic drag) and a separately implemented reference
 * integrator (fixed fine-step RK4 written in this test in a different form). Reports max error, energy drift and the
 * observed step-convergence order.
 */
class ScenarioGroundTruthTest {
    static Map<String, Object> q(double value, String unit) {
        Map<String, Object> q = new LinkedHashMap<>();
        q.put("value", value);
        q.put("unit", unit);
        return q;
    }

    static Map<String, Object> m(Object... kv) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) map.put((String) kv[i], kv[i + 1]);
        return map;
    }

    static Map<String, Object> solver(double duration, double maxStep, double minStep, int maxSteps, String mode) {
        return m("duration", q(duration, "s"), "maxStep", q(maxStep, "s"), "minStep", q(minStep, "s"),
                "positionTolerance", q(1e-9, "m"), "velocityTolerance", q(1e-9, "m/s"),
                "maxAcceptedSteps", maxSteps, "maxIterations", 100_000, "mode", mode);
    }

    static Map<String, Object> scenario(Map<String, Object> model, Map<String, Object> initial, Map<String, Object> solver) {
        return m("model", model, "initial", initial, "solver", solver);
    }

    static Completed complete(Map<String, Object> raw) {
        var outcome = ScenarioSolver.solve(Scenario.parse(raw));
        assertThat(outcome).as("outcome %s", outcome).isInstanceOf(Completed.class);
        return (Completed) outcome;
    }

    // ---- closed forms (independent of the solver) ----
    record XV(double x, double v) { }

    static XV spring(double mass, double k, double c, double x0, double v0, double t) {
        double w0 = Math.sqrt(k / mass);
        double zeta = c / (2 * Math.sqrt(k * mass));
        if (zeta < 1 - 1e-12) {
            double wd = w0 * Math.sqrt(1 - zeta * zeta);
            double a = zeta * w0;
            double b = (v0 + a * x0) / wd;
            double e = Math.exp(-a * t);
            double x = e * (x0 * Math.cos(wd * t) + b * Math.sin(wd * t));
            double v = e * (-a * (x0 * Math.cos(wd * t) + b * Math.sin(wd * t)) + (-x0 * wd * Math.sin(wd * t) + b * wd * Math.cos(wd * t)));
            return new XV(x, v);
        }
        if (zeta <= 1 + 1e-12) {
            double e = Math.exp(-w0 * t);
            double b = v0 + w0 * x0;
            return new XV(e * (x0 + b * t), e * (b - w0 * (x0 + b * t)));
        }
        double s = Math.sqrt(zeta * zeta - 1);
        double r1 = -w0 * (zeta - s);
        double r2 = -w0 * (zeta + s);
        double a = (v0 - r2 * x0) / (r1 - r2);
        double b = x0 - a;
        return new XV(a * Math.exp(r1 * t) + b * Math.exp(r2 * t), a * r1 * Math.exp(r1 * t) + b * r2 * Math.exp(r2 * t));
    }

    /** Separately implemented reference: fixed-step classical RK4 on (x,y,vx,vy) written as scalar updates. */
    static double[] referenceProjectile(double mass, double g, int law, double coeff, double[] s0, double t, int steps) {
        double x = s0[0], y = s0[1], vx = s0[2], vy = s0[3];
        double h = t / steps;
        for (int i = 0; i < steps; i++) {
            double[] k1 = f(mass, g, law, coeff, x, y, vx, vy);
            double[] k2 = f(mass, g, law, coeff, x + h / 2 * k1[0], y + h / 2 * k1[1], vx + h / 2 * k1[2], vy + h / 2 * k1[3]);
            double[] k3 = f(mass, g, law, coeff, x + h / 2 * k2[0], y + h / 2 * k2[1], vx + h / 2 * k2[2], vy + h / 2 * k2[3]);
            double[] k4 = f(mass, g, law, coeff, x + h * k3[0], y + h * k3[1], vx + h * k3[2], vy + h * k3[3]);
            x += h * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) / 6;
            y += h * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) / 6;
            vx += h * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]) / 6;
            vy += h * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3]) / 6;
        }
        return new double[] {x, y, vx, vy};
    }

    private static double[] f(double mass, double g, int law, double coeff, double x, double y, double vx, double vy) {
        double sp = Math.sqrt(vx * vx + vy * vy);
        double factor = law == 0 ? 0 : law == 1 ? coeff : coeff * sp;
        return new double[] {vx, vy, -factor * vx / mass, -g - factor * vy / mass};
    }

    static Map<String, Object> projectile(double mass, String law, Double coeff, String coeffUnit) {
        Map<String, Object> drag = m("law", law);
        if (coeff != null) drag.put("coefficient", q(coeff, coeffUnit));
        return m("type", "PROJECTILE", "mass", q(mass, "kg"), "drag", drag);
    }

    @Test
    void newtonVectorMatchesTheClosedFormAcrossUnits() {
        // m = 2 kg (given as 2000 g), F = 6 N (given as 6000 mN), t = 2 s (given as 2000 ms)
        Completed done = complete(scenario(m("type", "NEWTON_CONSTANT_FORCE", "mass", q(2000, "g"), "force", q(6000, "mN")),
                m("position", q(0, "m"), "velocity", q(0, "m/s")), m("duration", q(2000, "ms"), "maxStep", q(0.5, "s"),
                        "minStep", q(1e-4, "s"), "positionTolerance", q(1e-8, "m"), "velocityTolerance", q(1e-8, "m/s"),
                        "maxAcceptedSteps", 1000, "maxIterations", 10_000)));
        Sample last = done.samples().get(done.samples().size() - 1);
        assertThat(last.t()).isEqualTo(2.0);
        assertThat(last.ax()).isEqualTo(3.0);
        assertThat(last.vx()).isCloseTo(6.0, org.assertj.core.data.Offset.offset(1e-12));
        assertThat(last.x()).isCloseTo(6.0, org.assertj.core.data.Offset.offset(1e-12));
        assertThat(done.verification().energy().ok()).isTrue();
    }

    @Test
    void springSolutionsMatchTheAnalyticSolutionInEveryDampingRegime() {
        double mass = 0.5;
        double k = 200.0;
        double critical = 2 * Math.sqrt(k * mass);
        double[][] regimes = {{0.0}, {1.2}, {critical}, {3 * critical}};
        for (double[] regime : regimes) {
            double c = regime[0];
            Completed done = complete(scenario(
                    m("type", "DAMPED_SPRING", "mass", q(mass, "kg"), "springConstant", q(k, "N/m"), "damping", q(c, "kg/s")),
                    m("position", q(0.1, "m"), "velocity", q(0.3, "m/s")), solver(3.0, 0.05, 1e-5, 10_000, "ADAPTIVE")));
            double maxX = 0, maxV = 0;
            for (Sample s : done.samples()) {
                XV truth = spring(mass, k, c, 0.1, 0.3, s.t());
                maxX = Math.max(maxX, Math.abs(s.x() - truth.x()));
                maxV = Math.max(maxV, Math.abs(s.vx() - truth.v()));
            }
            var energy = done.verification().energy();
            System.out.printf("GT spring c=%.3f regime=%s maxPosErr=%.3e maxVelErr=%.3e energyClass=%s relDrift=%.3e steps=%d%n",
                    c, energy.lawClass(), maxX, maxV, energy.lawClass(), energy.relativeDrift(), done.verification().acceptedSteps());
            assertThat(maxX).as("c=%s", c).isLessThan(2e-7);
            assertThat(maxV).as("c=%s", c).isLessThan(2e-6);
            assertThat(energy.relativeDrift()).isLessThan(1e-6);
            assertThat(energy.lawClass()).isEqualTo(c == 0 ? "CONSERVATIVE" : "DISSIPATIVE_NON_INCREASING");
        }
    }

    @Test
    void dragFreeAndLinearDragProjectilesMatchClosedForms() {
        double mass = 0.2, vx0 = 30, vy0 = 40, g = 9.80665, y0 = 2.0;
        double speed = Math.hypot(vx0, vy0), angle = Math.atan2(vy0, vx0);
        for (double b : new double[] {0.0, 0.05}) {
            Map<String, Object> model = b == 0 ? projectile(mass, "NONE", null, null) : projectile(mass, "LINEAR", b, "kg/s");
            Completed done = complete(scenario(model, m("x", q(0, "m"), "y", q(y0, "m"), "speed", q(speed, "m/s"), "angle", q(angle, "rad")),
                    solver(5.0, 0.1, 1e-5, 10_000, "ADAPTIVE")));
            double gamma = b / mass;
            double maxErr = 0;
            for (Sample s : done.samples()) {
                double t = s.t(), ex, ey, evx, evy;
                if (b == 0) {
                    ex = vx0 * t; ey = y0 + vy0 * t - 0.5 * g * t * t; evx = vx0; evy = vy0 - g * t;
                } else {
                    double e = Math.exp(-gamma * t);
                    ex = vx0 * (1 - e) / gamma;
                    ey = y0 + (vy0 + g / gamma) * (1 - e) / gamma - g * t / gamma;
                    evx = vx0 * e;
                    evy = (vy0 + g / gamma) * e - g / gamma;
                }
                maxErr = Math.max(maxErr, Math.max(Math.max(Math.abs(s.x() - ex), Math.abs(s.y() - ey)),
                        Math.max(Math.abs(s.vx() - evx), Math.abs(s.vy() - evy))));
            }
            var energy = done.verification().energy();
            System.out.printf("GT projectile b=%.2f maxStateErr=%.3e energy=%s relDrift=%.3e steps=%d%n", b, maxErr,
                    energy.lawClass(), energy.relativeDrift(), done.verification().acceptedSteps());
            assertThat(maxErr).isLessThan(5e-7);
        }
    }

    @Test
    void verticalFallUnderQuadraticDragMatchesTheTanhSolutionAndTheReferenceIntegrator() {
        double mass = 1.5, k = 0.02, g = 9.80665, y0 = 1000.0;
        double vt = Math.sqrt(mass * g / k);
        Completed done = complete(scenario(projectile(mass, "QUADRATIC", k, "kg/m"),
                m("x", q(0, "m"), "y", q(y0, "m"), "speed", q(0, "m/s"), "angle", q(0, "rad")), solver(12.0, 0.1, 1e-5, 10_000, "ADAPTIVE")));
        double maxTanh = 0;
        for (Sample s : done.samples()) {
            double t = s.t();
            double v = -vt * Math.tanh(g * t / vt);
            double y = y0 - vt * vt / g * Math.log(Math.cosh(g * t / vt));
            maxTanh = Math.max(maxTanh, Math.max(Math.abs(s.vy() - v), Math.abs(s.y() - y)));
        }
        // quadratic drag with a launched projectile: reference RK4 at a 100x finer fixed step (50,000 steps over 6 s)
        double angle = Math.toRadians(35), speed = 55;
        Completed shot = complete(scenario(projectile(mass, "QUADRATIC", k, "kg/m"),
                m("x", q(0, "m"), "y", q(1.0, "m"), "speed", q(speed, "m/s"), "angle", q(angle, "rad")), solver(6.0, 0.05, 1e-5, 10_000, "ADAPTIVE")));
        Sample last = shot.samples().get(shot.samples().size() - 1);
        double[] ref = referenceProjectile(mass, g, 2, k, new double[] {0, 1.0, speed * Math.cos(angle), speed * Math.sin(angle)}, 6.0, 50_000);
        double maxRef = Math.max(Math.max(Math.abs(last.x() - ref[0]), Math.abs(last.y() - ref[1])),
                Math.max(Math.abs(last.vx() - ref[2]), Math.abs(last.vy() - ref[3])));
        System.out.printf("GT quadratic maxTanhErr=%.3e maxVsReference=%.3e steps=%d energyRelDrift=%.3e%n", maxTanh, maxRef,
                shot.verification().acceptedSteps(), shot.verification().energy().relativeDrift());
        assertThat(maxTanh).isLessThan(5e-7);
        assertThat(maxRef).isLessThan(5e-7);
        assertThat(shot.verification().energy().lawClass()).isEqualTo("DISSIPATIVE_NON_INCREASING");
    }

    @Test
    void fixedStepConvergenceOrderIsFourAndErrorShrinksAsExpected() {
        double mass = 1.0, k = 40.0, c = 0.8;
        List<Double> errors = new ArrayList<>();
        double h = 0.1;
        for (int i = 0; i < 4; i++, h /= 2) {
            Map<String, Object> raw = scenario(m("type", "DAMPED_SPRING", "mass", q(mass, "kg"), "springConstant", q(k, "N/m"),
                    "damping", q(c, "kg/s")), m("position", q(1.0, "m"), "velocity", q(0.0, "m/s")),
                    solver(2.0, h, h, 10_000, "FIXED_STEP"));
            raw.put("validation", m("energyRelativeTolerance", 0.1));
            ((Map<String, Object>) raw.get("solver")).put("positionTolerance", q(1.0, "m"));
            ((Map<String, Object>) raw.get("solver")).put("velocityTolerance", q(1.0, "m/s"));
            Completed done = complete(raw);
            double max = 0;
            for (Sample s : done.samples()) max = Math.max(max, Math.abs(s.x() - spring(mass, k, c, 1.0, 0.0, s.t()).x()));
            errors.add(max);
        }
        List<Double> orders = new ArrayList<>();
        for (int i = 1; i < errors.size(); i++) orders.add(Math.log(errors.get(i - 1) / errors.get(i)) / Math.log(2));
        System.out.printf("GT convergence maxErrors=%s observedOrders=%s%n", errors, orders);
        for (double order : orders) assertThat(order).isBetween(3.6, 4.6);
    }
}
