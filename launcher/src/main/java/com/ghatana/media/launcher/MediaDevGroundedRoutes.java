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
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * DEV_ONLY grounded-answer routes (outside the canonical manifest/OpenAPI):
 * {@code GET /dev/v1/grounded-answers/status}, {@code POST /dev/v1/grounded-answers} and
 * {@code GET /dev/v1/grounded-answers/{outputId}}. Every response is labelled DEV_ONLY.
 */
final class MediaDevGroundedRoutes {
    private static final Logger log = LoggerFactory.getLogger(MediaDevGroundedRoutes.class);
    static final String STATUS = "/dev/v1/grounded-answers/status";
    static final String ANSWERS = "/dev/v1/grounded-answers";
    private static final Pattern OUTPUT = Pattern.compile("^/dev/v1/grounded-answers/([^/]+)$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();

    private final MediaDevGroundedAnswerRuntime grounded;
    private final MediaRuntime runtime;

    MediaDevGroundedRoutes(MediaDevGroundedAnswerRuntime grounded, MediaRuntime runtime) {
        this.grounded = grounded;
        this.runtime = runtime;
    }

    static boolean handles(String path) {
        return path.equals(ANSWERS) || path.startsWith(ANSWERS + "/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY grounded-answer capacity is exhausted; retry the same requestId after the Retry-After delay",
                    Map.of("scope", failure.scope()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact source artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevGroundedAnswerRuntime.GroundedRightsNotAdmittedException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, "RIGHTS_AUTHORITY_UNAVAILABLE".equals(failure.code()) ? 503 : 403, failure.code(),
                    "The exact source version has no current PROCESSING rights and consent admission; no answer was produced and nothing was registered",
                    Map.of("scope", "PROCESSING", "verdict", failure.resolution().verdict().name(),
                            "reasons", failure.resolution().reasons().stream().map(Enum::name).sorted().toList()));
        } catch (MediaDevGroundedClock.ClockBindingException failure) {
            out.error(exchange, 409, failure.code(),
                    "A child result is not bound to the source's exact clock and version; the request was refused and nothing was registered",
                    Map.of("detail", failure.getMessage()));
        } catch (MediaDevGroundedAnswerRuntime.GroundedRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevRequestLedger.LedgerRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevGroundedAnswerRuntime.GroundedRequestReusedException failure) {
            out.error(exchange, 409, "GROUNDED_REQUEST_ID_REUSED",
                    "requestId was already used with a different grounded-answer request or result", Map.of());
        } catch (MediaDevGroundedAnswerRuntime.GroundedRegistrationFailedException failure) {
            out.error(exchange, 502, "GROUNDED_OUTPUT_REGISTRATION_FAILED",
                    "The answer was not registered; retry with the same requestId to resume", Map.of());
        } catch (IllegalStateException failure) {
            // Keep unexpected grounded-lane state failures out of MediaHttpHandler's broad timeline conflict mapper.
            // The output may already have been registered, so the response must not claim that nothing happened.
            log.error("Unexpected state failure in DEV_ONLY grounded-answer route", failure);
            out.error(exchange, 500, "GROUNDED_INTERNAL_ERROR",
                    "The grounded-answer result could not be confirmed; inspect the same requestId before retrying",
                    Map.of());
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (STATUS.equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, grounded.status());
            return;
        }
        if (ANSWERS.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                    || !MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create")) {
                runtime.recordDeniedRequest();
                out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                        "DEV_ONLY artifact read and create permissions are required for grounded answers", Map.of());
                return;
            }
            Map<String, Object> body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                    new TypeReference<Map<String, Object>>() { });
            if (body == null) throw new IllegalArgumentException("request body is required");
            Set<String> allowed = Set.of("requestId", "artifactId", "artifactVersionId", "question", "language",
                    "allowPartial");
            Set<String> required = Set.of("requestId", "artifactId", "artifactVersionId", "question");
            if (!body.keySet().containsAll(required) || !allowed.containsAll(body.keySet())) {
                throw new IllegalArgumentException("grounded-answer request fields do not match its declared shape");
            }
            Object partial = body.getOrDefault("allowPartial", Boolean.FALSE);
            if (!(partial instanceof Boolean allowPartial)) {
                throw new IllegalArgumentException("allowPartial must be a boolean");
            }
            Object language = body.get("language");
            if (language != null && !(language instanceof String)) {
                throw new IllegalArgumentException("language must be a string");
            }
            var result = grounded.ask(tenantId, principalId, new MediaDevGroundedAnswerRuntime.AskRequest(
                    string(body.get("requestId"), "requestId"), string(body.get("artifactId"), "artifactId"),
                    string(body.get("artifactVersionId"), "artifactVersionId"),
                    string(body.get("question"), "question"), (String) language, allowPartial));
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
            var found = grounded.reopen(tenantId, principalId, pathSegment(single.group(1)));
            if (found.isEmpty()) {
                out.error(exchange, 404, "GROUNDED_OUTPUT_NOT_FOUND",
                        "Grounded answer is not available in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, view(found.get()));
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Grounded-answer route not found", Map.of());
    }

    private static Map<String, Object> view(MediaDevGroundedAnswerRuntime.GroundedResult result) {
        MediaArtifact artifact = result.artifact();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevGroundedAnswerRuntime.SCHEMA);
        view.put("outputId", artifact.artifactId());
        view.put("artifact", Map.of(
                "artifactId", artifact.artifactId(),
                "artifactVersionId", artifact.version().value(),
                "contentType", artifact.contentType(),
                "sizeBytes", artifact.sizeBytes(),
                "sha256", artifact.sha256(),
                "artifactPath", "/api/v1/artifacts/" + artifact.artifactId()));
        view.put("lineage", result.lineage());
        view.put("document", result.document());
        view.put("replayed", result.replayed());
        if (result.admission() != null) {
            view.put("admission", Map.of("scope", "PROCESSING", "verdict", result.admission().verdict().name(),
                    "attestationIds", result.admission().attestationIds(),
                    "resolverId", result.admission().resolverId()));
        }
        view.put("scope", "DEV_ONLY");
        view.put("note", "DEV_ONLY local open-model output with server-validated citations; not a production, "
                + "quality, entailment, rights or approval claim");
        return view;
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
