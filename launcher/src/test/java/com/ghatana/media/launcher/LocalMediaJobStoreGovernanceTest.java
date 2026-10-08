package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LocalMediaJobStoreGovernanceTest {

    @Test
    void requestReplayIsIdempotentAndIdentityBound() {
        var store = new LocalMediaRuntimeSupport.JobStore();
        ProcessingJob first = job("job-1", "request-1", "artifact-1");
        assertThat(store.create(first)).isEqualTo(first);
        assertThat(store.create(job("job-2", "request-1", "artifact-1"))).isEqualTo(first);
        assertThatThrownBy(() -> store.create(job("job-3", "request-1", "different-artifact")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("different job");
    }

    @Test
    void leaseReclaimAdvancesFenceAndRejectsConcurrentWorker() throws Exception {
        var store = new LocalMediaRuntimeSupport.JobStore();
        ProcessingJob job = store.create(job("job-1", "request-1", "artifact-1"));
        // Keep enough headroom for a loaded CI worker before checking the initial lease.
        var first = store.claim(job, "worker-a", Instant.now().plusSeconds(1));
        assertThat(store.leaseValid(first)).isTrue();
        assertThatThrownBy(() -> store.claim(job, "worker-b", Instant.now().plusSeconds(1)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("another worker");

        Thread.sleep(1_100);
        var reclaimed = store.claim(job, "worker-b", Instant.now().plusSeconds(1));
        assertThat(reclaimed.fencingToken()).isGreaterThan(first.fencingToken());
        assertThat(store.leaseValid(first)).isFalse();
        assertThat(store.leaseValid(reclaimed)).isTrue();
    }

    @Test
    void recoverableProjectionExcludesTerminalJobs() {
        var store = new LocalMediaRuntimeSupport.JobStore();
        ProcessingJob accepted = store.create(job("job-1", "request-1", "artifact-1"));
        assertThat(store.recoverable(10)).containsExactly(accepted);
        ProcessingJob failed = new ProcessingJob(
                accepted.jobId(), accepted.requestId(), accepted.tenantId(), accepted.principalId(),
                accepted.artifactId(), accepted.jobType(), accepted.providerId(), JobStatus.FAILED,
                accepted.createdAt(), null, Instant.now(), Map.of(), "RECONCILED", 2);
        store.update(accepted, failed);
        assertThat(store.recoverable(10)).isEmpty();
    }

    @Test
    void outcomeUnknownInvalidatesAnExistingWorkerLease() {
        var store = new LocalMediaRuntimeSupport.JobStore();
        ProcessingJob accepted = store.create(job("job-unknown", "request-unknown", "artifact-1"));
        var lease = store.claim(accepted, "worker-a", Instant.now().plusSeconds(60));
        ProcessingJob unknown = new ProcessingJob(
                accepted.jobId(), accepted.requestId(), accepted.tenantId(), accepted.principalId(),
                accepted.artifactId(), accepted.jobType(), accepted.providerId(), JobStatus.OUTCOME_UNKNOWN,
                accepted.createdAt(), null, null, Map.of("reconciliation", "outcome unknown"), "", 2);

        store.update(accepted, unknown);

        assertThat(store.leaseValid(lease)).isFalse();
    }

    private static ProcessingJob job(String jobId, String requestId, String artifactId) {
        return new ProcessingJob(
                jobId, requestId, "tenant-a", "principal-a", artifactId, JobType.VISION,
                "provider-a", JobStatus.ACCEPTED, Instant.now(), null, null, Map.of(), "", 1);
    }
}
