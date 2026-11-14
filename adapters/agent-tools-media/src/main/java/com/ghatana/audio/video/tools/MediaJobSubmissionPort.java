/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;

import java.util.Optional;

/**
 * Port through which Media agent tools reach the canonical Media job submission path.
 *
 * <p>The port is an integration seam, not an admission authority: implementations must
 * preserve the runtime's own admission, tenant/principal ownership and idempotency, and
 * must refuse with {@link com.ghatana.media.runtime.MediaCapabilityNotAdmittedException}
 * (zero effect) when the runtime does not admit the operation. Any other exception from
 * {@link #submit} is treated as an ambiguous dispatch (OUTCOME_UNKNOWN).
 *
 * @doc.type interface
 * @doc.purpose Canonical Media job submission seam for agent tools
 * @doc.layer product
 * @doc.pattern Port
 */
public interface MediaJobSubmissionPort {

    /** Submits the job bound to the authenticated principal; idempotent on the request id. */
    ProcessingJob submit(ProcessingJobRequest request, AuthenticatedPrincipal authenticated);

    /**
     * Read-only lookup of the job created for a derived request id, used to reconcile an
     * ambiguous submission. Empty means "not observable", never "no job was created".
     */
    Optional<ProcessingJob> findByRequestId(String tenantId, String requestId);
}
