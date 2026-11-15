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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY caption routes (outside the canonical manifest/OpenAPI):
 * {@code POST /dev/v1/captions/corrections} body {@code {requestId, baseArtifactId, expectedVersionId, cues:[{startMillis,
 * endMillis, text}]}} (permissions {@code media:project:dev:write}, {@code media:artifact:read},
 * {@code media:artifact:create}) and {@code GET /dev/v1/captions/{artifactId}} (permissions {@code media:project:dev:read}
 * and {@code media:artifact:read}). The acting principal is the authenticated caller; no body field names one.
 */
final class MediaDevCaptionRoutes {
    static final String CORRECTIONS = "/dev/v1/captions/corrections";
    private static final Pattern ONE = Pattern.compile("^/dev/v1/captions/([^/]+)$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();

    private final MediaDevCaptionRuntime captions;
    private final MediaRuntime runtime;

    MediaDevCaptionRoutes(MediaDevCaptionRuntime captions, MediaRuntime runtime) {
        this.captions = captions;
        this.runtime = runtime;
    }

    static boolean handles(String path) {
        return path.startsWith("/dev/v1/captions/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY caption capacity is exhausted; retry the same requestId after the Retry-After delay",
                    Map.of("scope", failure.scope()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact caption version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevCaptionRuntime.CaptionRefusedException failure) {
            if (failure.status() == 403) runtime.recordDeniedRequest();
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevRequestLedger.LedgerRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevCaptionRuntime.CaptionRegistrationFailedException failure) {
            out.error(exchange, 502, "CAPTION_REGISTRATION_FAILED",
                    "The corrected caption was not registered; retry with the same requestId to resume", Map.of());
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (CORRECTIONS.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                    || !MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create")) {
                runtime.recordDeniedRequest();
                out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                        "DEV_ONLY artifact read and create permissions are required for a caption correction", Map.of());
                return;
            }
            Map<String, Object> body = body(exchange, maxBody);
            requireKeys(body, Set.of("requestId", "baseArtifactId", "expectedVersionId", "cues"), Set.of(),
                    "caption correction request");
            if (!(body.get("cues") instanceof List<?> rawCues)) throw new IllegalArgumentException("cues must be an array");
            List<MediaDevCaptionRuntime.CueInput> cues = new ArrayList<>(Math.min(rawCues.size(), 6_000));
            if (rawCues.size() > MediaDevWebVtt.MAX_CUES) {
                out.error(exchange, 422, "CAPTION_LIMIT_EXCEEDED", "too many cues", Map.of());
                return;
            }
            for (Object raw : rawCues) {
                if (!(raw instanceof Map<?, ?> cue)) throw new IllegalArgumentException("each cue must be an object");
                @SuppressWarnings("unchecked") Map<String, Object> fields = (Map<String, Object>) cue;
                requireKeys(fields, Set.of("startMillis", "endMillis", "text"), Set.of(), "cue");
                cues.add(new MediaDevCaptionRuntime.CueInput(millis(fields.get("startMillis"), "startMillis"),
                        millis(fields.get("endMillis"), "endMillis"), string(fields.get("text"), "text")));
            }
            var request = new MediaDevCaptionRuntime.CorrectionRequest(string(body.get("requestId"), "requestId"),
                    string(body.get("baseArtifactId"), "baseArtifactId"),
                    string(body.get("expectedVersionId"), "expectedVersionId"), cues);
            var version = captions.correct(tenantId, principalId, request);
            Map<String, Object> view = view(tenantId, principalId, version);
            out.json(exchange, version.replayed() ? 200 : 201, view);
            return;
        }
        Matcher single = ONE.matcher(path);
        if (single.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")) {
                runtime.recordDeniedRequest();
                out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                        "DEV_ONLY artifact read permission is required", Map.of());
                return;
            }
            var found = captions.reopen(tenantId, principalId, pathSegment(single.group(1)));
            if (found.isEmpty()) {
                out.error(exchange, 404, "CAPTION_NOT_FOUND",
                        "Caption version is not available in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, view(tenantId, principalId, found.get()));
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Caption route not found", Map.of());
    }

    private Map<String, Object> view(String tenantId, String principalId, MediaDevCaptionRuntime.CaptionVersion version) {
        MediaArtifact artifact = version.artifact();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevCaptionRuntime.SCHEMA);
        view.put("captionId", artifact.artifactId());
        view.put("artifact", Map.of(
                "artifactId", artifact.artifactId(),
                "artifactVersionId", artifact.version().value(),
                "contentType", artifact.contentType(),
                "sizeBytes", artifact.sizeBytes(),
                "sha256", artifact.sha256(),
                "artifactPath", "/api/v1/artifacts/" + artifact.artifactId()));
        view.put("kind", version.lineage().get("kind"));
        List<Map<String, Object>> cues = new ArrayList<>();
        for (MediaDevWebVtt.Cue cue : version.cues()) {
            cues.add(Map.of("startMillis", cue.startMillis(), "endMillis", cue.endMillis(), "text", cue.text()));
        }
        view.put("cues", cues);
        view.put("lineage", version.lineage());
        Map<String, Object> review = new LinkedHashMap<>();
        var status = captions.reviewStatus(tenantId, principalId, artifact);
        if (status.isPresent()) {
            review.put("available", true);
            review.put("reviewCaseId", status.get().reviewCaseId());
            review.put("caseExists", status.get().caseExists());
            review.put("latestDecision", status.get().latestDecision());
            review.put("currentness", status.get().currentness());
            review.put("acceptedByAssignedReviewer", status.get().acceptedByAssignedReviewer());
        } else {
            review.put("available", false);
            review.put("acceptedByAssignedReviewer", false);
        }
        review.put("establishesApproval", false);
        view.put("review", review);
        view.put("replayed", version.replayed());
        view.put("scope", "DEV_ONLY");
        view.put("note", "DEV_ONLY caption version; machine text is unreviewed and a correction is a statement by an "
                + "authenticated DEV_ONLY principal, not a quality, measurement, approval or delivery claim");
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

    private static long millis(Object value, String field) {
        if (!(value instanceof Number number) || value instanceof Double || value instanceof Float
                || value instanceof java.math.BigDecimal) {
            throw new IllegalArgumentException(field + " must be a whole number of milliseconds");
        }
        return number.longValue();
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
