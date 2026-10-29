package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactContentReadReceipt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;

import java.util.Optional;
import java.io.IOException;
import java.io.OutputStream;

/**
 * Typed service-facing access to the canonical Media job and artifact runtime.
 *
 * <p>Implementations must preserve the runtime's admission, tenant/principal ownership,
 * idempotency, lease fencing, outbox, and outcome-finality semantics. This port is an
 * integration seam; it does not itself admit a provider or grant processing rights.
 */
public interface MediaProcessingRuntimePort {
    ProcessingJob submit(ProcessingJobRequest request);

    /**
     * Submits a job bound to the principal established at the authenticated ingress
     * boundary. The request's tenant/principal must match the credential exactly; request
     * identity fields are lookup inputs and never authority on their own. Production
     * transports that authenticate ingress separately must use this overload so the
     * downstream verified policy context derives from the real credential.
     *
     * <p>The default fails closed: a port that cannot bind a verified credential has no
     * authenticated submission path.</p>
     */
    default ProcessingJob submit(ProcessingJobRequest request, AuthenticatedPrincipal authenticated) {
        throw new MediaCapabilityNotAdmittedException(
                MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED, "RUNTIME_PORT",
                "authenticated Media job submission is not supported by this runtime port");
    }

    /**
     * Begins a canonical artifact upload bound to the authenticated ingress identity.
     * The request's tenant/principal must match the credential. The default fails closed.
     */
    default UploadSession beginUpload(
            UploadRequest request, String idempotencyKey, AuthenticatedPrincipal authenticated) {
        throw new MediaCapabilityNotAdmittedException(
                MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED, "RUNTIME_PORT",
                "authenticated Media upload is not supported by this runtime port");
    }

    /** Appends one upload chunk under the authenticated identity. The default fails closed. */
    default UploadSession appendUploadChunk(
            AuthenticatedPrincipal authenticated, String uploadId, int chunkIndex, byte[] bytes) {
        throw new MediaCapabilityNotAdmittedException(
                MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED, "RUNTIME_PORT",
                "authenticated Media upload is not supported by this runtime port");
    }

    /** Finalizes an owned upload under the authenticated identity. The default fails closed. */
    default MediaArtifact completeUpload(AuthenticatedPrincipal authenticated, String uploadId) {
        throw new MediaCapabilityNotAdmittedException(
                MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED, "RUNTIME_PORT",
                "authenticated Media upload is not supported by this runtime port");
    }

    Optional<ProcessingJob> job(String tenantId, String principalId, String jobId);

    Optional<MediaArtifact> artifact(String tenantId, String principalId, String artifactId);

    /**
     * Copies exact immutable artifact bytes to a caller-owned sink after owner/version checks.
     * Implementations must enforce maxBytes before exposing content and verify the completed
     * stream against the artifact's recorded SHA-256. Missing, unauthorized, or stale sources
     * return empty; production rights admission may fail closed with NOT_ADMITTED.
     */
    default Optional<ArtifactContentReadReceipt> copyArtifactContent(
            String tenantId, String principalId, String artifactId, ArtifactVersion expectedVersion,
            OutputStream target, long maxBytes) throws IOException {
        return Optional.empty();
    }

    /**
     * Reports whether the composed runtime can currently dispatch a job of this type
     * through a usable provider, evaluated the same way job submission selects one.
     * This is provider availability only — it grants no source rights and does not
     * admit any operation. The default fails closed: a port that cannot inspect its
     * provider registry reports not-ready.
     */
    default boolean processingReady(JobType jobType) {
        return false;
    }

    /**
     * Resolves source-rights admission for one immutable source version and operation
     * without creating a job, attempt, upload, or provider effect. Implementations must
     * resolve the exact artifact version owned by the authenticated principal against the
     * composed trusted authority, using the provider the runtime would actually select for
     * {@code jobType}. The default fails closed with {@link
     * com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status#UNAVAILABLE}:
     * a port that cannot reach an authority never reports an admission.
     */
    default MediaSourceAuthorizationContracts.Decision resolveSourceAuthorization(
            String tenantId,
            String principalId,
            String artifactId,
            ArtifactVersion sourceVersion,
            JobType jobType,
            String purpose,
            AuthenticatedPrincipal authenticated) {
        return new MediaSourceAuthorizationContracts.Decision(
                MediaSourceAuthorizationContracts.Status.UNAVAILABLE, null);
    }
}
