package com.ghatana.media.launcher;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.production.simulation.scenario.Scenario;
import com.ghatana.media.production.simulation.scenario.ScenarioException;
import com.ghatana.media.production.simulation.scenario.ScenarioSolver;
import com.ghatana.media.production.simulation.scenario.ScenarioSolver.Abstained;
import com.ghatana.media.production.simulation.scenario.ScenarioSolver.Completed;
import com.ghatana.media.production.simulation.scenario.ScenarioSolver.Reason;
import com.ghatana.media.production.simulation.scenario.ScenarioSolver.Sample;
import com.ghatana.media.production.simulation.scenario.ScenarioSolver.Verification;
import com.ghatana.media.production.simulation.scenario.ScenarioUnits;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.stream.Stream;

/**
 * DEV_ONLY scientific simulation (J-14 {@code media.dev.outcome-scientific-simulation} and J-15
 * {@code media.dev.outcome-validated-simulation-pass}). A typed, unit-checked scenario (Newton constant force, damped
 * spring, projectile with no, linear or quadratic drag) is solved by the real {@link ScenarioSolver} (RK4 with step
 * doubling), assessed for trust, and the outcome is persisted as immutable artifacts:
 *
 * <ul>
 *   <li>a result document ({@value #RESULT_SCHEMA}) carrying either the full unit-labelled trace, the verification
 *       (step counters, error ratio, energy law, domain, declared constraints) and a plot description, or the typed
 *       ABSTAINED reasons and honest solver counters with no trace and no value at all;</li>
 *   <li>for a COMPLETED pass, a PNG plot, and optionally an H.264 MP4 animation of the trace through FFmpeg.</li>
 * </ul>
 *
 * <p>The durable request ledger maps a requestId to its outputs: the same scenario replays them (the solver is not run
 * again), a different scenario is 409. Everything is simulated model output; nothing here is a measurement and no
 * production eligibility is claimed.</p>
 */
final class MediaDevSimulationRuntime {
    static final String SCHEMA = "media.dev.simulation.v1";
    static final String RESULT_SCHEMA = "media.dev.simulation-result.v1";
    static final String KIND_RESULT = "SIMULATION_RESULT";
    static final String KIND_PLOT = "SIMULATION_PLOT";
    static final String KIND_VIDEO = "SIMULATION_VIDEO";
    static final String LANE = "simulation.run";
    static final String EVIDENCE_CLASS = "SIMULATED_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE";
    static final int MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
    static final int VIDEO_FRAMES = 48;
    static final int VIDEO_FPS = 24;
    static final long MAX_VIDEO_BYTES = 32L * 1024 * 1024;
    private static final Duration ENCODE_TIMEOUT = Duration.ofMinutes(3);
    private static final Duration PROBE_TIMEOUT = Duration.ofSeconds(60);
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final List<String> LINEAGE_KEYS = List.of("simulationSchema", "scope", "kind", "requestId", "scenarioSha256",
            "outcome", "solver", "inputs", "siblings", "evidenceClass", "productionEligible", "resultSha256", "claims");
    private static final String CLAIMS = "Simulated model output from a deterministic solver; never a measurement. "
            + "No rights, approval, quality or production claim.";

    static {
        System.setProperty("java.awt.headless", "true");
    }

    /** A typed refusal with an HTTP status; carries no request content. */
    static final class SimulationRefusedException extends RuntimeException {
        private final int status;
        private final String code;
        private final Map<String, Object> details;

        SimulationRefusedException(int status, String code, String message, Map<String, Object> details) {
            super(message, null, false, false);
            this.status = status;
            this.code = code;
            this.details = details;
        }

        int status() { return status; }
        String code() { return code; }
        Map<String, Object> details() { return details; }
    }

    static final class SimulationOutcomeUnknownException extends RuntimeException {
        SimulationOutcomeUnknownException() {
            super("the video encode process did not finish; the outcome is unknown", null, false, false);
        }
    }

