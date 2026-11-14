/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;

import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * In-process {@link MediaJobSubmissionPort} over the canonical
 * {@link MediaProcessingRuntimePort}. Submission uses the authenticated overload so the
 * runtime derives policy context from the credential, never from the request identity.
 *
 * <p>The runtime port has no request-id lookup. This implementation remembers the job id of
 * submissions whose acknowledgment it observed, so a lost acknowledgment (the case that
 * needs reconciliation) stays unobservable here and the invocation remains OUTCOME_UNKNOWN
 * until the host supplies a durable request-id lookup via another port implementation.
 *
 * @doc.type class
 * @doc.purpose In-process Media runtime submission port
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class RuntimeMediaJobSubmissionPort implements MediaJobSubmissionPort {

    private record Known(String principalId, String jobId) { }

    private final MediaProcessingRuntimePort runtime;
    private final Map<String, Known> observed = new ConcurrentHashMap<>();

    public RuntimeMediaJobSubmissionPort(MediaProcessingRuntimePort runtime) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
    }

    @Override
    public ProcessingJob submit(ProcessingJobRequest request, AuthenticatedPrincipal authenticated) {
        ProcessingJob job = runtime.submit(request, authenticated);
        if (job != null) {
            observed.put(request.tenantId() + "\u0000" + request.requestId(),
                    new Known(request.principalId(), job.jobId()));
        }
        return job;
    }

    @Override
    public Optional<ProcessingJob> findByRequestId(String tenantId, String requestId) {
        Known known = observed.get(tenantId + "\u0000" + requestId);
        if (known == null) return Optional.empty();
        return runtime.job(tenantId, known.principalId(), known.jobId());
    }
}
