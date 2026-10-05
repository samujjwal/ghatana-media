package com.ghatana.media.launcher;

import com.ghatana.launcher.routemanifest.ReconciliationResult;
import com.ghatana.launcher.routemanifest.RouteCategory;
import com.ghatana.launcher.routemanifest.RouteEntry;
import com.ghatana.launcher.routemanifest.RouteManifestSupport;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Canonical executable route manifest for the standalone Media Runtime.
 *
 * @doc.type class
 * @doc.purpose Provide Media Route Manifest behavior
 * @doc.layer product
 * @doc.pattern Component
 */
public final class MediaRouteManifest {
    private MediaRouteManifest() { }
    public static final String SERVICE_ID = "media";
    public static final String SERVICE_VERSION = "1.3.0";

    private static final List<RouteEntry> CANONICAL_ROUTES = List.of(
            new RouteEntry("GET", "/health", RouteCategory.HEALTH, true, "Aggregate health"),
            new RouteEntry("GET", "/health/live", RouteCategory.HEALTH, true, "Process liveness"),
            new RouteEntry("GET", "/health/ready", RouteCategory.HEALTH, true, "Dependency readiness"),
            new RouteEntry("GET", "/health/startup", RouteCategory.HEALTH, true, "Startup completion"),
            new RouteEntry("GET", "/ready", RouteCategory.HEALTH, true, "Readiness alias"),
            new RouteEntry("GET", "/metrics", RouteCategory.METRICS, true, "Runtime metrics"),
            new RouteEntry("GET", "/info", RouteCategory.INFO, true, "Runtime information"),
            new RouteEntry("GET", "/api/v1/health", RouteCategory.HEALTH, true, "Versioned health"),
            new RouteEntry("POST", "/api/v1/consents", RouteCategory.APPLICATION, false, "Grant principal-owned Media consent"),
            new RouteEntry("GET", "/api/v1/consents", RouteCategory.APPLICATION, false, "List principal-owned Media consents"),
            new RouteEntry("GET", "/api/v1/consents/{consentId}", RouteCategory.APPLICATION, false, "Read principal-owned Media consent"),
            new RouteEntry("DELETE", "/api/v1/consents/{consentId}", RouteCategory.APPLICATION, false, "Revoke principal-owned Media consent"),
            new RouteEntry("POST", "/api/v1/artifacts/uploads", RouteCategory.APPLICATION, false, "Begin resumable upload"),
            new RouteEntry("GET", "/api/v1/artifacts/uploads/{uploadId}", RouteCategory.APPLICATION, false, "Read upload status"),
            new RouteEntry("PUT", "/api/v1/artifacts/uploads/{uploadId}/chunks/{chunkIndex}", RouteCategory.APPLICATION, false, "Append upload chunk"),
            new RouteEntry("POST", "/api/v1/artifacts/uploads/{uploadId}/complete", RouteCategory.APPLICATION, false, "Verify and complete upload"),
            new RouteEntry("GET", "/api/v1/artifacts/{artifactId}", RouteCategory.APPLICATION, false, "Read artifact metadata"),
            new RouteEntry("POST", "/api/v1/jobs", RouteCategory.APPLICATION, false, "Submit processing job"),
            new RouteEntry("GET", "/api/v1/jobs", RouteCategory.APPLICATION, false, "List processing jobs"),
            new RouteEntry("GET", "/api/v1/jobs/{jobId}", RouteCategory.APPLICATION, false, "Read processing job"),
            new RouteEntry("POST", "/api/v1/jobs/{jobId}/cancel", RouteCategory.APPLICATION, false, "Cancel processing job"),
            new RouteEntry("POST", "/api/v1/streams", RouteCategory.APPLICATION, false, "Open stream session"),
            new RouteEntry("GET", "/api/v1/streams/{sessionId}", RouteCategory.APPLICATION, false, "Read stream session"),
            new RouteEntry("POST", "/api/v1/streams/{sessionId}/connect", RouteCategory.APPLICATION, false, "Connect or reconnect stream"),
            new RouteEntry("POST", "/api/v1/streams/{sessionId}/frames/{sequence}", RouteCategory.APPLICATION, false, "Submit ordered stream frame"),
            new RouteEntry("POST", "/api/v1/streams/{sessionId}/close", RouteCategory.APPLICATION, false, "Close stream session"),
            new RouteEntry("GET", "/api/v1/providers", RouteCategory.APPLICATION, false, "Read provider readiness"));

    public static List<RouteEntry> all() { return CANONICAL_ROUTES; }
    public static Set<String> allPaths() { return RouteManifestSupport.allPaths(CANONICAL_ROUTES); }
    public static Set<String> publicPaths() { return RouteManifestSupport.publicPaths(CANONICAL_ROUTES); }
    public static boolean isKnownPath(String path) { return RouteManifestSupport.isKnownPath(CANONICAL_ROUTES, path); }
    public static int routeCount() { return RouteManifestSupport.routeCount(CANONICAL_ROUTES); }

    /** Returns the canonical permission for one protected route, or {@code null} for unknown routes. */
    public static String requiredPermission(String method, String path) {
        if ("POST".equals(method) && "/api/v1/consents".equals(path)) return "media:consent:create";
        if ("GET".equals(method) && path.matches("^/api/v1/consents(?:/[^/]+)?$")) return "media:consent:read";
        if ("DELETE".equals(method) && path.matches("^/api/v1/consents/[^/]+$")) return "media:consent:revoke";
        if ("POST".equals(method) && "/api/v1/artifacts/uploads".equals(path)) return "media:artifact:create";
        if ("GET".equals(method) && path.matches("^/api/v1/artifacts/(?:uploads/)?[^/]+$")) return "media:artifact:read";
        if (("PUT".equals(method) && path.matches("^/api/v1/artifacts/uploads/[^/]+/chunks/[^/]+$"))
                || ("POST".equals(method) && path.matches("^/api/v1/artifacts/uploads/[^/]+/complete$"))) return "media:artifact:write";
        if ("POST".equals(method) && "/api/v1/jobs".equals(path)) return "media:job:create";
        if ("GET".equals(method) && path.matches("^/api/v1/jobs(?:/[^/]+)?$")) return "media:job:read";
        if ("POST".equals(method) && path.matches("^/api/v1/jobs/[^/]+/cancel$")) return "media:job:cancel";
        if ("POST".equals(method) && "/api/v1/streams".equals(path)) return "media:stream:create";
        if ("GET".equals(method) && path.matches("^/api/v1/streams/[^/]+$")) return "media:stream:read";
        if ("POST".equals(method) && path.matches("^/api/v1/streams/[^/]+/(?:connect|frames/[^/]+)$")) return "media:stream:write";
        if ("POST".equals(method) && path.matches("^/api/v1/streams/[^/]+/close$")) return "media:stream:close";
        if ("GET".equals(method) && "/api/v1/providers".equals(path)) return "media:provider:read";
        return null;
    }

    public static Map<String, Object> toManifest() { return RouteManifestSupport.toManifest(SERVICE_ID, SERVICE_VERSION, CANONICAL_ROUTES); }
    public static ReconciliationResult reconcile(Set<String> servedPaths) { return RouteManifestSupport.reconcile(CANONICAL_ROUTES, servedPaths); }
}