    static final class SimulationRequestReusedException extends IllegalStateException {
        SimulationRequestReusedException() { super("simulation requestId was already used for a different scenario"); }
    }

    static final class SimulationRegistrationFailedException extends IllegalStateException {
        SimulationRegistrationFailedException(Throwable cause) {
            super("simulation output could not be registered as an immutable artifact", cause);
        }
    }

    record RunRequest(String requestId, Object scenario) {
        RunRequest {
            requestId = MediaDevDubSupport.boundedId(requestId, "requestId");
        }
    }

    /** Registered outputs of one run plus the result document read back from the stored result artifact. */
    record Run(MediaArtifact result, Map<String, Object> document, MediaArtifact plot, MediaArtifact video,
               Map<String, Object> lineage, boolean replayed) implements MediaDevRenderAdmission.ReplayAware {
        @Override public boolean replayedResult() { return replayed; }
        String outcome() { return String.valueOf(document.get("outcome")); }
    }

    private final MediaRuntime runtime;
    private final Path ffmpeg;
    private final Path ffprobe;
    private final MediaDevProjectRenderRuntime.OutputRegistrar registrar;
    private final MediaDevRequestLedger ledger;

    MediaDevSimulationRuntime(MediaRuntime runtime, Path ffmpeg, Path ffprobe,
                              MediaDevProjectRenderRuntime.OutputRegistrar registrar, MediaDevRequestLedger ledger) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        if ((ffmpeg == null) != (ffprobe == null)) throw new IllegalArgumentException("ffmpeg and ffprobe go together");
        if (ffmpeg != null && (!ffmpeg.isAbsolute() || !ffprobe.isAbsolute())) {
            throw new IllegalArgumentException("ffmpeg and ffprobe must be absolute paths");
        }
        this.ffmpeg = ffmpeg;
        this.ffprobe = ffprobe;
        this.registrar = Objects.requireNonNull(registrar, "registrar");
        this.ledger = Objects.requireNonNull(ledger, "ledger");
    }

    /** The video animation is available only when an absolute FFmpeg and FFprobe pair is configured. */
    static MediaDevSimulationRuntime compose(MediaRuntime runtime, Map<String, String> environment, MediaDevRequestLedger ledger) {
        String ff = environment.get(MediaDevProjectRenderRuntime.FFMPEG_ENV);
        String fp = environment.get(MediaDevProjectRenderRuntime.FFPROBE_ENV);
        boolean tools = ff != null && !ff.isBlank() && fp != null && !fp.isBlank();
        return new MediaDevSimulationRuntime(runtime, tools ? Path.of(ff) : null, tools ? Path.of(fp) : null,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), ledger);
    }

    Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", "DEV_ONLY");
        out.put("ready", true);
        out.put("scenarioSchema", Scenario.SCHEMA);
        out.put("resultSchema", RESULT_SCHEMA);
        out.put("models", List.of("NEWTON_CONSTANT_FORCE", "DAMPED_SPRING", "PROJECTILE"));
        out.put("dragLaws", List.of("NONE", "LINEAR", "QUADRATIC"));
        out.put("solver", Map.of("id", ScenarioSolver.SOLVER_ID, "version", ScenarioSolver.SOLVER_VERSION,
                "modes", List.of("ADAPTIVE", "FIXED_STEP"), "order", 4));
        out.put("observables", List.of("POSITION_X", "POSITION_Y", "VELOCITY_X", "VELOCITY_Y", "SPEED", "TOTAL_ENERGY", "TIME"));
        out.put("units", ScenarioUnits.catalog());
        Map<String, Object> limits = new LinkedHashMap<>();
        limits.put("maxAcceptedSteps", Scenario.MAX_ACCEPTED_STEPS);
        limits.put("maxIterations", Scenario.MAX_ITERATIONS);
        limits.put("maxDurationSeconds", Scenario.MAX_DURATION_SECONDS);
        limits.put("maxDurationOverMinStep", Scenario.MAX_DURATION_OVER_MIN_STEP);
        limits.put("maxConstraints", Scenario.MAX_CONSTRAINTS);
        limits.put("maxMagnitudeSi", Scenario.MAX_MAGNITUDE_SI);
        out.put("limits", limits);
        out.put("domain", Map.of("nonRelativisticLimitMetersPerSecond", ScenarioSolver.NON_RELATIVISTIC_LIMIT,
                "dragSubsonicLimitMetersPerSecond", ScenarioSolver.SPEED_OF_SOUND, "divergenceLimitSi", ScenarioSolver.DIVERGENCE_LIMIT));
        out.put("outcomes", List.of("COMPLETED", "ABSTAINED"));
        out.put("video", Map.of("available", ffmpeg != null, "frames", VIDEO_FRAMES, "framesPerSecond", VIDEO_FPS,
                "codec", "libx264", "container", "mp4", "pixelFormat", "yuv420p"));
        out.put("plot", Map.of("width", MediaDevSimulationPlot.WIDTH, "height", MediaDevSimulationPlot.HEIGHT, "text", "NOT_SUPPORTED"));
        out.put("evidenceClass", EVIDENCE_CLASS);
        out.put("productionEligible", false);
        return out;
    }

    // ------------------------------------------------------------------ read

    Optional<Run> reopen(String tenantId, String principalId, String resultArtifactId) {
        Optional<MediaArtifact> result = runtime.artifact(tenantId, principalId, resultArtifactId)
                .filter(artifact -> SCHEMA.equals(artifact.metadata().get("simulationSchema"))
                        && KIND_RESULT.equals(artifact.metadata().get("kind")));
        if (result.isEmpty()) return Optional.empty();
        MediaArtifact plot = null;
        MediaArtifact video = null;
        if (result.get().metadata().get("siblings") instanceof Map<?, ?> siblings) {
            if (siblings.get("plot") instanceof Map<?, ?> ref) {
                plot = sibling(tenantId, principalId, ref, KIND_PLOT);
                if (plot == null) return Optional.empty();
            }
            if (siblings.get("video") instanceof Map<?, ?> ref) {
                video = sibling(tenantId, principalId, ref, KIND_VIDEO);
                if (video == null) return Optional.empty();
            }
        }
        return Optional.of(new Run(result.get(), readDocument(tenantId, principalId, result.get()), plot, video,
                lineageOf(result.get()), true));
    }

    private MediaArtifact sibling(String tenantId, String principalId, Map<?, ?> ref, String kind) {
        if (!(ref.get("artifactId") instanceof String id) || !(ref.get("artifactVersionId") instanceof String version)) return null;
        return runtime.artifact(tenantId, principalId, id)
                .filter(artifact -> artifact.version().value().equals(version) && kind.equals(artifact.metadata().get("kind")))
                .orElse(null);
    }

    private Map<String, Object> readDocument(String tenantId, String principalId, MediaArtifact result) {
        if (result.sizeBytes() > MAX_DOCUMENT_BYTES) {
            throw new SimulationRefusedException(422, "SIMULATION_RESULT_TOO_LARGE", "the result exceeds the byte ceiling", Map.of());
        }
        ByteArrayOutputStream content = new ByteArrayOutputStream((int) Math.max(1, result.sizeBytes()));
        try {
            runtime.copyArtifactContent(tenantId, principalId, result.artifactId(), result.version(), content, MAX_DOCUMENT_BYTES)
                    .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
            return JSON.readValue(content.toByteArray(), new TypeReference<LinkedHashMap<String, Object>>() { });
        } catch (IOException | RuntimeException unreadable) {
            if (unreadable instanceof MediaDevProjectRenderRuntime.SourceVersionUnavailableException missing) throw missing;
            throw new SimulationRefusedException(422, "SIMULATION_RESULT_INVALID",
                    "the stored result is not a readable JSON document", Map.of());
        }
    }

    private static Map<String, Object> lineageOf(MediaArtifact artifact) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        for (String key : LINEAGE_KEYS) {
            if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
        }
        return lineage;
    }

    // ------------------------------------------------------------------ run

    Run run(String tenantId, String principalId, RunRequest request) {
        Objects.requireNonNull(request, "request");
        // Parse and budget first: a refused scenario costs no permit, no solver step and no ledger row.
        Scenario scenario = Scenario.parse(request.scenario());
        if (scenario.video() && ffmpeg == null) {
            throw new SimulationRefusedException(503, "SIMULATION_VIDEO_UNAVAILABLE",
                    "an MP4 animation needs MEDIA_DEV_RENDER_FFMPEG and MEDIA_DEV_RENDER_FFPROBE", Map.of("path", "$.scenario.render.video"));
        }
        String scenarioJson = canonicalJson(scenario.canonical());
        String scenarioSha = MediaDevProjectRenderRuntime.sha256Hex(scenarioJson);
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.simulation.run.v1", scenarioSha);
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "simulation_run", tenantId,
                () -> ledger.run(tenantId, principalId, LANE, request.requestId(), fingerprint,
                        outputs -> replay(tenantId, principalId, outputs),
                        () -> produce(tenantId, principalId, request, scenario, scenarioSha),
                        run -> outputsOf(run),
                        SimulationRequestReusedException::new));
    }

    private static List<OutputRef> outputsOf(Run run) {
        List<OutputRef> refs = new ArrayList<>();
        refs.add(new OutputRef("result", run.result().artifactId(), run.result().version().value()));
        if (run.plot() != null) refs.add(new OutputRef("plot", run.plot().artifactId(), run.plot().version().value()));
        if (run.video() != null) refs.add(new OutputRef("video", run.video().artifactId(), run.video().version().value()));
        return refs;
    }

    private Run replay(String tenantId, String principalId, List<OutputRef> outputs) {
        OutputRef ref = outputs.stream().filter(candidate -> candidate.role().equals("result")).findFirst()
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE));
        return reopen(tenantId, principalId, ref.artifactId())
                .filter(found -> found.result().version().value().equals(ref.versionId()))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE));
    }

    private Run produce(String tenantId, String principalId, RunRequest request, Scenario scenario, String scenarioSha) {
        ScenarioSolver.Outcome outcome = ScenarioSolver.solve(scenario);
        Map<String, Object> inputs = ordered("role", "SCENARIO", "sha256", scenarioSha, "schema", Scenario.SCHEMA);
        Map<String, Object> solverInfo = new LinkedHashMap<>();
        solverInfo.put("id", ScenarioSolver.SOLVER_ID);
        solverInfo.put("version", ScenarioSolver.SOLVER_VERSION);
        solverInfo.put("order", 4);
        solverInfo.put("mode", scenario.policy().mode().name());

        if (outcome instanceof Abstained abstained) {
            Map<String, Object> document = baseDocument(request, scenario, scenarioSha, solverInfo, "ABSTAINED");
            List<Map<String, Object>> reasons = new ArrayList<>();
            for (Reason reason : abstained.reasons()) {
                Map<String, Object> view = new LinkedHashMap<>();
                view.put("code", reason.code());
                view.put("path", reason.path());
                view.put("message", reason.message());
                view.put("details", new java.util.TreeMap<>(reason.details()));
                reasons.add(view);
            }
            document.put("reasons", reasons);
            Map<String, Object> counters = new LinkedHashMap<>();
            counters.put("acceptedSteps", abstained.diagnostics().acceptedSteps());
            counters.put("iterations", abstained.diagnostics().iterations());
            counters.put("reachedTimeSeconds", abstained.diagnostics().reachedTimeSeconds());
            document.put("diagnostics", counters);
            document.put("withheld", "no trace and no observable value is returned for an abstained pass");
            MediaArtifact result = registerOne(tenantId, principalId, "result", request.requestId(), MediaDevDubSupport.json(document),
                    "application/json", "json", "simulation-abstained-" + MediaDevDubSupport.safeName(request.requestId()),
                    lineage(KIND_RESULT, request, scenarioSha, "ABSTAINED", solverInfo, inputs, null, null));
            return new Run(result, document, null, null, lineageOf(result), false);
        }

        Completed completed = (Completed) outcome;
        List<Sample> samples = completed.samples();
        Verification verification = completed.verification();
        MediaArtifact plotArtifact = null;
        MediaArtifact videoArtifact = null;
        Map<String, Object> plotView = null;
        if (scenario.plot()) {
            MediaDevSimulationPlot plot = new MediaDevSimulationPlot(scenario, samples);
            double end = samples.get(samples.size() - 1).t();
            byte[] png = MediaDevSimulationPlot.png(plot.render(end, false), "media.dev.simulation request=" + request.requestId()
                    + " scenario=" + scenarioSha);
            plotArtifact = registerOne(tenantId, principalId, "plot", request.requestId(), png, "image/png", "png",
                    "simulation-plot-" + MediaDevDubSupport.safeName(request.requestId()),
                    lineage(KIND_PLOT, request, scenarioSha, "COMPLETED", solverInfo, inputs, null, null));
            plotView = new LinkedHashMap<>();
            plotView.put("width", MediaDevSimulationPlot.WIDTH);
            plotView.put("height", MediaDevSimulationPlot.HEIGHT);
            plotView.put("panels", plot.panels());
            plotView.put("colors", ordered("trajectory", String.format(Locale.ROOT, "#%06X", MediaDevSimulationPlot.TRAJECTORY_RGB),
                    "energy", String.format(Locale.ROOT, "#%06X", MediaDevSimulationPlot.ENERGY_RGB),
                    "background", "#FFFFFF"));
            plotView.put("mapping", "px = x0 + (v - xMin)/(xMax - xMin)*(x1 - x0); py = y1 - (v - yMin)/(yMax - yMin)*(y1 - y0)");
            plotView.put("plot", MediaDevDubSupport.ref(plotArtifact));
            if (scenario.video()) {
                videoArtifact = encodeVideo(tenantId, principalId, request, scenarioSha, solverInfo, inputs, plot, end);
                plotView.put("video", MediaDevDubSupport.ref(videoArtifact));
            }
        }

        Map<String, Object> document = baseDocument(request, scenario, scenarioSha, solverInfo, "COMPLETED");
        document.put("trace", trace(samples));
        document.put("observables", observables(samples.get(samples.size() - 1)));
        document.put("verification", verificationView(verification));
        document.put("uncertainty", ordered("status", "NOT_ASSESSED",
                "note", "measurement uncertainty is not propagated by this lane; no uncertainty value is stated"));
        if (verification.impact() != null) {
            document.put("impact", ordered("timeSeconds", verification.impact().timeSeconds(),
                    "rangeMeters", verification.impact().rangeMeters(),
                    "speedMetersPerSecond", verification.impact().speedMetersPerSecond()));
        }
        if (plotView != null) document.put("plot", plotView);
        Map<String, Object> siblings = new LinkedHashMap<>();
        if (plotArtifact != null) siblings.put("plot", MediaDevDubSupport.ref(plotArtifact));
        if (videoArtifact != null) siblings.put("video", MediaDevDubSupport.ref(videoArtifact));
        MediaArtifact result = registerOne(tenantId, principalId, "result", request.requestId(), MediaDevDubSupport.json(document),
                "application/json", "json", "simulation-result-" + MediaDevDubSupport.safeName(request.requestId()),
                lineage(KIND_RESULT, request, scenarioSha, "COMPLETED", solverInfo, inputs, siblings.isEmpty() ? null : siblings, null));
        return new Run(result, document, plotArtifact, videoArtifact, lineageOf(result), false);
    }

    private static Map<String, Object> baseDocument(RunRequest request, Scenario scenario, String scenarioSha,
                                                    Map<String, Object> solverInfo, String outcome) {
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", RESULT_SCHEMA);
        document.put("scope", "DEV_ONLY");
        document.put("outcome", outcome);
        document.put("requestId", request.requestId());
        document.put("scenarioSha256", scenarioSha);
        document.put("scenario", scenario.canonical());
        document.put("solver", solverInfo);
        document.put("evidenceClass", EVIDENCE_CLASS);
        document.put("productionEligible", false);
        document.put("claims", CLAIMS);
        return document;
    }

    private static Map<String, Object> trace(List<Sample> samples) {
        List<double[]> rows = new ArrayList<>(samples.size());
        for (Sample s : samples) {
            rows.add(new double[] {s.t(), s.x(), s.y(), s.vx(), s.vy(), s.ax(), s.ay(), s.speed(), s.energy()});
        }
        Map<String, Object> trace = new LinkedHashMap<>();
        trace.put("columns", List.of("timeSeconds", "positionXMeters", "positionYMeters", "velocityXMetersPerSecond",
                "velocityYMetersPerSecond", "accelerationXMetersPerSecondSquared", "accelerationYMetersPerSecondSquared",
                "speedMetersPerSecond", "totalEnergyJoules"));
        trace.put("units", "SI");
        trace.put("rows", rows);
        return trace;
    }

    private static Map<String, Object> observables(Sample last) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("timeSeconds", last.t());
        out.put("positionXMeters", last.x());
        out.put("positionYMeters", last.y());
        out.put("velocityXMetersPerSecond", last.vx());
        out.put("velocityYMetersPerSecond", last.vy());
        out.put("accelerationXMetersPerSecondSquared", last.ax());
        out.put("accelerationYMetersPerSecondSquared", last.ay());
        out.put("speedMetersPerSecond", last.speed());
        out.put("totalEnergyJoules", last.energy());
        return out;
    }

    private static Map<String, Object> verificationView(Verification v) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("acceptedSteps", v.acceptedSteps());
        out.put("iterations", v.iterations());
        out.put("maxErrorRatio", v.maxErrorRatio());
        out.put("minStepSeconds", v.minStepSeconds());
        out.put("maxStepSeconds", v.maxStepSeconds());
        out.put("termination", v.termination());
        out.put("maxSpeedMetersPerSecond", v.maxSpeed());
        Map<String, Object> energy = new LinkedHashMap<>();
        energy.put("lawClass", v.energy().lawClass());
        energy.put("initialJoules", v.energy().initialJoules());
        energy.put("finalJoules", v.energy().finalJoules());
        energy.put("maxAbsDriftJoules", v.energy().maxAbsDriftJoules());
        energy.put("maxIncreaseJoules", v.energy().maxIncreaseJoules());
        energy.put("scaleJoules", v.energy().scaleJoules());
        energy.put("relativeDrift", v.energy().relativeDrift());
        energy.put("tolerance", v.energy().tolerance());
        energy.put("ok", v.energy().ok());
        out.put("energy", energy);
        out.put("domain", ordered("ok", true, "nonRelativisticLimitMetersPerSecond", ScenarioSolver.NON_RELATIVISTIC_LIMIT));
        List<Map<String, Object>> constraints = new ArrayList<>();
        for (ScenarioSolver.ConstraintResult c : v.constraints()) {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("id", c.id());
            view.put("observable", c.observable());
            view.put("aggregate", c.aggregate());
            view.put("op", c.op());
            view.put("limitSi", c.limit());
            view.put("observedSi", c.observed());
            view.put("satisfied", c.satisfied());
            constraints.add(view);
        }
        out.put("constraints", constraints);
        out.put("trust", "every check passed: error estimate within tolerance, energy law, domain, finiteness and declared constraints");
        return out;
    }

    private static Map<String, Object> lineage(String kind, RunRequest request, String scenarioSha, String outcome,
                                               Map<String, Object> solverInfo, Map<String, Object> inputs,
                                               Map<String, Object> siblings, String resultSha) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("simulationSchema", SCHEMA);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("kind", kind);
        lineage.put("requestId", request.requestId());
        lineage.put("scenarioSha256", scenarioSha);
        lineage.put("outcome", outcome);
        lineage.put("solver", solverInfo);
        lineage.put("inputs", List.of(inputs));
        if (siblings != null) lineage.put("siblings", siblings);
        lineage.put("evidenceClass", EVIDENCE_CLASS);
        lineage.put("productionEligible", false);
        lineage.put("claims", CLAIMS);
        return lineage;
    }

    // ------------------------------------------------------------------ video

    private MediaArtifact encodeVideo(String tenantId, String principalId, RunRequest request, String scenarioSha,
                                      Map<String, Object> solverInfo, Map<String, Object> inputs, MediaDevSimulationPlot plot,
                                      double endTime) {
        Path dir = privateTempDirectory();
        try {
            for (int i = 0; i < VIDEO_FRAMES; i++) {
                double t = endTime * i / (VIDEO_FRAMES - 1);
                BufferedImage frame = plot.render(t, true);
                ImageIO.write(frame, "png", dir.resolve(String.format(Locale.ROOT, "f%03d.png", i)).toFile());
            }
            Path out = dir.resolve("out.mp4");
            List<String> command = List.of(ffmpeg.toString(), "-nostdin", "-hide_banner", "-v", "error", "-xerror",
                    "-framerate", Integer.toString(VIDEO_FPS), "-i", dir.resolve("f%03d.png").toString(),
                    "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-bf", "0", "-threads", "1",
                    "-movflags", "+faststart", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1",
                    "-metadata", "comment=media.dev.simulation request=" + request.requestId() + " scenario=" + scenarioSha,
                    "-fps_mode", "passthrough", "-an", "-y", out.toString());
            BoundedProcessRunner.Result result = BoundedProcessRunner.run(command, dir, Map.of(), ENCODE_TIMEOUT, 1024, 8192,
                    BoundedProcessRunner.CancellationToken.NEVER, out, MAX_VIDEO_BYTES);
            classify(result, "encode", "SIMULATION_ENCODE_FAILED");
            verifyVideo(out, dir);
            byte[] mp4 = Files.readAllBytes(out);
            return registerOne(tenantId, principalId, "video", request.requestId(), mp4, "video/mp4", "mp4",
                    "simulation-video-" + MediaDevDubSupport.safeName(request.requestId()),
                    lineage(KIND_VIDEO, request, scenarioSha, "COMPLETED", solverInfo, inputs, null, null));
        } catch (IOException failure) {
            throw new SimulationRefusedException(503, "SIMULATION_TOOLS_UNAVAILABLE",
                    "the video tools could not be run; nothing was registered", Map.of());
        } finally {
            deleteTree(dir);
        }
    }

    private void verifyVideo(Path file, Path dir) throws IOException {
        BoundedProcessRunner.Result probe = BoundedProcessRunner.run(List.of(ffprobe.toString(), "-v", "error", "-count_frames",
                "-select_streams", "v:0", "-show_entries",
                "stream=codec_name,pix_fmt,width,height,avg_frame_rate,nb_read_frames", "-of", "json", file.toString()), dir,
                Map.of(), PROBE_TIMEOUT, 1024 * 1024, 8192, BoundedProcessRunner.CancellationToken.NEVER, null, 0);
        classify(probe, "probe", "SIMULATION_VERIFICATION_FAILED");
        String problem = null;
        try {
            JsonNode stream = JSON.readTree(new String(probe.stdout(), StandardCharsets.UTF_8)).path("streams").path(0);
            if (!"h264".equals(stream.path("codec_name").asString())) problem = "codec";
            else if (!"yuv420p".equals(stream.path("pix_fmt").asString())) problem = "pixel format";
            else if (stream.path("width").asInt() != MediaDevSimulationPlot.WIDTH
                    || stream.path("height").asInt() != MediaDevSimulationPlot.HEIGHT) problem = "geometry";
            else if (!(VIDEO_FPS + "/1").equals(stream.path("avg_frame_rate").asString())) problem = "frame rate";
            else if (Integer.parseInt(stream.path("nb_read_frames").asString("-1")) != VIDEO_FRAMES) problem = "frame count";
        } catch (RuntimeException unreadable) {
            problem = "probe output";
        }
        if (problem != null) {
            throw new SimulationRefusedException(500, "SIMULATION_VERIFICATION_FAILED",
                    "the encoded video does not match the requested timeline (" + problem + "); nothing was registered",
                    Map.of("mismatch", problem));
        }
    }

    private static void classify(BoundedProcessRunner.Result result, String phase, String failureCode) {
        if (result.succeeded()) return;
        boolean signalled = result.end() == BoundedProcessRunner.End.EXITED && (result.exitCode() >= 128 || result.exitCode() < 0);
        if (result.end() == BoundedProcessRunner.End.TIMED_OUT || result.end() == BoundedProcessRunner.End.CANCELLED || signalled) {
            throw new SimulationOutcomeUnknownException();
        }
        throw new SimulationRefusedException(422, failureCode, "the " + phase + " step failed; nothing was registered", Map.of());
    }

    // ------------------------------------------------------------------ registration

    private MediaArtifact registerOne(String tenantId, String principalId, String role, String requestId, byte[] bytes,
                                      String contentType, String extension, String namePrefix, Map<String, Object> lineage) {
        String sha256 = MediaDevProjectRenderRuntime.sha256Hex(bytes);
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        if (!KIND_RESULT.equals(lineage.get("kind"))) metadata.put("resultSha256", sha256);
        metadata.put("purpose", "simulation-output");
        UploadRequest upload = new UploadRequest(tenantId, principalId, namePrefix + "." + extension, contentType,
                bytes.length, sha256, "INTERNAL", Duration.ofDays(30), metadata);
        String idempotencyKey = "dev-sim:" + role + ":" + MediaDevProjectRenderRuntime.sha256Hex(
                tenantId + "\u0000" + principalId + "\u0000" + requestId);
        MediaDevProjectRenderRuntime.Registered registered;
        try {
            registered = registrar.register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new SimulationRequestReusedException();
            }
            throw new SimulationRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            throw new SimulationRegistrationFailedException(failure);
        }
        MediaArtifact artifact = registered.artifact();
        if (!artifact.sha256().equals(sha256)) {
            throw new SimulationRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match produced bytes"));
        }
        return artifact;
    }

    // ------------------------------------------------------------------ helpers

    /** Insertion-ordered map: stored documents and lineage must serialize identically in every JVM ({@code Map.of} does not). */
    private static Map<String, Object> ordered(Object... keyValues) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) map.put((String) keyValues[i], keyValues[i + 1]);
        return map;
    }

    private static String canonicalJson(Object value) {
        try {
            return JSON.writeValueAsString(value);
        } catch (RuntimeException failure) {
            throw new IllegalStateException("simulation scenario could not be serialized", failure);
        }
    }

    private static Path privateTempDirectory() {
        try {
            return Files.createTempDirectory("media-dev-simulation-",
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        } catch (IOException failure) {
            throw new IllegalStateException("private working directory could not be created", failure);
        }
    }

    private static void deleteTree(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete());
        } catch (IOException ignored) {
            // best effort: the directory is private (0700) under the OS temp root
        }
    }
}
