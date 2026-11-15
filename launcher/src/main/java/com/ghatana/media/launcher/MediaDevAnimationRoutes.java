package com.ghatana.media.launcher;

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
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY deterministic 2D animation routes (outside the canonical manifest/OpenAPI):
 * {@code GET /dev/v1/animations/status}, {@code POST /dev/v1/animations/renders} and
 * {@code GET /dev/v1/animations/renders/{renderId}} (the render id is the manifest artifact id). Permissions are
 * {@code media:project:dev:write|read} plus {@code media:artifact:read} (and {@code media:artifact:create} for the
 * POST). The acting principal is the authenticated caller; no body field names one. The MP4 is read back through the
 * existing exact-version {@code GET /dev/v1/artifacts/{id}/content} route (Range supported).
 */
final class MediaDevAnimationRoutes {
    static final String STATUS = "/dev/v1/animations/status";
    static final String RENDERS = "/dev/v1/animations/renders";
    private static final Pattern RENDER = Pattern.compile("^/dev/v1/animations/renders/([^/]+)$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();
    private static final String NOTE = "DEV_ONLY deterministic 2D render encoded as lossy H.264; no quality, rights, "
            + "approval or production claim";

    private final MediaDevAnimationRuntime animation;
    private final MediaRuntime runtime;

    MediaDevAnimationRoutes(MediaDevAnimationRuntime animation, MediaRuntime runtime) {
        this.animation = animation;
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
                    "DEV_ONLY animation capacity is exhausted; retry the same requestId after the Retry-After delay",
                    Map.of("scope", failure.scope()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact asset artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevAnimationRuntime.AnimationRefusedException failure) {
            if (failure.status() == 403) runtime.recordDeniedRequest();
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevAnimationRuntime.AnimationOutcomeUnknownException failure) {
            out.error(exchange, 503, "ANIMATION_OUTCOME_UNKNOWN",
                    "The render process did not finish; its outcome is UNKNOWN and nothing was registered. "
                            + "Retry the same requestId",
                    Map.of("outcome", "UNKNOWN"));
        } catch (MediaDevRequestLedger.LedgerRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevAnimationRuntime.AnimationRequestReusedException failure) {
            out.error(exchange, 409, "ANIMATION_REQUEST_ID_REUSED",
                    "requestId was already used with a different animation request", Map.of());
        } catch (MediaDevAnimationRuntime.AnimationRegistrationFailedException failure) {
            out.error(exchange, 502, "ANIMATION_OUTPUT_REGISTRATION_FAILED",
                    "The output was not registered; retry with the same requestId to resume", Map.of());
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (STATUS.equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, animation.status());
            return;
        }
        if (RENDERS.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                    || !MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create")) {
                runtime.recordDeniedRequest();
                out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                        "DEV_ONLY artifact read and create permissions are required for animation renders", Map.of());
                return;
            }
            Map<String, Object> body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                    new TypeReference<Map<String, Object>>() { });
            if (body == null) throw new IllegalArgumentException("request body is required");
            requireKeys(body, Set.of("requestId", "spec"), Set.of("encoder"), "animation render request");
            int crf = MediaDevAnimationRuntime.DEFAULT_CRF;
            if (body.containsKey("encoder")) {
                if (!(body.get("encoder") instanceof Map<?, ?> encoder)) {
                    throw MediaDevAnimationSpec.invalid("$.encoder", "encoder must be an object");
                }
                for (Object key : encoder.keySet()) {
                    if (!"crf".equals(key)) throw MediaDevAnimationSpec.invalid("$.encoder." + key, "is not a known field");
                }
                if (encoder.containsKey("crf")) {
                    if (!(encoder.get("crf") instanceof Integer || encoder.get("crf") instanceof Long)) {
                        throw MediaDevAnimationSpec.invalid("$.encoder.crf", "crf must be an integer");
                    }
                    crf = (int) Math.max(Integer.MIN_VALUE, Math.min(Integer.MAX_VALUE, ((Number) encoder.get("crf")).longValue()));
                }
            }
            if (!(body.get("requestId") instanceof String requestId)) {
                throw new IllegalArgumentException("requestId must be a string");
            }
            MediaDevAnimationRuntime.Render render = animation.render(tenantId, principalId,
                    new MediaDevAnimationRuntime.RenderRequest(requestId, body.get("spec"), crf));
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
            var found = animation.reopen(tenantId, principalId, pathSegment(one.group(1)));
            if (found.isEmpty()) {
                out.error(exchange, 404, "ANIMATION_RENDER_NOT_FOUND",
                        "Animation render is not available in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, view(found.get()));
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Animation route not found", Map.of());
    }

    private static Map<String, Object> view(MediaDevAnimationRuntime.Render render) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevAnimationRuntime.SCHEMA);
        view.put("scope", "DEV_ONLY");
        view.put("renderId", render.manifest().artifactId());
        view.put("video", artifactView(render.video()));
        view.put("manifestArtifact", artifactView(render.manifest()));
        view.put("manifest", render.manifestDocument());
        view.put("videoLineage", render.videoLineage());
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
            if (!value.containsKey(key)) throw MediaDevAnimationSpec.invalid("$." + key, "is required");
        }
        for (String key : value.keySet()) {
            if (!required.contains(key) && !optional.contains(key)) {
                throw MediaDevAnimationSpec.invalid("$." + key, field + " has no field " + key);
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
