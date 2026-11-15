package com.ghatana.media.launcher;

import com.ghatana.media.production.simulation.scenario.ScenarioException;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.sun.net.httpserver.HttpExchange;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY scientific simulation routes (outside the canonical manifest/OpenAPI): {@code GET /dev/v1/simulations/status},
 * {@code POST /dev/v1/simulations} and {@code GET /dev/v1/simulations/{simulationId}} (the id is the result artifact id).
 * Permissions are {@code media:project:dev:write|read} plus {@code media:artifact:read} (and {@code media:artifact:create}
 * for the POST). The acting principal is the authenticated caller. The plot and MP4 are read back through the existing
 * exact-version {@code GET /dev/v1/artifacts/{id}/content} route.
 *
 * <p>A refused scenario is {@code 422} with {@code details.path}: {@code SIMULATION_UNIT_MISMATCH},
 * {@code SIMULATION_NON_FINITE_INPUT}, {@code SIMULATION_BUDGET_EXCEEDED} or {@code SIMULATION_SCENARIO_INVALID}. A solved
 * scenario is {@code 201} (replay {@code 200}) with {@code outcome} {@code COMPLETED} or {@code ABSTAINED}; an abstained
 * pass carries typed reasons and never a value.</p>
 */
final class MediaDevSimulationRoutes {
    static final String STATUS = "/dev/v1/simulations/status";
    static final String SIMULATIONS = "/dev/v1/simulations";
    private static final Pattern ONE = Pattern.compile("^/dev/v1/simulations/([^/]+)$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();
    private static final String NOTE = "DEV_ONLY simulated model output from a deterministic solver; never a measurement, "
            + "no rights, approval, quality or production claim";
    private static final Logger log = LoggerFactory.getLogger(MediaDevSimulationRoutes.class);

    private final MediaDevSimulationRuntime simulation;
    private final MediaRuntime runtime;

    MediaDevSimulationRoutes(MediaDevSimulationRuntime simulation, MediaRuntime runtime) {
        this.simulation = simulation;
        this.runtime = runtime;
    }

    static boolean handles(String path) {
        return path.equals(STATUS) || path.equals(SIMULATIONS) || path.startsWith(SIMULATIONS + "/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId, int maxBody,
                MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (ScenarioException refused) {
            String code = switch (refused.kind()) {
                case UNIT_MISMATCH -> "SIMULATION_UNIT_MISMATCH";
                case NON_FINITE -> "SIMULATION_NON_FINITE_INPUT";
                case BUDGET -> "SIMULATION_BUDGET_EXCEEDED";
                case INVALID -> "SIMULATION_SCENARIO_INVALID";
            };
            out.error(exchange, 422, code, refused.getMessage(), refused.details());
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY simulation capacity is exhausted; retry the same requestId after the Retry-After delay",
                    Map.of("scope", failure.scope()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            out.error(exchange, 404, "SIMULATION_NOT_FOUND", "The simulation output is not available to this DEV_ONLY principal",
                    Map.of());
        } catch (MediaDevSimulationRuntime.SimulationRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevSimulationRuntime.SimulationOutcomeUnknownException failure) {
            out.error(exchange, 503, "SIMULATION_OUTCOME_UNKNOWN",
                    "The video process did not finish; its outcome is UNKNOWN and nothing was registered. Retry the same requestId",
                    Map.of("outcome", "UNKNOWN"));
        } catch (MediaDevRequestLedger.LedgerRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevSimulationRuntime.SimulationRequestReusedException failure) {
            out.error(exchange, 409, "SIMULATION_REQUEST_ID_REUSED",
                    "requestId was already used with a different scenario", Map.of());
        } catch (MediaDevSimulationRuntime.SimulationRegistrationFailedException failure) {
            out.error(exchange, 502, "SIMULATION_OUTPUT_REGISTRATION_FAILED",
                    "The output was not registered; retry with the same requestId to resume", Map.of());
        } catch (IllegalArgumentException | IllegalStateException | SecurityException handled) {
            throw handled; // mapped to 400/409/403 by the host handler
        } catch (RuntimeException unexpected) {
            log.error("DEV simulation request failed unexpectedly", unexpected);
            throw unexpected;
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (STATUS.equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, simulation.status());
            return;
        }
        if (SIMULATIONS.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                    || !MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create")) {
                runtime.recordDeniedRequest();
                out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                        "DEV_ONLY artifact read and create permissions are required for simulations", Map.of());
                return;
            }
            Map<String, Object> body;
            try {
                body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false), new TypeReference<Map<String, Object>>() { });
            } catch (tools.jackson.core.JacksonException malformed) {
                throw new ScenarioException(ScenarioException.Kind.INVALID, "$", "the request body is not a valid JSON object");
            }
            if (body == null) throw new ScenarioException(ScenarioException.Kind.INVALID, "$", "the request body is required");
            for (String key : new String[] {"requestId", "scenario"}) {
                if (!body.containsKey(key)) throw new ScenarioException(ScenarioException.Kind.INVALID, "$." + key, "is required");
            }
            for (String key : body.keySet()) {
                if (!key.equals("requestId") && !key.equals("scenario")) {
                    throw new ScenarioException(ScenarioException.Kind.INVALID, "$." + key, "is not a known field");
                }
            }
            if (!(body.get("requestId") instanceof String requestId)) {
                throw new ScenarioException(ScenarioException.Kind.INVALID, "$.requestId", "requestId must be a string");
            }
            MediaDevSimulationRuntime.Run run = simulation.run(tenantId, principalId,
                    new MediaDevSimulationRuntime.RunRequest(requestId, body.get("scenario")));
            out.json(exchange, run.replayed() ? 200 : 201, view(run));
            return;
        }
        Matcher one = ONE.matcher(path);
        if (one.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")) {
                runtime.recordDeniedRequest();
                out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED", "DEV_ONLY artifact read permission is required", Map.of());
                return;
            }
            var found = simulation.reopen(tenantId, principalId, pathSegment(one.group(1)));
            if (found.isEmpty()) {
                out.error(exchange, 404, "SIMULATION_NOT_FOUND",
                        "Simulation is not available in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, view(found.get()));
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Simulation route not found", Map.of());
    }

    private static Map<String, Object> view(MediaDevSimulationRuntime.Run run) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevSimulationRuntime.SCHEMA);
        view.put("scope", "DEV_ONLY");
        view.put("simulationId", run.result().artifactId());
        view.put("outcome", run.outcome());
        view.put("result", run.document());
        view.put("resultArtifact", artifactView(run.result()));
        if (run.plot() != null) view.put("plotArtifact", artifactView(run.plot()));
        if (run.video() != null) view.put("videoArtifact", artifactView(run.video()));
        view.put("lineage", run.lineage());
        view.put("replayed", run.replayed());
        view.put("note", NOTE);
        return view;
    }

    private static Map<String, Object> artifactView(MediaArtifact artifact) {
        return Map.of(
                "artifactId", artifact.artifactId(),
                "artifactVersionId", artifact.version().value(),
                "contentType", artifact.contentType(),
                "sizeBytes", artifact.sizeBytes(),
                "sha256", artifact.sha256(),
                "artifactPath", "/api/v1/artifacts/" + artifact.artifactId());
    }

    private static void notAllowed(HttpExchange exchange, String allow, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
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
