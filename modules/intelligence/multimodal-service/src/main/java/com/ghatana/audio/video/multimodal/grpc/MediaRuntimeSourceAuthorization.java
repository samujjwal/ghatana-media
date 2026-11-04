package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;

import java.time.Instant;
import java.security.MessageDigest;
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
        // This runtime probe resolves one immutable source artifact at a time. It cannot
        // authorize a composite of independently supplied modality payloads. Admit the
        // narrow case where the one submitted modality is byte-identical to that artifact,
        // and require both the parent operation and its actual child provider operation
        // to be currently authorized before the operation can fan out.
        if (request.modalities().size() != 1 || request.contentBytes() <= 0
                || !digestEquals(request.contentSha256(), sourceVersion.value().substring("sha256:".length()))) {
            return request.modalities().size() != 1
                    ? Decision.NOT_ADMITTED : Decision.DENIED;
        }
        JobType childJobType = childJobType(request.modalities().iterator().next());
        if (childJobType == null) return Decision.NOT_ADMITTED;
        Decision parent = resolve(request, sourceVersion, JobType.MULTIMODAL);
        if (parent != Decision.ADMITTED) return parent;
        return resolve(request, sourceVersion, childJobType);
    }

    private Decision resolve(AuthorizationRequest request, ArtifactVersion sourceVersion, JobType jobType) {
        final MediaSourceAuthorizationContracts.Decision decision;
        try {
            decision = port.resolveSourceAuthorization(
                    request.tenantId(), request.principalId().toString(), request.artifactId(),
                    sourceVersion, jobType, request.purpose(),
                    new AuthenticatedPrincipal(
                            request.tenantId(), request.principalId().toString(), Instant.now()));
        } catch (RuntimeException unavailable) {
            return Decision.NOT_ADMITTED;
        }
        if (decision == null || decision.status() == null) {
            return Decision.NOT_ADMITTED;
        }
        return switch (decision.status()) {
            case ALLOWED -> evidenceMatches(request, sourceVersion, jobType, decision.evidence())
                    ? Decision.ADMITTED : Decision.DENIED;
            case DENIED, REVOKED, STALE -> Decision.DENIED;
            case UNAVAILABLE -> Decision.NOT_ADMITTED;
        };
    }

    private static JobType childJobType(SourceAuthorization.Modality modality) {
        return switch (modality) {
            case AUDIO -> JobType.SPEECH_TO_TEXT;
            case IMAGE, VIDEO -> JobType.VISION;
            case TEXT -> null;
        };
    }

    private static boolean evidenceMatches(AuthorizationRequest request, ArtifactVersion version,
                                           JobType jobType,
                                           MediaSourceAuthorizationContracts.Evidence evidence) {
        return evidence != null
                && evidence.tenantId().equals(request.tenantId())
                && evidence.principalId().equals(request.principalId().toString())
                && evidence.artifactId().equals(request.artifactId())
                && evidence.sourceVersion().equals(version)
                && digestEquals(evidence.sourceSha256(), request.contentSha256())
                && evidence.operation().equalsIgnoreCase(jobType.name())
                && evidence.purpose().equals(request.purpose())
                && evidence.currentAt(java.time.Clock.systemUTC());
    }

    private static boolean digestEquals(String left, String right) {
        try {
            return MessageDigest.isEqual(java.util.HexFormat.of().parseHex(left),
                    java.util.HexFormat.of().parseHex(right));
        } catch (IllegalArgumentException malformed) {
            return false;
        }
    }
}
