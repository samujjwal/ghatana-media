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
 * DEV_ONLY 360 export, viewer readback and interactive demonstration routes (outside the canonical manifest/OpenAPI):
 * {@code GET /dev/v1/spatial/status}, {@code POST /dev/v1/spatial/exports}, {@code GET /dev/v1/spatial/exports/{id}},
 * {@code POST /dev/v1/spatial/viewports}, {@code GET /dev/v1/interactive-demos/status},
 * {@code POST /dev/v1/interactive-demos}, {@code GET /dev/v1/interactive-demos/{id}} and
 * {@code GET /dev/v1/interactive-demos/{id}/package.zip}. Permissions are
 * {@code media:project:dev:write|read} plus {@code media:artifact:read} (and {@code media:artifact:create} for creating
 * POSTs). The acting principal is the authenticated caller.
 */
final class MediaDevSpatialRoutes {
    static final String SPATIAL_STATUS = "/dev/v1/spatial/status";
    static final String EXPORTS = "/dev/v1/spatial/exports";
    static final String VIEWPORTS = "/dev/v1/spatial/viewports";
    static final String DEMO_STATUS = "/dev/v1/interactive-demos/status";
    static final String DEMOS = "/dev/v1/interactive-demos";
    private static final Pattern EXPORT = Pattern.compile("^/dev/v1/spatial/exports/([^/]+)$");
    private static final Pattern DEMO = Pattern.compile("^/dev/v1/interactive-demos/([^/]+)$");
    private static final Pattern DEMO_PACKAGE = Pattern.compile("^/dev/v1/interactive-demos/([^/]+)/package\\.zip$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();

    private final MediaDevSpatialRuntime spatial;
    private final MediaDevInteractiveDemoRuntime demos;
    private final MediaRuntime runtime;

    MediaDevSpatialRoutes(MediaDevSpatialRuntime spatial, MediaDevInteractiveDemoRuntime demos, MediaRuntime runtime) {
        this.spatial = spatial;
        this.demos = demos;
        this.runtime = runtime;
    }

    static boolean handles(String path) {
        return path.startsWith("/dev/v1/spatial/") || path.equals(DEMOS) || path.startsWith(DEMOS + "/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId, int maxBody,
                MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY spatial and demonstration capacity is exhausted; retry the same requestId after the "
                            + "Retry-After delay", Map.of("scope", failure.scope()));
        } catch (MediaDevDemoGraph.GraphException failure) {
            out.error(exchange, 422, failure.code(), failure.getMessage(), Map.of("path", failure.path()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact source artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevVideoRuntime.VideoRightsNotAdmittedException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, "RIGHTS_AUTHORITY_UNAVAILABLE".equals(failure.code()) ? 503 : 403, failure.code(),
                    "A source version has no current PROCESSING rights and consent admission; nothing was run",
                    Map.of("scope", "PROCESSING", "verdict", failure.resolution().verdict().name(),
                            "artifactId", failure.artifactId()));
        } catch (MediaDevVideoRuntime.VideoOutcomeUnknownException failure) {
            out.error(exchange, 503, "VIDEO_OUTCOME_UNKNOWN",
                    "The video process did not finish; its outcome is UNKNOWN and nothing was registered. "
                            + "Retry the same requestId", Map.of("outcome", "UNKNOWN"));
        } catch (MediaDevVideoRuntime.VideoRefusedException failure) {
            if (failure.status() == 403 || failure.status() == 404) runtime.recordDeniedRequest();
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevRequestLedger.LedgerRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevVideoRuntime.VideoRequestReusedException failure) {
            out.error(exchange, 409, "VIDEO_REQUEST_ID_REUSED",
                    "requestId was already used with a different request", Map.of());
        } catch (MediaDevVideoRuntime.VideoRegistrationFailedException failure) {
            out.error(exchange, 502, "VIDEO_OUTPUT_REGISTRATION_FAILED",
                    "The output was not registered; retry with the same requestId to resume", Map.of());
        }
    }

    private boolean permitted(HttpExchange exchange, boolean create, MediaDevCreativeOutputRoutes.Responder out)
            throws IOException {
        if (MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                && (!create || MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create"))) return true;
        runtime.recordDeniedRequest();
        out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                "DEV_ONLY artifact read" + (create ? " and create" : "") + " permissions are required", Map.of());
        return false;
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (SPATIAL_STATUS.equals(path) || DEMO_STATUS.equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, SPATIAL_STATUS.equals(path) ? spatial.status() : demos.status());
            return;
        }
        if (EXPORTS.equals(path) || VIEWPORTS.equals(path) || DEMOS.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!permitted(exchange, !VIEWPORTS.equals(path), out)) return;
            Map<String, Object> body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                    new TypeReference<Map<String, Object>>() { });
            if (body == null) throw new IllegalArgumentException("request body is required");
            if (EXPORTS.equals(path)) {
                var result = spatial.export(tenantId, principalId, parseExport(body));
                out.json(exchange, result.replayed() ? 200 : 201, exportView(result));
            } else if (VIEWPORTS.equals(path)) {
                var viewport = spatial.viewport(tenantId, principalId, parseViewport(body));
                out.json(exchange, 200, viewport.view());
            } else {
                var result = demos.create(tenantId, principalId, parseDemo(body));
                out.json(exchange, result.replayed() ? 200 : 201, demoView(result));
            }
            return;
        }
        Matcher demoPackage = DEMO_PACKAGE.matcher(path);
        if (demoPackage.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!permitted(exchange, false, out)) return;
            var zip = demos.packageZip(tenantId, principalId, pathSegment(demoPackage.group(1)));
            if (zip.isEmpty()) {
                out.error(exchange, 404, "INTERACTIVE_DEMO_NOT_FOUND",
                        "Interactive demonstration is not available in this tenant and owner scope", Map.of());
                return;
            }
            exchange.getResponseHeaders().set("Content-Type", "application/zip");
            exchange.getResponseHeaders().set("Content-Disposition", "attachment; filename=\"interactive-demo.zip\"");
            exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.sendResponseHeaders(200, zip.get().length);
            try (var body = exchange.getResponseBody()) { body.write(zip.get()); }
            return;
        }
        Matcher export = EXPORT.matcher(path);
        Matcher demo = DEMO.matcher(path);
        if (export.matches() || demo.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!permitted(exchange, false, out)) return;
            if (export.matches()) {
                var found = spatial.reopen(tenantId, principalId, pathSegment(export.group(1)));
                if (found.isEmpty()) {
                    out.error(exchange, 404, "SPATIAL_EXPORT_NOT_FOUND",
                            "Spatial export is not available in this tenant and owner scope", Map.of());
                    return;
                }
                out.json(exchange, 200, exportView(found.get()));
            } else {
                var found = demos.reopen(tenantId, principalId, pathSegment(demo.group(1)));
                if (found.isEmpty()) {
                    out.error(exchange, 404, "INTERACTIVE_DEMO_NOT_FOUND",
                            "Interactive demonstration is not available in this tenant and owner scope", Map.of());
                    return;
                }
                out.json(exchange, 200, demoView(found.get()));
            }
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Spatial or interactive demonstration route not found", Map.of());
    }

    // ------------------------------------------------------------------ parsing

    private static MediaDevSpatialRuntime.ExportRequest parseExport(Map<String, Object> body) {
        requireKeys(body, Set.of("requestId", "artifactId", "artifactVersionId"), Set.of("declaration"), "spatial export request");
        if (!body.containsKey("declaration") || body.get("declaration") == null) {
            throw new MediaDevDemoGraph.GraphException("SPHERICAL_DECLARATION_REQUIRED", "declaration",
                    "spherical metadata is written only when the user declares the source projection; none was declared");
        }
        Map<String, Object> declaration = object(body.get("declaration"), "declaration");
        requireKeys(declaration, Set.of("projection", "stereoMode"), Set.of("initialView"), "declaration");
        MediaDevMp4Spherical.Pose pose = MediaDevMp4Spherical.Pose.identity();
        if (declaration.containsKey("initialView")) {
            Map<String, Object> view = object(declaration.get("initialView"), "declaration.initialView");
            requireKeys(view, Set.of(), Set.of("yawDegrees", "pitchDegrees", "rollDegrees"), "declaration.initialView");
            try {
                pose = new MediaDevMp4Spherical.Pose(
                        view.containsKey("yawDegrees") ? decimal(view.get("yawDegrees"), "yawDegrees") : 0,
                        view.containsKey("pitchDegrees") ? decimal(view.get("pitchDegrees"), "pitchDegrees") : 0,
                        view.containsKey("rollDegrees") ? decimal(view.get("rollDegrees"), "rollDegrees") : 0);
            } catch (IllegalArgumentException outOfRange) {
                if (outOfRange.getMessage() != null && outOfRange.getMessage().startsWith("pose")) {
                    throw new MediaDevDemoGraph.GraphException("INITIAL_VIEW_OUT_OF_RANGE", "declaration.initialView",
                            outOfRange.getMessage());
                }
                throw outOfRange;
            }
        }
        return new MediaDevSpatialRuntime.ExportRequest(string(body.get("requestId"), "requestId"),
                string(body.get("artifactId"), "artifactId"), string(body.get("artifactVersionId"), "artifactVersionId"),
                new MediaDevSpatialRuntime.Declaration(string(declaration.get("projection"), "declaration.projection"),
                        string(declaration.get("stereoMode"), "declaration.stereoMode"), pose));
    }

    private static MediaDevSpatialRuntime.ViewportRequest parseViewport(Map<String, Object> body) {
        requireKeys(body, Set.of("artifactId", "artifactVersionId", "yawDegrees", "pitchDegrees"),
                Set.of("frameIndex", "fovDegrees", "width", "height"), "viewport request");
        double yaw = bounded(decimal(body.get("yawDegrees"), "yawDegrees"), -180, 180, "yawDegrees");
        double pitch = bounded(decimal(body.get("pitchDegrees"), "pitchDegrees"), -90, 90, "pitchDegrees");
        double fov = body.containsKey("fovDegrees") ? bounded(decimal(body.get("fovDegrees"), "fovDegrees"), 20, 120, "fovDegrees") : 90;
        int width = body.containsKey("width") ? (int) bounded(integer(body.get("width"), "width"), 16, 1280, "width") : 320;
        int height = body.containsKey("height") ? (int) bounded(integer(body.get("height"), "height"), 16, 1280, "height") : 200;
        int frame = body.containsKey("frameIndex") ? (int) bounded(integer(body.get("frameIndex"), "frameIndex"), 0, 100_000, "frameIndex") : 0;
        return new MediaDevSpatialRuntime.ViewportRequest(string(body.get("artifactId"), "artifactId"),
                string(body.get("artifactVersionId"), "artifactVersionId"), frame, yaw, pitch, fov, width, height);
    }

    private static MediaDevInteractiveDemoRuntime.DemoRequest parseDemo(Map<String, Object> body) {
        requireKeys(body, Set.of("requestId", "title", "startNodeId", "sourceTruth", "nodes"), Set.of(), "interactive demonstration request");
        Map<String, Object> truth = object(body.get("sourceTruth"), "sourceTruth");
        requireKeys(truth, Set.of("kind"), Set.of("curationNote"), "sourceTruth");
        if (!(body.get("nodes") instanceof List<?> rawNodes)) throw new IllegalArgumentException("nodes must be an array");
        List<MediaDevInteractiveDemoRuntime.NodeSpec> nodes = new ArrayList<>();
        for (Object rawNode : rawNodes) {
            Map<String, Object> node = object(rawNode, "node");
            requireKeys(node, Set.of("id", "label", "video"), Set.of("captions", "choices"), "node");
            MediaDevVideoRuntime.SourceRef captions = null;
            String language = null;
            if (node.get("captions") != null) {
                Map<String, Object> caption = object(node.get("captions"), "captions");
                requireKeys(caption, Set.of("artifactId", "artifactVersionId", "language"), Set.of(), "captions");
                captions = new MediaDevVideoRuntime.SourceRef(string(caption.get("artifactId"), "artifactId"),
                        string(caption.get("artifactVersionId"), "artifactVersionId"));
                language = string(caption.get("language"), "language");
            }
            List<MediaDevDemoGraph.Choice> choices = new ArrayList<>();
            if (node.get("choices") != null) {
                if (!(node.get("choices") instanceof List<?> rawChoices)) throw new IllegalArgumentException("choices must be an array");
                for (Object rawChoice : rawChoices) {
                    Map<String, Object> choice = object(rawChoice, "choice");
                    requireKeys(choice, Set.of("id", "label", "to"), Set.of(), "choice");
                    choices.add(new MediaDevDemoGraph.Choice(optionalString(choice.get("id")),
                            optionalString(choice.get("label")), optionalString(choice.get("to"))));
                }
            }
            Map<String, Object> videoRef = object(node.get("video"), "video");
            requireKeys(videoRef, Set.of("artifactId", "artifactVersionId"), Set.of(), "video");
            nodes.add(new MediaDevInteractiveDemoRuntime.NodeSpec(optionalString(node.get("id")),
                    optionalString(node.get("label")),
                    new MediaDevVideoRuntime.SourceRef(string(videoRef.get("artifactId"), "artifactId"),
                            string(videoRef.get("artifactVersionId"), "artifactVersionId")),
                    captions, language, choices));
        }
        return new MediaDevInteractiveDemoRuntime.DemoRequest(string(body.get("requestId"), "requestId"),
                optionalString(body.get("title")), optionalString(body.get("startNodeId")),
                string(truth.get("kind"), "sourceTruth.kind"), optionalString(truth.get("curationNote")), nodes);
    }

    // ------------------------------------------------------------------ responses

    private static Map<String, Object> artifactView(MediaArtifact artifact) {
        return Map.of("artifactId", artifact.artifactId(), "artifactVersionId", artifact.version().value(),
                "contentType", artifact.contentType(), "sizeBytes", artifact.sizeBytes(), "sha256", artifact.sha256(),
                "artifactPath", "/api/v1/artifacts/" + artifact.artifactId());
    }

    private static Map<String, Object> exportView(MediaDevVideoRuntime.VideoResult result) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevSpatialRuntime.SCHEMA);
        view.put("scope", "DEV_ONLY");
        view.put("exportId", result.artifact().artifactId());
        view.put("artifact", artifactView(result.artifact()));
        view.put("lineage", result.lineage());
        view.put("replayed", result.replayed());
        view.put("note", "DEV_ONLY MP4 stream copy with Spherical Video V2 metadata written only for a declared "
                + "equirectangular source; no quality, rights, approval or production claim");
        return view;
    }

    private static Map<String, Object> demoView(MediaDevVideoRuntime.VideoResult result) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevInteractiveDemoRuntime.SCHEMA);
        view.put("scope", "DEV_ONLY");
        view.put("demoId", result.artifact().artifactId());
        view.put("artifact", artifactView(result.artifact()));
        view.put("lineage", result.lineage());
        view.put("replayed", result.replayed());
        view.put("packagePath", "/dev/v1/interactive-demos/" + result.artifact().artifactId() + "/package.zip");
        view.put("note", "DEV_ONLY self-contained demonstration package; download packagePath, unzip and serve index.html from its own origin");
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

    private static String optionalString(Object value) {
        if (value == null) return null;
        if (!(value instanceof String text)) throw new IllegalArgumentException("a text field must be a string");
        return text;
    }

    private static double decimal(Object value, String field) {
        if (!(value instanceof Number number)) throw new IllegalArgumentException(field + " must be a number");
        return number.doubleValue();
    }

    private static double integer(Object value, String field) {
        if (!(value instanceof Integer || value instanceof Long || value instanceof Short)) {
            throw new IllegalArgumentException(field + " must be an integer");
        }
        return ((Number) value).doubleValue();
    }

    private static double bounded(double value, double min, double max, String field) {
        if (!Double.isFinite(value) || value < min || value > max) {
            throw new MediaDevVideoRuntime.VideoRefusedException(422, "VIEWPORT_PARAMETER_OUT_OF_RANGE",
                    field + " must be within [" + min + ", " + max + "]", Map.of("path", field));
        }
        return value;
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
