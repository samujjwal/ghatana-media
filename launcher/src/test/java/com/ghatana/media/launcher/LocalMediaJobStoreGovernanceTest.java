package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LocalMediaJobStoreGovernanceTest {

    @Test
    void requestReplayIsIdempotentAndIdentityBound() {
        var store = new LocalMediaRuntimeSupport.JobStore();
        ProcessingJob first = job("job-1", "request-1", "artifact-1");
        assertThat(store.create(first)).isEqualTo(first);
        assertThat(store.create(job("job-2", "request-1", "artifact-1"))).isEqualTo(first);
        ProcessingJob fallbackCompleted = new ProcessingJob(
                first.jobId(), first.requestId(), first.tenantId(), first.principalId(), first.artifactId(),
                first.jobType(), "provider-fallback", JobStatus.COMPLETED, first.createdAt(),
                Instant.now(), Instant.now(), Map.of("providerId", "provider-fallback"), "", 2,
                first.requestFingerprint());
        store.update(first, fallbackCompleted);
        assertThat(store.create(job("job-after-fallback", "request-1", "artifact-1")))
                .isEqualTo(fallbackCompleted);
        assertThatThrownBy(() -> store.create(job("job-3", "request-1", "different-artifact")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("different job payload");
    }

    @Test
    void concurrentRequestReplaysAtomicallyResolveToTheSameJob() throws Exception {
        var store = new LocalMediaRuntimeSupport.JobStore();
        int callers = 24;
        var ready = new CountDownLatch(callers);
        var start = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(callers)) {
            var results = java.util.stream.IntStream.range(0, callers)
                    .mapToObj(index -> executor.submit(() -> {
                        ready.countDown();
                        if (!start.await(5, TimeUnit.SECONDS)) throw new AssertionError("start timed out");
                        return store.create(job("job-" + index, "shared-request", "artifact-1"));
                    })).toList();
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            var resolved = results.stream().map(future -> {
                try { return future.get(5, TimeUnit.SECONDS); }
                catch (Exception failure) { throw new AssertionError("idempotent replay failed", failure); }
            }).toList();
            assertThat(resolved).hasSize(callers).allMatch(value -> value.jobId().equals(resolved.getFirst().jobId()));
            assertThat(store.list("tenant-a", 100)).hasSize(1);
        }
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
                accepted.createdAt(), null, Instant.now(), Map.of(), "RECONCILED", 2,
                accepted.requestFingerprint());
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
                accepted.createdAt(), null, null, Map.of("reconciliation", "outcome unknown"), "", 2,
                accepted.requestFingerprint());

        store.update(accepted, unknown);

        assertThat(store.leaseValid(lease)).isFalse();
    }

    private static ProcessingJob job(String jobId, String requestId, String artifactId) {
        return new ProcessingJob(
                jobId, requestId, "tenant-a", "principal-a", artifactId, JobType.VISION,
                "provider-a", JobStatus.ACCEPTED, Instant.now(), null, null, Map.of(), "", 1,
                "sha256:" + requestId + ":" + artifactId);
    }
}
