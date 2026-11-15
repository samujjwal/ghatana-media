package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevIntakeRuntime.IntakeRefusedException;
import com.ghatana.media.runtime.MediaArtifactVersionLedgerContracts.Version;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY versioned artifact intake routes, outside the canonical manifest and OpenAPI.
 *
 * <ul>
 *   <li>{@code POST /dev/v1/intakes} body {@code {lineageId, artifactId, artifactVersionId}} (permissions
 *       {@code media:project:dev:write}, {@code media:artifact:read}): registers a finalised artifact as the next
 *       immutable version of the lineage with its media probe. 201 for a new version, 200 when the lineage already
 *       held this exact content.</li>
 *   <li>{@code GET /dev/v1/intakes/{lineageId}}: owner-scoped version list with parent links, probes and the live
 *       PROCESSING admission verdict of each exact version.</li>
 * </ul>
 */
final class MediaDevIntakeRoutes {
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}");
    private static final Pattern CREATE = Pattern.compile("^/dev/v1/intakes$");
    private static final Pattern ONE = Pattern.compile("^/dev/v1/intakes/([^/]+)$");
    private static final ObjectMapper MAPPER = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();

    private final MediaRuntime runtime;
    private final MediaDevIntakeRuntime intake;

    MediaDevIntakeRoutes(MediaRuntime runtime, MediaDevIntakeRuntime intake) {
        this.runtime = java.util.Objects.requireNonNull(runtime, "runtime");
        this.intake = java.util.Objects.requireNonNull(intake, "intake");
    }

    static boolean handles(String path) { return path.equals("/dev/v1/intakes") || path.startsWith("/dev/v1/intakes/"); }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId) throws IOException {
        try {
            if (CREATE.matcher(path).matches()) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")) {
                    runtime.recordDeniedRequest();
                    error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED", "DEV_ONLY artifact read permission is required");
                    return;
                }
                Map<String, Object> body = MAPPER.readValue(
                        MediaHttpHandler.boundedBody(exchange, runtime.config().maximumBodyBytes(), false),
                        new TypeReference<Map<String, Object>>() { });
                if (body == null || !body.keySet().equals(Set.of("lineageId", "artifactId", "artifactVersionId"))) {
                    throw new IllegalArgumentException("intake fields do not match their declared shape");
                }
                String lineageId = id(body.get("lineageId"), "lineageId");
                var registered = intake.register(tenantId, principalId, lineageId, text(body.get("artifactId"), "artifactId"),
                        text(body.get("artifactVersionId"), "artifactVersionId"));
                Map<String, Object> out = versionView(tenantId, registered.version());
                out.put("deduplicated", registered.deduplicated());
                json(exchange, registered.deduplicated() ? 200 : 201, out);
                return;
            }
            Matcher one = ONE.matcher(path);
            if (one.matches()) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                String lineageId = segment(one.group(1));
                List<Version> versions = intake.versions(tenantId, principalId, lineageId);
                if (versions.isEmpty()) {
                    error(exchange, 404, "INTAKE_LINEAGE_NOT_FOUND", "No such lineage for this principal");
                    return;
                }
                List<Object> views = new ArrayList<>();
                for (Version version : versions) views.add(versionView(tenantId, version));
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("lineageId", lineageId);
                out.put("latestVersionNumber", versions.get(versions.size() - 1).versionNumber());
                out.put("versions", views);
                out.put("scope", "DEV_ONLY");
                out.put("establishesApproval", false);
                json(exchange, 200, out);
                return;
            }
            error(exchange, 404, "NOT_FOUND", "Intake route not found");
        } catch (IntakeRefusedException refused) {
            if (refused.status() == 404 || refused.status() == 403) runtime.recordDeniedRequest();
            error(exchange, refused.status(), refused.code(), refused.getMessage());
        } catch (IllegalArgumentException | tools.jackson.core.JacksonException invalid) {
            error(exchange, 400, "INVALID_REQUEST", "Intake request is invalid");
        } catch (IllegalStateException failure) {
            error(exchange, 503, "INTAKE_STATE_UNAVAILABLE", "Intake state could not be read or updated");
        }
    }

    private Map<String, Object> versionView(String tenantId, Version version) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("lineageId", version.lineageId());
        view.put("versionNumber", version.versionNumber());
        view.put("artifactId", version.artifactId());
        view.put("artifactVersionId", version.artifactVersionId());
        view.put("sha256", version.contentSha256());
        view.put("sizeBytes", version.sizeBytes());
        view.put("parentArtifactVersionId", version.parentArtifactVersionId());
        view.put("createdAt", version.createdAt().toString());
        try {
            view.put("probe", MAPPER.readValue(version.probeJson(), new TypeReference<Map<String, Object>>() { }));
        } catch (RuntimeException unreadable) {
            view.put("probe", null);
        }
        Resolution resolution = intake.admission(tenantId, version);
        Map<String, Object> admission = new LinkedHashMap<>();
        admission.put("scope", "PROCESSING");
        if (resolution == null) {
            admission.put("verdict", "UNAVAILABLE");
            admission.put("reasons", List.of("RIGHTS_AUTHORITY_NOT_AVAILABLE"));
            admission.put("attestationIds", List.of());
        } else {
            admission.put("verdict", resolution.verdict().name());
            admission.put("reasons", resolution.reasons().stream().map(Enum::name).sorted().toList());
            admission.put("attestationIds", resolution.attestationIds());
        }
        admission.put("usableForProcessing", resolution != null && "ADMITTED".equals(resolution.verdict().name()));
        view.put("processingAdmission", admission);
        view.put("scope", "DEV_ONLY");
        view.put("establishesApproval", false);
        return view;
    }

    private static String id(Object value, String name) {
        String text = text(value, name);
        if (!ID.matcher(text).matches()) throw new IllegalArgumentException(name + " must be an opaque id");
        return text;
    }

    private static String text(Object value, String name) {
        if (!(value instanceof String text) || text.isBlank() || !text.equals(text.strip()) || text.length() > 384) {
            throw new IllegalArgumentException(name + " must be an exact non-blank string");
        }
        return text;
    }

    private static String segment(String raw) {
        String decoded = URLDecoder.decode(raw.replace("+", "%2B"), StandardCharsets.UTF_8);
        if (!ID.matcher(decoded).matches()) throw new IllegalArgumentException("Path identifier is not a valid opaque id");
        return decoded;
    }

    private void methodNotAllowed(HttpExchange exchange, String allow) throws IOException {
        exchange.getResponseHeaders().set("Allow", allow);
        error(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    }

    private void error(HttpExchange exchange, int status, String code, String message) throws IOException {
        String requestId = exchange.getRequestHeaders().getFirst("X-Request-ID");
        if (requestId == null || !ID.matcher(requestId).matches()) requestId = UUID.randomUUID().toString();
        exchange.getResponseHeaders().set("X-Request-ID", requestId);
        json(exchange, status, Map.of(
                "error", Map.of("code", code, "message", message, "retryable", status == 503,
                        "evidenceRefs", List.of(), "actionRefs", List.of()),
                "meta", Map.of("requestId", requestId, "correlationId", requestId,
                        "timestamp", Instant.now().toString(), "apiVersion", "1.0.0")));
    }

    private void json(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = MAPPER.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var output = exchange.getResponseBody()) { output.write(bytes); }
    }
}
