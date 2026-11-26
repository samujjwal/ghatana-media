/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

final class RuntimeMediaJobSubmissionPortTest {

    private static final String TENANT = "tenant-readback";
    private static final String PRINCIPAL = "principal-readback";
    private static final String REQUEST_ID = "agtool-durable-request";

    private static AuthenticatedPrincipal principal(String tenant, String principal) {
        return new AuthenticatedPrincipal(tenant, principal, Instant.now());
    }

    private static ProcessingJobRequest request() {
        return new ProcessingJobRequest(REQUEST_ID, TENANT, PRINCIPAL, "invocation-1", "artifact-1",
                "sha256:" + "a".repeat(64), JobType.VISION, "", Map.of());
    }

    private static ProcessingJob job(ProcessingJobRequest request, String tenant, String principal, String jobId) {
        return new ProcessingJob(jobId, request.requestId(), tenant, principal, request.artifactId(),
                request.jobType(), "", JobStatus.RUNNING, Instant.now(), null, null,
                Map.of(), "", 1L, request.expectedArtifactVersion(), "");
    }

    @Test
    void durableRequestReadbackRecoversAfterAdapterRestartWithoutObservedCache() {
        MediaProcessingRuntimePort runtime = mock(MediaProcessingRuntimePort.class);
        AuthenticatedPrincipal owner = principal(TENANT, PRINCIPAL);
        ProcessingJob durable = job(request(), TENANT, PRINCIPAL, "job-durable");
        when(runtime.jobByRequestId(REQUEST_ID, owner)).thenReturn(Optional.of(durable));
        RuntimeMediaJobSubmissionPort restartedAdapter = new RuntimeMediaJobSubmissionPort(runtime);

        assertThat(restartedAdapter.findByRequestId(owner, REQUEST_ID)).contains(durable);

        verify(runtime).jobByRequestId(REQUEST_ID, owner);
        verify(runtime, never()).job(TENANT, PRINCIPAL, "job-durable");
    }

    @Test
    void mismatchedDurableRowIsRejectedWithoutFallingBackToAnotherJob() {
        MediaProcessingRuntimePort runtime = mock(MediaProcessingRuntimePort.class);
        AuthenticatedPrincipal owner = principal(TENANT, PRINCIPAL);
        ProcessingJob foreign = job(request(), TENANT, "other-principal", "job-foreign");
        when(runtime.jobByRequestId(REQUEST_ID, owner)).thenReturn(Optional.of(foreign));

        assertThat(new RuntimeMediaJobSubmissionPort(runtime).findByRequestId(owner, REQUEST_ID)).isEmpty();

        verify(runtime).jobByRequestId(REQUEST_ID, owner);
        verify(runtime, never()).job(TENANT, PRINCIPAL, "job-foreign");
    }

    @Test
    void cacheFallbackRequiresExactAuthenticatedPrincipalAndEmptyLookupStaysEmpty() {
        MediaProcessingRuntimePort runtime = mock(MediaProcessingRuntimePort.class);
        AuthenticatedPrincipal owner = principal(TENANT, PRINCIPAL);
        AuthenticatedPrincipal other = principal(TENANT, "other-principal");
        ProcessingJobRequest request = request();
        ProcessingJob observed = job(request, TENANT, PRINCIPAL, "job-observed");
        when(runtime.submit(request, owner)).thenReturn(observed);
        when(runtime.jobByRequestId(REQUEST_ID, owner)).thenReturn(Optional.empty());
        when(runtime.job(TENANT, PRINCIPAL, "job-observed")).thenReturn(Optional.of(observed));
        when(runtime.jobByRequestId(REQUEST_ID, other)).thenReturn(Optional.empty());
        RuntimeMediaJobSubmissionPort adapter = new RuntimeMediaJobSubmissionPort(runtime);

        assertThat(adapter.submit(request, owner)).isEqualTo(observed);
        assertThat(adapter.findByRequestId(owner, REQUEST_ID)).contains(observed);
        assertThat(adapter.findByRequestId(other, REQUEST_ID)).isEmpty();

        verify(runtime).jobByRequestId(REQUEST_ID, other);
        verify(runtime, never()).job(TENANT, "other-principal", "job-observed");
    }
}
