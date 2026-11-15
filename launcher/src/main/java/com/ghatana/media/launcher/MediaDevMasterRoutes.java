package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.sun.net.httpserver.HttpExchange;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY stem, mix and master routes (outside the canonical manifest/OpenAPI), journey J-17:
 * {@code GET /dev/v1/masters/status}, {@code POST /dev/v1/masters/stems}, {@code GET /dev/v1/masters/stems/{id}},
 * {@code POST /dev/v1/masters} and {@code GET /dev/v1/masters/{reportId}}. Bodies are strict (unknown or duplicate keys,
 * wrong types and out-of-range numbers are a typed 422 naming the JSON path) and are fully parsed before any lookup,
 * rights call, synthesis or encode. The acting principal is the authenticated caller. Audio is read back through the
 * exact-version {@code GET /dev/v1/artifacts/{id}/content} route.
 */
final class MediaDevMasterRoutes {
    static final String PREFIX = "/dev/v1/masters";
    static final String STATUS = PREFIX + "/status";
    static final String STEMS = PREFIX + "/stems";
    private static final Pattern STEM = Pattern.compile("^/dev/v1/masters/stems/([^/]+)$");
    private static final Pattern MASTER = Pattern.compile("^/dev/v1/masters/([^/]+)$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();
    private static final String NOTE = "DEV_ONLY mix and master; loudness and true peak are measured on the output samples. "
            + "No rights clearance beyond the recorded statements, no quality, approval or production claim";
    private static final Logger log = LoggerFactory.getLogger(MediaDevMasterRoutes.class);

    private final MediaDevMasterRuntime masters;
    private final MediaRuntime runtime;

    MediaDevMasterRoutes(MediaDevMasterRuntime masters, MediaRuntime runtime) {
        this.masters = masters;
        this.runtime = runtime;
    }

    static boolean handles(String path) {
        return path.equals(PREFIX) || path.startsWith(PREFIX + "/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId, int maxBody,
                MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY audio capacity is exhausted; retry the same requestId after the Retry-After delay",
                    Map.of("scope", failure.scope()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact stem artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevMasterRuntime.MasterRefusedException failure) {
            if (failure.status() == 403) runtime.recordDeniedRequest();
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevMasterRuntime.MasterOutcomeUnknownException failure) {
            out.error(exchange, 503, "MASTER_OUTCOME_UNKNOWN",
                    "The encode process did not finish; its outcome is UNKNOWN and nothing was registered. "
                            + "Retry the same requestId", Map.of("outcome", "UNKNOWN"));
        } catch (MediaDevRequestLedger.LedgerRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevMasterRuntime.MasterRequestReusedException failure) {
            out.error(exchange, 409, "MASTER_REQUEST_ID_REUSED",
                    "requestId was already used with a different request", Map.of());
        } catch (MediaDevMasterRuntime.MasterRegistrationFailedException failure) {
            log.warn("DEV master output registration failed cause={}", String.valueOf(failure.getCause()), failure.getCause());
            out.error(exchange, 502, "MASTER_OUTPUT_REGISTRATION_FAILED",
                    "The output was not registered; retry with the same requestId to resume", Map.of());
        } catch (IllegalArgumentException | IllegalStateException | SecurityException handled) {
            throw handled; // mapped to 400/409/403 by the host handler
        } catch (RuntimeException unexpected) {
            log.error("DEV master request failed unexpectedly", unexpected);
            throw unexpected;
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (STATUS.equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, masters.status());
            return;
        }
        if (STEMS.equals(path) || PREFIX.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!requireArtifactPermissions(exchange, true, out)) return;
            Object body = body(exchange, maxBody);
            if (STEMS.equals(path)) {
                var result = masters.generateStem(tenantId, principalId, MediaDevMasterSpec.parseStemRequest(body));
                out.json(exchange, result.replayed() ? 200 : 201, stemView(result));
            } else {
                var result = masters.master(tenantId, principalId, MediaDevMasterSpec.parseMaster(body));
                out.json(exchange, result.replayed() ? 200 : 201, masterView(result));
            }
            return;
        }
        Matcher stem = STEM.matcher(path);
        Matcher master = MASTER.matcher(path);
        if (stem.matches() || master.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!requireArtifactPermissions(exchange, false, out)) return;
            if (stem.matches()) {
                var found = masters.reopenStem(tenantId, principalId, pathSegment(stem.group(1)));
                if (found.isEmpty()) {
                    out.error(exchange, 404, "STEM_NOT_FOUND", "Stem is not available in this tenant and owner scope", Map.of());
                    return;
                }
                out.json(exchange, 200, stemView(found.get()));
            } else {
                var found = masters.reopenMaster(tenantId, principalId, pathSegment(master.group(1)));
                if (found.isEmpty()) {
                    out.error(exchange, 404, "MASTER_NOT_FOUND", "Master is not available in this tenant and owner scope", Map.of());
                    return;
                }
                out.json(exchange, 200, masterView(found.get()));
            }
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Master route not found", Map.of());
    }

    private boolean requireArtifactPermissions(HttpExchange exchange, boolean create,
                                               MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                && (!create || MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create"))) return true;
        runtime.recordDeniedRequest();
        out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                "DEV_ONLY artifact read" + (create ? " and create" : "") + " permissions are required for masters", Map.of());
        return false;
    }

    private static Object body(HttpExchange exchange, int maxBody) throws IOException {
        try {
            Object body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                    new TypeReference<Object>() { });
            if (body == null) throw MediaDevMasterSpec.invalid("$", "the request body is required");
            return body;
        } catch (tools.jackson.core.JacksonException malformed) {
            throw MediaDevMasterSpec.invalid("$", "the request body is not valid JSON without duplicate keys");
        }
    }

    private static Map<String, Object> stemView(MediaDevMasterRuntime.StemResult result) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevMasterRuntime.SCHEMA_STEM);
        view.put("scope", "DEV_ONLY");
        view.put("stemId", result.artifact().artifactId());
        view.put("artifact", artifactView(result.artifact()));
        view.put("lineage", result.lineage());
        view.put("replayed", result.replayed());
        view.put("note", NOTE);
        return view;
    }

    private static Map<String, Object> masterView(MediaDevMasterRuntime.MasterResult result) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevMasterRuntime.SCHEMA_MASTER);
        view.put("scope", "DEV_ONLY");
        view.put("masterId", result.report().artifactId());
        view.put("wav", artifactView(result.wav()));
        view.put("flac", artifactView(result.flac()));
        view.put("reportArtifact", artifactView(result.report()));
        view.put("report", result.document());
        view.put("replayed", result.replayed());
        view.put("note", NOTE);
        return view;
    }

    private static Map<String, Object> artifactView(MediaArtifact artifact) {
        return Map.of(
                "artifactId", artifact.artifactId(),
                "artifactVersionId", artifact.version().value(),
                "contentType", artifact.contentType(),
                "sizeBytes", artifact.sizeBytes(),
                "sha256", artifact.sha256(),
                "artifactPath", "/api/v1/artifacts/" + artifact.artifactId(),
                "contentPath", "/dev/v1/artifacts/" + artifact.artifactId() + "/content");
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
