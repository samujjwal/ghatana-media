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
        if ("GET".equals(method) && "/dev/v1/projects".equals(path)) return PROJECT_READ;
        if ("GET".equals(method) && path.matches("^/dev/v1/projects/[^/]+$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/projects/[^/]+/timelines$")) return PROJECT_WRITE;
        if ("POST".equals(method) && path.matches("^/dev/v1/projects/[^/]+/timelines/[^/]+/edits$")) return PROJECT_WRITE;
        if ("POST".equals(method) && path.matches("^/dev/v1/projects/[^/]+/restore$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/projects/[^/]+/revisions/[^/]+$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/projects/[^/]+/renders$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/projects/[^/]+/renders/[^/]+$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/reviews$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/reviews/[^/]+(/versions|/content)?$")) return PROJECT_READ;
        if ("GET".equals(method) && path.matches("^/dev/v1/reviews$")) return PROJECT_READ;
        if ("GET".equals(method) && path.matches("^/dev/v1/review-lineages/[^/]+$")) return PROJECT_READ;
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
        if ("POST".equals(method) && path.matches("^/dev/v1/exports/[^/]+/reconcile$")) return DELIVERY_EXPORT;
        if ("GET".equals(method) && path.matches("^/dev/v1/exports/[^/]+$")) return DELIVERY_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/creative-outputs/(audio-repairs|simulations|spatial-glb)$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/creative-outputs/[^/]+$")) return PROJECT_READ;
        if ("GET".equals(method) && path.matches("^/dev/v1/request-outcomes/[^/]+/[^/]+$")) return PROJECT_READ;
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
        // Stems, foley, mix and loudness master (J-17); the routes additionally require media:artifact:{read,create}.
        if ("GET".equals(method) && "/dev/v1/masters/status".equals(path)) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/masters(/stems)?$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/masters/(stems/)?[^/]+$") && !"/dev/v1/masters/status".equals(path)) return PROJECT_READ;
        // Live media sessions (J-29); the routes additionally require media:artifact:read (and create for POST).
        if ("GET".equals(method) && path.matches("^/dev/v1/live-sessions/(status|[^/]+)$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/live-sessions(/[^/]+/(frames|eos|abort))?$")) return PROJECT_WRITE;
        // Observed readiness of the local providers (no paths, endpoints or tokens).
        if ("GET".equals(method) && "/dev/v1/providers/catalog".equals(path)) return PROJECT_READ;
        // Translation and dubbing; the routes additionally require media:artifact:read (and create for POST).
        if ("GET".equals(method) && "/dev/v1/translations/capabilities".equals(path)) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/translations(/revisions)?$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/translations/[^/]+$")) return PROJECT_READ;
        // Multitrack composite render (J-18); the routes additionally require media:artifact:{read,create}.
        if ("GET".equals(method) && path.matches("^/dev/v1/composite-renders/(capabilities|[^/]+)$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/composite-renders(/[^/]+/cancel)?$")) return PROJECT_WRITE;
        // Versioned storyboard (J-09); the routes additionally require media:artifact:{read,create} (read-only for GETs).
        if ("GET".equals(method) && path.matches("^/dev/v1/storyboards(/capabilities|/[^/]+(/(versions|readiness))?|/[^/]+/versions/[0-9]+(/(render|review))?)$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/storyboards(/[^/]+/(versions|renders)|/[^/]+/versions/[0-9]+/review)?$")) return PROJECT_WRITE;
        if ("POST".equals(method) && "/dev/v1/dubs".equals(path)) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/dubs/[^/]+$")) return PROJECT_READ;
        if ("GET".equals(method) && "/dev/v1/grounded-answers/status".equals(path)) return PROJECT_READ;
        if ("POST".equals(method) && "/dev/v1/grounded-answers".equals(path)) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/grounded-answers/[^/]+$")) return PROJECT_READ;
        // 360/spatial export, viewer readback and sandboxed interactive demonstration packages (J-28); the routes
        // additionally require media:artifact:read (and create for the creating POSTs).
        if ("GET".equals(method) && path.matches("^/dev/v1/(spatial|interactive-demos)/status$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/(spatial/(exports|viewports)|interactive-demos)$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/(spatial/exports|interactive-demos)/[^/]+$")) return PROJECT_READ;
        if ("GET".equals(method) && path.matches("^/dev/v1/interactive-demos/[^/]+/package\\.zip$")) return PROJECT_READ;
        // Video enhancement and measured comparison (J-08); the routes additionally require media:artifact:read/create.
        if ("POST".equals(method) && path.matches("^/dev/v1/video/(enhancements|comparisons)$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/video/(enhancements|comparisons)/[^/]+$")) return PROJECT_READ;
        // Bounded quality optimization with measured report, reversible head and undo (J-19); the routes additionally
        // require media:artifact:read (and create for the optimization POST).
        if ("GET".equals(method) && "/dev/v1/quality/status".equals(path)) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/quality/optimizations(/[^/]+/cancel)?$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/quality/(optimizations|lineages)/[^/]+$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/quality/lineages/[^/]+/undo$")) return PROJECT_WRITE;
        // Deterministic 2D animation render (J-12); the routes additionally require media:artifact:{read,create}.
        if ("GET".equals(method) && "/dev/v1/animations/status".equals(path)) return PROJECT_READ;
        if ("POST".equals(method) && "/dev/v1/animations/renders".equals(path)) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/animations/renders/[^/]+$")) return PROJECT_READ;
        // Rights-checked reference-conditioned scenes (J-10); the routes additionally require media:artifact:{read,create}.
        if ("GET".equals(method) && "/dev/v1/reference-scenes/status".equals(path)) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/reference-scenes/(reference-sets|runs)$")) return PROJECT_WRITE;
        if ("POST".equals(method) && path.matches("^/dev/v1/reference-scenes/runs/[^/]+/regenerations$")) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/reference-scenes/(reference-sets|runs)/[^/]+$")) return PROJECT_READ;
        // Deterministic 3D rig render (J-13); the routes additionally require media:artifact:{read,create}.
        if ("GET".equals(method) && "/dev/v1/rigs/status".equals(path)) return PROJECT_READ;
        if ("POST".equals(method) && "/dev/v1/rigs/renders".equals(path)) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/rigs/renders/[^/]+$")) return PROJECT_READ;
        // Scientific simulation (J-14/J-15); the routes additionally require media:artifact:{read,create}.
        if ("GET".equals(method) && "/dev/v1/simulations/status".equals(path)) return PROJECT_READ;
        if ("POST".equals(method) && "/dev/v1/simulations".equals(path)) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/simulations/[^/]+$") && !"/dev/v1/simulations/status".equals(path)) return PROJECT_READ;
        // Tracked region edit with exact version compare-and-set and undo (J-11); the routes also need media:artifact:{read,create}.
        if ("GET".equals(method) && "/dev/v1/region-edits/status".equals(path)) return PROJECT_READ;
        if ("POST".equals(method) && "/dev/v1/region-edits/lineages".equals(path)) return PROJECT_WRITE;
        if ("GET".equals(method) && path.matches("^/dev/v1/region-edits/lineages/[^/]+$")) return PROJECT_READ;
        if ("POST".equals(method) && path.matches("^/dev/v1/region-edits/lineages/[^/]+/(edits|undo)$")) return PROJECT_WRITE;
        // J-26 erasure and legal holds; the routes additionally require media:artifact:{read,write}.
        if ("GET".equals(method) && path.matches("^/dev/v1/(erasure-plans/[^/]+|erasures/[^/]+|legal-holds(/[^/]+)?)$")) return PROJECT_READ;
        if ("POST".equals(method) && ("/dev/v1/erasures".equals(path) || "/dev/v1/legal-holds".equals(path)
                || path.matches("^/dev/v1/legal-holds/[^/]+/release$"))) return PROJECT_WRITE;
        return null;
    }
}
