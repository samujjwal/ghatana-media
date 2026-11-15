package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.InMemoryManagedStore;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.base;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.object;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.read;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * J-14/J-15 DEV_ONLY scientific simulation over the real HTTP host, security filter, durable-shape artifact store and
 * request ledger (in-process ledger) with REAL FFmpeg/ffprobe for the optional animation. The PostgreSQL/S3 path,
 * restart readback and the browser are covered by {@code MediaDevSimulationIT} and the Explorer live test.
 */
class MediaDevSimulationHttpTest {
    private static final String TENANT = "tenant-local";
    private static final String OTHER_TENANT = "tenant-other";
    private static final String OWNER = "test-principal-owner";
    private static final String OTHER = "test-principal-other";
    private static final String SECRET = "test-only-dev-project-secret-at-least-32-bytes";
    private static final Set<String> PERMISSIONS = Set.of("media:project:dev:create", "media:project:dev:read",
            "media:project:dev:write", "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final String SIMS = "/dev/v1/simulations";

    private static Path ffmpeg;
    private static Path ffprobe;
    private static Path root;

    @BeforeAll
    static void tools() throws Exception {
        ffmpeg = Path.of(System.getenv("MEDIA_DEV_RENDER_FFMPEG") == null ? "/nonexistent" : System.getenv("MEDIA_DEV_RENDER_FFMPEG"));
        ffprobe = Path.of(System.getenv("MEDIA_DEV_RENDER_FFPROBE") == null ? "/nonexistent" : System.getenv("MEDIA_DEV_RENDER_FFPROBE"));
        root = Files.createTempDirectory("media-dev-simulation-http-");
    }

    @AfterAll
    static void cleanup() {
        if (root != null) deleteTree(root);
    }

    // ---- scenario builders ----
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

    static Map<String, Object> springScenario(double c) {
        return m("model", m("type", "DAMPED_SPRING", "mass", q(0.5, "kg"), "springConstant", q(200, "N/m"), "damping", q(c, "kg/s")),
                "initial", m("position", q(0.1, "m"), "velocity", q(0.3, "m/s")), "solver", solver(2.0, 0.05, 1e-5, 5000, "ADAPTIVE"),
                "render", m("plot", true, "video", false));
    }

    static String body(String requestId, Object scenario) throws Exception {
        return JSON.writeValueAsString(m("requestId", requestId, "scenario", scenario));
    }

    // ---- tests ----

    @Test
    void statusListsModelsUnitsLimitsAndTheDomain() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            HttpResponse<String> response = send(base(server), "GET", SIMS + "/status", null, TENANT, OWNER, PERMISSIONS);
            assertThat(response.statusCode()).isEqualTo(200);
            Map<String, Object> status = read(response.body());
            assertThat((List<Object>) status.get("models")).containsExactly("NEWTON_CONSTANT_FORCE", "DAMPED_SPRING", "PROJECTILE");
            assertThat(object(status.get("limits"))).containsEntry("maxAcceptedSteps", 10_000);
            assertThat(object(status.get("units"))).containsEntry("kg/s", "M^1*T^-1").containsEntry("deg", "A^1");
            assertThat(status).containsEntry("productionEligible", false);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void completedPassPersistsTraceAndPlotReplaysIdempotentlyAndIsTenantScoped() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            HttpResponse<String> first = send(base, "POST", SIMS, body("sim-1", springScenario(1.2)), TENANT, OWNER, PERMISSIONS);
            assertThat(first.statusCode()).as(first.body()).isEqualTo(201);
            Map<String, Object> view = read(first.body());
            assertThat(view).containsEntry("outcome", "COMPLETED").containsEntry("replayed", false).containsEntry("scope", "DEV_ONLY");
            Map<String, Object> result = object(view.get("result"));
            assertThat(result).containsEntry("productionEligible", false).containsKey("trace");
            Map<String, Object> verification = object(result.get("verification"));
            assertThat(object(verification.get("energy"))).containsEntry("ok", true).containsEntry("lawClass", "DISSIPATIVE_NON_INCREASING");
            List<?> rows = (List<?>) object(result.get("trace")).get("rows");
            // closed-form check of the terminal row: underdamped spring
            double m = 0.5, k = 200, c = 1.2, x0 = 0.1, v0 = 0.3;
            double w0 = Math.sqrt(k / m), zeta = c / (2 * Math.sqrt(k * m)), a = zeta * w0, wd = w0 * Math.sqrt(1 - zeta * zeta);
            List<?> last = (List<?>) rows.get(rows.size() - 1);
            double t = ((Number) last.get(0)).doubleValue();
            double truth = Math.exp(-a * t) * (x0 * Math.cos(wd * t) + (v0 + a * x0) / wd * Math.sin(wd * t));
            assertThat(t).isEqualTo(2.0);
            assertThat(((Number) last.get(1)).doubleValue()).isCloseTo(truth, org.assertj.core.data.Offset.offset(1e-7));

            // the plot is a decodable PNG with the declared geometry; the curve pixels are where the transform says
            Map<String, Object> plotArtifact = object(view.get("plotArtifact"));
            byte[] png = content(runtime, (String) plotArtifact.get("artifactId"));
            BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
            assertThat(image.getWidth()).isEqualTo(800);
            assertThat(image.getHeight()).isEqualTo(400);
            assertThat(plotArtifact).containsEntry("contentType", "image/png");
            Map<String, Object> panel = object(((List<?>) object(result.get("plot")).get("panels")).get(0));
            Map<String, Object> rect = object(panel.get("pixelRect"));
            int hits = 0, checked = 0;
            for (Object row : rows) {
                List<?> r = (List<?>) row;
                double tt = ((Number) r.get(0)).doubleValue();
                double px = ((Number) rect.get("x0")).doubleValue() + (tt - ((Number) panel.get("xMin")).doubleValue())
                        / (((Number) panel.get("xMax")).doubleValue() - ((Number) panel.get("xMin")).doubleValue())
                        * (((Number) rect.get("x1")).doubleValue() - ((Number) rect.get("x0")).doubleValue());
                double xTruth = Math.exp(-a * tt) * (x0 * Math.cos(wd * tt) + (v0 + a * x0) / wd * Math.sin(wd * tt));
                double py = ((Number) rect.get("y1")).doubleValue() - (xTruth - ((Number) panel.get("yMin")).doubleValue())
                        / (((Number) panel.get("yMax")).doubleValue() - ((Number) panel.get("yMin")).doubleValue())
                        * (((Number) rect.get("y1")).doubleValue() - ((Number) rect.get("y0")).doubleValue());
                checked++;
                if (isCurveColored(image, (int) Math.round(px), (int) Math.round(py), MediaDevSimulationPlot.TRAJECTORY_RGB)) hits++;
            }
            assertThat(hits).as("analytic curve points on the drawn curve").isEqualTo(checked);

            // lineage and persistence
            Map<String, Object> lineage = object(view.get("lineage"));
            assertThat(lineage).containsEntry("kind", "SIMULATION_RESULT").containsEntry("productionEligible", false)
                    .containsEntry("scenarioSha256", result.get("scenarioSha256"));
            assertThat(object(lineage.get("siblings"))).containsKey("plot");
            int count = artifactCount(runtime);

            // idempotent replay: 200, same ids, nothing new registered
            HttpResponse<String> replay = send(base, "POST", SIMS, body("sim-1", springScenario(1.2)), TENANT, OWNER, PERMISSIONS);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(read(replay.body())).containsEntry("replayed", true).containsEntry("simulationId", view.get("simulationId"));
            assertThat(object(read(replay.body()).get("result")).get("trace")).isEqualTo(result.get("trace"));
            assertThat(artifactCount(runtime)).isEqualTo(count);

            // an equivalent scenario in other units under the same requestId is the same request
            Map<String, Object> inUnits = springScenario(1.2);
            ((Map<String, Object>) object(inUnits.get("model"))).put("mass", q(500, "g"));
            assertThat(send(base, "POST", SIMS, body("sim-1", inUnits), TENANT, OWNER, PERMISSIONS).statusCode()).isEqualTo(200);

            // a different scenario under the same requestId is a typed 409; nothing new is registered
            HttpResponse<String> reused = send(base, "POST", SIMS, body("sim-1", springScenario(2.4)), TENANT, OWNER, PERMISSIONS);
            assertThat(reused.statusCode()).isEqualTo(409);
            assertThat(object(read(reused.body()).get("error"))).containsEntry("code", "SIMULATION_REQUEST_ID_REUSED");
            assertThat(artifactCount(runtime)).isEqualTo(count);

            // reopen by id; wrong tenant and other principal see 404
            String id = (String) view.get("simulationId");
            HttpResponse<String> reopened = send(base, "GET", SIMS + "/" + id, null, TENANT, OWNER, PERMISSIONS);
            assertThat(reopened.statusCode()).isEqualTo(200);
            assertThat(object(read(reopened.body()).get("result")).get("trace")).isEqualTo(result.get("trace"));
            assertThat(send(base, "GET", SIMS + "/" + id, null, OTHER_TENANT, OWNER, PERMISSIONS).statusCode()).isEqualTo(404);
            assertThat(send(base, "GET", SIMS + "/" + id, null, TENANT, OTHER, PERMISSIONS).statusCode()).isEqualTo(404);
            assertThat(send(base, "GET", SIMS + "/nope", null, TENANT, OWNER, PERMISSIONS).statusCode()).isEqualTo(404);
            // the plot artifact id is not a simulation id
            assertThat(send(base, "GET", SIMS + "/" + plotArtifact.get("artifactId"), null, TENANT, OWNER, PERMISSIONS).statusCode()).isEqualTo(404);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void refusedScenariosAre422WithPathsAndRegisterNothing() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            int before = artifactCount(runtime);
            record Case(String code, String path, java.util.function.Consumer<Map<String, Object>> mutate) { }
            List<Case> cases = List.of(
                    new Case("SIMULATION_UNIT_MISMATCH", "$.model.mass.unit", s -> object(s.get("model")).put("mass", q(1, "m"))),
                    new Case("SIMULATION_UNIT_MISMATCH", "$.model.springConstant.unit", s -> object(s.get("model")).put("springConstant", q(1, "N"))),
                    new Case("SIMULATION_UNIT_MISMATCH", "$.solver.duration.unit", s -> object(s.get("solver")).put("duration", q(1, "kg"))),
                    new Case("SIMULATION_UNIT_MISMATCH", "$.initial.velocity.unit", s -> object(s.get("initial")).put("velocity", q(1, "furlong"))),
                    new Case("SIMULATION_NON_FINITE_INPUT", "$.initial.position.value", s -> object(s.get("initial")).put("position", q(1e308, "km"))),
                    new Case("SIMULATION_BUDGET_EXCEEDED", "$.solver.maxAcceptedSteps", s -> object(s.get("solver")).put("maxAcceptedSteps", 10_001)),
                    new Case("SIMULATION_BUDGET_EXCEEDED", "$.solver.minStep", s -> object(s.get("solver")).put("minStep", q(1e-9, "s"))),
                    new Case("SIMULATION_SCENARIO_INVALID", "$.model.mass", s -> object(s.get("model")).put("mass", q(-1, "kg"))),
                    new Case("SIMULATION_SCENARIO_INVALID", "$.model.damping", s -> object(s.get("model")).put("damping", q(-1, "kg/s"))),
                    new Case("SIMULATION_SCENARIO_INVALID", "$.extra", s -> s.put("extra", 1)));
            for (Case c : cases) {
                Map<String, Object> scenario = springScenario(1.2);
                c.mutate().accept(scenario);
                HttpResponse<String> response = send(base, "POST", SIMS, body("bad", scenario), TENANT, OWNER, PERMISSIONS);
                assertThat(response.statusCode()).as(c.path() + " " + response.body()).isEqualTo(422);
                Map<String, Object> error = object(read(response.body()).get("error"));
                assertThat(error).containsEntry("code", c.code());
                assertThat(object(error.get("details"))).containsEntry("path", c.path());
            }
            // a literal beyond double range in raw JSON, wrong types and malformed bodies
            String raw = "{\"requestId\":\"bad\",\"scenario\":" + JSON.writeValueAsString(springScenario(1.2)).replace("\"value\":0.5", "\"value\":1e999") + "}";
            HttpResponse<String> huge = send(base, "POST", SIMS, raw, TENANT, OWNER, PERMISSIONS);
            assertThat(huge.statusCode()).as(huge.body()).isEqualTo(422);
            assertThat(object(read(huge.body()).get("error"))).containsEntry("code", "SIMULATION_NON_FINITE_INPUT");
            assertThat(object(object(read(huge.body()).get("error")).get("details"))).containsEntry("path", "$.model.mass.value");
            HttpResponse<String> malformed = send(base, "POST", SIMS, "{\"requestId\":", TENANT, OWNER, PERMISSIONS);
            assertThat(malformed.statusCode()).isEqualTo(422);
            assertThat(send(base, "POST", SIMS, "{\"requestId\":\"x\"}", TENANT, OWNER, PERMISSIONS).statusCode()).isEqualTo(422);
            assertThat(artifactCount(runtime)).as("no refusal registered anything").isEqualTo(before);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void untrustworthyPassesAbstainWithTypedReasonsAndNoValues() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            Map<String, Map<String, Object>> cases = new LinkedHashMap<>();
            Map<String, Object> diverge = springScenario(0);
            object(diverge.get("model")).put("springConstant", q(1e12, "N/m"));
            diverge.put("solver", solver(100, 1.0, 1.0, 1000, "FIXED_STEP"));
            cases.put("DIVERGED", diverge);
            Map<String, Object> stuck = springScenario(0);
            object(stuck.get("model")).put("springConstant", q(1e12, "N/m"));
            stuck.put("solver", solver(100, 1.0, 0.5, 1000, "ADAPTIVE"));
            cases.put("NON_CONVERGENCE", stuck);
            Map<String, Object> budget = springScenario(0);
            budget.put("solver", solver(10, 0.1, 0.1, 5, "FIXED_STEP"));
            cases.put("STEP_BUDGET_EXHAUSTED", budget);
            Map<String, Object> constrained = springScenario(0);
            constrained.put("constraints", List.of(m("id", "amplitude", "observable", "POSITION_X", "aggregate", "MAX", "op", "LE", "limit", q(0.01, "m"))));
            cases.put("CONSTRAINT_VIOLATED", constrained);
            Map<String, Object> mach = m("model", m("type", "PROJECTILE", "mass", q(1, "kg"), "drag", m("law", "QUADRATIC", "coefficient", q(0.01, "kg/m"))),
                    "initial", m("x", q(0, "m"), "y", q(0, "m"), "speed", q(400, "m/s"), "angle", q(45, "deg")),
                    "solver", solver(2, 0.05, 1e-5, 1000, "ADAPTIVE"));
            cases.put("OUT_OF_MODEL_DOMAIN", mach);
            int index = 0;
            int perArtifact = -1; // store files per registered artifact (content + metadata), learned from the first abstention
            for (Map.Entry<String, Map<String, Object>> entry : cases.entrySet()) {
                int before = artifactCount(runtime);
                String id = "abstain-" + index++;
                HttpResponse<String> response = send(base, "POST", SIMS, body(id, entry.getValue()), TENANT, OWNER, PERMISSIONS);
                assertThat(response.statusCode()).as(entry.getKey() + " " + response.body()).isEqualTo(201);
                Map<String, Object> view = read(response.body());
                assertThat(view).containsEntry("outcome", "ABSTAINED").doesNotContainKey("plotArtifact");
                Map<String, Object> result = object(view.get("result"));
                assertThat(result).doesNotContainKeys("trace", "observables", "verification", "plot");
                assertThat(result).containsEntry("productionEligible", false).containsKey("diagnostics");
                List<?> reasons = (List<?>) result.get("reasons");
                assertThat(object(reasons.get(0))).containsEntry("code", entry.getKey());
                int added = artifactCount(runtime) - before;
                if (perArtifact < 0) perArtifact = added;
                assertThat(added).as("exactly one artifact (the abstention record) is stored").isEqualTo(perArtifact).isPositive();
                // the abstention is itself durable and replays unchanged
                HttpResponse<String> replay = send(base, "POST", SIMS, body(id, entry.getValue()), TENANT, OWNER, PERMISSIONS);
                assertThat(replay.statusCode()).isEqualTo(200);
                assertThat(read(replay.body())).containsEntry("outcome", "ABSTAINED").containsEntry("replayed", true);
                assertThat(send(base, "GET", SIMS + "/" + view.get("simulationId"), null, TENANT, OWNER, PERMISSIONS).statusCode()).isEqualTo(200);
                assertThat(artifactCount(runtime)).isEqualTo(before + perArtifact);
            }
            // the violated constraint reports the measured value honestly in the reason details only
            Map<String, Object> reason = object(((List<?>) object(read(send(base, "GET", SIMS + "/" + readId(runtime, base, "abstain-3"), null, TENANT, OWNER, PERMISSIONS).body())
                    .get("result")).get("reasons")).get(0));
            assertThat(object(reason.get("details"))).containsEntry("constraintId", "amplitude").containsKey("observedSi");
        } finally {
            server.stop(0);
        }
    }

    private static String readId(MediaRuntime runtime, String base, String requestId) throws Exception {
        // replay returns the id of the stored result
        Map<String, Object> scenario = springScenario(0);
        scenario.put("constraints", List.of(m("id", "amplitude", "observable", "POSITION_X", "aggregate", "MAX", "op", "LE", "limit", q(0.01, "m"))));
        return (String) read(send(base, "POST", SIMS, body(requestId, scenario), TENANT, OWNER, PERMISSIONS).body()).get("simulationId");
    }

    @Test
    void permissionsAreEnforcedPerRoute() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            Set<String> noCreate = Set.of("media:project:dev:write", "media:project:dev:read", "media:artifact:read");
            assertThat(send(base, "POST", SIMS, body("p1", springScenario(1)), TENANT, OWNER, noCreate).statusCode()).isEqualTo(403);
            Set<String> noWrite = Set.of("media:project:dev:read", "media:artifact:read", "media:artifact:create");
            assertThat(send(base, "POST", SIMS, body("p2", springScenario(1)), TENANT, OWNER, noWrite).statusCode()).isEqualTo(403);
            assertThat(send(base, "GET", SIMS + "/x", null, TENANT, OWNER, Set.of("media:project:dev:read")).statusCode()).isEqualTo(403);
            assertThat(send(base, "DELETE", SIMS + "/x", null, TENANT, OWNER, PERMISSIONS).statusCode()).isIn(403, 404, 405);
            assertThat(artifactCount(runtime)).isZero();
        } finally {
            server.stop(0);
        }
    }

    @Test
    void projectileWithQuadraticDragStopsAtGroundImpactAndRendersAVerifiedMp4() throws Exception {
        assertThat(System.getenv("MEDIA_DEV_RENDER_FFMPEG")).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(System.getenv("MEDIA_DEV_RENDER_FFPROBE")).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            Map<String, Object> scenario = m("model", m("type", "PROJECTILE", "mass", q(0.145, "kg"), "drag", m("law", "QUADRATIC", "coefficient", q(0.0012, "kg/m"))),
                    "initial", m("x", q(0, "m"), "y", q(1.0, "m"), "speed", q(40, "m/s"), "angle", q(40, "deg")),
                    "solver", m("duration", q(30, "s"), "maxStep", q(0.05, "s"), "minStep", q(1e-5, "s"), "positionTolerance", q(1e-8, "m"),
                            "velocityTolerance", q(1e-8, "m/s"), "maxAcceptedSteps", 5000, "maxIterations", 100000, "terminateOnGroundImpact", true),
                    "constraints", List.of(m("id", "lands-within", "observable", "POSITION_X", "op", "LE", "limit", q(200, "m")),
                            m("id", "never-faster", "observable", "SPEED", "aggregate", "MAX", "op", "LE", "limit", q(41, "m/s"))),
                    "render", m("plot", true, "video", true));
            HttpResponse<String> response = send(base, "POST", SIMS, body("proj-1", scenario), TENANT, OWNER, PERMISSIONS);
            assertThat(response.statusCode()).as(response.body()).isEqualTo(201);
            Map<String, Object> view = read(response.body());
            assertThat(view).containsEntry("outcome", "COMPLETED").containsKeys("plotArtifact", "videoArtifact");
            Map<String, Object> result = object(view.get("result"));
            assertThat(object(object(result.get("verification")).get("energy"))).containsEntry("lawClass", "DISSIPATIVE_NON_INCREASING");
            assertThat(object(result.get("verification"))).containsEntry("termination", "GROUND_IMPACT");
            Map<String, Object> impact = object(result.get("impact"));
            // independent reference integrator at a 100000-step fixed RK4 until the same impact time
            double t = ((Number) impact.get("timeSeconds")).doubleValue();
            double[] ref = reference(0.145, 0.0012, 1.0, 40, Math.toRadians(40), t, 200_000);
            assertThat(ref[1]).as("reference y at the solver's impact time").isCloseTo(0.0, org.assertj.core.data.Offset.offset(1e-6));
            assertThat(((Number) impact.get("rangeMeters")).doubleValue()).isCloseTo(ref[0], org.assertj.core.data.Offset.offset(1e-6));
            String videoId = (String) object(view.get("videoArtifact")).get("artifactId");
            byte[] mp4 = content(runtime, videoId);
            Path file = root.resolve("sim.mp4");
            Files.write(file, mp4);
            String probe = run(ffprobe.toString(), "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                    "stream=nb_read_frames,avg_frame_rate,width,height,codec_name,pix_fmt", "-of", "default=nw=1", file.toString());
            assertThat(probe).contains("nb_read_frames=48").contains("avg_frame_rate=24/1").contains("width=800").contains("height=400")
                    .contains("codec_name=h264").contains("pix_fmt=yuv420p");
            assertThat(object(view.get("videoArtifact"))).containsEntry("contentType", "video/mp4");
            // reopen returns both siblings
            Map<String, Object> reopened = read(send(base, "GET", SIMS + "/" + view.get("simulationId"), null, TENANT, OWNER, PERMISSIONS).body());
            assertThat(reopened).containsKeys("plotArtifact", "videoArtifact");
        } finally {
            server.stop(0);
        }
    }

    private static double[] reference(double mass, double k, double y0, double speed, double angle, double t, int steps) {
        double x = 0, y = y0, vx = speed * Math.cos(angle), vy = speed * Math.sin(angle), h = t / steps, g = 9.80665;
        for (int i = 0; i < steps; i++) {
            double[] a = acc(mass, k, g, vx, vy);
            double[] b = acc(mass, k, g, vx + h / 2 * a[0], vy + h / 2 * a[1]);
            double[] c = acc(mass, k, g, vx + h / 2 * b[0], vy + h / 2 * b[1]);
            double[] d = acc(mass, k, g, vx + h * c[0], vy + h * c[1]);
            x += h * (vx + 2 * (vx + h / 2 * a[0]) + 2 * (vx + h / 2 * b[0]) + (vx + h * c[0])) / 6;
            y += h * (vy + 2 * (vy + h / 2 * a[1]) + 2 * (vy + h / 2 * b[1]) + (vy + h * c[1])) / 6;
            vx += h * (a[0] + 2 * b[0] + 2 * c[0] + d[0]) / 6;
            vy += h * (a[1] + 2 * b[1] + 2 * c[1] + d[1]) / 6;
        }
        return new double[] {x, y, vx, vy};
    }

    private static double[] acc(double mass, double k, double g, double vx, double vy) {
        double s = Math.hypot(vx, vy);
        return new double[] {-k * s * vx / mass, -g - k * s * vy / mass};
    }

    private static boolean isCurveColored(BufferedImage image, int px, int py, int rgb) {
        for (int dx = -3; dx <= 3; dx++) {
            for (int dy = -3; dy <= 3; dy++) {
                int x = px + dx, y = py + dy;
                if (x < 0 || y < 0 || x >= image.getWidth() || y >= image.getHeight()) continue;
                if ((image.getRGB(x, y) & 0xFFFFFF) == rgb) return true;
            }
        }
        return false;
    }

    // ---- harness ----

    private HttpServer server(MediaRuntime runtime) throws Exception {
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        HttpServer server = MediaDevProjectRenderHttpTest.server(runtime, projects, null);
        server.removeContext("/");
        boolean tools = Files.isRegularFile(ffmpeg);
        MediaDevSimulationRuntime simulation = new MediaDevSimulationRuntime(runtime, tools ? ffmpeg : null, tools ? ffprobe : null,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), MediaDevRequestLedger.inMemory());
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, projects).withDevSimulation(simulation);
        server.createContext("/", new MediaSecurityFilter(handler, "dev", Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true",
                "MEDIA_DEV_JWT_HMAC_SECRET", SECRET),
                java.time.Clock.fixed(Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC)));
        return server;
    }

    private static MediaRuntime runtime() throws Exception {
        Path store = Files.createTempDirectory(root, "store-");
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "dev", 8093, 1_048_576, 131_072, 64L * 1024 * 1024, Duration.ofSeconds(2),
                        2, "", "", true, false, store, 0, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT,
                        MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT_PER_TENANT),
                new LocalMediaRuntimeSupport.FileArtifactStore(store), new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(new MediaDevProjectRenderHttpTest.NoEffectProvider()),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static int artifactCount(MediaRuntime runtime) throws Exception {
        try (var files = Files.walk(Path.of(runtime.config().localStorageRoot().toString()))) {
            return (int) files.filter(Files::isRegularFile).count();
        }
    }

    private static byte[] content(MediaRuntime runtime, String artifactId) throws Exception {
        MediaArtifact artifact = runtime.artifact(TENANT, OWNER, artifactId).orElseThrow();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        runtime.copyArtifactContent(TENANT, OWNER, artifactId, artifact.version(), out, 64 * 1024 * 1024).orElseThrow();
        return out.toByteArray();
    }

    private static HttpResponse<String> send(String base, String method, String path, String body, String tenant,
                                             String principal, Set<String> permissions) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + path))
                .header("Authorization", "Bearer " + token(principal, tenant, permissions)).header("X-Tenant-Id", tenant);
        if (body != null) request.header("Content-Type", "application/json");
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static String token(String principal, String tenant, Set<String> permissions) throws Exception {
        java.time.Clock clock = java.time.Clock.fixed(Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC);
        String header = encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String permissionJson = permissions.stream().sorted().map(permission -> "\"" + permission + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payload = "{\"sub\":\"" + principal + "\",\"tenant_id\":\"" + tenant
                + "\",\"iss\":\"urn:ghatana:media:dev-only\",\"aud\":\"ghatana-media-dev\",\"dev_only\":true,"
                + "\"iat\":" + clock.instant().getEpochSecond() + ",\"exp\":" + clock.instant().plusSeconds(120).getEpochSecond()
                + ",\"permissions\":[" + permissionJson + "]}";
        String signingInput = header + "." + encode(payload);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String encode(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static String run(String... command) throws Exception {
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(process.waitFor()).as(output).isZero();
        return output;
    }

    private static void deleteTree(Path dir) {
        try (var walk = Files.walk(dir)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (Exception ignored) {
            // best effort
        }
    }
}
