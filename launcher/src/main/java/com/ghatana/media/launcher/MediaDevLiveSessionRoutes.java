package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.sun.net.httpserver.HttpExchange;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.math.BigDecimal;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY live session routes (outside the canonical manifest/OpenAPI), journey J-29:
 * {@code GET /dev/v1/live-sessions/status}, {@code POST /dev/v1/live-sessions}, {@code GET /dev/v1/live-sessions/{id}},
 * {@code POST /dev/v1/live-sessions/{id}/frames} (binary record stream, may be chunked),
 * {@code POST /dev/v1/live-sessions/{id}/eos} and {@code POST /dev/v1/live-sessions/{id}/abort}. Every request is
 * authenticated by the DEV_ONLY bearer token; the acting principal owns the session and a foreign session is a 404.
 */
final class MediaDevLiveSessionRoutes {
    static final String PREFIX = "/dev/v1/live-sessions";
    static final String STATUS = PREFIX + "/status";
    private static final Pattern SESSION = Pattern.compile("^/dev/v1/live-sessions/([^/]+)(?:/(frames|eos|abort))?$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}");
    private static final Logger log = LoggerFactory.getLogger(MediaDevLiveSessionRoutes.class);

    private final MediaDevLiveSessionRuntime sessions;
    private final MediaRuntime runtime;

    MediaDevLiveSessionRoutes(MediaDevLiveSessionRuntime sessions, MediaRuntime runtime) {
        this.sessions = sessions;
        this.runtime = runtime;
    }

