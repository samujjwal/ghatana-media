package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevCompositePlan.CaptionMode;
import com.ghatana.media.launcher.MediaDevCompositePlan.Color;
import com.ghatana.media.launcher.MediaDevCompositePlan.GapPolicy;
import com.ghatana.media.launcher.MediaDevCompositePlan.Gain;
import com.ghatana.media.launcher.MediaDevCompositePlan.Overlay;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectAccessDeniedException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectNotFoundException;
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
 * DEV_ONLY multitrack composite render routes (outside the canonical manifest/OpenAPI):
 * {@code GET /dev/v1/composite-renders/capabilities}, {@code POST /dev/v1/composite-renders},
 * {@code GET /dev/v1/composite-renders/{artifactId}} and {@code POST /dev/v1/composite-renders/{requestId}/cancel}.
 * Every response is labelled DEV_ONLY.
 */
final class MediaDevCompositeRenderRoutes {
    static final String BASE = "/dev/v1/composite-renders";
    private static final Pattern RENDER = Pattern.compile("^/dev/v1/composite-renders/([^/]+)$");
    private static final Pattern CANCEL = Pattern.compile("^/dev/v1/composite-renders/([^/]+)/cancel$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();

    private final MediaDevCompositeRenderRuntime composite;
    private final MediaRuntime runtime;

    MediaDevCompositeRenderRoutes(MediaDevCompositeRenderRuntime composite, MediaRuntime runtime) {
        this.composite = composite;
        this.runtime = runtime;
    }

    static boolean handles(String path) {
        return path.equals(BASE) || path.startsWith(BASE + "/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId, int maxBody,
                MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (ProjectNotFoundException failure) {
            out.error(exchange, 404, "PROJECT_NOT_FOUND", "Project is not available in this tenant and owner scope", Map.of());
        } catch (ProjectAccessDeniedException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 403, "PROJECT_ACCESS_DENIED", "Principal is not authorized to access this project", Map.of());
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY render capacity is exhausted; retry the same requestId after the Retry-After delay",
                    Map.of("scope", failure.scope()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact source artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevSpeechRuntime.SpeechRefusedException failure) {
            if (failure.status() == 403) runtime.recordDeniedRequest();
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevProjectRenderRuntime.RenderNotSupportedException failure) {
            out.error(exchange, 422, failure.code(), failure.getMessage(), Map.of());
        } catch (MediaDevRequestLedger.LedgerRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevSpeechRuntime.SpeechRequestReusedException failure) {
            out.error(exchange, 409, "REQUEST_ID_REUSED", "requestId was already used with a different request", Map.of());
        } catch (MediaDevSpeechRuntime.SpeechRegistrationFailedException failure) {
            out.error(exchange, 502, "OUTPUT_REGISTRATION_FAILED",
                    "Output was not registered; retry with the same requestId to resume", Map.of());
        } catch (MediaDevProjectRenderRuntime.RenderTimeoutException failure) {
            out.error(exchange, 504, "RENDER_TIMEOUT", "The DEV_ONLY render exceeded its time budget and was cancelled; "
                    + "nothing was registered. Retry the same requestId", Map.of());
        } catch (MediaDevProjectRenderRuntime.RenderOutcomeUnknownException failure) {
            out.error(exchange, 503, "RENDER_OUTCOME_UNKNOWN", "The DEV_ONLY render process ended abnormally; its outcome "
                    + "is unknown and nothing was registered. Retry the same requestId", Map.of());
        } catch (MediaDevProjectRenderRuntime.RenderExecutionFailedException failure) {
            out.error(exchange, 502, "RENDER_EXECUTION_FAILED", "Render did not produce a verified output",
                    Map.of("reason", failure.reason()));
        }
    }

    private boolean permitted(HttpExchange exchange, boolean write, MediaDevCreativeOutputRoutes.Responder out)
            throws IOException {
        if (MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                && (!write || MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create"))) return true;
        runtime.recordDeniedRequest();
        out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                "DEV_ONLY artifact read" + (write ? " and create" : "") + " permissions are required", Map.of());
        return false;
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if ((BASE + "/capabilities").equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, composite.capabilities());
            return;
        }
        if (BASE.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!permitted(exchange, true, out)) return;
            Map<String, Object> body = body(exchange, maxBody);
            requireKeys(body, Set.of("requestId", "projectId", "revisionId", "timelineId", "width", "height",
                    "framesPerSecond"), Set.of("gapPolicy", "captionMode", "color", "overlays", "audio", "maxOutputBytes"),
                    "composite render request");
            MediaDevCompositePlan.Spec spec = new MediaDevCompositePlan.Spec(integer(body.get("width"), "width"),
                    integer(body.get("height"), "height"), integer(body.get("framesPerSecond"), "framesPerSecond"),
                    enumValue(GapPolicy.class, body.get("gapPolicy"), GapPolicy.REFUSE, "gapPolicy"),
                    enumValue(CaptionMode.class, body.get("captionMode"), CaptionMode.MUX, "captionMode"),
                    color(body.get("color")), overlays(body.get("overlays")), gains(body.get("audio")));
            long maxOutput = body.containsKey("maxOutputBytes")
                    ? integer(body.get("maxOutputBytes"), "maxOutputBytes") : composite.config().maxOutputBytes();
            var request = new MediaDevCompositeRenderRuntime.Request(string(body.get("requestId"), "requestId"),
                    string(body.get("projectId"), "projectId"), string(body.get("revisionId"), "revisionId"),
                    string(body.get("timelineId"), "timelineId"), spec, maxOutput);
            var result = composite.render(tenantId, principalId, request);
            out.json(exchange, result.replayed() ? 200 : 201, view(result));
            return;
        }
        Matcher cancel = CANCEL.matcher(path);
        if (cancel.matches()) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!permitted(exchange, true, out)) return;
            String requestId = pathSegment(cancel.group(1));
            if (!composite.cancel(tenantId, principalId, requestId)) {
                out.error(exchange, 404, "RENDER_NOT_IN_FLIGHT",
                        "No render with this requestId is running for this principal", Map.of());
                return;
            }
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("requestId", requestId);
            view.put("cancelRequested", true);
            view.put("scope", "DEV_ONLY");
            out.json(exchange, 200, view);
            return;
        }
        Matcher render = RENDER.matcher(path);
        if (render.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!permitted(exchange, false, out)) return;
            var found = composite.reopen(tenantId, principalId, pathSegment(render.group(1)));
            if (found.isEmpty()) {
                out.error(exchange, 404, "RENDER_NOT_FOUND", "Render is not available in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, view(found.get()));
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Composite render route not found", Map.of());
    }

    static Map<String, Object> view(MediaDevCompositeRenderRuntime.Result result) {
        MediaArtifact artifact = result.artifact();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevCompositeRenderRuntime.SCHEMA);
        view.put("scope", "DEV_ONLY");
        view.put("renderId", artifact.artifactId());
        view.put("artifact", Map.of("artifactId", artifact.artifactId(), "artifactVersionId", artifact.version().value(),
                "contentType", artifact.contentType(), "sizeBytes", artifact.sizeBytes(), "sha256", artifact.sha256(),
                "artifactPath", "/api/v1/artifacts/" + artifact.artifactId()));
        view.put("lineage", result.lineage());
        view.put("replayed", result.replayed());
        return view;
    }

