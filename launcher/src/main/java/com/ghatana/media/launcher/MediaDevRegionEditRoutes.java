package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevRegionPixels.Effect;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Version;
import com.sun.net.httpserver.HttpExchange;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY tracked region edit routes (outside the canonical manifest/OpenAPI):
 * {@code GET /dev/v1/region-edits/status}, {@code POST /dev/v1/region-edits/lineages},
 * {@code GET /dev/v1/region-edits/lineages/{lineageId}},
 * {@code POST /dev/v1/region-edits/lineages/{lineageId}/edits} and
 * {@code POST /dev/v1/region-edits/lineages/{lineageId}/undo}. Permissions are {@code media:project:dev:write|read}
 * plus {@code media:artifact:read} (and {@code media:artifact:create} for the renders). The acting principal is the
 * authenticated caller; no body field names one. Videos are read back through the existing exact-version
 * {@code GET /dev/v1/artifacts/{id}/content} route.
 */
final class MediaDevRegionEditRoutes {
    static final String PREFIX = "/dev/v1/region-edits";
    static final String STATUS = PREFIX + "/status";
    static final String LINEAGES = PREFIX + "/lineages";
    private static final Pattern LINEAGE = Pattern.compile("^/dev/v1/region-edits/lineages/([^/]+)$");
    private static final Pattern EDITS = Pattern.compile("^/dev/v1/region-edits/lineages/([^/]+)/edits$");
    private static final Pattern UNDO = Pattern.compile("^/dev/v1/region-edits/lineages/([^/]+)/undo$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();
    private static final String NOTE = "DEV_ONLY tracked region edit following a local open-model detector; the mask is "
            + "the detector's box interpolated in PTS, not ground truth; no quality, rights, approval or production claim";
    private static final Logger log = LoggerFactory.getLogger(MediaDevRegionEditRoutes.class);

    private final MediaDevRegionEditRuntime edits;
    private final MediaRuntime runtime;

    MediaDevRegionEditRoutes(MediaDevRegionEditRuntime edits, MediaRuntime runtime) {
        this.edits = edits;
        this.runtime = runtime;
    }

    static boolean handles(String path) {
        return path.equals(STATUS) || path.equals(LINEAGES) || path.startsWith(LINEAGES + "/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId, int maxBody,
                MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY region edit capacity is exhausted; retry the same requestId after the Retry-After delay",
                    Map.of("scope", failure.scope()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevRegionEditRuntime.RegionEditRefusedException failure) {
            if (failure.status() == 403) runtime.recordDeniedRequest();
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevRegionEditRuntime.RegionEditOutcomeUnknownException failure) {
            out.error(exchange, 503, "REGION_EDIT_OUTCOME_UNKNOWN",
                    "The render process did not finish; its outcome is UNKNOWN and nothing was registered. "
                            + "Retry the same requestId", Map.of("outcome", "UNKNOWN"));
        } catch (MediaDevRequestLedger.LedgerRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevRegionEditRuntime.RegionEditRequestReusedException failure) {
            out.error(exchange, 409, "REGION_EDIT_REQUEST_ID_REUSED",
                    "requestId was already used with a different region edit request", Map.of());
        } catch (MediaDevRegionEditRuntime.RegionEditRegistrationFailedException failure) {
            out.error(exchange, 502, "REGION_EDIT_OUTPUT_REGISTRATION_FAILED",
                    "The output was not registered; retry with the same requestId to resume", Map.of());
        } catch (IllegalArgumentException | IllegalStateException | SecurityException handled) {
            throw handled; // mapped to 400/409/403 by the host handler
        } catch (RuntimeException unexpected) {
            log.error("DEV region edit request failed unexpectedly", unexpected);
            throw unexpected;
        }
    }

    private boolean artifactPermitted(HttpExchange exchange, boolean create, MediaDevCreativeOutputRoutes.Responder out)
            throws IOException {
        if (MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                && (!create || MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create"))) return true;
        runtime.recordDeniedRequest();
        out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                "DEV_ONLY artifact read" + (create ? " and create" : "") + " permissions are required for region edits",
                Map.of());
        return false;
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (STATUS.equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, edits.status());
            return;
        }
        if (LINEAGES.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!artifactPermitted(exchange, true, out)) return;
            Map<String, Object> body = body(exchange, maxBody);
            requireKeys(body, Set.of("lineageId", "artifactId", "artifactVersionId"), Set.of(), "lineage request");
            var created = edits.createLineage(tenantId, principalId, string(body.get("lineageId"), "$.lineageId"),
                    string(body.get("artifactId"), "$.artifactId"),
                    string(body.get("artifactVersionId"), "$.artifactVersionId"));
            Map<String, Object> view = lineageView(tenantId, principalId, created.version().lineageId());
            view.put("created", !created.replayed());
            out.json(exchange, created.replayed() ? 200 : 201, view);
            return;
        }
        Matcher lineage = LINEAGE.matcher(path);
        if (lineage.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!artifactPermitted(exchange, false, out)) return;
            String id = pathSegment(lineage.group(1));
            if (edits.versions(tenantId, principalId, id).isEmpty()) {
                out.error(exchange, 404, "LINEAGE_NOT_FOUND", "no such lineage in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, lineageView(tenantId, principalId, id));
            return;
        }
        Matcher edit = EDITS.matcher(path);
        if (edit.matches()) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!artifactPermitted(exchange, true, out)) return;
            String id = pathSegment(edit.group(1));
            var outcome = edits.edit(tenantId, principalId, id, editRequest(body(exchange, maxBody)));
            out.json(exchange, outcome.replayed() ? 200 : 201, outcomeView(tenantId, principalId, outcome));
            return;
        }
        Matcher undo = UNDO.matcher(path);
        if (undo.matches()) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!artifactPermitted(exchange, true, out)) return;
            String id = pathSegment(undo.group(1));
            Map<String, Object> body = body(exchange, maxBody);
            requireKeys(body, Set.of("requestId", "baseVersion"), Set.of(), "undo request");
            var outcome = edits.undo(tenantId, principalId, id, new MediaDevRegionEditRuntime.UndoRequest(
                    string(body.get("requestId"), "$.requestId"), integer(body.get("baseVersion"), "$.baseVersion")));
            out.json(exchange, outcome.replayed() ? 200 : 201, outcomeView(tenantId, principalId, outcome));
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Region edit route not found", Map.of());
    }

    private Map<String, Object> lineageView(String tenantId, String principalId, String lineageId) {
        List<Version> rows = edits.versions(tenantId, principalId, lineageId);
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevRegionEditRuntime.SCHEMA);
        view.put("scope", "DEV_ONLY");
        view.put("lineageId", lineageId);
        Version head = rows.getLast();
        view.put("headVersion", head.versionNumber());
        view.put("headArtifact", Map.of("artifactId", head.artifactId(), "artifactVersionId", head.artifactVersionId(),
                "sha256", head.contentSha256()));
        Version effective = head;
        while (effective.kind() == com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Kind.UNDO) {
            effective = rows.get(effective.restoresVersionNumber() - 1);
        }
        view.put("undoAvailable", effective.kind() == com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Kind.EDIT);
        List<Map<String, Object>> versions = new java.util.ArrayList<>();
        for (Version version : rows) versions.add(edits.versionView(tenantId, principalId, version));
        view.put("versions", versions);
        view.put("note", NOTE);
        return view;
    }

    private Map<String, Object> outcomeView(String tenantId, String principalId, MediaDevRegionEditRuntime.Outcome outcome) {
        Map<String, Object> view = lineageView(tenantId, principalId, outcome.version().lineageId());
        view.put("version", edits.versionView(tenantId, principalId, outcome.version()));
        if (outcome.manifest() != null) view.put("manifest", outcome.manifest());
        view.put("replayed", outcome.replayed());
        return view;
    }

    private static MediaDevRegionEditRuntime.EditRequest editRequest(Map<String, Object> body) {
        requireKeys(body, Set.of("requestId", "baseVersion", "track", "effect"),
                Set.of("paddingPx", "holdEnds", "maxDriftPx", "encoder"), "region edit request");
        if (!(body.get("track") instanceof Map<?, ?> trackMap)) throw invalid("$.track", "track must be an object");
        Map<String, Object> track = stringKeys(trackMap, "$.track");
        requireKeys(track, Set.of("artifactId", "artifactVersionId", "trackId"), Set.of(), "track", "$.track");
        if (!(body.get("effect") instanceof Map<?, ?> effectMap)) throw invalid("$.effect", "effect must be an object");
        Map<String, Object> effect = stringKeys(effectMap, "$.effect");
        int crf = 0;
        if (body.containsKey("encoder")) {
            if (!(body.get("encoder") instanceof Map<?, ?> encoderMap)) throw invalid("$.encoder", "encoder must be an object");
            Map<String, Object> encoder = stringKeys(encoderMap, "$.encoder");
            requireKeys(encoder, Set.of(), Set.of("crf"), "encoder", "$.encoder");
            if (encoder.containsKey("crf")) crf = integer(encoder.get("crf"), "$.encoder.crf");
        }
        int padding = body.containsKey("paddingPx") ? integer(body.get("paddingPx"), "$.paddingPx") : 4;
        boolean hold = false;
        if (body.containsKey("holdEnds")) {
            if (!(body.get("holdEnds") instanceof Boolean flag)) throw invalid("$.holdEnds", "holdEnds must be a boolean");
            hold = flag;
        }
        Double drift = null;
        if (body.containsKey("maxDriftPx")) {
            if (!(body.get("maxDriftPx") instanceof Number number)) throw invalid("$.maxDriftPx", "maxDriftPx must be a number");
            drift = number.doubleValue();
        }
        return new MediaDevRegionEditRuntime.EditRequest(string(body.get("requestId"), "$.requestId"),
                integer(body.get("baseVersion"), "$.baseVersion"),
                new MediaDevRegionEditRuntime.TrackRef(string(track.get("artifactId"), "$.track.artifactId"),
                        string(track.get("artifactVersionId"), "$.track.artifactVersionId"),
                        string(track.get("trackId"), "$.track.trackId")),
                effect(effect), padding, hold, drift, crf);
    }

    private static Effect effect(Map<String, Object> effect) {
        String type = string(effect.get("type"), "$.effect.type");
        try {
            return switch (type) {
                case "BLUR" -> {
                    requireKeys(effect, Set.of("type"), Set.of("radius"), "effect", "$.effect");
                    yield Effect.blur(effect.containsKey("radius") ? integer(effect.get("radius"), "$.effect.radius") : 8);
                }
                case "PIXELATE" -> {
                    requireKeys(effect, Set.of("type"), Set.of("blockSize"), "effect", "$.effect");
                    yield Effect.pixelate(effect.containsKey("blockSize")
                            ? integer(effect.get("blockSize"), "$.effect.blockSize") : 16);
                }
                case "FILL" -> {
                    requireKeys(effect, Set.of("type"), Set.of("color"), "effect", "$.effect");
                    yield Effect.fill(effect.containsKey("color") ? string(effect.get("color"), "$.effect.color") : "#000000");
                }
                default -> throw invalid("$.effect.type", "effect type must be BLUR, PIXELATE or FILL");
            };
        } catch (IllegalArgumentException refused) {
            throw invalid("$.effect", refused.getMessage());
        }
    }

    private static Map<String, Object> stringKeys(Map<?, ?> map, String path) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (!(entry.getKey() instanceof String key)) throw invalid(path, "keys must be strings");
            out.put(key, entry.getValue());
        }
        return out;
    }

    private static Map<String, Object> body(HttpExchange exchange, int maxBody) throws IOException {
        try {
            Map<String, Object> body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                    new TypeReference<Map<String, Object>>() { });
            if (body == null) throw invalid("$", "the request body is required");
            return body;
        } catch (tools.jackson.core.JacksonException malformed) {
            throw invalid("$", "the request body is not a valid JSON object");
        }
    }

    private static void requireKeys(Map<String, Object> value, Set<String> required, Set<String> optional, String field) {
        requireKeys(value, required, optional, field, "$");
    }

    private static void requireKeys(Map<String, Object> value, Set<String> required, Set<String> optional, String field,
                                    String prefix) {
        for (String key : required) {
            if (!value.containsKey(key)) throw invalid(prefix + "." + key, "is required");
        }
        for (String key : value.keySet()) {
            if (!required.contains(key) && !optional.contains(key)) {
                throw invalid(prefix + "." + key, field + " has no field " + key);
            }
        }
    }

    private static String string(Object value, String path) {
        if (!(value instanceof String text)) throw invalid(path, "must be a string");
        return text;
    }

    private static int integer(Object value, String path) {
        if (!(value instanceof Integer || value instanceof Long)) throw invalid(path, "must be an integer");
        long number = ((Number) value).longValue();
        if (number < Integer.MIN_VALUE || number > Integer.MAX_VALUE) throw invalid(path, "is out of range");
        return (int) number;
    }

    private static MediaDevRegionEditRuntime.RegionEditRefusedException invalid(String path, String message) {
        return MediaDevRegionEditRuntime.invalid(path, message);
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
