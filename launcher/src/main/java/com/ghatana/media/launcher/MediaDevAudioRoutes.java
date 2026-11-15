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
 * DEV_ONLY audio restoration routes (outside the canonical manifest/OpenAPI), journey J-07:
 * {@code GET /dev/v1/audio/status}, {@code POST /dev/v1/audio/restorations},
 * {@code POST /dev/v1/audio/comparisons} and {@code GET /dev/v1/audio/outputs/{artifactId}}.
 * Request bodies are strict: unknown or duplicate keys, wrong types and out-of-range numbers are refused with a typed
 * 4xx before any rights call, source read or engine start. Every response is labelled DEV_ONLY.
 */
final class MediaDevAudioRoutes {
    static final String STATUS = "/dev/v1/audio/status";
    static final String RESTORATIONS = "/dev/v1/audio/restorations";
    static final String COMPARISONS = "/dev/v1/audio/comparisons";
    private static final Pattern OUTPUT = Pattern.compile("^/dev/v1/audio/outputs/([^/]+)$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();

    private final MediaDevAudioRestorationRuntime audio;
    private final MediaRuntime runtime;

    MediaDevAudioRoutes(MediaDevAudioRestorationRuntime audio, MediaRuntime runtime) {
        this.audio = audio;
        this.runtime = runtime;
    }

    static boolean handles(String path) { return path.startsWith("/dev/v1/audio/"); }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY audio capacity is exhausted; retry the same requestId after the Retry-After delay",
                    Map.of("scope", failure.scope()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact source artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevAudioRestorationRuntime.AudioRefusedException failure) {
            if (failure.status() == 403) runtime.recordDeniedRequest();
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevAudioRestorationRuntime.AudioOutcomeUnknownException failure) {
            out.error(exchange, 503, "AUDIO_RESTORATION_OUTCOME_UNKNOWN",
                    "The local audio engine did not complete; its outcome is UNKNOWN and nothing was registered. "
                            + "Retry the same requestId", Map.of("outcome", "UNKNOWN", "reason", failure.reason()));
        } catch (MediaDevRequestLedger.LedgerRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevAudioRestorationRuntime.AudioRequestReusedException failure) {
            out.error(exchange, 409, "AUDIO_REQUEST_ID_REUSED",
                    "requestId was already used with a different audio request", Map.of());
        } catch (MediaDevAudioRestorationRuntime.AudioRegistrationFailedException failure) {
            out.error(exchange, 502, "AUDIO_OUTPUT_REGISTRATION_FAILED",
                    "Output was not registered; retry with the same requestId to resume", Map.of());
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (STATUS.equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, audio.status());
            return;
        }
        if (RESTORATIONS.equals(path) || COMPARISONS.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                    || !MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create")) {
                runtime.recordDeniedRequest();
                out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                        "DEV_ONLY artifact read and create permissions are required for audio outputs", Map.of());
                return;
            }
            Map<String, Object> body = body(exchange, maxBody);
            // Everything below parses and validates the request fully before the runtime is called.
            if (RESTORATIONS.equals(path)) {
                requireKeys(body, Set.of("requestId", "artifactId", "artifactVersionId", "operations"), Set.of(),
                        "restoration request");
                var request = new MediaDevAudioRestorationRuntime.RestoreRequest(
                        string(body.get("requestId"), "requestId"), string(body.get("artifactId"), "artifactId"),
                        string(body.get("artifactVersionId"), "artifactVersionId"), operations(body.get("operations")));
                var result = audio.restore(tenantId, principalId, request);
                out.json(exchange, result.replayed() ? 200 : 201, view(result));
            } else {
                requireKeys(body, Set.of("requestId", "source", "restored"), Set.of("reference", "transcript"),
                        "comparison request");
                var request = new MediaDevAudioRestorationRuntime.CompareRequest(
                        string(body.get("requestId"), "requestId"), versionRef(body.get("source"), "source"),
                        versionRef(body.get("restored"), "restored"),
                        body.get("reference") == null ? null : versionRef(body.get("reference"), "reference"),
                        transcript(body.get("transcript")));
                var result = audio.compare(tenantId, principalId, request);
                out.json(exchange, result.replayed() ? 200 : 201, view(result));
            }
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
            var found = audio.reopen(tenantId, principalId, pathSegment(single.group(1)));
            if (found.isEmpty()) {
                out.error(exchange, 404, "AUDIO_OUTPUT_NOT_FOUND",
                        "Audio output is not available in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, view(found.get()));
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Audio route not found", Map.of());
    }

    private static Map<String, Object> view(MediaDevAudioRestorationRuntime.AudioOutput result) {
        MediaArtifact artifact = result.artifact();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", "COMPARISON".equals(result.kind()) ? MediaDevAudioRestorationRuntime.SCHEMA_COMPARISON
                : MediaDevAudioRestorationRuntime.SCHEMA_RESTORATION);
        view.put("kind", result.kind());
        view.put("outputId", artifact.artifactId());
        view.put("artifact", Map.of(
                "artifactId", artifact.artifactId(),
                "artifactVersionId", artifact.version().value(),
                "contentType", artifact.contentType(),
                "sizeBytes", artifact.sizeBytes(),
                "sha256", artifact.sha256(),
                "artifactPath", "/api/v1/artifacts/" + artifact.artifactId()));
        view.put("lineage", result.lineage());
        if (result.document() != null) view.put("report", result.document());
        view.put("replayed", result.replayed());
        view.put("scope", "DEV_ONLY");
        view.put("note", "DEV_ONLY local audio engine output; not a production, perceptual-quality, rights or approval claim");
        return view;
    }

