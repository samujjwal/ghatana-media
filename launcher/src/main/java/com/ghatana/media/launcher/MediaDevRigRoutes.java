package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.sun.net.httpserver.HttpExchange;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY deterministic 3D rig render routes (outside the canonical manifest/OpenAPI):
 * {@code GET /dev/v1/rigs/status}, {@code POST /dev/v1/rigs/renders} and
 * {@code GET /dev/v1/rigs/renders/{renderId}} (the render id is the manifest artifact id). Permissions are
 * {@code media:project:dev:write|read} plus {@code media:artifact:read} (and {@code media:artifact:create} for the
 * POST). The acting principal is the authenticated caller; no body field names one. The MP4 and the GLB are read back through the
 * existing exact-version {@code GET /dev/v1/artifacts/{id}/content} route (Range supported).
 */
final class MediaDevRigRoutes {
    static final String STATUS = "/dev/v1/rigs/status";
    static final String RENDERS = "/dev/v1/rigs/renders";
    private static final Pattern RENDER = Pattern.compile("^/dev/v1/rigs/renders/([^/]+)$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();
    private static final String NOTE = "DEV_ONLY deterministic 3D rig render encoded as lossy H.264 plus a float32 GLB; no "
            + "quality, rights, approval or production claim";

    private static final Logger log = LoggerFactory.getLogger(MediaDevRigRoutes.class);

    private final MediaDevRigRuntime rig;
    private final MediaRuntime runtime;

    MediaDevRigRoutes(MediaDevRigRuntime rig, MediaRuntime runtime) {
        this.rig = rig;
        this.runtime = runtime;
    }

    static boolean handles(String path) {
        return path.equals(STATUS) || path.equals(RENDERS) || path.startsWith(RENDERS + "/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId, int maxBody,
                MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY rig-render capacity is exhausted; retry the same requestId after the Retry-After delay",
                    Map.of("scope", failure.scope()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact texture asset artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevRigRuntime.RigRefusedException failure) {
            if (failure.status() == 403) runtime.recordDeniedRequest();
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevRigRuntime.RigOutcomeUnknownException failure) {
            out.error(exchange, 503, "RIG_OUTCOME_UNKNOWN",
                    "The render process did not finish; its outcome is UNKNOWN and nothing was registered. "
                            + "Retry the same requestId",
                    Map.of("outcome", "UNKNOWN"));
        } catch (MediaDevRequestLedger.LedgerRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevRigRuntime.RigRequestReusedException failure) {
            out.error(exchange, 409, "RIG_REQUEST_ID_REUSED",
                    "requestId was already used with a different rig render request", Map.of());
        } catch (MediaDevRigRuntime.RigRegistrationFailedException failure) {
            out.error(exchange, 502, "RIG_OUTPUT_REGISTRATION_FAILED",
                    "The output was not registered; retry with the same requestId to resume", Map.of());
        } catch (IllegalArgumentException | IllegalStateException | SecurityException handled) {
            throw handled; // mapped to 400/409/403 by the host handler
        } catch (RuntimeException unexpected) {
            log.error("DEV rig request failed unexpectedly", unexpected);
            throw unexpected;
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (STATUS.equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, rig.status());
            return;
        }
        if (RENDERS.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                    || !MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create")) {
                runtime.recordDeniedRequest();
                out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                        "DEV_ONLY artifact read and create permissions are required for rig renders", Map.of());
                return;
            }
            Map<String, Object> body;
            try {
                body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                        new TypeReference<Map<String, Object>>() { });
            } catch (tools.jackson.core.JacksonException malformed) {
                throw MediaDevRigSpec.invalid("$", "the request body is not a valid JSON object");
            }
            if (body == null) throw MediaDevRigSpec.invalid("$", "the request body is required");
            requireKeys(body, Set.of("requestId", "spec"), Set.of("encoder"), "rig render request");
            int crf = MediaDevRigRuntime.DEFAULT_CRF;
            if (body.containsKey("encoder")) {
                if (!(body.get("encoder") instanceof Map<?, ?> encoder)) {
                    throw MediaDevRigSpec.invalid("$.encoder", "encoder must be an object");
                }
                for (Object key : encoder.keySet()) {
                    if (!"crf".equals(key)) throw MediaDevRigSpec.invalid("$.encoder." + key, "is not a known field");
                }
                if (encoder.containsKey("crf")) {
                    if (!(encoder.get("crf") instanceof Integer || encoder.get("crf") instanceof Long)) {
                        throw MediaDevRigSpec.invalid("$.encoder.crf", "crf must be an integer");
                    }
                    crf = (int) Math.max(Integer.MIN_VALUE, Math.min(Integer.MAX_VALUE, ((Number) encoder.get("crf")).longValue()));
                }
            }
            if (!(body.get("requestId") instanceof String requestId)) {
                throw new IllegalArgumentException("requestId must be a string");
            }
            MediaDevRigRuntime.Render render = rig.render(tenantId, principalId,
                    new MediaDevRigRuntime.RenderRequest(requestId, body.get("spec"), crf));
            out.json(exchange, render.replayed() ? 200 : 201, view(render));
            return;
        }
        Matcher one = RENDER.matcher(path);
        if (one.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")) {
                runtime.recordDeniedRequest();
                out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                        "DEV_ONLY artifact read permission is required", Map.of());
                return;
            }
            var found = rig.reopen(tenantId, principalId, pathSegment(one.group(1)));
            if (found.isEmpty()) {
                out.error(exchange, 404, "RIG_RENDER_NOT_FOUND",
                        "Rig render is not available in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, view(found.get()));
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Rig route not found", Map.of());
    }

    private static Map<String, Object> view(MediaDevRigRuntime.Render render) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevRigRuntime.SCHEMA);
        view.put("scope", "DEV_ONLY");
        view.put("renderId", render.manifest().artifactId());
        view.put("video", artifactView(render.video()));
        view.put("glb", artifactView(render.glb()));
        view.put("manifestArtifact", artifactView(render.manifest()));
        view.put("manifest", render.manifestDocument());
        view.put("videoLineage", render.videoLineage());
        view.put("glbLineage", render.glbLineage());
        view.put("replayed", render.replayed());
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

    private static void requireKeys(Map<String, Object> value, Set<String> required, Set<String> optional, String field) {
        for (String key : required) {
            if (!value.containsKey(key)) throw MediaDevRigSpec.invalid("$." + key, "is required");
        }
        for (String key : value.keySet()) {
            if (!required.contains(key) && !optional.contains(key)) {
                throw MediaDevRigSpec.invalid("$." + key, field + " has no field " + key);
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
