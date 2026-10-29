package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;

import java.time.Instant;
import java.util.Objects;

/**
 * Production {@link SourceAuthorization} bound to the canonical Media runtime port.
 *
 * <p>Each gRPC authorization request is resolved against the composed trusted
 * source-rights authority through the runtime's effect-free
 * {@link MediaProcessingRuntimePort#resolveSourceAuthorization} probe — the same
 * artifact/version/ownership/provider-selection path job admission uses. The
 * verified ingress identity becomes the authenticated principal; caller-supplied
 * fields are lookup inputs only. Nothing here creates a job, upload, or provider
 * effect, and no authority outcome is cached.</p>
 *
 * @doc.type class
 * @doc.purpose Binds the multimodal gRPC source-authorization seam to the real runtime authority
 * @doc.layer product
 * @doc.pattern Adapter
 */
final class MediaRuntimeSourceAuthorization implements SourceAuthorization {

    private final MediaProcessingRuntimePort port;

    MediaRuntimeSourceAuthorization(MediaProcessingRuntimePort port) {
        this.port = Objects.requireNonNull(port, "port");
    }

    @Override
    public Decision authorize(AuthorizationRequest request) {
        Objects.requireNonNull(request, "request");
        final ArtifactVersion sourceVersion;
        try {
            sourceVersion = new ArtifactVersion(request.artifactVersion());
        } catch (IllegalArgumentException malformed) {
            // A version that is not the immutable content digest can never resolve
            // to an owned source version; deny rather than report unavailable.
            return Decision.DENIED;
        }
        final MediaSourceAuthorizationContracts.Decision decision;
        try {
            decision = port.resolveSourceAuthorization(
                    request.tenantId(), request.principalId().toString(), request.artifactId(),
                    sourceVersion, JobType.MULTIMODAL, request.purpose(),
                    new AuthenticatedPrincipal(
                            request.tenantId(), request.principalId().toString(), Instant.now()));
        } catch (RuntimeException unavailable) {
            return Decision.NOT_ADMITTED;
        }
        if (decision == null || decision.status() == null) {
            return Decision.NOT_ADMITTED;
        }
        return switch (decision.status()) {
            case ALLOWED -> Decision.ADMITTED;
            case DENIED, REVOKED, STALE -> Decision.DENIED;
            case UNAVAILABLE -> Decision.NOT_ADMITTED;
        };
    }
}