    // ---- strict body parsing ----

    private static Map<String, Object> body(HttpExchange exchange, int maxBody) throws IOException {
        Map<String, Object> body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                new TypeReference<Map<String, Object>>() { });
        if (body == null) throw new IllegalArgumentException("request body is required");
        return body;
    }

    private static void requireKeys(Map<String, Object> body, Set<String> required, Set<String> optional, String what) {
        if (!body.keySet().containsAll(required)) throw new IllegalArgumentException(what + " is missing a required field");
        for (String key : body.keySet()) {
            if (!required.contains(key) && !optional.contains(key)) {
                throw new IllegalArgumentException(what + " has an unknown field");
            }
        }
    }

    private static MediaDevAudioRestorationRuntime.Operations operations(Object value) {
        Map<String, Object> map = object(value, "operations");
        requireKeys(map, Set.of(), Set.of("declip", "dehum", "denoise", "normalize"), "operations");
        MediaDevAudioRestorationRuntime.Declip declip = null;
        MediaDevAudioRestorationRuntime.Dehum dehum = null;
        MediaDevAudioRestorationRuntime.Denoise denoise = null;
        MediaDevAudioRestorationRuntime.Normalize normalize = null;
        if (map.get("declip") != null) {
            Map<String, Object> d = object(map.get("declip"), "operations.declip");
            requireKeys(d, Set.of(), Set.of("threshold"), "operations.declip");
            declip = new MediaDevAudioRestorationRuntime.Declip(d.containsKey("threshold")
                    ? wholeNumber(d.get("threshold"), "declip.threshold") : 10);
        }
        if (map.get("dehum") != null) {
            Map<String, Object> d = object(map.get("dehum"), "operations.dehum");
            requireKeys(d, Set.of("frequencyHz"), Set.of(), "operations.dehum");
            dehum = new MediaDevAudioRestorationRuntime.Dehum(wholeNumber(d.get("frequencyHz"), "dehum.frequencyHz"));
        }
        if (map.get("denoise") != null) {
            Map<String, Object> d = object(map.get("denoise"), "operations.denoise");
            requireKeys(d, Set.of(), Set.of("reductionDb", "noiseFloorDb", "trackNoise"), "operations.denoise");
            denoise = new MediaDevAudioRestorationRuntime.Denoise(
                    d.containsKey("reductionDb") ? number(d.get("reductionDb"), "denoise.reductionDb") : 12.0,
                    d.containsKey("noiseFloorDb") ? number(d.get("noiseFloorDb"), "denoise.noiseFloorDb") : -50.0,
                    !d.containsKey("trackNoise") || bool(d.get("trackNoise"), "denoise.trackNoise"));
        }
        if (map.get("normalize") != null) {
            Map<String, Object> d = object(map.get("normalize"), "operations.normalize");
            requireKeys(d, Set.of(), Set.of("targetLufs"), "operations.normalize");
            normalize = new MediaDevAudioRestorationRuntime.Normalize(
                    d.containsKey("targetLufs") ? number(d.get("targetLufs"), "normalize.targetLufs") : -16.0);
        }
        return new MediaDevAudioRestorationRuntime.Operations(declip, dehum, denoise, normalize);
    }

    private static MediaDevAudioRestorationRuntime.VersionRef versionRef(Object value, String field) {
        Map<String, Object> map = object(value, field);
        requireKeys(map, Set.of("artifactId", "artifactVersionId"), Set.of(), field);
        return new MediaDevAudioRestorationRuntime.VersionRef(string(map.get("artifactId"), field + ".artifactId"),
                string(map.get("artifactVersionId"), field + ".artifactVersionId"));
    }

    private static MediaDevAudioRestorationRuntime.TranscriptRequest transcript(Object value) {
        if (value == null) return null;
        Map<String, Object> map = object(value, "transcript");
        requireKeys(map, Set.of(), Set.of("language", "referenceText"), "transcript");
        return new MediaDevAudioRestorationRuntime.TranscriptRequest(
                map.get("language") == null ? null : string(map.get("language"), "transcript.language"),
                map.get("referenceText") == null ? null : string(map.get("referenceText"), "transcript.referenceText"));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value, String field) {
        if (!(value instanceof Map<?, ?> map)) throw new IllegalArgumentException(field + " must be an object");
        return (Map<String, Object>) map;
    }

    private static String string(Object value, String field) {
        if (!(value instanceof String text)) throw new IllegalArgumentException(field + " must be a string");
        return text;
    }

    private static int wholeNumber(Object value, String field) {
        if (!(value instanceof Integer || value instanceof Long || value instanceof Short)) {
            throw new IllegalArgumentException(field + " must be an integer");
        }
        long v = ((Number) value).longValue();
        if (v < Integer.MIN_VALUE || v > Integer.MAX_VALUE) throw new IllegalArgumentException(field + " is out of range");
        return (int) v;
    }

    private static double number(Object value, String field) {
        if (!(value instanceof Number number)) throw new IllegalArgumentException(field + " must be a number");
        return number.doubleValue();
    }

    private static boolean bool(Object value, String field) {
        if (!(value instanceof Boolean flag)) throw new IllegalArgumentException(field + " must be a boolean");
        return flag;
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
