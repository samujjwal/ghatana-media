package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaHeadLedgerContracts.Event;
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
 * DEV_ONLY quality-optimization routes (outside the canonical manifest/OpenAPI), J-19:
 * {@code GET /dev/v1/quality/status}, {@code POST /dev/v1/quality/optimizations},
 * {@code GET /dev/v1/quality/optimizations/{reportArtifactId}},
 * {@code POST /dev/v1/quality/optimizations/{requestId}/cancel}, {@code GET /dev/v1/quality/lineages/{lineageId}} and
 * {@code POST /dev/v1/quality/lineages/{lineageId}/undo}. Permissions are {@code media:project:dev:write|read} plus
 * {@code media:artifact:read} (and {@code media:artifact:create} for the optimization POST). The acting principal is the
 * authenticated caller; no body field names one. Every bound is validated while the body is parsed, so an out-of-range
 * request is refused (422 {@code QUALITY_PARAMETER_OUT_OF_RANGE}) before any source lookup, rights check or process.
 */
final class MediaDevQualityRoutes {
    static final String PREFIX = "/dev/v1/quality/";
    static final String OPTIMIZATIONS = "/dev/v1/quality/optimizations";
    private static final Pattern OPTIMIZATION = Pattern.compile("^/dev/v1/quality/optimizations/([^/]+)$");
    private static final Pattern CANCEL = Pattern.compile("^/dev/v1/quality/optimizations/([^/]+)/cancel$");
    private static final Pattern LINEAGE = Pattern.compile("^/dev/v1/quality/lineages/([^/]+)$");
    private static final Pattern UNDO = Pattern.compile("^/dev/v1/quality/lineages/([^/]+)/undo$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();

    private final MediaDevQualityOptimizationRuntime quality;
    private final MediaRuntime runtime;

    MediaDevQualityRoutes(MediaDevQualityOptimizationRuntime quality, MediaRuntime runtime) {
        this.quality = quality;
        this.runtime = runtime;
    }

    static boolean handles(String path) { return path.startsWith(PREFIX); }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY quality capacity is exhausted; retry the same requestId after the Retry-After delay",
                    Map.of("scope", failure.scope()));
        } catch (MediaDevQualityOptimizationRuntime.QualityParameterException failure) {
            out.error(exchange, 422, failure.code(), failure.getMessage(), Map.of("parameter", failure.parameter()));
        } catch (MediaDevVideoRuntime.VideoParameterException failure) {
            out.error(exchange, 422, "QUALITY_PARAMETER_OUT_OF_RANGE", failure.getMessage(),
                    Map.of("parameter", failure.parameter()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact source artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevVideoRuntime.VideoRightsNotAdmittedException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, "RIGHTS_AUTHORITY_UNAVAILABLE".equals(failure.code()) ? 503 : 403, failure.code(),
                    "The source version has no current PROCESSING rights and consent admission; nothing was run",
                    Map.of("scope", "PROCESSING", "verdict", failure.resolution().verdict().name(),
                            "artifactId", failure.artifactId(),
                            "reasons", failure.resolution().reasons().stream().map(Enum::name).sorted().toList()));
        } catch (MediaDevQualityOptimizationRuntime.QualityCancelledException failure) {
            out.error(exchange, 409, "OPTIMIZATION_CANCELLED",
                    "The search was cancelled; nothing was registered and the head did not move. "
                            + "Retry the same requestId to run it again",
                    Map.of("outcome", "CANCELLED"));
        } catch (MediaDevVideoRuntime.VideoOutcomeUnknownException failure) {
            out.error(exchange, 503, "OPTIMIZATION_OUTCOME_UNKNOWN",
                    "A video process did not finish; its outcome is UNKNOWN and nothing was registered. "
                            + "Retry the same requestId",
                    Map.of("outcome", "UNKNOWN"));
        } catch (MediaDevQualityOptimizationRuntime.QualityRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevVideoRuntime.VideoRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevRequestLedger.LedgerRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevVideoRuntime.VideoRequestReusedException failure) {
            out.error(exchange, 409, "QUALITY_REQUEST_ID_REUSED",
                    "requestId was already used with a different optimization request", Map.of());
        } catch (MediaDevVideoRuntime.VideoRegistrationFailedException failure) {
            out.error(exchange, 502, "QUALITY_OUTPUT_REGISTRATION_FAILED",
                    "The output was not registered; retry with the same requestId to resume", Map.of());
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if ((PREFIX + "status").equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, quality.status());
            return;
        }
        if (OPTIMIZATIONS.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!artifactPermissions(exchange, out, true)) return;
            Map<String, Object> body = body(exchange, maxBody);
            MediaDevQualityOptimizationRuntime.QualityResult result =
                    quality.optimize(tenantId, principalId, parseOptimization(body));
            out.json(exchange, result.replayed() ? 200 : 201, view(tenantId, principalId, result, lineageIdOf(body)));
            return;
        }
        Matcher cancel = CANCEL.matcher(path);
        if (cancel.matches()) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            String requestId = pathSegment(cancel.group(1));
            if (!quality.cancel(tenantId, principalId, requestId)) {
                out.error(exchange, 404, "OPTIMIZATION_NOT_RUNNING",
                        "No search with this requestId is running for this principal", Map.of());
                return;
            }
            out.json(exchange, 200, Map.of("requestId", requestId, "cancelRequested", true, "scope", "DEV_ONLY"));
            return;
        }
        Matcher optimization = OPTIMIZATION.matcher(path);
        if (optimization.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!artifactPermissions(exchange, out, false)) return;
            var found = quality.reopenReport(tenantId, principalId, pathSegment(optimization.group(1)));
            if (found.isEmpty()) {
                out.error(exchange, 404, "QUALITY_OUTPUT_NOT_FOUND",
                        "The optimization report is not available in this tenant and owner scope", Map.of());
                return;
            }
            Object lineageId = found.get().reportLineage().get("lineageId");
            out.json(exchange, 200, view(tenantId, principalId, found.get(),
                    lineageId instanceof String text ? text : null));
            return;
        }
        Matcher undo = UNDO.matcher(path);
        if (undo.matches()) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!artifactPermissions(exchange, out, false)) return;
            Map<String, Object> body = body(exchange, maxBody);
            requireKeys(body, Set.of("requestId", "expectedHeadArtifactVersionId"), Set.of(), "undo request");
            String lineageId = pathSegment(undo.group(1));
            var result = quality.undo(tenantId, principalId, lineageId, string(body.get("requestId"), "requestId"),
                    string(body.get("expectedHeadArtifactVersionId"), "expectedHeadArtifactVersionId"));
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("schema", "media.dev.quality-undo.v1");
            view.put("lineageId", lineageId);
            if (result.undone() != null) view.put("undone", MediaDevQualityOptimizationRuntime.eventView(result.undone()));
            view.put("head", MediaDevQualityOptimizationRuntime.eventView(result.head()));
            view.put("undoable", result.state().undoable());
            view.put("replayed", result.replayed());
            view.put("scope", "DEV_ONLY");
            out.json(exchange, result.replayed() ? 200 : 201, view);
            return;
        }
        Matcher lineage = LINEAGE.matcher(path);
        if (lineage.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!artifactPermissions(exchange, out, false)) return;
            String lineageId = pathSegment(lineage.group(1));
            var found = quality.lineage(tenantId, principalId, lineageId);
            if (found.isEmpty()) {
                out.error(exchange, 404, "QUALITY_LINEAGE_NOT_FOUND", "No such lineage for this principal", Map.of());
                return;
            }
            out.json(exchange, 200, lineageView(found.get()));
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Quality route not found", Map.of());
    }

    private boolean artifactPermissions(HttpExchange exchange, MediaDevCreativeOutputRoutes.Responder out,
                                        boolean create) throws IOException {
        if (MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                && (!create || MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create"))) {
            return true;
        }
        runtime.recordDeniedRequest();
        out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                "DEV_ONLY artifact read" + (create ? " and create" : "") + " permissions are required", Map.of());
        return false;
    }

    private static Map<String, Object> body(HttpExchange exchange, int maxBody) throws IOException {
        Map<String, Object> body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                new TypeReference<Map<String, Object>>() { });
        if (body == null) throw new IllegalArgumentException("request body is required");
        return body;
    }

    // ------------------------------------------------------------------ request parsing

    private static String lineageIdOf(Map<String, Object> body) { return (String) body.get("lineageId"); }

    private static MediaDevQualityOptimizationRuntime.OptimizeRequest parseOptimization(Map<String, Object> body) {
        requireKeys(body, Set.of("requestId", "lineageId", "artifactId", "artifactVersionId", "target"),
                Set.of("search"), "optimization request");
        Map<String, Object> target = object(body.get("target"), "target");
        String type = string(target.get("type"), "target.type");
        MediaDevQualityOptimizationRuntime.Target parsed;
        switch (type) {
            case "MIN_BYTES_AT_QUALITY" -> {
                requireKeys(target, Set.of("type", "metric", "minQuality"), Set.of(), "target");
                parsed = new MediaDevQualityOptimizationRuntime.Target(MediaDevQualitySearch.Goal.MIN_BYTES_AT_QUALITY,
                        MediaDevQualityOptimizationRuntime.Metric.parse(string(target.get("metric"), "target.metric")),
                        decimal(target.get("minQuality"), "target.minQuality"), 0);
            }
            case "MAX_QUALITY_UNDER_BYTES" -> {
                requireKeys(target, Set.of("type", "metric", "maxBytes"), Set.of(), "target");
                parsed = new MediaDevQualityOptimizationRuntime.Target(MediaDevQualitySearch.Goal.MAX_QUALITY_UNDER_BYTES,
                        MediaDevQualityOptimizationRuntime.Metric.parse(string(target.get("metric"), "target.metric")),
                        0, whole(target.get("maxBytes"), "target.maxBytes"));
            }
            default -> throw new MediaDevQualityOptimizationRuntime.QualityParameterException("target.type",
                    "target.type must be MIN_BYTES_AT_QUALITY or MAX_QUALITY_UNDER_BYTES");
        }
        int crfMin = MediaDevQualityOptimizationRuntime.DEFAULT_CRF_MIN;
        int crfMax = MediaDevQualityOptimizationRuntime.DEFAULT_CRF_MAX;
        int attempts = MediaDevQualityOptimizationRuntime.DEFAULT_ATTEMPTS;
        if (body.containsKey("search")) {
            Map<String, Object> search = object(body.get("search"), "search");
            requireKeys(search, Set.of(), Set.of("crfMin", "crfMax", "maxAttempts"), "search");
            if (search.containsKey("crfMin")) crfMin = (int) clampedInt(search.get("crfMin"), "search.crfMin");
            if (search.containsKey("crfMax")) crfMax = (int) clampedInt(search.get("crfMax"), "search.crfMax");
            if (search.containsKey("maxAttempts")) attempts = (int) clampedInt(search.get("maxAttempts"), "search.maxAttempts");
        }
        return new MediaDevQualityOptimizationRuntime.OptimizeRequest(string(body.get("requestId"), "requestId"),
                string(body.get("lineageId"), "lineageId"), string(body.get("artifactId"), "artifactId"),
                string(body.get("artifactVersionId"), "artifactVersionId"), parsed, crfMin, crfMax, attempts);
    }

    // ------------------------------------------------------------------ response

    private Map<String, Object> view(String tenantId, String principalId,
                                     MediaDevQualityOptimizationRuntime.QualityResult result, String lineageId) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevQualityOptimizationRuntime.REPORT_SCHEMA);
        view.put("outcome", result.selected() ? "SELECTED" : "ABSTAINED");
        view.put("report", result.document());
        view.put("reportSha256", result.reportLineage().get("reportSha256"));
        view.put("reportArtifact", artifactView(result.report()));
        if (result.selected()) {
            Map<String, Object> chosen = new LinkedHashMap<>(artifactView(result.chosen()));
            chosen.put("lineage", result.chosenLineage());
            view.put("chosen", chosen);
        } else {
            view.put("chosen", null);
        }
        if (result.applied() != null) view.put("applied", MediaDevQualityOptimizationRuntime.eventView(result.applied()));
        if (lineageId != null) {
            quality.lineage(tenantId, principalId, lineageId).ifPresent(found -> view.put("lineage", lineageView(found)));
        }
        view.put("replayed", result.replayed());
        if (result.admission() != null) {
            view.put("admission", Map.of("scope", "PROCESSING", "verdict", result.admission().verdict().name(),
                    "attestationIds", result.admission().attestationIds(),
                    "resolverId", result.admission().resolverId()));
        }
        view.put("scope", "DEV_ONLY");
        view.put("note", "DEV_ONLY measured luma SSIM/PSNR of real encodes; the chosen version is a new immutable "
                + "artifact with no rights attestation of its own; no perceptual, rights, approval or production claim");
        return view;
    }

    private static Map<String, Object> artifactView(MediaArtifact artifact) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("artifactId", artifact.artifactId());
        view.put("artifactVersionId", artifact.version().value());
        view.put("contentType", artifact.contentType());
        view.put("sizeBytes", artifact.sizeBytes());
        view.put("sha256", artifact.sha256());
        view.put("artifactPath", "/api/v1/artifacts/" + artifact.artifactId());
        return view;
    }

    private static Map<String, Object> lineageView(MediaDevQualityOptimizationRuntime.LineageView found) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("lineageId", found.lineageId());
        Event head = found.state().head().orElseThrow();
        view.put("head", MediaDevQualityOptimizationRuntime.eventView(head));
        view.put("undoable", found.state().undoable());
        List<Map<String, Object>> events = new ArrayList<>();
        for (Event event : found.events()) events.add(MediaDevQualityOptimizationRuntime.eventView(event));
        view.put("events", events);
        return view;
    }

    // ------------------------------------------------------------------ strict JSON helpers

    private static void requireKeys(Map<String, Object> value, Set<String> required, Set<String> optional, String field) {
        if (!value.keySet().containsAll(required)
                || !java.util.stream.Stream.concat(required.stream(), optional.stream())
                        .collect(java.util.stream.Collectors.toSet()).containsAll(value.keySet())) {
            throw new IllegalArgumentException(field + " fields do not match its declared shape");
        }
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

    private static long whole(Object value, String field) {
        if (!(value instanceof Integer || value instanceof Long || value instanceof Short)) {
            throw new IllegalArgumentException(field + " must be an integer");
        }
        return ((Number) value).longValue();
    }

    /** An integer; a value beyond int range is refused as out of range rather than wrapped. */
    private static long clampedInt(Object value, String field) {
        long v = whole(value, field);
        if (v < Integer.MIN_VALUE || v > Integer.MAX_VALUE) {
            throw new MediaDevQualityOptimizationRuntime.QualityParameterException(field, field + " is out of range");
        }
        return v;
    }

    private static double decimal(Object value, String field) {
        if (!(value instanceof Number number)) throw new IllegalArgumentException(field + " must be a number");
        return number.doubleValue();
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
