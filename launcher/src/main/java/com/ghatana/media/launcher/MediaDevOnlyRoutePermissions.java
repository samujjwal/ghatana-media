package com.ghatana.media.launcher;

/** Route permissions for the noncanonical DEV_ONLY route family; never used for production JWT admission. */
final class MediaDevOnlyRoutePermissions {
    static final String PROJECT_CREATE = "media:project:dev:create";
    static final String PROJECT_READ = "media:project:dev:read";
    static final String PROJECT_WRITE = "media:project:dev:write";
    static final String DELIVERY_EXPORT = "media:delivery:dev:export";
    static final String DELIVERY_READ = "media:delivery:dev:read";
    static final String JOB_CANCEL = "media:job:cancel";

    private MediaDevOnlyRoutePermissions() { }

    static String requiredPermission(String method, String path) {
        if ("GET".equals(method) && "/dev/v1/context".equals(path)) return PROJECT_READ;
        if ("GET".equals(method) && "/dev/v1/artifact-upload-policy".equals(path)) return "media:artifact:create";
        if ("GET".equals(method) && path.matches("^/dev/v1/artifacts/[^/]+/content$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/jobs/[^/]+/cancel$")) return JOB_CANCEL;
        if ("POST".equals(method) && "/dev/v1/projects".equals(path)) return PROJECT_CREATE;
        if ("GET".equals(method) && path.matches("^/dev/v1/projects/[^/]+$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/projects/[^/]+/timelines$")) return PROJECT_WRITE;
        if ("POST".equals(method) && path.matches("^/dev/v1/projects/[^/]+/timelines/[^/]+/edits$")) return PROJECT_WRITE;
        if ("POST".equals(method) && path.matches("^/dev/v1/projects/[^/]+/restore$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/projects/[^/]+/revisions/[^/]+$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/projects/[^/]+/renders$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/projects/[^/]+/renders/[^/]+$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/reviews$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/reviews/[^/]+$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/reviews/[^/]+/(comments|decisions|assignments)$")) return PROJECT_WRITE;
        if ("POST".equals(method) && path.matches("^/dev/v1/reviews/[^/]+/assignments/[^/]+/revoke$")) return PROJECT_WRITE;
        if ("POST".equals(method) && "/dev/v1/exports".equals(path)) return DELIVERY_EXPORT;
        if ("GET".equals(method) && path.matches("^/dev/v1/exports/[^/]+$")) return DELIVERY_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/creative-outputs/(audio-repairs|simulations|spatial-glb)$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/creative-outputs/[^/]+$")) return PROJECT_READ;
        return null;
    }
}
