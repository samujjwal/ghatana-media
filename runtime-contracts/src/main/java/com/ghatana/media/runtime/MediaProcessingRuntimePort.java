package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactContentReadReceipt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;

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
}
