package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/** J05: a per-tenant bound stops one tenant from exhausting the global job pool. */
class MediaRuntimeTenantFairnessTest {

    @Test
    void perTenantBoundFailsSecondTenantJobWhileOtherTenantsDispatch() throws Exception {
        var root = Files.createTempDirectory("media-tenant-fairness-");
        var blocker = new BlockingProvider();
        var completing = new CompletingProvider();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(
                        true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofMinutes(5), 4, "", "", true, false, root, 1),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(blocker, completing),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        try {
            var artifactA = upload(runtime, "tenant-a", "a.wav");
            var artifactB = upload(runtime, "tenant-b", "b.wav");

            var first = runtime.submit(new ProcessingJobRequest(
                    "request-a-1", "tenant-a", "tenant-a-principal", "corr-a-1",
                    artifactA.artifactId(), JobType.VISION, blocker.providerId(), Map.of()));
            await(runtime, "tenant-a", "tenant-a-principal", first.jobId(), JobStatus.RUNNING);

            // The same tenant's second dispatch exceeds the per-tenant bound.
            var second = runtime.submit(new ProcessingJobRequest(
                    "request-a-2", "tenant-a", "tenant-a-principal", "corr-a-2",
                    artifactA.artifactId(), JobType.VISION, blocker.providerId(), Map.of()));
            var secondTerminal = awaitAny(runtime, "tenant-a", "tenant-a-principal", second.jobId(),
                    Set.of(JobStatus.FAILED));
            assertThat(secondTerminal.failureCode()).isEqualTo("TENANT_CONCURRENCY_LIMIT");

            // A different tenant still dispatches under the same global pool.
            var other = runtime.submit(new ProcessingJobRequest(
                    "request-b-1", "tenant-b", "tenant-b-principal", "corr-b-1",
                    artifactB.artifactId(), JobType.VISION, completing.providerId(), Map.of()));
            var otherTerminal = awaitAny(runtime, "tenant-b", "tenant-b-principal", other.jobId(),
                    Set.of(JobStatus.COMPLETED, JobStatus.FAILED));
            assertThat(otherTerminal.status()).as("failureCode=%s result=%s", otherTerminal.failureCode(), otherTerminal.result()).isEqualTo(JobStatus.COMPLETED);

            // When the first tenant job releases its slot the tenant can dispatch again.
            blocker.future().complete(Map.of("caption", "done"));
            var firstTerminal = awaitAny(runtime, "tenant-a", "tenant-a-principal", first.jobId(),
                    Set.of(JobStatus.COMPLETED, JobStatus.FAILED));
            assertThat(firstTerminal.status()).isEqualTo(JobStatus.COMPLETED);
            var third = runtime.submit(new ProcessingJobRequest(
                    "request-a-3", "tenant-a", "tenant-a-principal", "corr-a-3",
                    artifactA.artifactId(), JobType.VISION, completing.providerId(), Map.of()));
            var thirdTerminal = awaitAny(runtime, "tenant-a", "tenant-a-principal", third.jobId(),
                    Set.of(JobStatus.COMPLETED, JobStatus.FAILED));
            assertThat(thirdTerminal.status()).as("failureCode=%s result=%s", thirdTerminal.failureCode(), thirdTerminal.result()).isEqualTo(JobStatus.COMPLETED);
        } finally {
            runtime.close();
        }
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact upload(
            MediaRuntime runtime, String tenant, String fileName) throws Exception {
        byte[] content = fileName.getBytes(StandardCharsets.UTF_8);
        var upload = runtime.beginUpload(new UploadRequest(
                tenant, tenant + "-principal", fileName, "audio/wav", content.length,
                sha256(content), "CONFIDENTIAL", Duration.ofHours(1), Map.of()),
                tenant + "-upload");
        runtime.appendChunk(tenant, tenant + "-principal", upload.uploadId(), 0, content);
        return runtime.completeUpload(tenant, tenant + "-principal", upload.uploadId());
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob await(
            MediaRuntime runtime, String tenant, String principal, String jobId, JobStatus wanted)
            throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            var job = runtime.job(tenant, principal, jobId).orElseThrow();
            if (job.status() == wanted) return job;
            Thread.sleep(10);
        }
        throw new AssertionError("job " + jobId + " did not reach " + wanted);
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob awaitAny(
            MediaRuntime runtime, String tenant, String principal, String jobId, Set<JobStatus> wanted)
            throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        var job = runtime.job(tenant, principal, jobId).orElseThrow();
        while (!wanted.contains(job.status()) && System.nanoTime() < deadline) {
            Thread.sleep(10);
            job = runtime.job(tenant, principal, jobId).orElseThrow();
        }
        assertThat(job.status()).isIn(wanted);
        return job;
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static final class BlockingProvider implements MediaProcessingProvider {
        private final CompletableFuture<Map<String, Object>> future = new CompletableFuture<>();
        private final AtomicReference<Cancellation> cancellation = new AtomicReference<>();

        @Override public String providerId() { return "blocking-tenant-provider"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            cancellation.set(context.cancellation());
            return future;
        }
        CompletableFuture<Map<String, Object>> future() { return future; }
    }

    private static final class CompletingProvider implements MediaProcessingProvider {
        @Override public String providerId() { return "completing-tenant-provider"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 2; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return CompletableFuture.completedFuture(Map.of("caption", "done"));
        }
    }
}
