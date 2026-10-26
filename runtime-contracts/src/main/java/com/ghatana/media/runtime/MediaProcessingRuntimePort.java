package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;

import java.util.Optional;

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
}
