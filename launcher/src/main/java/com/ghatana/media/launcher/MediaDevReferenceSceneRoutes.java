package com.ghatana.media.launcher;

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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY reference-conditioned scene routes (outside the canonical manifest/OpenAPI):
 * {@code GET /dev/v1/reference-scenes/status}, {@code POST|GET /dev/v1/reference-scenes/reference-sets[/{setId}]},
 * {@code POST /dev/v1/reference-scenes/runs}, {@code GET /dev/v1/reference-scenes/runs/{runId}} and
 * {@code POST /dev/v1/reference-scenes/runs/{runId}/regenerations}. Permissions are {@code media:project:dev:write|read}
 * plus {@code media:artifact:read} (and {@code media:artifact:create} for the POSTs that register outputs). The acting
 * principal is the authenticated caller; no body field names one. Scene PNGs are read back through the exact-version
 * {@code GET /dev/v1/artifacts/{id}/content} route.
 */
final class MediaDevReferenceSceneRoutes {
    static final String BASE = "/dev/v1/reference-scenes";
    static final String STATUS = BASE + "/status";
    static final String SETS = BASE + "/reference-sets";
    static final String RUNS = BASE + "/runs";
    private static final Pattern SET = Pattern.compile("^" + Pattern.quote(SETS) + "/([^/]+)$");
    private static final Pattern RUN = Pattern.compile("^" + Pattern.quote(RUNS) + "/([^/]+)$");
    private static final Pattern REGENERATION = Pattern.compile("^" + Pattern.quote(RUNS) + "/([^/]+)/regenerations$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();
    private static final String NOTE = "DEV_ONLY authored-template composition of rights-checked reference images; no "
            + "generative model was used; no quality, rights, approval or production claim";

    private static final Logger log = LoggerFactory.getLogger(MediaDevReferenceSceneRoutes.class);

    private final MediaDevReferenceSceneRuntime scenes;
    private final MediaRuntime runtime;

    MediaDevReferenceSceneRoutes(MediaDevReferenceSceneRuntime scenes, MediaRuntime runtime) {
        this.scenes = scenes;
        this.runtime = runtime;
    }

    static boolean handles(String path) {
        return path.equals(BASE) || path.startsWith(BASE + "/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId, int maxBody,
                MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY reference scene capacity is exhausted; retry the same requestId after the Retry-After delay",
                    Map.of("scope", failure.scope()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact reference artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevReferenceSceneRuntime.RefSceneRefusedException failure) {
            if (failure.status() == 403) runtime.recordDeniedRequest();
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevRequestLedger.LedgerRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevReferenceSceneRuntime.RefSceneRequestReusedException failure) {
            out.error(exchange, 409, "REFERENCE_SCENE_REQUEST_ID_REUSED",
                    "requestId was already used with a different reference scene request", Map.of());
        } catch (MediaDevReferenceSceneRuntime.RefSceneRegistrationFailedException failure) {
            out.error(exchange, 502, "REFERENCE_SCENE_OUTPUT_REGISTRATION_FAILED",
                    "The output was not registered; retry with the same requestId to resume", Map.of());
        } catch (IllegalArgumentException | IllegalStateException | SecurityException handled) {
            throw handled; // mapped to 400/409/403 by the host handler
        } catch (RuntimeException unexpected) {
            log.error("DEV reference scene request failed unexpectedly", unexpected);
            throw unexpected;
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (STATUS.equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, scenes.status());
            return;
        }
        if (SETS.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!requireReadCreate(exchange, out)) return;
            Map<String, Object> body = body(exchange, maxBody);
            requireKeys(body, Set.of("requestId", "references"), Set.of("name"), "reference set request");
            if (!(body.get("requestId") instanceof String requestId)) throw new IllegalArgumentException("requestId must be a string");
            if (body.containsKey("name") && !(body.get("name") instanceof String)) {
                throw MediaDevReferenceSceneSpec.invalid("$.name", "name must be a string");
            }
            if (!(body.get("references") instanceof List<?> list)) {
                throw MediaDevReferenceSceneSpec.invalid("$.references", "references must be a list");
            }
            List<MediaDevReferenceSceneRuntime.RefInput> references = new ArrayList<>();
            for (int i = 0; i < list.size(); i++) {
                if (!(list.get(i) instanceof Map<?, ?> item)) {
                    throw MediaDevReferenceSceneSpec.invalid("$.references[" + i + "]", "a reference must be an object");
                }
                for (Object key : item.keySet()) {
                    if (!Set.of("referenceId", "artifactId", "artifactVersionId").contains(key)) {
                        throw MediaDevReferenceSceneSpec.invalid("$.references[" + i + "]." + key, "is not a known field");
                    }
                }
                references.add(new MediaDevReferenceSceneRuntime.RefInput(text(item.get("referenceId")),
                        text(item.get("artifactId")), text(item.get("artifactVersionId"))));
            }
            MediaDevReferenceSceneRuntime.RefSet set = scenes.registerSet(tenantId, principalId,
                    new MediaDevReferenceSceneRuntime.SetRequest(requestId, (String) body.get("name"), references));
            out.json(exchange, set.replayed() ? 200 : 201, setView(set));
            return;
        }
        Matcher oneSet = SET.matcher(path);
        if (oneSet.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!requireRead(exchange, out)) return;
            var found = scenes.reopenSet(tenantId, principalId, pathSegment(oneSet.group(1)));
            if (found.isEmpty()) {
                out.error(exchange, 404, "REFERENCE_SET_NOT_FOUND",
                        "The reference set is not available in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, setView(found.get()));
            return;
        }
        if (RUNS.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!requireReadCreate(exchange, out)) return;
            Map<String, Object> body = body(exchange, maxBody);
            if (!(body.get("mode") instanceof String mode) || !(mode.equals("TEMPLATE") || mode.equals("MODEL"))) {
                throw MediaDevReferenceSceneSpec.invalid("$.mode", "mode must be TEMPLATE or MODEL");
            }
            if (mode.equals("MODEL")) {
                requireKeys(body, Set.of("requestId", "mode"), Set.of("referenceSetId", "seed", "sceneCount", "prompt"),
                        "reference scene request");
                // No admitted generative model: typed refusal, no rights lookup, no read, no artifact, no template fallback.
                throw scenes.modelUnavailable();
            }
            requireKeys(body, Set.of("requestId", "mode", "referenceSetId", "template", "seed", "sceneCount", "parameters"),
                    Set.of("continuity"), "reference scene request");
            if (!(body.get("requestId") instanceof String requestId)) throw new IllegalArgumentException("requestId must be a string");
            if (!(body.get("referenceSetId") instanceof String setId)) {
                throw MediaDevReferenceSceneSpec.invalid("$.referenceSetId", "referenceSetId must be a string");
            }
            MediaDevReferenceSceneRuntime.Run run = scenes.generate(tenantId, principalId,
                    new MediaDevReferenceSceneRuntime.RunRequest(requestId, setId, body.get("template"), body.get("seed"),
                            body.get("sceneCount"), body.get("parameters"), body.get("continuity")));
            out.json(exchange, run.replayed() ? 200 : 201, runView(run));
            return;
        }
        Matcher regeneration = REGENERATION.matcher(path);
        if (regeneration.matches()) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!requireRead(exchange, out)) return;
            out.json(exchange, 200, scenes.regenerate(tenantId, principalId, pathSegment(regeneration.group(1))));
            return;
        }
        Matcher oneRun = RUN.matcher(path);
        if (oneRun.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!requireRead(exchange, out)) return;
            var found = scenes.reopen(tenantId, principalId, pathSegment(oneRun.group(1)));
            if (found.isEmpty()) {
                out.error(exchange, 404, "REFERENCE_SCENE_RUN_NOT_FOUND",
                        "The run is not available in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, runView(found.get()));
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Reference scene route not found", Map.of());
    }

    private boolean requireRead(HttpExchange exchange, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")) return true;
        runtime.recordDeniedRequest();
        out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED", "DEV_ONLY artifact read permission is required", Map.of());
        return false;
    }

    private boolean requireReadCreate(HttpExchange exchange, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                && MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create")) return true;
        runtime.recordDeniedRequest();
        out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                "DEV_ONLY artifact read and create permissions are required for reference scenes", Map.of());
        return false;
    }

