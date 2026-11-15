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
        // Rights and consent authority; the route additionally requires media:artifact:read to attest an exact version.
        if ("POST".equals(method) && "/dev/v1/rights/attestations".equals(path)) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/rights/attestations/[^/]+$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/rights/attestations/[^/]+/(confirm|revoke)$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/rights/artifacts/[^/]+/versions/[^/]+/attestations$")) return PROJECT_READ;
        if ("POST".equals(method) && "/dev/v1/intakes".equals(path)) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/intakes/[^/]+$")) return PROJECT_READ;
        if ("POST".equals(method) && "/dev/v1/exports".equals(path)) return DELIVERY_EXPORT;
        if ("GET".equals(method) && path.matches("^/dev/v1/exports/[^/]+$")) return DELIVERY_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/creative-outputs/(audio-repairs|simulations|spatial-glb)$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/creative-outputs/[^/]+$")) return PROJECT_READ;
        if ("GET".equals(method) && "/dev/v1/speech/capabilities".equals(path)) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/speech/(transcriptions|syntheses)$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/speech/outputs/[^/]+$")) return PROJECT_READ;
        // Human caption correction over an exact WebVTT version; the routes also require media:artifact:read/create.
        if ("POST".equals(method) && "/dev/v1/captions/corrections".equals(path)) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/captions/[^/]+$")) return PROJECT_READ;
        if ("GET".equals(method) && "/dev/v1/vision/status".equals(path)) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/vision/(analyses|questions|tracks|roi-analyses)$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/vision/outputs/[^/]+$")) return PROJECT_READ;
        // Audio restoration (denoise/declip/dehum) and measured source-vs-restored comparison; routes also need artifact read/create.
        if ("GET".equals(method) && "/dev/v1/audio/status".equals(path)) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/audio/(restorations|comparisons)$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/audio/outputs/[^/]+$")) return PROJECT_READ;
        // Observed readiness of the local providers (no paths, endpoints or tokens).
        if ("GET".equals(method) && "/dev/v1/providers/catalog".equals(path)) return PROJECT_READ;
        // Translation and dubbing; the routes additionally require media:artifact:read (and create for POST).
        if ("GET".equals(method) && "/dev/v1/translations/capabilities".equals(path)) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/translations(/revisions)?$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/translations/[^/]+$")) return PROJECT_READ;
        if ("POST".equals(method) && "/dev/v1/dubs".equals(path)) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/dubs/[^/]+$")) return PROJECT_READ;
        if ("GET".equals(method) && "/dev/v1/grounded-answers/status".equals(path)) return PROJECT_READ;
        if ("POST".equals(method) && "/dev/v1/grounded-answers".equals(path)) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/grounded-answers/[^/]+$")) return PROJECT_READ;
        // Video enhancement and measured comparison (J-08); the routes additionally require media:artifact:read/create.
        if ("POST".equals(method) && path.matches("^/dev/v1/video/(enhancements|comparisons)$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/video/(enhancements|comparisons)/[^/]+$")) return PROJECT_READ;
        // Deterministic 2D animation render (J-12); the routes additionally require media:artifact:{read,create}.
        if ("GET".equals(method) && "/dev/v1/animations/status".equals(path)) return PROJECT_READ;
        if ("POST".equals(method) && "/dev/v1/animations/renders".equals(path)) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/animations/renders/[^/]+$")) return PROJECT_READ;
        // J-26 erasure and legal holds; the routes additionally require media:artifact:{read,write}.
        if ("GET".equals(method) && path.matches("^/dev/v1/(erasure-plans/[^/]+|erasures/[^/]+|legal-holds(/[^/]+)?)$")) return PROJECT_READ;
        if ("POST".equals(method) && ("/dev/v1/erasures".equals(path) || "/dev/v1/legal-holds".equals(path)
                || path.matches("^/dev/v1/legal-holds/[^/]+/release$"))) return PROJECT_WRITE;
        return null;
    }
}
