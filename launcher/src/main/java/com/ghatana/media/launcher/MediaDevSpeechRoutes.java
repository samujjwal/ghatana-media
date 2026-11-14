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
 * DEV_ONLY local speech routes (outside the canonical manifest/OpenAPI):
 * {@code GET /dev/v1/speech/capabilities}, {@code POST /dev/v1/speech/transcriptions},
 * {@code POST /dev/v1/speech/syntheses} and {@code GET /dev/v1/speech/outputs/{artifactId}}.
 * Every response is labelled DEV_ONLY.
 */
final class MediaDevSpeechRoutes {
    static final String CAPABILITIES = "/dev/v1/speech/capabilities";
    static final String TRANSCRIPTIONS = "/dev/v1/speech/transcriptions";
    static final String SYNTHESES = "/dev/v1/speech/syntheses";
    private static final Pattern OUTPUT = Pattern.compile("^/dev/v1/speech/outputs/([^/]+)$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();

    private final MediaDevSpeechRuntime speech;
    private final MediaRuntime runtime;

    MediaDevSpeechRoutes(MediaDevSpeechRuntime speech, MediaRuntime runtime) {
        this.speech = speech;
        this.runtime = runtime;
    }

    static boolean handles(String path) {
        return path.startsWith("/dev/v1/speech/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY speech capacity is exhausted; retry the same requestId after the Retry-After delay",
                    Map.of("scope", failure.scope()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact source artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevSpeechRuntime.SpeechRefusedException failure) {
            if (failure.status() == 403) runtime.recordDeniedRequest();
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevSpeechRuntime.SpeechRequestReusedException failure) {
            out.error(exchange, 409, "SPEECH_REQUEST_ID_REUSED",
                    "requestId was already used with a different speech request", Map.of());
        } catch (MediaDevSpeechRuntime.SpeechRegistrationFailedException failure) {
            out.error(exchange, 502, "SPEECH_OUTPUT_REGISTRATION_FAILED",
                    "Output was not registered; retry with the same requestId to resume", Map.of());
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (CAPABILITIES.equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, speech.capabilities());
            return;
        }
        if (TRANSCRIPTIONS.equals(path) || SYNTHESES.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            boolean transcription = TRANSCRIPTIONS.equals(path);
            if ((transcription && !MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read"))
                    || !MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create")) {
                runtime.recordDeniedRequest();
                out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                        "DEV_ONLY artifact create" + (transcription ? " and read" : "")
                                + " permissions are required for speech outputs", Map.of());
                return;
            }
            Map<String, Object> body = body(exchange, maxBody);
            if (transcription) {
                requireKeys(body, Set.of("requestId", "artifactId", "artifactVersionId"), Set.of("language"),
                        "transcription request");
                var result = speech.transcribe(tenantId, principalId, new MediaDevSpeechRuntime.TranscribeRequest(
                        string(body.get("requestId"), "requestId"), string(body.get("artifactId"), "artifactId"),
                        string(body.get("artifactVersionId"), "artifactVersionId"),
                        body.get("language") == null ? null : string(body.get("language"), "language")));
                Map<String, Object> view = new LinkedHashMap<>();
                view.put("schema", MediaDevSpeechRuntime.SCHEMA);
                view.put("transcript", outputView(result.transcript()));
                view.put("captions", outputView(result.captions()));
                view.put("text", result.text());
                view.put("cueCount", result.cueCount());
                view.put("replayed", result.transcript().replayed() && result.captions().replayed());
                view.put("scope", "DEV_ONLY");
                view.put("note", "DEV_ONLY local recognizer output; not a production, quality, measurement or approval claim");
                out.json(exchange, result.transcript().replayed() ? 200 : 201, view);
            } else {
                requireKeys(body, Set.of("requestId", "text"), Set.of("voice", "speakingRate"), "synthesis request");
                var result = speech.synthesize(tenantId, principalId, new MediaDevSpeechRuntime.SynthesizeRequest(
                        string(body.get("requestId"), "requestId"), string(body.get("text"), "text"),
                        body.get("voice") == null ? null : string(body.get("voice"), "voice"),
                        body.get("speakingRate") == null ? 1.0 : decimal(body.get("speakingRate"), "speakingRate")));
                Map<String, Object> view = outputView(result);
                view.put("schema", MediaDevSpeechRuntime.SCHEMA);
                view.put("scope", "DEV_ONLY");
                view.put("note", "DEV_ONLY synthesized speech (stock voice, no cloning); not a production or quality claim");
                out.json(exchange, result.replayed() ? 200 : 201, view);
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
            var found = speech.reopen(tenantId, principalId, pathSegment(single.group(1)));
            if (found.isEmpty()) {
                out.error(exchange, 404, "SPEECH_OUTPUT_NOT_FOUND",
                        "Speech output is not available in this tenant and owner scope", Map.of());
                return;
            }
            Map<String, Object> view = outputView(found.get());
            view.put("schema", MediaDevSpeechRuntime.SCHEMA);
            view.put("scope", "DEV_ONLY");
            out.json(exchange, 200, view);
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Speech route not found", Map.of());
    }

    private static Map<String, Object> outputView(MediaDevSpeechRuntime.SpeechOutput output) {
        MediaArtifact artifact = output.artifact();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("outputId", artifact.artifactId());
        view.put("artifact", Map.of(
                "artifactId", artifact.artifactId(),
                "artifactVersionId", artifact.version().value(),
                "contentType", artifact.contentType(),
                "sizeBytes", artifact.sizeBytes(),
                "sha256", artifact.sha256(),
                "artifactPath", "/api/v1/artifacts/" + artifact.artifactId()));
        view.put("lineage", output.lineage());
        view.put("replayed", output.replayed());
        return view;
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

    private static String string(Object value, String field) {
        if (!(value instanceof String text)) throw new IllegalArgumentException(field + " must be a string");
        return text;
    }

    private static double decimal(Object value, String field) {
        if (!(value instanceof Number number) || value instanceof Boolean) {
            throw new IllegalArgumentException(field + " must be a number");
        }
        double parsed = new java.math.BigDecimal(number.toString()).doubleValue();
        if (!Double.isFinite(parsed)) throw new IllegalArgumentException(field + " must be finite");
        return parsed;
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