    private static Map<String, Object> body(HttpExchange exchange, int maxBody) throws IOException {
        Map<String, Object> body;
        try {
            body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                    new TypeReference<Map<String, Object>>() { });
        } catch (tools.jackson.core.JacksonException malformed) {
            throw MediaDevReferenceSceneSpec.invalid("$", "the request body is not a valid JSON object");
        }
        if (body == null) throw MediaDevReferenceSceneSpec.invalid("$", "the request body is required");
        return body;
    }

    private static String text(Object value) {
        return value instanceof String string ? string : null;
    }

    private static Map<String, Object> setView(MediaDevReferenceSceneRuntime.RefSet set) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevReferenceSceneRuntime.SET_SCHEMA);
        view.put("scope", "DEV_ONLY");
        view.put("referenceSetId", set.artifact().artifactId());
        view.put("artifact", artifactView(set.artifact()));
        view.put("document", set.document());
        view.put("lineage", MediaDevReferenceSceneRuntime.lineageOf(set.artifact()));
        view.put("replayed", set.replayed());
        view.put("note", NOTE);
        return view;
    }

    private static Map<String, Object> runView(MediaDevReferenceSceneRuntime.Run run) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevReferenceSceneRuntime.RUN_SCHEMA);
        view.put("scope", "DEV_ONLY");
        view.put("runId", run.manifest().artifactId());
        view.put("mode", "TEMPLATE");
        view.put("outcome", run.document().get("outcome"));
        List<Map<String, Object>> sceneViews = new ArrayList<>();
        for (MediaArtifact scene : run.scenes()) sceneViews.add(artifactView(scene));
        view.put("scenes", sceneViews);
        view.put("manifestArtifact", artifactView(run.manifest()));
        view.put("manifest", run.document());
        view.put("replayed", run.replayed());
        view.put("note", NOTE);
        return view;
    }

    private static Map<String, Object> artifactView(MediaArtifact artifact) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("artifactId", artifact.artifactId());
        view.put("artifactVersionId", artifact.version().value());
        view.put("contentType", artifact.contentType());
        view.put("sizeBytes", artifact.sizeBytes());
        view.put("sha256", artifact.sha256());
        view.put("artifactPath", "/api/v1/artifacts/" + artifact.artifactId());
        return view;
    }

    private static void requireKeys(Map<String, Object> value, Set<String> required, Set<String> optional, String field) {
        for (String key : required) {
            if (!value.containsKey(key)) throw MediaDevReferenceSceneSpec.invalid("$." + key, "is required");
        }
        for (String key : value.keySet()) {
            if (!required.contains(key) && !optional.contains(key)) {
                throw MediaDevReferenceSceneSpec.invalid("$." + key, field + " has no field " + key);
            }
        }
    }

    private static void notAllowed(HttpExchange exchange, String allow, MediaDevCreativeOutputRoutes.Responder out)
            throws IOException {
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
