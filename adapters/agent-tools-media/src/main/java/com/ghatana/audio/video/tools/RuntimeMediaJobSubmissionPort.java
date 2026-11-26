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
 * <p>Readback first uses the runtime's durable request-id lookup, which remains available
 * after this adapter is reconstructed. The in-process job-id cache is only a fallback for an
 * exact authenticated principal when the durable query has no observable row.
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
        if (job != null && authenticated != null
                && authenticated.tenantId().equals(request.tenantId())
                && authenticated.principalId().equals(request.principalId())
                && authenticated.tenantId().equals(job.tenantId())
                && authenticated.principalId().equals(job.principalId())
                && request.requestId().equals(job.requestId())) {
            observed.put(key(authenticated.tenantId(), request.requestId()),
                    new Known(authenticated.principalId(), job.jobId()));
        }
        return job;
    }

    @Override
    public Optional<ProcessingJob> findByRequestId(AuthenticatedPrincipal authenticated, String requestId) {
        if (authenticated == null || requestId == null || requestId.isBlank()) return Optional.empty();
        Optional<ProcessingJob> durable = runtime.jobByRequestId(requestId, authenticated);
        if (durable == null) return Optional.empty();
        if (durable.isPresent()) return owned(durable.get(), authenticated, requestId) ? durable : Optional.empty();

        Known known = observed.get(key(authenticated.tenantId(), requestId));
        if (known == null || !known.principalId().equals(authenticated.principalId())) return Optional.empty();
        return runtime.job(authenticated.tenantId(), authenticated.principalId(), known.jobId())
                .filter(job -> owned(job, authenticated, requestId));
    }

    private static boolean owned(ProcessingJob job, AuthenticatedPrincipal authenticated, String requestId) {
        return job != null && job.requestId().equals(requestId)
                && job.tenantId().equals(authenticated.tenantId())
                && job.principalId().equals(authenticated.principalId());
    }

    private static String key(String tenantId, String requestId) {
        return tenantId + "\u0000" + requestId;
    }
}
