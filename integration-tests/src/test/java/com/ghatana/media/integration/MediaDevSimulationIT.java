package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffprobe;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-14 {@code media.dev.outcome-scientific-simulation} and J-15 {@code media.dev.outcome-validated-simulation-pass}
 * against REAL processes: the real launcher with the durable PostgreSQL + S3 artifact store and request ledger
 * (Testcontainers) and real FFmpeg/ffprobe.
 *
 * <p>Truth is independent of the solver: every comparison below reads the STORED result bytes back from S3 and compares
 * them with closed-form analytic solutions (Newton, undamped/under/critically/over-damped spring, drag-free and
 * linear-drag projectile, vertical fall under quadratic drag) and with a reference integrator written in this test
 * (fixed fine-step RK4). It reports the maximum error, the energy drift measured from the stored trace and the observed
 * step-convergence order. The plot is decoded and its curve pixels are checked against the analytic curve through the
 * stored pixel transform; the MP4 is probed and two decoded frames are checked.</p>
 *
 * <p>Fault suite: unit/dimension mismatch, non-finite and over-budget scenarios (422 with the JSON path, nothing
 * stored), divergence, non-convergence, step-budget exhaustion, out-of-domain and a violated constraint (typed
 * ABSTAINED with reasons and no trace, also in the stored bytes), wrong tenant and principal, idempotent replay, a changed
 * scenario under the same requestId, the real encoder killed mid-run, the launcher killed mid-run and a restart readback.
 * Missing runtime prerequisites FAIL the test.</p>
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevSimulationIT {
    private static final String SIMS = "/dev/v1/simulations";
    private static final double G = 9.80665;

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private String tenant;
    private String principal;
    private String bucket;
    private int port;
    private String token;

    @Test
    void realLauncherSolvesAgainstAnalyticTruthAbstainsWhenUntrustworthyAndSurvivesTheFaultSuite() throws Exception {
        assertThat(ffmpeg()).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(ffprobe()).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
        String run = UUID.randomUUID().toString().replace("-", "");
        tenant = "tenant-dev-sim-" + run;
        String otherTenant = "tenant-dev-sim-other-" + run;
        principal = "media-dev-sim-" + run;
        bucket = "media-dev-sim-" + run.substring(0, 16);
        String schema = "media_dev_sim_" + run;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-sim-services-");
        Path work = Files.createTempDirectory("media-dev-sim-work-");
        Path log = Files.createTempFile("media-dev-sim-process-", ".log");
        Process launcher = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            MediaDevFaultInjector.ModeScript wrapper = MediaDevFaultInjector.ModeScript.ffmpeg(work, Path.of(ffmpeg()));
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_DEV_RENDER_FFMPEG", wrapper.path().toString());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe());
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, principal);

            JsonNode status = get(port, tenant, token, SIMS + "/status", 200);
            assertThat(status.path("ready").asBoolean()).isTrue();
            assertThat(status.path("limits").path("maxAcceptedSteps").asInt()).isEqualTo(10_000);
            assertThat(status.path("video").path("available").asBoolean()).isTrue();
            assertThat(status.path("productionEligible").asBoolean()).isFalse();

            // ---------------------------------------------------------------- Newton vector (mixed units)
            JsonNode newton = solve("newton-" + run, scenario(m("type", "NEWTON_CONSTANT_FORCE", "mass", q(2000, "g"), "force", q(6000, "mN")),
                    m("position", q(0, "m"), "velocity", q(0, "m/s")), solverPolicy(2000, "ms", 0.5, 1e-4, 1000, "ADAPTIVE")), 201);
            JsonNode newtonDoc = stored(newton);
            JsonNode newtonLast = lastRow(newtonDoc);
            assertThat(newtonLast.get(0).asDouble()).isEqualTo(2.0);
            assertThat(newtonLast.get(5).asDouble()).as("a = F/m").isEqualTo(3.0);
            assertThat(newtonLast.get(3).asDouble()).isCloseTo(6.0, within(1e-12));
            assertThat(newtonLast.get(1).asDouble()).isCloseTo(6.0, within(1e-12));
            System.out.printf("J14-IT-NEWTON m=2kg F=6N t=2s -> a=%.15g v=%.15g x=%.15g (exact 3, 6, 6)%n",
                    newtonLast.get(5).asDouble(), newtonLast.get(3).asDouble(), newtonLast.get(1).asDouble());

            // ---------------------------------------------------------------- springs in all four damping regimes
            double mass = 0.5, k = 200, critical = 2 * Math.sqrt(k * mass);
            List<String> springIds = new ArrayList<>();
            for (double c : new double[] {0, 1.2, critical, 3 * critical}) {
                JsonNode view = solve("spring-" + c + "-" + run, scenario(m("type", "DAMPED_SPRING", "mass", q(mass, "kg"),
                        "springConstant", q(k, "N/m"), "damping", q(c, "kg/s")), m("position", q(0.1, "m"), "velocity", q(0.3, "m/s")),
                        solverPolicy(3.0, "s", 0.05, 1e-5, 10_000, "ADAPTIVE")), 201);
                springIds.add(view.path("simulationId").asString());
                JsonNode doc = stored(view);
                double maxX = 0, maxV = 0, e0 = 0, maxDrift = 0, maxRise = 0, prevE = Double.NaN;
                for (JsonNode row : doc.path("trace").path("rows")) {
                    double t = row.get(0).asDouble(), x = row.get(1).asDouble(), v = row.get(3).asDouble();
                    double[] truth = spring(mass, k, c, 0.1, 0.3, t);
                    maxX = Math.max(maxX, Math.abs(x - truth[0]));
                    maxV = Math.max(maxV, Math.abs(v - truth[1]));
                    double e = 0.5 * mass * v * v + 0.5 * k * x * x; // energy recomputed from the stored state, not read from the host
                    if (Double.isNaN(prevE)) e0 = e;
                    else maxRise = Math.max(maxRise, e - prevE);
                    maxDrift = Math.max(maxDrift, Math.abs(e - e0));
                    prevE = e;
                }
                assertThat(maxX).as("c=" + c).isLessThan(2e-7);
                assertThat(maxV).as("c=" + c).isLessThan(2e-6);
                if (c == 0) assertThat(maxDrift / e0).as("undamped energy conservation").isLessThan(1e-6);
                else assertThat(maxRise / e0).as("damped energy never rises").isLessThan(1e-6);
                System.out.printf("J14-IT-SPRING c=%.3f zeta=%.3f maxPosErr=%.3e maxVelErr=%.3e %s=%.3e steps=%d%n",
                        c, c / critical, maxX, maxV, c == 0 ? "energyDriftRel" : "maxEnergyRiseRel", c == 0 ? maxDrift / e0 : maxRise / e0,
                        doc.path("verification").path("acceptedSteps").asInt());
            }

            // ---------------------------------------------------------------- step-convergence order (fixed step vs analytic)
            List<Double> errors = new ArrayList<>();
            double h = 0.1;
            for (int i = 0; i < 4; i++, h /= 2) {
                Map<String, Object> raw = scenario(m("type", "DAMPED_SPRING", "mass", q(1.0, "kg"), "springConstant", q(40, "N/m"), "damping", q(0.8, "kg/s")),
                        m("position", q(1.0, "m"), "velocity", q(0, "m/s")), solverPolicy(2.0, "s", h, h, 10_000, "FIXED_STEP"));
                raw.put("validation", m("energyRelativeTolerance", 0.1));
                ((Map<String, Object>) raw.get("solver")).put("positionTolerance", q(1.0, "m"));
                ((Map<String, Object>) raw.get("solver")).put("velocityTolerance", q(1.0, "m/s"));
                JsonNode doc = stored(solve("order-" + i + "-" + run, raw, 201));
                double max = 0;
                for (JsonNode row : doc.path("trace").path("rows")) max = Math.max(max, Math.abs(row.get(1).asDouble() - spring(1.0, 40, 0.8, 1.0, 0, row.get(0).asDouble())[0]));
                errors.add(max);
            }
            List<Double> orders = new ArrayList<>();
            for (int i = 1; i < errors.size(); i++) orders.add(Math.log(errors.get(i - 1) / errors.get(i)) / Math.log(2));
            System.out.printf("J14-IT-CONVERGENCE stepsizes=0.1,0.05,0.025,0.0125 maxErrors=%s observedOrders=%s (RK4 expects 4)%n", errors, orders);
            for (double order : orders) assertThat(order).isBetween(3.6, 4.6);

            // ---------------------------------------------------------------- projectiles: no drag, linear drag, quadratic drag
            double vx0 = 30, vy0 = 40, y0 = 2.0, pm = 0.2;
            double speed = Math.hypot(vx0, vy0), angle = Math.atan2(vy0, vx0);
            JsonNode drag0 = solve("proj0-" + run, scenario(m("type", "PROJECTILE", "mass", q(pm, "kg"), "drag", m("law", "NONE")),
                    m("x", q(0, "m"), "y", q(y0, "m"), "speed", q(speed, "m/s"), "angle", q(angle, "rad")), solverPolicy(5.0, "s", 0.1, 1e-5, 10_000, "ADAPTIVE")), 201);
            double err0 = 0;
            for (JsonNode row : stored(drag0).path("trace").path("rows")) {
                double t = row.get(0).asDouble();
                err0 = Math.max(err0, Math.max(Math.abs(row.get(1).asDouble() - vx0 * t), Math.abs(row.get(2).asDouble() - (y0 + vy0 * t - 0.5 * G * t * t))));
            }
            assertThat(err0).isLessThan(1e-9);
            double b = 0.05, gamma = b / pm;
            JsonNode dragL = solve("projL-" + run, scenario(m("type", "PROJECTILE", "mass", q(pm, "kg"), "drag", m("law", "LINEAR", "coefficient", q(b, "kg/s"))),
                    m("x", q(0, "m"), "y", q(y0, "m"), "speed", q(speed, "m/s"), "angle", q(angle, "rad")), solverPolicy(5.0, "s", 0.1, 1e-5, 10_000, "ADAPTIVE")), 201);
            double errL = 0;
            for (JsonNode row : stored(dragL).path("trace").path("rows")) {
                double t = row.get(0).asDouble(), e = Math.exp(-gamma * t);
                double ex = vx0 * (1 - e) / gamma, ey = y0 + (vy0 + G / gamma) * (1 - e) / gamma - G * t / gamma;
                errL = Math.max(errL, Math.max(Math.abs(row.get(1).asDouble() - ex), Math.abs(row.get(2).asDouble() - ey)));
            }
            assertThat(errL).isLessThan(5e-7);
            double qk = 0.0012, qm = 0.145;
            JsonNode dragQ = solve("projQ-" + run, scenario(m("type", "PROJECTILE", "mass", q(qm, "kg"), "drag", m("law", "QUADRATIC", "coefficient", q(qk, "kg/m"))),
                    m("x", q(0, "m"), "y", q(1.0, "m"), "speed", q(40, "m/s"), "angle", q(40, "deg")),
                    withImpact(solverPolicy(30.0, "s", 0.05, 1e-5, 5000, "ADAPTIVE"))), 201);
            JsonNode qDoc = stored(dragQ);
            JsonNode qLast = lastRow(qDoc);
            double tImpact = qLast.get(0).asDouble();
            double[] ref = referenceQuadratic(qm, qk, 1.0, 40 * Math.cos(Math.toRadians(40)), 40 * Math.sin(Math.toRadians(40)), tImpact, 400_000);
            double errQ = Math.max(Math.abs(qLast.get(1).asDouble() - ref[0]), Math.abs(qLast.get(3).asDouble() - ref[2]));
            assertThat(ref[1]).as("reference y at the solver's impact time").isCloseTo(0.0, within(1e-7));
            assertThat(errQ).isLessThan(1e-6);
            assertThat(qDoc.path("verification").path("energy").path("lawClass").asString()).isEqualTo("DISSIPATIVE_NON_INCREASING");
            assertThat(qDoc.path("verification").path("termination").asString()).isEqualTo("GROUND_IMPACT");
            // quadratic drag, vertical fall: terminal-velocity closed form
            double vt = Math.sqrt(qm * G / qk), fallY0 = 1000;
            JsonNode fall = solve("fall-" + run, scenario(m("type", "PROJECTILE", "mass", q(qm, "kg"), "drag", m("law", "QUADRATIC", "coefficient", q(qk, "kg/m"))),
                    m("x", q(0, "m"), "y", q(fallY0, "m"), "speed", q(0, "m/s"), "angle", q(0, "rad")), solverPolicy(12.0, "s", 0.1, 1e-5, 10_000, "ADAPTIVE")), 201);
            double errFall = 0;
            for (JsonNode row : stored(fall).path("trace").path("rows")) {
                double t = row.get(0).asDouble();
                errFall = Math.max(errFall, Math.max(Math.abs(row.get(4).asDouble() + vt * Math.tanh(G * t / vt)),
                        Math.abs(row.get(2).asDouble() - (fallY0 - vt * vt / G * Math.log(Math.cosh(G * t / vt))))));
            }
            assertThat(errFall).isLessThan(5e-7);
            System.out.printf("J14-IT-PROJECTILE noDragMaxErr=%.3e linearDragMaxErr=%.3e quadraticVsRK4(400k steps) maxErr=%.3e impactT=%.9f quadraticFallVsTanhMaxErr=%.3e%n",
                    err0, errL, errQ, tImpact, errFall);

            // ---------------------------------------------------------------- plot and MP4 verified from the stored bytes
            Map<String, Object> animated = scenario(m("type", "PROJECTILE", "mass", q(pm, "kg"), "drag", m("law", "NONE")),
                    m("x", q(0, "m"), "y", q(y0, "m"), "speed", q(speed, "m/s"), "angle", q(angle, "rad")), withImpact(solverPolicy(30.0, "s", 0.1, 1e-5, 5000, "ADAPTIVE")));
            animated.put("render", m("plot", true, "video", true));
            JsonNode anim = solve("anim-" + run, animated, 201);
            JsonNode animDoc = stored(anim);
            double tFlight = (vy0 + Math.sqrt(vy0 * vy0 + 2 * G * y0)) / G;
            assertThat(animDoc.path("impact").path("timeSeconds").asDouble()).isCloseTo(tFlight, within(1e-9));
            assertThat(animDoc.path("impact").path("rangeMeters").asDouble()).isCloseTo(vx0 * tFlight, within(1e-8));
            byte[] png = artifactBytes(anim.path("plotArtifact").path("artifactId").asString());
            assertThat(sha256(png)).isEqualTo(anim.path("plotArtifact").path("sha256").asString());
            BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
            assertThat(image.getWidth()).isEqualTo(800);
            assertThat(image.getHeight()).isEqualTo(400);
            JsonNode panel = animDoc.path("plot").path("panels").get(0);
            int checked = 0, hits = 0;
            for (JsonNode row : animDoc.path("trace").path("rows")) {
                double t = row.get(0).asDouble();
                double px = pixelX(panel, vx0 * t), py = pixelY(panel, y0 + vy0 * t - 0.5 * G * t * t);
                checked++;
                if (near(image, (int) Math.round(px), (int) Math.round(py), 0xC80000)) hits++;
            }
            assertThat(hits).as("analytic trajectory points on the drawn curve").isEqualTo(checked);
            byte[] mp4 = artifactBytes(anim.path("videoArtifact").path("artifactId").asString());
            assertThat(sha256(mp4)).isEqualTo(anim.path("videoArtifact").path("sha256").asString());
            Path file = work.resolve("sim.mp4");
            Files.write(file, mp4);
            String probe = exec(List.of(ffprobe(), "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                    "stream=nb_read_frames,avg_frame_rate,width,height,codec_name,pix_fmt", "-of", "default=nw=1", file.toString()));
            assertThat(probe).contains("nb_read_frames=48").contains("avg_frame_rate=24/1").contains("width=800").contains("height=400")
                    .contains("codec_name=h264").contains("pix_fmt=yuv420p");
            for (int frame : new int[] {0, 47}) {
                Path out = work.resolve("frame" + frame + ".png");
                exec(List.of(ffmpeg(), "-v", "error", "-y", "-i", file.toString(), "-vf", "select=eq(n\\," + frame + ")", "-frames:v", "1", out.toString()));
                BufferedImage decoded = ImageIO.read(out.toFile());
                double tt = tFlight * frame / 47.0;
                int mx = (int) Math.round(pixelX(panel, vx0 * tt)), my = (int) Math.round(pixelY(panel, y0 + vy0 * tt - 0.5 * G * tt * tt));
                assertThat(marker(decoded, mx, my)).as("blue marker at the analytic position in decoded frame " + frame).isTrue();
            }
            System.out.printf("J14-IT-PLOT-MP4 curvePixelsOnAnalytic=%d/%d mp4Frames=48 decodedMarkersAtAnalyticPositions=2/2%n", hits, checked);

            // ---------------------------------------------------------------- J-14/J-15 refusals and abstentions
            int rowsBefore = rows(tenant, principal, "SIMULATION");
            Map<String, Object> badUnit = spring(0.5, 200, 1.2);
            ((Map<String, Object>) badUnit.get("model")).put("mass", q(1, "m"));
            JsonNode e1 = expect("bad1-" + run, badUnit, 422, "SIMULATION_UNIT_MISMATCH");
            assertThat(e1.path("error").path("details").path("path").asString()).isEqualTo("$.model.mass.unit");
            assertThat(e1.path("error").path("details").path("expected").asString()).isEqualTo("M^1");
            Map<String, Object> badTime = spring(0.5, 200, 1.2);
            ((Map<String, Object>) badTime.get("solver")).put("duration", q(1, "N"));
            assertThat(expect("bad2-" + run, badTime, 422, "SIMULATION_UNIT_MISMATCH").path("error").path("details").path("path").asString())
                    .isEqualTo("$.solver.duration.unit");
            String huge = JSON.writeValueAsString(m("requestId", "bad3-" + run, "scenario", spring(0.5, 200, 1.2))).replace("\"value\":0.5", "\"value\":1e999");
            HttpResponse<String> nonFinite = send(port, tenant, token, "POST", SIMS, huge);
            assertThat(nonFinite.statusCode()).as(nonFinite.body()).isEqualTo(422);
            assertThat(JSON.readTree(nonFinite.body()).path("error").path("code").asString()).isEqualTo("SIMULATION_NON_FINITE_INPUT");
            assertThat(JSON.readTree(nonFinite.body()).path("error").path("details").path("path").asString()).isEqualTo("$.model.mass.value");
            Map<String, Object> overflow = spring(0.5, 200, 1.2);
            ((Map<String, Object>) overflow.get("initial")).put("position", q(1e308, "km"));
            assertThat(expect("bad4-" + run, overflow, 422, "SIMULATION_NON_FINITE_INPUT").path("error").path("details").path("path").asString())
                    .isEqualTo("$.initial.position.value");
            Map<String, Object> overBudget = spring(0.5, 200, 1.2);
            ((Map<String, Object>) overBudget.get("solver")).put("maxAcceptedSteps", 10_001);
            JsonNode budget = expect("bad5-" + run, overBudget, 422, "SIMULATION_BUDGET_EXCEEDED");
            assertThat(budget.path("error").path("details").path("requested").asInt()).isEqualTo(10_001);
            assertThat(budget.path("error").path("details").path("ceiling").asInt()).isEqualTo(10_000);
            Map<String, Object> negative = spring(0.5, 200, -1);
            assertThat(expect("bad6-" + run, negative, 422, "SIMULATION_SCENARIO_INVALID").path("error").path("details").path("path").asString())
                    .isEqualTo("$.model.damping");
            assertThat(rows(tenant, principal, "SIMULATION")).as("every refusal registered nothing").isEqualTo(rowsBefore);

            Map<String, Map<String, Object>> abstentions = new LinkedHashMap<>();
            Map<String, Object> stiff = scenario(m("type", "DAMPED_SPRING", "mass", q(1, "kg"), "springConstant", q(1e12, "N/m"), "damping", q(0, "kg/s")),
                    m("position", q(1, "m"), "velocity", q(0, "m/s")), solverPolicy(100, "s", 1.0, 1.0, 1000, "FIXED_STEP"));
            abstentions.put("DIVERGED", stiff);
            abstentions.put("NON_CONVERGENCE", scenario(m("type", "DAMPED_SPRING", "mass", q(1, "kg"), "springConstant", q(1e12, "N/m"), "damping", q(0, "kg/s")),
                    m("position", q(1, "m"), "velocity", q(0, "m/s")), solverPolicy(100, "s", 1.0, 0.5, 1000, "ADAPTIVE")));
            abstentions.put("STEP_BUDGET_EXHAUSTED", scenario(m("type", "DAMPED_SPRING", "mass", q(1, "kg"), "springConstant", q(40, "N/m"), "damping", q(0, "kg/s")),
                    m("position", q(1, "m"), "velocity", q(0, "m/s")), solverPolicy(10, "s", 0.1, 0.1, 5, "FIXED_STEP")));
            abstentions.put("OUT_OF_MODEL_DOMAIN", scenario(m("type", "PROJECTILE", "mass", q(1, "kg"), "drag", m("law", "QUADRATIC", "coefficient", q(0.01, "kg/m"))),
                    m("x", q(0, "m"), "y", q(0, "m"), "speed", q(400, "m/s"), "angle", q(45, "deg")), solverPolicy(2, "s", 0.05, 1e-5, 1000, "ADAPTIVE")));
            Map<String, Object> constrained = spring(0.5, 200, 0);
            constrained.put("constraints", List.of(m("id", "amplitude", "observable", "POSITION_X", "aggregate", "MAX", "op", "LE", "limit", q(0.01, "m"))));
            abstentions.put("CONSTRAINT_VIOLATED", constrained);
            Map<String, Object> inaccurate = scenario(m("type", "DAMPED_SPRING", "mass", q(1, "kg"), "springConstant", q(40, "N/m"), "damping", q(0, "kg/s")),
                    m("position", q(1, "m"), "velocity", q(0, "m/s")), solverPolicy(2, "s", 0.2, 0.2, 1000, "FIXED_STEP"));
            abstentions.put("ERROR_ESTIMATE_EXCEEDS_TOLERANCE", inaccurate);
            Map<String, String> abstainedIds = new LinkedHashMap<>();
            for (Map.Entry<String, Map<String, Object>> entry : abstentions.entrySet()) {
                int before = rows(tenant, principal, "SIMULATION");
                JsonNode view = solve("abstain-" + entry.getKey() + "-" + run, entry.getValue(), 201);
                assertThat(view.path("outcome").asString()).isEqualTo("ABSTAINED");
                assertThat(view.has("plotArtifact")).isFalse();
                assertThat(view.path("result").path("reasons").get(0).path("code").asString()).as(view.toString()).isEqualTo(entry.getKey());
                JsonNode doc = stored(view);
                assertThat(doc.path("outcome").asString()).isEqualTo("ABSTAINED");
                for (String forbidden : List.of("trace", "observables", "verification", "plot")) {
                    assertThat(doc.has(forbidden)).as("stored abstention must not carry " + forbidden).isFalse();
                }
                assertThat(doc.path("productionEligible").asBoolean()).isFalse();
                assertThat(rows(tenant, principal, "SIMULATION")).as("only the abstention record is stored").isEqualTo(before + 1);
                abstainedIds.put(entry.getKey(), view.path("simulationId").asString());
                System.out.printf("J15-IT-ABSTAIN %s -> %s %s%n", entry.getKey(), view.path("result").path("reasons").get(0).path("code").asString(),
                        view.path("result").path("diagnostics"));
            }
            JsonNode violated = stored(get(port, tenant, token, SIMS + "/" + abstainedIds.get("CONSTRAINT_VIOLATED"), 200)).path("reasons").get(0);
            assertThat(violated.path("details").path("constraintId").asString()).isEqualTo("amplitude");
            assertThat(violated.path("details").path("observedSi").asDouble()).as("sampled maximum amplitude vs closed form sqrt(x0^2+(v0/w0)^2)")
                    .isCloseTo(Math.sqrt(0.1 * 0.1 + Math.pow(0.3 / Math.sqrt(200 / 0.5), 2)), within(1e-4));
            // J-15: the same declared constraint, satisfied, yields a validated pass that reports each constraint
            Map<String, Object> satisfied = spring(0.5, 200, 0);
            satisfied.put("constraints", List.of(m("id", "amplitude", "observable", "POSITION_X", "aggregate", "MAX", "op", "LE", "limit", q(0.2, "m")),
                    m("id", "energy", "observable", "TOTAL_ENERGY", "aggregate", "FINAL", "op", "GE", "limit", q(0.01, "J"))));
            JsonNode passed15 = solve("validated-" + run, satisfied, 201);
            assertThat(passed15.path("outcome").asString()).isEqualTo("COMPLETED");
            for (JsonNode c : stored(passed15).path("verification").path("constraints")) assertThat(c.path("satisfied").asBoolean()).isTrue();

            // ---------------------------------------------------------------- tenancy, idempotent replay and a changed scenario
            String simId = newton.path("simulationId").asString();
            String otherToken = issueDevToken(otherTenant, principal);
            assertThat(send(port, otherTenant, otherToken, "GET", SIMS + "/" + simId, null).statusCode()).isEqualTo(404);
            assertThat(send(port, tenant, issueDevToken(tenant, "someone-else-" + run), "GET", SIMS + "/" + simId, null).statusCode()).isEqualTo(404);
            assertThat(send(port, tenant, token, "GET", SIMS + "/" + anim.path("plotArtifact").path("artifactId").asString(), null).statusCode())
                    .as("a plot artifact id is not a simulation id").isEqualTo(404);
            HttpResponse<String> foreignRun = send(port, otherTenant, otherToken, "POST", SIMS, body("newton-" + run, newtonScenario()));
            assertThat(foreignRun.statusCode()).as("the same requestId in another tenant is its own request").isEqualTo(201);
            assertThat(JSON.readTree(foreignRun.body()).path("simulationId").asString()).isNotEqualTo(simId);
            assertThat(rows(otherTenant, principal, "SIMULATION")).isPositive();
            int rowsBeforeReplay = rows(tenant, principal, "SIMULATION");
            JsonNode replay = solve("newton-" + run, newtonScenario(), 200);
            assertThat(replay.path("replayed").asBoolean()).isTrue();
            assertThat(replay.path("simulationId").asString()).isEqualTo(simId);
            assertThat(replay.path("result").path("trace").toString()).isEqualTo(newton.path("result").path("trace").toString());
            Map<String, Object> changed = newtonScenario();
            ((Map<String, Object>) ((Map<String, Object>) changed.get("model")).get("force")).put("value", 7000);
            JsonNode reused = expect("newton-" + run, changed, 409, "SIMULATION_REQUEST_ID_REUSED");
            assertThat(reused.path("error").path("message").asString()).contains("different scenario");
            assertThat(rows(tenant, principal, "SIMULATION")).as("replay and the 409 registered nothing").isEqualTo(rowsBeforeReplay);

            // ---------------------------------------------------------------- the real encoder killed mid-run
            Map<String, Object> videoScenario = animated;
            wrapper.mode("hang");
            String killBody = body("kill-encoder-" + run, videoScenario);
            CompletableFuture<HttpResponse<String>> inFlight = sendAsync(killBody);
            ProcessHandle encoder = MediaDevFaultInjector.awaitDescendant(launcher, "sleep 3600", Duration.ofSeconds(120));
            assertThat(inFlight.isDone()).isFalse();
            MediaDevFaultInjector.signal(encoder, "KILL");
            HttpResponse<String> unknown = inFlight.get(2, TimeUnit.MINUTES);
            assertThat(unknown.statusCode()).as(unknown.body()).isEqualTo(503);
            assertThat(unknown.body()).contains("SIMULATION_OUTCOME_UNKNOWN").contains("\"outcome\":\"UNKNOWN\"");
            assertThat(rowsOfKind(tenant, principal, "kill-encoder-" + run, "SIMULATION_RESULT")).as("no result was registered by the killed run").isZero();
            wrapper.mode("ok");
            JsonNode retried = post(port, tenant, token, SIMS, JSON.readTree(killBody), 201);
            assertThat(retried.path("replayed").asBoolean()).isFalse();
            assertThat(retried.path("outcome").asString()).isEqualTo("COMPLETED");
            assertThat(rows(tenant, principal, "kill-encoder-" + run)).as("plot, video and result exactly once").isEqualTo(3);
            assertThat(send(port, tenant, token, "POST", SIMS, killBody).statusCode()).isEqualTo(200);
            assertThat(rows(tenant, principal, "kill-encoder-" + run)).isEqualTo(3);

            // ---------------------------------------------------------------- the launcher killed mid-run
            wrapper.mode("hang");
            String crashBody = body("kill-launcher-" + run, videoScenario);
            CompletableFuture<HttpResponse<String>> doomed = sendAsync(crashBody);
            MediaDevFaultInjector.awaitDescendant(launcher, "sleep 3600", Duration.ofSeconds(120));
            List<ProcessHandle> orphans = MediaDevFaultInjector.descendants(launcher);
            launcher.destroyForcibly();
            for (ProcessHandle orphan : orphans) orphan.destroyForcibly();
            assertThat(launcher.waitFor(30, TimeUnit.SECONDS)).isTrue();
            try {
                doomed.get(1, TimeUnit.MINUTES);
                throw new AssertionError("the in-flight request of a killed launcher cannot complete");
            } catch (java.util.concurrent.ExecutionException expected) {
                // the connection died with the launcher
            }
            assertThat(rowsOfKind(tenant, principal, "kill-launcher-" + run, "SIMULATION_RESULT")).isZero();
            wrapper.mode("ok");
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, principal);
            JsonNode afterCrash = post(port, tenant, token, SIMS, JSON.readTree(crashBody), 201);
            assertThat(afterCrash.path("outcome").asString()).isEqualTo("COMPLETED");
            assertThat(send(port, tenant, token, "POST", SIMS, crashBody).statusCode()).isEqualTo(200);
            assertThat(rows(tenant, principal, "kill-launcher-" + run)).as("plot, video and result exactly once after the kill").isEqualTo(3);

            // ---------------------------------------------------------------- restart readback and determinism across restarts
            for (String id : springIds) {
                JsonNode reopened = get(port, tenant, token, SIMS + "/" + id, 200);
                assertThat(reopened.path("outcome").asString()).isEqualTo("COMPLETED");
                assertThat(reopened.path("replayed").asBoolean()).isTrue();
                assertThat(reopened.path("resultArtifact").path("sha256").asString())
                        .isEqualTo(sha256(artifactBytes(reopened.path("resultArtifact").path("artifactId").asString())));
            }
            JsonNode newtonAfter = get(port, tenant, token, SIMS + "/" + simId, 200);
            assertThat(newtonAfter.path("result").path("trace").toString()).isEqualTo(newton.path("result").path("trace").toString());
            for (Map.Entry<String, String> entry : abstainedIds.entrySet()) {
                JsonNode reopened = get(port, tenant, token, SIMS + "/" + entry.getValue(), 200);
                assertThat(reopened.path("outcome").asString()).isEqualTo("ABSTAINED");
                assertThat(reopened.path("result").path("reasons").get(0).path("code").asString()).isEqualTo(entry.getKey());
            }
            JsonNode replayAfterRestart = solve("newton-" + run, newtonScenario(), 200);
            assertThat(replayAfterRestart.path("simulationId").asString()).isEqualTo(simId);
            JsonNode again = solve("newton-again-" + run, newtonScenario(), 201);
            assertThat(again.path("result").path("trace").toString()).as("a new run after a restart reproduces the trace bit for bit")
                    .isEqualTo(newton.path("result").path("trace").toString());
            JsonNode springAgain = solve("spring-restart-" + run, scenario(m("type", "DAMPED_SPRING", "mass", q(mass, "kg"),
                    "springConstant", q(k, "N/m"), "damping", q(1.2, "kg/s")), m("position", q(0.1, "m"), "velocity", q(0.3, "m/s")),
                    solverPolicy(3.0, "s", 0.05, 1e-5, 10_000, "ADAPTIVE")), 201);
            assertThat(springAgain.path("result").path("trace").toString())
                    .isEqualTo(get(port, tenant, token, SIMS + "/" + springIds.get(1), 200).path("result").path("trace").toString());
            System.out.println("J14-IT-RESTART readback of " + (springIds.size() + 1 + abstainedIds.size())
                    + " stored simulations after kill+restart; replay 200; new runs reproduce traces bit for bit");
            passed = true;
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("J-14/J-15 simulation IT failure log retained at " + log);
            deleteTree(services);
            deleteTree(work);
        }
    }

    // ------------------------------------------------------------------------------------------ scenario builders

    private static Map<String, Object> q(double value, String unit) {
        Map<String, Object> q = new LinkedHashMap<>();
        q.put("value", value);
        q.put("unit", unit);
        return q;
    }

    private static Map<String, Object> m(Object... kv) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) map.put((String) kv[i], kv[i + 1]);
        return map;
    }

    private static Map<String, Object> solverPolicy(double duration, String unit, double maxStep, double minStep, int maxSteps, String mode) {
        return m("duration", q(duration, unit), "maxStep", q(maxStep, "s"), "minStep", q(minStep, "s"), "positionTolerance", q(1e-9, "m"),
                "velocityTolerance", q(1e-9, "m/s"), "maxAcceptedSteps", maxSteps, "maxIterations", 100_000, "mode", mode);
    }

    private static Map<String, Object> withImpact(Map<String, Object> solver) {
        solver.put("terminateOnGroundImpact", true);
        return solver;
    }

    private static Map<String, Object> scenario(Map<String, Object> model, Map<String, Object> initial, Map<String, Object> solver) {
        return m("model", model, "initial", initial, "solver", solver, "render", m("plot", true, "video", false));
    }

    private static Map<String, Object> spring(double mass, double k, double c) {
        return scenario(m("type", "DAMPED_SPRING", "mass", q(mass, "kg"), "springConstant", q(k, "N/m"), "damping", q(c, "kg/s")),
                m("position", q(0.1, "m"), "velocity", q(0.3, "m/s")), solverPolicy(2.0, "s", 0.05, 1e-5, 5000, "ADAPTIVE"));
    }

    private static Map<String, Object> newtonScenario() {
        return scenario(m("type", "NEWTON_CONSTANT_FORCE", "mass", q(2000, "g"), "force", q(6000, "mN")),
                m("position", q(0, "m"), "velocity", q(0, "m/s")), solverPolicy(2000, "ms", 0.5, 1e-4, 1000, "ADAPTIVE"));
    }

    private static String body(String requestId, Map<String, Object> scenario) throws Exception {
        return JSON.writeValueAsString(m("requestId", requestId, "scenario", scenario));
    }

    // ------------------------------------------------------------------------------------------ closed forms and references

    private static org.assertj.core.data.Offset<Double> within(double value) { return org.assertj.core.data.Offset.offset(value); }

    /** {x, v} of the spring with the given damping at t (closed form for every regime). */
    private static double[] spring(double mass, double k, double c, double x0, double v0, double t) {
        double w0 = Math.sqrt(k / mass), zeta = c / (2 * Math.sqrt(k * mass));
        if (zeta < 1 - 1e-12) {
            double wd = w0 * Math.sqrt(1 - zeta * zeta), a = zeta * w0, bb = (v0 + a * x0) / wd, e = Math.exp(-a * t);
            double inner = x0 * Math.cos(wd * t) + bb * Math.sin(wd * t);
            return new double[] {e * inner, e * (-a * inner + (-x0 * wd * Math.sin(wd * t) + bb * wd * Math.cos(wd * t)))};
        }
        if (zeta <= 1 + 1e-12) {
            double e = Math.exp(-w0 * t), bb = v0 + w0 * x0;
            return new double[] {e * (x0 + bb * t), e * (bb - w0 * (x0 + bb * t))};
        }
        double s = Math.sqrt(zeta * zeta - 1), r1 = -w0 * (zeta - s), r2 = -w0 * (zeta + s), a = (v0 - r2 * x0) / (r1 - r2), bb = x0 - a;
        return new double[] {a * Math.exp(r1 * t) + bb * Math.exp(r2 * t), a * r1 * Math.exp(r1 * t) + bb * r2 * Math.exp(r2 * t)};
    }

    /** Reference integrator written for this test: fixed-step classical RK4 for quadratic drag; returns {x, y, vx, vy}. */
    private static double[] referenceQuadratic(double mass, double k, double y0, double vx0, double vy0, double t, int steps) {
        double x = 0, y = y0, vx = vx0, vy = vy0, h = t / steps;
        for (int i = 0; i < steps; i++) {
            double[] a = acc(mass, k, vx, vy), b = acc(mass, k, vx + h / 2 * a[0], vy + h / 2 * a[1]);
            double[] c = acc(mass, k, vx + h / 2 * b[0], vy + h / 2 * b[1]), d = acc(mass, k, vx + h * c[0], vy + h * c[1]);
            x += h * (vx + 2 * (vx + h / 2 * a[0]) + 2 * (vx + h / 2 * b[0]) + (vx + h * c[0])) / 6;
            y += h * (vy + 2 * (vy + h / 2 * a[1]) + 2 * (vy + h / 2 * b[1]) + (vy + h * c[1])) / 6;
            vx += h * (a[0] + 2 * b[0] + 2 * c[0] + d[0]) / 6;
            vy += h * (a[1] + 2 * b[1] + 2 * c[1] + d[1]) / 6;
        }
        return new double[] {x, y, vx, vy};
    }

    private static double[] acc(double mass, double k, double vx, double vy) {
        double s = Math.hypot(vx, vy);
        return new double[] {-k * s * vx / mass, -G - k * s * vy / mass};
    }

    // ------------------------------------------------------------------------------------------ plot helpers

    private static double pixelX(JsonNode panel, double v) {
        JsonNode r = panel.path("pixelRect");
        return r.path("x0").asDouble() + (v - panel.path("xMin").asDouble()) / (panel.path("xMax").asDouble() - panel.path("xMin").asDouble())
                * (r.path("x1").asDouble() - r.path("x0").asDouble());
    }

    private static double pixelY(JsonNode panel, double v) {
        JsonNode r = panel.path("pixelRect");
        return r.path("y1").asDouble() - (v - panel.path("yMin").asDouble()) / (panel.path("yMax").asDouble() - panel.path("yMin").asDouble())
                * (r.path("y1").asDouble() - r.path("y0").asDouble());
    }

    private static boolean near(BufferedImage image, int px, int py, int rgb) {
        for (int dx = -3; dx <= 3; dx++) {
            for (int dy = -3; dy <= 3; dy++) {
                int x = px + dx, y = py + dy;
                if (x >= 0 && y >= 0 && x < image.getWidth() && y < image.getHeight() && (image.getRGB(x, y) & 0xFFFFFF) == rgb) return true;
            }
        }
        return false;
    }

    /** Lossy YUV420 decode: look for blue-dominant pixels around the expected marker centre. */
    private static boolean marker(BufferedImage image, int px, int py) {
        int blue = 0;
        for (int dx = -6; dx <= 6; dx++) {
            for (int dy = -6; dy <= 6; dy++) {
                int x = px + dx, y = py + dy;
                if (x < 0 || y < 0 || x >= image.getWidth() || y >= image.getHeight()) continue;
                int p = image.getRGB(x, y);
                int r = (p >> 16) & 0xFF, g = (p >> 8) & 0xFF, b = p & 0xFF;
                if (b > 120 && r < 90 && g < 90) blue++;
            }
        }
        return blue >= 20;
    }

    // ------------------------------------------------------------------------------------------ HTTP and database helpers

    private JsonNode solve(String requestId, Map<String, Object> scenario, int status) throws Exception {
        HttpResponse<String> response = send(port, tenant, token, "POST", SIMS, body(requestId, scenario));
        assertThat(response.statusCode()).as(response.body().length() > 2000 ? response.body().substring(0, 2000) : response.body()).isEqualTo(status);
        return JSON.readTree(response.body());
    }

    private JsonNode expect(String requestId, Map<String, Object> scenario, int status, String code) throws Exception {
        HttpResponse<String> response = send(port, tenant, token, "POST", SIMS, body(requestId, scenario));
        assertThat(response.statusCode()).as(response.body()).isEqualTo(status);
        JsonNode parsed = JSON.readTree(response.body());
        assertThat(parsed.path("error").path("code").asString()).as(response.body()).isEqualTo(code);
        return parsed;
    }

    private CompletableFuture<HttpResponse<String>> sendAsync(String body) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                return send(port, tenant, token, "POST", SIMS, body);
            } catch (Exception failure) {
                throw new IllegalStateException(failure);
            }
        });
    }

    /** The result document read back from the STORED S3 bytes (not from the HTTP view). */
    private JsonNode stored(JsonNode view) throws Exception {
        String id = view.path("resultArtifact").path("artifactId").asString();
        byte[] bytes = artifactBytes(id);
        assertThat(sha256(bytes)).isEqualTo(view.path("resultArtifact").path("sha256").asString());
        return JSON.readTree(bytes);
    }

    private byte[] artifactBytes(String artifactId) throws Exception {
        return s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, artifactId));
    }

    private static JsonNode lastRow(JsonNode doc) {
        JsonNode rows = doc.path("trace").path("rows");
        return rows.get(rows.size() - 1);
    }

    private static String exec(List<String> command) throws Exception {
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes());
        assertThat(process.waitFor(120, TimeUnit.SECONDS)).isTrue();
        assertThat(process.exitValue()).as(output).isZero();
        return output;
    }

    /** Durable artifact rows of the principal whose content type or metadata mentions {@code needle}. */
    private static int rows(String tenant, String principal, String needle) throws Exception {
        return count(tenant, principal, "(content_type=? OR metadata_json LIKE ?)", needle, "%" + needle + "%");
    }

    private static int rowsOfKind(String tenant, String principal, String requestId, String kind) throws Exception {
        return count(tenant, principal, "(metadata_json LIKE ? AND metadata_json LIKE ?)", "%" + requestId + "%", "%\"kind\":\"" + kind + "\"%");
    }

    private static int count(String tenant, String principal, String predicate, String a, String b) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=? AND " + predicate)) {
            statement.setString(1, tenant);
            statement.setString(2, principal);
            statement.setString(3, a);
            statement.setString(4, b);
            try (var row = statement.executeQuery()) {
                row.next();
                return row.getInt(1);
            }
        }
    }
}
