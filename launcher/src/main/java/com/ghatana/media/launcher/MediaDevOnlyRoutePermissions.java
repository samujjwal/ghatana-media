package com.ghatana.media.launcher;

/** Route permissions for the noncanonical DEV_ONLY route family; never used for production JWT admission. */
final class MediaDevOnlyRoutePermissions {
    static final String PROJECT_CREATE = "media:project:dev:create";
    static final String PROJECT_READ = "media:project:dev:read";
    static final String PROJECT_WRITE = "media:project:dev:write";
    static final String JOB_CANCEL = "media:job:cancel";

    private MediaDevOnlyRoutePermissions() { }

    static String requiredPermission(String method, String path) {
        if ("GET".equals(method) && "/dev/v1/context".equals(path)) return PROJECT_READ;
        if ("GET".equals(method) && "/dev/v1/artifact-upload-policy".equals(path)) return "media:artifact:create";
        if ("POST".equals(method) && path.matches("^/dev/v1/jobs/[^/]+/cancel$")) return JOB_CANCEL;
        if ("POST".equals(method) && "/dev/v1/projects".equals(path)) return PROJECT_CREATE;
        if ("GET".equals(method) && path.matches("^/dev/v1/projects/[^/]+$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/projects/[^/]+/timelines$")) return PROJECT_WRITE;
        if ("POST".equals(method) && path.matches("^/dev/v1/projects/[^/]+/timelines/[^/]+/edits$")) return PROJECT_WRITE;
        if ("POST".equals(method) && path.matches("^/dev/v1/projects/[^/]+/restore$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/projects/[^/]+/revisions/[^/]+$")) return PROJECT_READ;
        return null;
    }
}
