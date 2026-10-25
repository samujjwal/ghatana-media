package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaJobStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobLease;
import com.ghatana.media.runtime.MediaRuntimeContracts.RecoveryCursor;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Restart proof for jobs whose provider outcome remained uncertain at shutdown. */
class MediaRuntimeRestartReconciliationTest {

    @Test
    void duplicateSubmissionReturnsExistingJobWithoutDispatchingProviderTwice() throws Exception {
        var root = Files.createTempDirectory("media-duplicate-submission-");
        var artifacts = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        var jobs = new LocalMediaRuntimeSupport.JobStore(false);
        var streams = new LocalMediaRuntimeSupport.StreamStore();
        CompletableFuture<Map<String, Object>> pending = new CompletableFuture<>();
        AtomicInteger calls = new AtomicInteger();
        MediaProcessingProvider provider = pendingProvider(pending, calls);
        MediaRuntime runtime = runtime(root, artifacts, jobs, streams, provider);
        try {
            byte[] bytes = "media".getBytes(StandardCharsets.UTF_8);
            var upload = runtime.beginUpload(new UploadRequest(
                    "tenant-a", "principal-a", "clip.bin", "application/octet-stream", bytes.length,
                    HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),
                    "CONFIDENTIAL", Duration.ofMinutes(10), Map.of()), "restart-first-upload");
            runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, bytes);
            var artifact = runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());
            var request = new ProcessingJobRequest(
                    "request-duplicate", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "remote", Map.of());

            var first = runtime.submit(request);
            var replay = runtime.submit(request);

            assertThat(replay.jobId()).isEqualTo(first.jobId());
            assertThatThrownBy(() -> runtime.submit(new ProcessingJobRequest(
                    request.requestId(), request.tenantId(), request.principalId(), request.correlationId(),
                    request.artifactId(), request.jobType(), request.providerHint(), Map.of("mode", "changed"))))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("different submission");
            assertThat(calls).hasValue(1);
        } finally {
            runtime.close();
        }
    }

    @Test
    void unconfirmedCancellationSurvivesShutdownAndRestartRequiresExplicitReconciliation() throws Exception {
        var root = Files.createTempDirectory("media-restart-reconciliation-");
        var artifacts = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        var jobs = new LocalMediaRuntimeSupport.JobStore(false);
        var streams = new LocalMediaRuntimeSupport.StreamStore();
        CompletableFuture<Map<String, Object>> pending = new CompletableFuture<>();
        AtomicInteger calls = new AtomicInteger();
        MediaProcessingProvider provider = pendingProvider(pending, calls);

        MediaRuntime first = runtime(root, artifacts, jobs, streams, provider);
        String jobId;
        try {
            byte[] bytes = "media".getBytes(StandardCharsets.UTF_8);
            var upload = first.beginUpload(new UploadRequest(
                    "tenant-a", "principal-a", "clip.bin", "application/octet-stream", bytes.length,
                    HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),
                    "CONFIDENTIAL", Duration.ofMinutes(10), Map.of()), "restart-first-upload");
            first.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, bytes);
            var artifact = first.completeUpload("tenant-a", "principal-a", upload.uploadId());
            var accepted = first.submit(new ProcessingJobRequest(
                    "request-restart", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "remote", Map.of()));
            jobId = accepted.jobId();

            var requested = first.cancel("tenant-a", "principal-a", jobId);
            assertThat(requested.status()).isEqualTo(JobStatus.RUNNING);
            assertThat(requested.result())
                    .containsEntry("cancellationOutcome", "REQUESTED_UNCONFIRMED");
            assertThat(pending).isNotCancelled();
        } finally {
            first.close();
        }

        assertThat(jobs.find("tenant-a", jobId)).get()
                .extracting(job -> job.status())
                .isEqualTo(JobStatus.RUNNING);

        MediaRuntime restarted = runtime(root, artifacts, jobs, streams, provider);
        try {
            var reconciled = restarted.job("tenant-a", "principal-a", jobId).orElseThrow();
            assertThat(reconciled.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(reconciled.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");

            assertThat(reconciled.result())
                    .containsEntry("reconciliation", "provider outcome unknown after runtime restart")
                    .containsEntry("providerOutcome", "UNKNOWN");
            assertThat(reconciled.status()).isNotEqualTo(JobStatus.CANCELLED);
            assertThat(calls).hasValue(1);
        } finally {
            restarted.close();
        }
    }

    @Test
    void startupRecoveryDrainsMoreThanOneBoundedBatchWithoutClaimingFailure() throws Exception {
        var root = Files.createTempDirectory("media-recovery-backlog-");
        var jobs = new LocalMediaRuntimeSupport.JobStore(false);
        for (int i = 0; i < 1_005; i++) {
            jobs.create(new ProcessingJob(
                    "job-" + i, "request-" + i, "tenant-a", "principal-a", "artifact-" + i,
                    JobType.VISION, "remote", JobStatus.RUNNING, java.time.Instant.now(),
                    java.time.Instant.now(), null, Map.of(), "", 1));
        }
        MediaJobStore poisonFirst = new MediaJobStore() {
            @Override public String storeId() { return jobs.storeId(); }
            @Override public ProcessingJob create(ProcessingJob job) { return jobs.create(job); }
            @Override public ProcessingJob create(ProcessingJob job, String submissionDigest) {
                return jobs.create(job, submissionDigest);
            }
            @Override public ProcessingJob update(ProcessingJob expected, ProcessingJob updated) {
                if ("job-0".equals(expected.jobId())) throw new IllegalStateException("poison row");
                return jobs.update(expected, updated);
            }
            @Override public ProcessingJob update(JobLease lease, ProcessingJob expected, ProcessingJob updated) {
                return jobs.update(lease, expected, updated);
            }
            @Override public Optional<ProcessingJob> find(String tenant, String job) { return jobs.find(tenant, job); }
            @Override public List<ProcessingJob> list(String tenant, int limit) { return jobs.list(tenant, limit); }
            @Override public JobLease claim(ProcessingJob expected, String owner, java.time.Instant expires) {
                return jobs.claim(expected, owner, expires);
            }
            @Override public boolean leaseValid(JobLease lease) { return jobs.leaseValid(lease); }
            @Override public void release(JobLease lease) { jobs.release(lease); }
            @Override public List<ProcessingJob> recoverable(int limit) { return jobs.recoverable(limit); }
            @Override public List<ProcessingJob> recoverableAfter(int limit, RecoveryCursor cursor) {
                return jobs.recoverableAfter(limit, cursor);
            }
            @Override public boolean durable() { return false; }
            @Override public boolean productionEligible() { return false; }
            @Override public boolean ready() { return true; }
        };
        var runtime = runtime(
                root, new LocalMediaRuntimeSupport.FileArtifactStore(root), poisonFirst,
                new LocalMediaRuntimeSupport.StreamStore(), pendingProvider(
                        new CompletableFuture<>(), new AtomicInteger()));
        try {
            assertThat(jobs.recoverable(1_000)).hasSize(1)
                    .allSatisfy(job -> assertThat(job.jobId()).isEqualTo("job-0"));
            assertThat(jobs.find("tenant-a", "job-0")).get()
                    .extracting(job -> job.status()).isEqualTo(JobStatus.RUNNING);
            assertThat(jobs.find("tenant-a", "job-1004")).get()
                    .extracting(job -> job.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
        } finally {
            runtime.close();
        }
    }

    private static MediaRuntime runtime(
            java.nio.file.Path root,
            LocalMediaRuntimeSupport.FileArtifactStore artifacts,
            MediaJobStore jobs,
            LocalMediaRuntimeSupport.StreamStore streams,
            MediaProcessingProvider provider) {
        return new MediaRuntime(
                new MediaRuntimeConfig(
                        true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                artifacts,
                jobs,
                streams,
                null,
                List.of(provider),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static MediaProcessingProvider pendingProvider(
            CompletableFuture<Map<String, Object>> pending,
            AtomicInteger calls) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "remote"; }
            @Override public String providerVersion() { return "remote-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 1; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                calls.incrementAndGet();
                return pending;
            }
            @Override public CancellationOutcome cancel(
                    String tenantId, String principalId, String correlationId, String jobId) {
                return CancellationOutcome.REQUESTED_UNCONFIRMED;
            }
        };
    }
}
