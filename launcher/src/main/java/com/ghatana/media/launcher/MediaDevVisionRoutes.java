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
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY local vision routes (outside the canonical manifest/OpenAPI): {@code GET /dev/v1/vision/status},
 * {@code POST /dev/v1/vision/analyses} (Florence-2 caption/detect/ocr), {@code POST /dev/v1/vision/questions}
 * (Qwen2.5-VL question about an image or video frame) and {@code GET /dev/v1/vision/outputs/{outputId}}.
 * Every response is labelled DEV_ONLY.
 */
final class MediaDevVisionRoutes {
    static final String STATUS = "/dev/v1/vision/status";
    static final String ANALYSES = "/dev/v1/vision/analyses";
    static final String QUESTIONS = "/dev/v1/vision/questions";
    private static final Pattern OUTPUT = Pattern.compile("^/dev/v1/vision/outputs/([^/]+)$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();

    private final MediaDevVisionRuntime vision;
    private final MediaRuntime runtime;

    MediaDevVisionRoutes(MediaDevVisionRuntime vision, MediaRuntime runtime) {
        this.vision = vision;
        this.runtime = runtime;
    }

    static boolean handles(String path) { return path.startsWith("/dev/v1/vision/"); }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY vision capacity is exhausted; retry the same requestId after the Retry-After delay",
                    Map.of("scope", failure.scope()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact source artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevVisionRuntime.VisionRightsNotAdmittedException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, "RIGHTS_AUTHORITY_UNAVAILABLE".equals(failure.code()) ? 503 : 403, failure.code(),
                    "The exact source version has no current PROCESSING rights and consent admission; nothing was dispatched",
                    Map.of("scope", "PROCESSING", "verdict", failure.resolution().verdict().name(),
                            "reasons", failure.resolution().reasons().stream().map(Enum::name).sorted().toList()));
        } catch (MediaDevVisionRuntime.VisionNotAdmittedException failure) {
            out.error(exchange, 503, "LOCAL_MODEL_NOT_ADMITTED",
                    "The required local model is not digest-qualified; nothing was dispatched",
                    Map.of("modelId", failure.modelId(), "reason", failure.code()));
        } catch (MediaDevVisionRuntime.VisionUnavailableException failure) {
            out.error(exchange, 503, "LOCAL_VISION_UNAVAILABLE",
                    "The loopback local vision sidecar is unavailable; retry the same requestId", Map.of());
        } catch (MediaDevVisionRuntime.VisionUnsupportedException failure) {
            out.error(exchange, 422, failure.code(), failure.getMessage(), Map.of());
        } catch (MediaDevVisionRuntime.VisionRequestReusedException failure) {
            out.error(exchange, 409, "VISION_REQUEST_ID_REUSED",
                    "requestId was already used with a different vision request", Map.of());
        } catch (MediaDevVisionRuntime.VisionRegistrationFailedException failure) {
            out.error(exchange, 502, "VISION_OUTPUT_REGISTRATION_FAILED",
                    "Output was not registered; retry with the same requestId to resume", Map.of());
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (STATUS.equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, vision.status());
            return;
        }
        if (ANALYSES.equals(path) || QUESTIONS.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                    || !MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create")) {
                runtime.recordDeniedRequest();
                out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                        "DEV_ONLY artifact read and create permissions are required for vision outputs", Map.of());
                return;
            }
            Map<String, Object> body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                    new TypeReference<Map<String, Object>>() { });
            if (body == null) throw new IllegalArgumentException("request body is required");
            boolean analysis = ANALYSES.equals(path);
            Set<String> allowed = analysis
                    ? Set.of("requestId", "artifactId", "artifactVersionId", "tasks", "frameTimeMs")
                    : Set.of("requestId", "artifactId", "artifactVersionId", "question", "frameTimeMs");
            Set<String> required = analysis
                    ? Set.of("requestId", "artifactId", "artifactVersionId", "tasks")
                    : Set.of("requestId", "artifactId", "artifactVersionId", "question");
            if (!body.keySet().containsAll(required) || !allowed.containsAll(body.keySet())) {
                throw new IllegalArgumentException("vision request fields do not match its declared shape");
            }
            long frameTimeMs = body.containsKey("frameTimeMs") ? integer(body.get("frameTimeMs")) : 0L;
            var result = analysis
                    ? vision.analyze(tenantId, principalId, new MediaDevVisionRuntime.AnalyzeRequest(
                            string(body.get("requestId"), "requestId"), string(body.get("artifactId"), "artifactId"),
                            string(body.get("artifactVersionId"), "artifactVersionId"), tasks(body.get("tasks")),
                            frameTimeMs))
                    : vision.ask(tenantId, principalId, new MediaDevVisionRuntime.AskRequest(
                            string(body.get("requestId"), "requestId"), string(body.get("artifactId"), "artifactId"),
                            string(body.get("artifactVersionId"), "artifactVersionId"),
                            string(body.get("question"), "question"), frameTimeMs));
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
            var found = vision.reopen(tenantId, principalId, pathSegment(single.group(1)));
            if (found.isEmpty()) {
                out.error(exchange, 404, "VISION_OUTPUT_NOT_FOUND",
                        "Vision output is not available in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, view(found.get()));
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Vision route not found", Map.of());
    }

    private static Map<String, Object> view(MediaDevVisionRuntime.VisionResult result) {
        MediaArtifact artifact = result.artifact();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevVisionRuntime.SCHEMA);
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
        view.put("note", "DEV_ONLY local open-model output; not a production, quality, rights or approval claim");
        return view;
    }

    private static Set<String> tasks(Object value) {
        if (!(value instanceof List<?> list) || list.isEmpty() || list.size() > 3) {
            throw new IllegalArgumentException("tasks must be a non-empty array of at most 3 task names");
        }
        Set<String> out = new LinkedHashSet<>();
        for (Object item : list) out.add(string(item, "tasks[]"));
        return out;
    }

    private static String string(Object value, String field) {
        if (!(value instanceof String text)) throw new IllegalArgumentException(field + " must be a string");
        return text;
    }

    private static long integer(Object value) {
        if (!(value instanceof Integer || value instanceof Long || value instanceof Short)) {
            throw new IllegalArgumentException("frameTimeMs must be an integer");
        }
        return ((Number) value).longValue();
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