    static boolean handles(String path) {
        return path.equals(PREFIX) || path.startsWith(PREFIX + "/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId, int maxBody,
                MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevLiveSessionRuntime.LiveException failure) {
            if (failure.status() == 403) runtime.recordDeniedRequest();
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (STATUS.equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, sessions.status());
            return;
        }
        boolean write = "POST".equals(method);
        if (!requirePermissions(exchange, write, out)) return;
        if (PREFIX.equals(path)) {
            if (!write) { notAllowed(exchange, "POST", out); return; }
            Map<String, Object> view = sessions.create(tenantId, principalId, parseOpen(body(exchange, maxBody)));
            out.json(exchange, Boolean.TRUE.equals(view.get("replayed")) ? 200 : 201, view);
            return;
        }
        Matcher match = SESSION.matcher(path);
        if (!match.matches()) {
            out.error(exchange, 404, "NOT_FOUND", "Live session route not found", Map.of());
            return;
        }
        String id = pathSegment(match.group(1));
        String action = match.group(2);
        if (action == null) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, sessions.read(tenantId, principalId, id));
            return;
        }
        if (!write) { notAllowed(exchange, "POST", out); return; }
        switch (action) {
            case "frames" -> {
                MediaDevLiveSessionRuntime.Ingest result = sessions.ingest(tenantId, principalId, id,
                        new BufferedInputStream(exchange.getRequestBody(), 64 * 1024), maxBody);
                Map<String, Object> view = new LinkedHashMap<>();
                view.put("accepted", result.accepted());
                view.put("duplicates", result.duplicates());
                view.put("session", result.view());
                if (result.stop() == null) {
                    out.json(exchange, 200, view);
                } else {
                    Map<String, Object> details = new LinkedHashMap<>(result.stop().details());
                    details.put("accepted", result.accepted());
                    details.put("duplicates", result.duplicates());
                    details.put("session", result.view());
                    if (result.stop().status() == 429 || result.stop().status() == 503) {
                        exchange.getResponseHeaders().set("Retry-After", "1");
                    }
                    out.error(exchange, result.stop().status(), result.stop().code(), result.stop().getMessage(), details);
                }
            }
            case "eos" -> {
                Object body = body(exchange, maxBody);
                Map<String, Object> view = sessions.end(tenantId, principalId, id,
                        new MediaDevLiveSessionRuntime.End(parseEnd(body)));
                out.json(exchange, Boolean.TRUE.equals(view.get("replayed")) ? 200 : 201, view);
            }
            default -> out.json(exchange, 200, sessions.abort(tenantId, principalId, id));
        }
    }

    // ------------------------------------------------------------------------------------------- parsing

    static MediaDevLiveSessionRuntime.Open parseOpen(Object raw) {
        Map<String, Object> root = object(raw, "$", Set.of("requestId", "consent", "format", "startPtsSamples",
                "reorderWindowFrames", "leaseSeconds"));
        String requestId = text(root, "$", "requestId", true);
        if (!ID.matcher(requestId).matches()) throw invalid("$.requestId", "requestId must be a 1-128 character opaque id");
        Map<String, Object> consent = object(root.get("consent"), "$.consent", Set.of("artifactId", "artifactVersionId", "scope"));
        String artifactId = text(consent, "$.consent", "artifactId", true);
        String versionId = text(consent, "$.consent", "artifactVersionId", true);
        Scope scope;
        try {
            scope = Scope.valueOf(text(consent, "$.consent", "scope", false) == null ? "VOICE_OR_LIKENESS_USE"
                    : text(consent, "$.consent", "scope", false));
        } catch (IllegalArgumentException unknown) {
            throw invalid("$.consent.scope", "scope must be PROCESSING or VOICE_OR_LIKENESS_USE");
        }
        if (!MediaDevLiveSessionRuntime.SCOPES.contains(scope)) {
            throw invalid("$.consent.scope", "scope must be PROCESSING or VOICE_OR_LIKENESS_USE");
        }
        Map<String, Object> format = root.get("format") == null ? Map.of()
                : object(root.get("format"), "$.format", Set.of("sampleRate", "channels", "samplesPerFrame"));
        int rate = (int) integer(format, "$.format", "sampleRate", 48_000, 1, 1_000_000);
        if (!MediaDevLiveSessionRuntime.RATES.contains(rate)) throw invalid("$.format.sampleRate", "sampleRate must be 16000, 24000 or 48000");
        int channels = (int) integer(format, "$.format", "channels", 1, 1, 2);
        int samples = (int) integer(format, "$.format", "samplesPerFrame", 960, MediaDevLiveSessionRuntime.MIN_FRAME_SAMPLES,
                MediaDevLiveSessionRuntime.MAX_FRAME_SAMPLES);
        long startPts = integer(root, "$", "startPtsSamples", 0, 0, 1L << 40);
        int window = (int) integer(root, "$", "reorderWindowFrames", 16, 1, MediaDevLiveSessionRuntime.MAX_WINDOW);
        int lease = (int) integer(root, "$", "leaseSeconds", 30, 1, MediaDevLiveSessionRuntime.MAX_LEASE_SECONDS);
        return new MediaDevLiveSessionRuntime.Open(requestId, artifactId, versionId, scope, rate, channels, samples, startPts, window, lease);
    }

    static long parseEnd(Object raw) {
        Map<String, Object> root = object(raw, "$", Set.of("finalSequence"));
        return integer(root, "$", "finalSequence", -1, 0, Integer.MAX_VALUE);
    }

    private static Map<String, Object> object(Object value, String path, Set<String> allowed) {
        if (!(value instanceof Map<?, ?> map)) throw invalid(path, "an object is required");
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            String key = String.valueOf(entry.getKey());
            if (!allowed.contains(key)) throw invalid(path + "." + key, "unknown field");
            out.put(key, entry.getValue());
        }
        return out;
    }

    private static String text(Map<String, Object> map, String path, String key, boolean required) {
        Object value = map.get(key);
        if (value == null) {
            if (required) throw invalid(path + "." + key, "is required");
            return null;
        }
        if (!(value instanceof String string) || string.isBlank() || string.length() > 256) {
            throw invalid(path + "." + key, "must be a non-blank string of at most 256 characters");
        }
        return string;
    }

    private static long integer(Map<String, Object> map, String path, String key, long fallback, long min, long max) {
        Object value = map.get(key);
        if (value == null) {
            if (fallback < 0 && "finalSequence".equals(key)) throw invalid(path + "." + key, "is required");
            return fallback;
        }
        if (!(value instanceof Number number)) throw invalid(path + "." + key, "must be an integer");
        long parsed;
        try { parsed = new BigDecimal(number.toString()).longValueExact(); }
        catch (ArithmeticException notInteger) { throw invalid(path + "." + key, "must be an integer"); }
        if (parsed < min || parsed > max) throw invalid(path + "." + key, "must be between " + min + " and " + max);
        return parsed;
    }

    private static MediaDevLiveSessionRuntime.LiveException invalid(String path, String message) {
        return new MediaDevLiveSessionRuntime.LiveException(422, "LIVE_REQUEST_INVALID", path + ": " + message, Map.of("path", path));
    }

    private static Object body(HttpExchange exchange, int maxBody) throws IOException {
        try {
            Object body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, Math.min(maxBody, 64 * 1024), false),
                    new TypeReference<Object>() { });
            if (body == null) throw invalid("$", "the request body is required");
            return body;
        } catch (tools.jackson.core.JacksonException malformed) {
            throw invalid("$", "the request body is not valid JSON without duplicate keys");
        }
    }

    private boolean requirePermissions(HttpExchange exchange, boolean create, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                && (!create || MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create"))) return true;
        runtime.recordDeniedRequest();
        out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                "DEV_ONLY artifact read" + (create ? " and create" : "") + " permissions are required for live sessions", Map.of());
        return false;
    }

    private static void notAllowed(HttpExchange exchange, String allow, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        exchange.getResponseHeaders().set("Allow", allow);
        out.error(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed", Map.of());
    }

    private static String pathSegment(String raw) {
        String decoded = URLDecoder.decode(raw.replace("+", "%2B"), StandardCharsets.UTF_8);
        if (decoded.indexOf('/') >= 0 || decoded.indexOf('\\') >= 0) throw new IllegalArgumentException("Path identifier must not contain a separator");
        return decoded;
    }
}
