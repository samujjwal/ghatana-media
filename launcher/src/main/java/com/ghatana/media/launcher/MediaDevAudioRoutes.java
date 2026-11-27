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
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
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

    private static final class OperationOutcomeFailure extends RuntimeException {
        private final int status;
        private final String outcome;
        OperationOutcomeFailure(int status, String outcome) {
            super(null, null, false, false);
            this.status = status;
            this.outcome = outcome;
        }
    }

    MediaDevAudioRoutes(MediaDevAudioRestorationRuntime audio, MediaRuntime runtime) {
        this.audio = audio;
        this.runtime = runtime;
    }

    static boolean handles(String path) { return path.startsWith("/dev/v1/audio/"); }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (OperationOutcomeFailure failure) {
            out.json(exchange, failure.status, operationOutcomeView(failure.outcome));
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
            boolean capabilityRequest = false;
            if (RESTORATIONS.equals(path)) {
                MediaDevAudioRestorationRuntime.AudioOutput result;
                if (body.containsKey("input1") || body.containsKey("input2") || body.containsKey("parameters")) {
                    capabilityRequest = true;
                    MediaDevAudioRestorationRuntime.NoiseSuppressionRequest request;
                    try {
                        requireKeys(body, Set.of("requestId", "input1", "input2", "parameters"), Set.of(),
                                "noise-suppression request");
                        request = noiseSuppressionRequest(body);
                    } catch (RuntimeException invalid) {
                        throw operationRejected(invalid);
                    }
                    try {
                        result = audio.suppressNoise(tenantId, principalId, request);
                    } catch (RuntimeException failure) {
                        throw operationFailure(failure);
                    }
                } else {
                    requireKeys(body, Set.of("requestId", "artifactId", "artifactVersionId", "operations"), Set.of(),
                            "restoration request");
                    var request = new MediaDevAudioRestorationRuntime.RestoreRequest(
                            string(body.get("requestId"), "requestId"), string(body.get("artifactId"), "artifactId"),
                            string(body.get("artifactVersionId"), "artifactVersionId"), operations(body.get("operations")));
                    result = audio.restore(tenantId, principalId, request);
                }
                out.json(exchange, result.replayed() ? 200 : 201,
                        capabilityRequest ? operationResultView(result) : view(result));
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

    private static Map<String, Object> operationResultView(MediaDevAudioRestorationRuntime.AudioOutput result) {
        MediaArtifact artifact = result.artifact();
        Map<?, ?> provenance = (Map<?, ?>) result.lineage().get("provenance");
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("artifactId", artifact.artifactId());
        payload.put("versionId", artifact.version().value());
        payload.put("declaredMediaType", artifact.contentType());
        payload.put("declaredByteLength", artifact.sizeBytes());
        Object input1 = result.lineage().get("input1");
        if (input1 instanceof Map<?, ?> input && input.get("payload") instanceof Map<?, ?> sourcePayload
                && sourcePayload.get("sourceRef") instanceof String sourceRef) {
            payload.put("sourceRef", sourceRef);
        }
        return Map.of("outcome", "SUCCEEDED", "observedAt", provenance.get("observedAt"),
                "outputs", List.of(Map.of("artifactType",
                        "derived-audio-candidate-with-source-preserved-and-measurements", "payload", payload)),
                "provenance", provenance, "implementationState", "UNKNOWN", "qualificationState", "NOT_EVALUATED",
                "runtimeAvailability", "UNKNOWN");
    }

    private static Map<String, Object> operationOutcomeView(String outcome) {
        String observedAt = Instant.now().toString();
        Map<String, Object> provenance = new LinkedHashMap<>();
        provenance.put("operationRef", MediaDevAudioRestorationRuntime.OP_RMS_NOISE_SUPPRESSION);
        provenance.put("observedAt", observedAt);
        provenance.put("sourceRefs", List.of());
        return Map.of("outcome", outcome, "observedAt", observedAt, "outputs", List.of(), "provenance", provenance,
                "implementationState", "UNKNOWN", "qualificationState", "NOT_EVALUATED", "runtimeAvailability", "UNKNOWN");
    }

    private static OperationOutcomeFailure operationRejected(RuntimeException failure) {
        int status = failure instanceof MediaDevAudioRestorationRuntime.AudioRefusedException refused
                ? refused.status() : 400;
        return new OperationOutcomeFailure(status, "REJECTED");
    }

    private static OperationOutcomeFailure operationFailure(RuntimeException failure) {
        if (failure instanceof MediaDevAudioRestorationRuntime.AudioOutcomeUnknownException
                || failure instanceof MediaDevAudioRestorationRuntime.AudioRegistrationFailedException) {
            return new OperationOutcomeFailure(503, "UNKNOWN_OUTCOME");
        }
        if (failure instanceof MediaDevRequestLedger.LedgerRefusedException refused) {
            return refused.status() >= 500
                    ? new OperationOutcomeFailure(503, "UNKNOWN_OUTCOME")
                    : new OperationOutcomeFailure(refused.status(), "REJECTED");
        }
        if (failure instanceof MediaDevAudioRestorationRuntime.AudioRequestReusedException) {
            return new OperationOutcomeFailure(409, "REJECTED");
        }
        if (failure instanceof MediaDevAudioRestorationRuntime.AudioRefusedException refused) {
            return new OperationOutcomeFailure(refused.status(), "REJECTED");
        }
        if (failure instanceof MediaDevProjectRenderRuntime.SourceVersionUnavailableException) {
            return new OperationOutcomeFailure(404, "REJECTED");
        }
        if (failure instanceof MediaDevRenderAdmission.CapacityExhaustedException) {
            return new OperationOutcomeFailure(429, "REJECTED");
        }
        // An unexpected runtime failure after entering the operation path may follow processing or registration.
        return new OperationOutcomeFailure(503, "UNKNOWN_OUTCOME");
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

    private static MediaDevAudioRestorationRuntime.NoiseSuppressionRequest noiseSuppressionRequest(Map<String, Object> body) {
        Map<String, Object> input1 = object(body.get("input1"), "input1");
        requireKeys(input1, Set.of("artifactType", "payload"), Set.of(), "input1");
        if (!"audio-artifact".equals(string(input1.get("artifactType"), "input1.artifactType"))) {
            throw new IllegalArgumentException("input1.artifactType must be audio-artifact");
        }
        Map<String, Object> audio = object(input1.get("payload"), "input1.payload");
        requireKeys(audio, Set.of("artifactId", "versionId"),
                Set.of("sourceRef", "declaredMediaType", "declaredByteLength"), "input1.payload");
        var input = new MediaDevAudioRestorationRuntime.NoiseInput(
                string(audio.get("artifactId"), "input1.payload.artifactId"),
                string(audio.get("versionId"), "input1.payload.versionId"),
                audio.containsKey("sourceRef") ? string(audio.get("sourceRef"), "input1.payload.sourceRef") : null,
                audio.containsKey("declaredMediaType")
                        ? string(audio.get("declaredMediaType"), "input1.payload.declaredMediaType") : null,
                audio.containsKey("declaredByteLength")
                        ? nonNegativeLong(audio.get("declaredByteLength"), "input1.payload.declaredByteLength") : null);

        Map<String, Object> input2 = object(body.get("input2"), "input2");
        requireKeys(input2, Set.of("artifactType", "payload"), Set.of(), "input2");
        if (!"preservation-and-enhancement-policy".equals(string(input2.get("artifactType"), "input2.artifactType"))) {
            throw new IllegalArgumentException("input2.artifactType must be preservation-and-enhancement-policy");
        }
        Map<String, Object> policy = object(input2.get("payload"), "input2.payload");
        requireKeys(policy, Set.of(), Set.of("purposeRef", "rightsEvidenceRefs", "consentRef", "retentionPolicyRef",
                "policyDecisionRef"), "input2.payload");
        List<String> evidenceRefs = new java.util.ArrayList<>();
        if (policy.containsKey("rightsEvidenceRefs")) {
            Object value = policy.get("rightsEvidenceRefs");
            if (!(value instanceof List<?> values) || values.isEmpty() || values.size() > 32) {
                throw new IllegalArgumentException("input2.payload.rightsEvidenceRefs must contain 1-32 references");
            }
            for (Object ref : values) evidenceRefs.add(string(ref, "input2.payload.rightsEvidenceRefs[]"));
        }
        var policyInput = new MediaDevAudioRestorationRuntime.NoisePolicy(
                policy.containsKey("purposeRef") ? string(policy.get("purposeRef"), "input2.payload.purposeRef") : null,
                evidenceRefs,
                policy.containsKey("consentRef") ? string(policy.get("consentRef"), "input2.payload.consentRef") : null,
                policy.containsKey("retentionPolicyRef")
                        ? string(policy.get("retentionPolicyRef"), "input2.payload.retentionPolicyRef") : null,
                policy.containsKey("policyDecisionRef")
                        ? string(policy.get("policyDecisionRef"), "input2.payload.policyDecisionRef") : null);

        Map<String, Object> parameters = object(body.get("parameters"), "parameters");
        requireKeys(parameters, Set.of("noiseOnlyFrameRange", "profileRef"), Set.of(), "parameters");
        Map<String, Object> range = object(parameters.get("noiseOnlyFrameRange"), "parameters.noiseOnlyFrameRange");
        requireKeys(range, Set.of("startFrame", "endFrame"), Set.of(), "parameters.noiseOnlyFrameRange");
        var noiseRange = new MediaDevAudioRestorationRuntime.NoiseRange(
                nonNegativeLong(range.get("startFrame"), "parameters.noiseOnlyFrameRange.startFrame"),
                nonNegativeLong(range.get("endFrame"), "parameters.noiseOnlyFrameRange.endFrame"));
        var noiseParameters = new MediaDevAudioRestorationRuntime.NoiseParameters(noiseRange,
                string(parameters.get("profileRef"), "parameters.profileRef"));
        return new MediaDevAudioRestorationRuntime.NoiseSuppressionRequest(
                string(body.get("requestId"), "requestId"), input, policyInput, noiseParameters);
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

    private static long nonNegativeLong(Object value, String field) {
        if (!(value instanceof Integer || value instanceof Long || value instanceof Short)) {
            throw new IllegalArgumentException(field + " must be an integer");
        }
        long number = ((Number) value).longValue();
        if (number < 0 || number > 2_147_483_648L) throw new IllegalArgumentException(field + " is out of range");
        return number;
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