    private static Color color(Object value) {
        if (value == null) return Color.NEUTRAL;
        Map<String, Object> map = object(value, "color");
        requireKeys(map, Set.of(), Set.of("brightness", "contrast", "saturation"), "color");
        return new Color(decimal(map.get("brightness"), 0.0, "color.brightness"),
                decimal(map.get("contrast"), 1.0, "color.contrast"), decimal(map.get("saturation"), 1.0, "color.saturation"));
    }

    private static List<Overlay> overlays(Object value) {
        List<Overlay> overlays = new ArrayList<>();
        if (value == null) return overlays;
        if (!(value instanceof List<?> list)) throw new IllegalArgumentException("overlays must be an array");
        for (Object item : list) {
            Map<String, Object> map = object(item, "overlay");
            requireKeys(map, Set.of("clipId", "x", "y"), Set.of("opacity"), "overlay");
            overlays.add(new Overlay(string(map.get("clipId"), "overlay.clipId"), integer(map.get("x"), "overlay.x"),
                    integer(map.get("y"), "overlay.y"), decimal(map.get("opacity"), 1.0, "overlay.opacity")));
        }
        return overlays;
    }

    private static List<Gain> gains(Object value) {
        List<Gain> gains = new ArrayList<>();
        if (value == null) return gains;
        if (!(value instanceof List<?> list)) throw new IllegalArgumentException("audio must be an array");
        for (Object item : list) {
            Map<String, Object> map = object(item, "audio gain");
            requireKeys(map, Set.of("clipId", "gainDb"), Set.of(), "audio gain");
            gains.add(new Gain(string(map.get("clipId"), "audio.clipId"), decimal(map.get("gainDb"), 0.0, "audio.gainDb")));
        }
        return gains;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value, String field) {
        if (!(value instanceof Map<?, ?> map)) throw new IllegalArgumentException(field + " must be an object");
        return (Map<String, Object>) map;
    }

    private static <E extends Enum<E>> E enumValue(Class<E> type, Object value, E fallback, String field) {
        if (value == null) return fallback;
        try {
            return Enum.valueOf(type, string(value, field));
        } catch (IllegalArgumentException unknown) {
            throw new IllegalArgumentException(field + " is not a supported value");
        }
    }

    private static int integer(Object value, String field) {
        if (!(value instanceof Integer || value instanceof Long || value instanceof Short)) {
            throw new IllegalArgumentException(field + " must be an integer");
        }
        long number = ((Number) value).longValue();
        if (number < Integer.MIN_VALUE || number > Integer.MAX_VALUE) throw new IllegalArgumentException(field + " is out of range");
        return (int) number;
    }

    private static double decimal(Object value, double fallback, String field) {
        if (value == null) return fallback;
        if (!(value instanceof Number number)) throw new IllegalArgumentException(field + " must be a number");
        return number.doubleValue();
    }

    private static Map<String, Object> body(HttpExchange exchange, int maxBody) throws IOException {
        Map<String, Object> body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                new TypeReference<Map<String, Object>>() { });
        if (body == null) throw new IllegalArgumentException("request body is required");
        return body;
    }

    private static void requireKeys(Map<String, Object> value, Set<String> required, Set<String> optional, String field) {
        if (!value.keySet().containsAll(required)
                || !java.util.stream.Stream.concat(required.stream(), optional.stream())
                        .collect(java.util.stream.Collectors.toSet()).containsAll(value.keySet())) {
            throw new IllegalArgumentException(field + " fields do not match its declared shape");
        }
    }

    private static String string(Object value, String field) {
        if (!(value instanceof String text)) throw new IllegalArgumentException(field + " must be a string");
        return text;
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
