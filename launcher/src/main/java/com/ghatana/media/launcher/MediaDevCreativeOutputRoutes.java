package com.ghatana.media.launcher;

import com.ghatana.media.production.simulation.PhysicalSimulation;
import com.ghatana.media.production.simulation.SimulationSemanticValidator;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.sun.net.httpserver.HttpExchange;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY creative-output routes (outside the canonical manifest/OpenAPI):
 * POST /dev/v1/creative-outputs/audio-repairs, POST /dev/v1/creative-outputs/simulations and
 * GET /dev/v1/creative-outputs/{outputId}. Every response is labelled DEV_ONLY.
 */
final class MediaDevCreativeOutputRoutes {
    static final String AUDIO_REPAIRS = "/dev/v1/creative-outputs/audio-repairs";
    static final String SIMULATIONS = "/dev/v1/creative-outputs/simulations";
    private static final Pattern OUTPUT = Pattern.compile("^/dev/v1/creative-outputs/([^/]+)$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();

    /** Response writers owned by {@link MediaHttpHandler}, so envelopes and headers stay identical. */
    interface Responder {
        void json(HttpExchange exchange, int status, Object body) throws IOException;
        void error(HttpExchange exchange, int status, String code, String message, Map<String, ?> details)
                throws IOException;
    }

    private final MediaDevCreativeOutputRuntime outputs;
    private final MediaRuntime runtime;

    MediaDevCreativeOutputRoutes(MediaDevCreativeOutputRuntime outputs, MediaRuntime runtime) {
        this.outputs = outputs;
        this.runtime = runtime;
    }

    static boolean handles(String path) {
        return path.startsWith("/dev/v1/creative-outputs/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                int maxBody, Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact source artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevCreativeOutputRuntime.CreativeUnsupportedException failure) {
            out.error(exchange, 422, failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevCreativeOutputRuntime.CreativeRequestReusedException failure) {
            out.error(exchange, 409, "CREATIVE_REQUEST_ID_REUSED",
                    "requestId was already used with a different creative-output request", Map.of());
        } catch (MediaDevCreativeOutputRuntime.CreativeRegistrationFailedException failure) {
            out.error(exchange, 502, "CREATIVE_OUTPUT_REGISTRATION_FAILED",
                    "Output was not registered; retry with the same requestId to resume", Map.of());
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, Responder out) throws IOException {
        if (AUDIO_REPAIRS.equals(path) || SIMULATIONS.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            boolean audio = AUDIO_REPAIRS.equals(path);
            if ((audio && !MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read"))
                    || !MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create")) {
                runtime.recordDeniedRequest();
                out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                        "DEV_ONLY artifact create" + (audio ? " and read" : "")
                                + " permissions are required for this creative output", Map.of());
                return;
            }
            Map<String, Object> body = body(exchange, maxBody);
            var result = audio ? outputs.repairAudio(tenantId, principalId, audioRequest(body))
                    : outputs.simulate(tenantId, principalId, parseSimulation(body));
            out.json(exchange, result.replayed() ? 200 : 201, view(result));
            return;
        }
        Matcher single = OUTPUT.matcher(path);
        if (single.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")) {
                runtime.recordDeniedRequest();
                out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                        "DEV_ONLY artifact read permission is required", Map.of());
                return;
            }
            var found = outputs.reopen(tenantId, principalId, pathSegment(single.group(1)));
            if (found.isEmpty()) {
                out.error(exchange, 404, "CREATIVE_OUTPUT_NOT_FOUND",
                        "Creative output is not available in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, view(found.get()));
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Creative output route not found", Map.of());
    }

    // ---- views ----

    private static Map<String, Object> view(MediaDevCreativeOutputRuntime.CreativeResult result) {
        MediaArtifact artifact = result.artifact();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevCreativeOutputRuntime.SCHEMA);
        view.put("outputId", artifact.artifactId());
        view.put("artifact", Map.of(
                "artifactId", artifact.artifactId(),
                "artifactVersionId", artifact.version().value(),
                "contentType", artifact.contentType(),
                "sizeBytes", artifact.sizeBytes(),
                "sha256", artifact.sha256(),
                "artifactPath", "/api/v1/artifacts/" + artifact.artifactId()));
        view.put("lineage", result.lineage());
        view.put("replayed", result.replayed());
        view.put("scope", "DEV_ONLY");
        view.put("note", "DEV_ONLY engine output; not a production, quality, measurement or approval claim");
        return view;
    }

    // ---- request parsing ----

    private static MediaDevCreativeOutputRuntime.AudioRepairRequest audioRequest(Map<String, Object> body) {
        requireKeys(body, Set.of("requestId", "source", "profile"), Set.of(), "audio repair request");
        Map<String, Object> source = object(body.get("source"), "source");
        requireKeys(source, Set.of("artifactId", "artifactVersionId"), Set.of(), "source");
        Map<String, Object> profile = object(body.get("profile"), "profile");
        requireKeys(profile, Set.of("threshold", "maxRunFrames"), Set.of(), "profile");
        return new MediaDevCreativeOutputRuntime.AudioRepairRequest(string(body.get("requestId"), "requestId"),
                string(source.get("artifactId"), "source.artifactId"),
                string(source.get("artifactVersionId"), "source.artifactVersionId"),
                decimal(profile.get("threshold"), "profile.threshold"),
                (int) integer(profile.get("maxRunFrames"), "profile.maxRunFrames"));
    }

    /** Engine-level input rejection while building the scenario (e.g. unit/dimension mismatch) is a typed 422. */
    private static MediaDevCreativeOutputRuntime.SimulationRequest parseSimulation(Map<String, Object> body) {
        try {
            return simulationRequest(body);
        } catch (PhysicalSimulation.InvalidSimulationInputException invalid) {
            throw new MediaDevCreativeOutputRuntime.CreativeUnsupportedException(
                    "SIMULATION_INPUT_INVALID", invalid.getMessage());
        }
    }

    private static MediaDevCreativeOutputRuntime.SimulationRequest simulationRequest(Map<String, Object> body) {
        requireKeys(body, Set.of("requestId", "scenario"), Set.of(), "simulation request");
        Map<String, Object> scenario = object(body.get("scenario"), "scenario");
        requireKeys(scenario, Set.of("model", "initialState", "solverPolicy", "expectedDuration", "invariants"),
                Set.of(), "scenario");
        Map<String, Object> model = object(scenario.get("model"), "scenario.model");
        PhysicalSimulation.Model parsedModel;
        String type = string(model.get("type"), "scenario.model.type");
        if ("CONSTANT_FORCE".equals(type)) {
            requireKeys(model, Set.of("type", "mass", "force"), Set.of(), "scenario.model");
            parsedModel = new PhysicalSimulation.ConstantForce(measurement(model.get("mass"), "mass"),
                    measurement(model.get("force"), "force"));
        } else if ("HARMONIC_SPRING".equals(type)) {
            requireKeys(model, Set.of("type", "mass", "springConstant", "equilibriumPosition"), Set.of(),
                    "scenario.model");
            parsedModel = new PhysicalSimulation.HarmonicSpring(measurement(model.get("mass"), "mass"),
                    measurement(model.get("springConstant"), "springConstant"),
                    measurement(model.get("equilibriumPosition"), "equilibriumPosition"));
        } else {
            throw new IllegalArgumentException("scenario.model.type must be CONSTANT_FORCE or HARMONIC_SPRING");
        }
        Map<String, Object> initial = object(scenario.get("initialState"), "scenario.initialState");
        requireKeys(initial, Set.of("position", "velocity"), Set.of(), "scenario.initialState");
        Map<String, Object> policy = object(scenario.get("solverPolicy"), "scenario.solverPolicy");
        requireKeys(policy, Set.of("duration", "maxStep", "minStep", "absolutePositionTolerance",
                "absoluteVelocityTolerance", "maxAcceptedSteps", "maxIterations"), Set.of(), "scenario.solverPolicy");
        List<?> rawInvariants = list(scenario.get("invariants"), "scenario.invariants");
        if (rawInvariants.size() > 16) throw new IllegalArgumentException("scenario.invariants exceeds 16 entries");
        List<SimulationSemanticValidator.DeclaredInvariant> invariants = new ArrayList<>();
        for (Object raw : rawInvariants) {
            Map<String, Object> invariant = object(raw, "invariant");
            requireKeys(invariant, Set.of("id", "observable", "expected", "absoluteTolerance"), Set.of(), "invariant");
            invariants.add(new SimulationSemanticValidator.DeclaredInvariant(string(invariant.get("id"), "invariant.id"),
                    enumValue(SimulationSemanticValidator.Observable.class, invariant.get("observable"), "observable"),
                    quantity(invariant.get("expected"), "invariant.expected"),
                    quantity(invariant.get("absoluteTolerance"), "invariant.absoluteTolerance")));
        }
        var parsedInitial = new PhysicalSimulation.InitialState(measurement(initial.get("position"), "position"),
                measurement(initial.get("velocity"), "velocity"));
        var parsedPolicy = new PhysicalSimulation.SolverPolicy(quantity(policy.get("duration"), "duration"),
                quantity(policy.get("maxStep"), "maxStep"), quantity(policy.get("minStep"), "minStep"),
                quantity(policy.get("absolutePositionTolerance"), "absolutePositionTolerance"),
                quantity(policy.get("absoluteVelocityTolerance"), "absoluteVelocityTolerance"),
                (int) integer(policy.get("maxAcceptedSteps"), "maxAcceptedSteps"),
                (int) integer(policy.get("maxIterations"), "maxIterations"));
        Map<String, String> digests = Map.of(
                "model", MediaDevProjectRenderRuntime.sha256Hex(MediaDevCreativeOutputRuntime.canonical(model)),
                "initialState", MediaDevProjectRenderRuntime.sha256Hex(MediaDevCreativeOutputRuntime.canonical(initial)),
                "solverPolicy", MediaDevProjectRenderRuntime.sha256Hex(MediaDevCreativeOutputRuntime.canonical(policy)));
        return new MediaDevCreativeOutputRuntime.SimulationRequest(string(body.get("requestId"), "requestId"),
                parsedModel, parsedInitial, parsedPolicy, quantity(scenario.get("expectedDuration"), "expectedDuration"),
                invariants, scenario, digests);
    }

    private static PhysicalSimulation.Measurement measurement(Object raw, String field) {
        Map<String, Object> value = object(raw, field);
        requireKeys(value, Set.of("value", "standardUncertainty"), Set.of(), field);
        return new PhysicalSimulation.Measurement(quantity(value.get("value"), field + ".value"),
                quantity(value.get("standardUncertainty"), field + ".standardUncertainty"));
    }

    private static PhysicalSimulation.Quantity quantity(Object raw, String field) {
        Map<String, Object> value = object(raw, field);
        requireKeys(value, Set.of("value", "unit"), Set.of(), field);
        return new PhysicalSimulation.Quantity(decimal(value.get("value"), field + ".value"),
                enumValue(PhysicalSimulation.Unit.class, value.get("unit"), field + ".unit"));
    }

    private static <E extends Enum<E>> E enumValue(Class<E> type, Object raw, String field) {
        try {
            return Enum.valueOf(type, string(raw, field));
        } catch (IllegalArgumentException unknown) {
            throw new IllegalArgumentException(field + " is not a supported value");
        }
    }

    private static Map<String, Object> body(HttpExchange exchange, int maxBody) throws IOException {
        Map<String, Object> body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                new TypeReference<Map<String, Object>>() { });
        if (body == null) throw new IllegalArgumentException("request body is required");
        return body;
    }

    private static void requireKeys(Map<String, Object> value, Set<String> required, Set<String> optional,
                                    String field) {
        if (!value.keySet().containsAll(required)
                || !java.util.stream.Stream.concat(required.stream(), optional.stream())
                        .collect(java.util.stream.Collectors.toSet()).containsAll(value.keySet())) {
            throw new IllegalArgumentException(field + " fields do not match its declared shape");
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value, String field) {
        if (!(value instanceof Map<?, ?> map)) throw new IllegalArgumentException(field + " must be an object");
        return (Map<String, Object>) map;
    }

    private static List<?> list(Object value, String field) {
        if (!(value instanceof List<?> list)) throw new IllegalArgumentException(field + " must be an array");
        return list;
    }

    private static String string(Object value, String field) {
        if (!(value instanceof String text)) throw new IllegalArgumentException(field + " must be a string");
        return text;
    }

    private static long integer(Object value, String field) {
        if (!(value instanceof Integer || value instanceof Long || value instanceof Short)) {
            throw new IllegalArgumentException(field + " must be an integer");
        }
        return ((Number) value).longValue();
    }

    private static double decimal(Object value, String field) {
        if (!(value instanceof Number number) || value instanceof Boolean) {
            throw new IllegalArgumentException(field + " must be a number");
        }
        double parsed = new java.math.BigDecimal(number.toString()).doubleValue();
        if (!Double.isFinite(parsed)) throw new IllegalArgumentException(field + " must be finite");
        return parsed;
    }

    private static void notAllowed(HttpExchange exchange, String allow, Responder out) throws IOException {
        exchange.getResponseHeaders().set("Allow", allow);
        out.error(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed", Map.of());
    }

    private static String pathSegment(String raw) {
        String decoded = URLDecoder.decode(raw.replace("+", "%2B"), StandardCharsets.UTF_8);
        if (decoded.indexOf('/') >= 0 || decoded.indexOf('\\') >= 0) {
            throw new IllegalArgumentException("Path identifier must not contain a separator");
        }
        return decoded;
    }
}
