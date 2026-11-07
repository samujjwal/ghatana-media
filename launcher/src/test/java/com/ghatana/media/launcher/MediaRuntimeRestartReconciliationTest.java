package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
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
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingAttempt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptQuery;
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
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Restart proof for jobs whose provider outcome remained uncertain at shutdown. */
class MediaRuntimeRestartReconciliationTest {

    @Test
    void speechRestartQueriesExactAttemptOnceAndPersistsOnlyUnknownReceiptDigest() throws Exception {
        var root = Files.createTempDirectory("media-stt-restart-readback-");
        var jobs = new LocalMediaRuntimeSupport.JobStore(false);
        ProcessingJob running = runningSpeechJob();
        jobs.create(running, running.requestFingerprint(), new com.ghatana.media.runtime.MediaRuntimeContracts
                .SttSubmissionSnapshot(com.ghatana.media.runtime.MediaRuntimeContracts.SttSubmissionSnapshot.VERSION,
                        null, null, "", "", "", "", "", null));
        ProcessingAttempt attempt = speechAttempt(running);
        AtomicInteger queries = new AtomicInteger();
        AtomicInteger dispatches = new AtomicInteger();
        AtomicReference<ProviderAttemptQuery> querySeen = new AtomicReference<>();
        var exactStore = attemptStore(jobs, attempt);
        MediaProcessingProvider provider = speechProvider(dispatches, query -> {
            queries.incrementAndGet();
            querySeen.set(query);
            return CompletableFuture.completedFuture(new ProviderAttemptObservation(
                    query, AttemptFinality.SUCCEEDED, query.providerReceiptId(),
                    Map.of("transcript", "sensitive transcript"), "a".repeat(64),
                    java.time.Instant.now()));
        });
        var runtime = runtime(root, new LocalMediaRuntimeSupport.FileArtifactStore(root), exactStore,
                new LocalMediaRuntimeSupport.StreamStore(), provider);
        try {
            var recovered = jobs.find(running.tenantId(), running.jobId()).orElseThrow();
            assertThat(querySeen.get()).isEqualTo(attempt.query());
            assertThat(queries).hasValue(1);
            assertThat(dispatches).hasValue(0);
            assertThat(recovered.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(recovered.result()).containsEntry("providerStatus", "SUCCEEDED")
                    .containsEntry("providerReceiptDigest", sha256(attempt.providerReceiptId()))
                    .containsEntry("reconciliation",
                            "provider succeeded; current source authorization unavailable")
                    .doesNotContainKey("transcript");
            assertThat(runtime.job(running.tenantId(), running.principalId(), running.jobId()).orElseThrow()
                    .status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            runtime.close();
            runtime = runtime(root, new LocalMediaRuntimeSupport.FileArtifactStore(root), exactStore,
                    new LocalMediaRuntimeSupport.StreamStore(), provider);
            assertThat(queries).hasValue(1);
        } finally {
            runtime.close();
        }
    }

    @Test
    void seededUnknownSpeechAttemptIsReconciledAcrossRuntimeReopenWithoutRedispatch() throws Exception {
        var root = Files.createTempDirectory("media-stt-seeded-unknown-recovery-");
        var jobs = new LocalMediaRuntimeSupport.JobStore(false);
        ProcessingJob running = runningSpeechJob();
        jobs.create(running, running.requestFingerprint(), new com.ghatana.media.runtime.MediaRuntimeContracts
                .SttSubmissionSnapshot(com.ghatana.media.runtime.MediaRuntimeContracts.SttSubmissionSnapshot.VERSION,
                        null, null, "", "", "", "", "", null));
        ProcessingAttempt attempt = speechAttempt(running);
        AtomicInteger dispatches = new AtomicInteger();
        AtomicInteger effects = new AtomicInteger();
        AtomicInteger statusQueries = new AtomicInteger();
        AtomicReference<ProviderAttemptQuery> querySeen = new AtomicReference<>();
        MediaProcessingProvider provider = new MediaProcessingProvider() {
            @Override public String providerId() { return "speech-provider"; }
            @Override public String providerVersion() { return "speech-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 1; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return CompletableFuture.failedFuture(new AssertionError("typed attempt path required"));
            }
            @Override public CompletableFuture<com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission>
                    processAttempt(ProcessingContext context,
                            com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext providerAttempt) {
                dispatches.incrementAndGet();
                // This direct fake-provider call is setup only; it does not exercise
                // MediaRuntime dispatch. The seeded RUNNING job/UNKNOWN attempt below
                // represents the recovery cut tested by runtime startup.
                effects.incrementAndGet();
                return CompletableFuture.completedFuture(
                        com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission.unknown());
            }
            @Override public CompletableFuture<ProviderAttemptObservation> reconcileAttempt(
                    ProviderAttemptQuery query) {
                statusQueries.incrementAndGet();
                querySeen.set(query);
                return CompletableFuture.completedFuture(new ProviderAttemptObservation(
                        query, AttemptFinality.SUCCEEDED, query.providerReceiptId(),
                        Map.of("transcript", "synthetic provider result"), "e".repeat(64),
                        java.time.Instant.now()));
            }
        };

        var submission = provider.processAttempt(null,
                com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext.from(attempt)).join();
        assertThat(submission.finality()).isEqualTo(AttemptFinality.UNKNOWN);
        assertThat(dispatches).hasValue(1);
        assertThat(effects).hasValue(1);

        // The stored RUNNING job/UNKNOWN attempt represents a pre-seeded recovery cut.
        // It does not assert that MediaRuntime performed the dispatch or persisted a lost ACK.
        var exactStore = attemptStore(jobs, attempt);
        MediaRuntime first = runtime(root, new LocalMediaRuntimeSupport.FileArtifactStore(root), exactStore,
                new LocalMediaRuntimeSupport.StreamStore(), provider);
        try {
            ProcessingJob recovered = jobs.find(running.tenantId(), running.jobId()).orElseThrow();
            assertThat(querySeen.get()).isEqualTo(attempt.query());
            assertThat(statusQueries).hasValue(1);
            assertThat(recovered.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(recovered.result()).containsEntry("providerStatus", "SUCCEEDED")
                    .doesNotContainKey("transcript");
        } finally {
            first.close();
        }

        MediaRuntime reopened = runtime(root, new LocalMediaRuntimeSupport.FileArtifactStore(root), exactStore,
                new LocalMediaRuntimeSupport.StreamStore(), provider);
        try {
            ProcessingJob readBack = reopened.job(
                    running.tenantId(), running.principalId(), running.jobId()).orElseThrow();
            assertThat(readBack.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(readBack.status()).isNotEqualTo(JobStatus.COMPLETED);
            assertThat(readBack.result()).doesNotContainKey("transcript");
            assertThat(dispatches).hasValue(1);
            assertThat(effects).hasValue(1);
            assertThat(statusQueries).hasValue(1);
        } finally {
            reopened.close();
        }
    }

    @Test
    void speechRestartQueryMismatchAndTimeoutRemainUnknownWithoutDispatch() throws Exception {
        for (boolean timeout : List.of(false, true)) {
            var root = Files.createTempDirectory("media-stt-restart-ambiguous-");
            var jobs = new LocalMediaRuntimeSupport.JobStore(false);
            ProcessingJob running = runningSpeechJob();
            jobs.create(running, running.requestFingerprint(), new com.ghatana.media.runtime.MediaRuntimeContracts
                    .SttSubmissionSnapshot(com.ghatana.media.runtime.MediaRuntimeContracts.SttSubmissionSnapshot.VERSION,
                            null, null, "", "", "", "", "", null));
            ProcessingAttempt attempt = speechAttempt(running);
            AtomicInteger queries = new AtomicInteger();
            AtomicInteger dispatches = new AtomicInteger();
            CompletableFuture<ProviderAttemptObservation> pending = new CompletableFuture<>();
            MediaProcessingProvider provider = speechProvider(dispatches, query -> {
                queries.incrementAndGet();
                if (timeout) return pending;
                ProviderAttemptQuery mismatched = new ProviderAttemptQuery(query.tenantId(), query.jobId(),
                        query.requestId(), query.attemptNumber(), query.fencingToken(), query.requestFingerprint(),
                        "other-provider", query.providerOperationId(), query.providerReceiptId());
                return CompletableFuture.completedFuture(new ProviderAttemptObservation(
                        mismatched, AttemptFinality.SUCCEEDED, query.providerReceiptId(), Map.of(),
                        "b".repeat(64), java.time.Instant.now()));
            });
            if (timeout) CompletableFuture.delayedExecutor(3, TimeUnit.SECONDS).execute(() ->
                    pending.complete(new ProviderAttemptObservation(attempt.query(), AttemptFinality.SUCCEEDED,
                            attempt.providerReceiptId(), Map.of(), "c".repeat(64), java.time.Instant.now())));
            var exactStore = attemptStore(jobs, attempt);
            var runtime = runtime(root, new LocalMediaRuntimeSupport.FileArtifactStore(root), exactStore,
                    new LocalMediaRuntimeSupport.StreamStore(), provider);
            try {
                var recovered = jobs.find(running.tenantId(), running.jobId()).orElseThrow();
                assertThat(recovered.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
                assertThat(queries).hasValue(1);
                assertThat(dispatches).hasValue(0);
                assertThat(recovered.result()).doesNotContainKey("providerStatus")
                        .doesNotContainKey("transcript");
                if (timeout) assertThat(pending).isCancelled();
            } finally {
                runtime.close();
            }
        }
    }

    @Test
    void speechRestartReceiptMismatchRemainsUnknownAcrossReopenWithoutDispatch() throws Exception {
        var root = Files.createTempDirectory("media-stt-restart-receipt-mismatch-");
        var jobs = new LocalMediaRuntimeSupport.JobStore(false);
        ProcessingJob running = runningSpeechJob();
        jobs.create(running, running.requestFingerprint(), new com.ghatana.media.runtime.MediaRuntimeContracts
                .SttSubmissionSnapshot(com.ghatana.media.runtime.MediaRuntimeContracts.SttSubmissionSnapshot.VERSION,
                        null, null, "", "", "", "", "", null));
        ProcessingAttempt attempt = speechAttempt(running);
        AtomicInteger queries = new AtomicInteger();
        AtomicInteger dispatches = new AtomicInteger();
        AtomicReference<ProviderAttemptQuery> querySeen = new AtomicReference<>();
        assertThatThrownBy(() -> new ProviderAttemptObservation(
                attempt.query(), AttemptFinality.SUCCEEDED, "different-provider-receipt",
                Map.of("transcript", "must not be exposed"), "f".repeat(64), java.time.Instant.now()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("receipt does not match exact query");
        MediaProcessingProvider provider = speechProvider(dispatches, query -> {
            queries.incrementAndGet();
            querySeen.set(query);
            return CompletableFuture.failedFuture(
                    new IllegalArgumentException("provider receipt did not match exact attempt query"));
        });
        var exactStore = attemptStore(jobs, attempt);

        MediaRuntime first = runtime(root, new LocalMediaRuntimeSupport.FileArtifactStore(root), exactStore,
                new LocalMediaRuntimeSupport.StreamStore(), provider);
        try {
            ProcessingJob recovered = jobs.find(running.tenantId(), running.jobId()).orElseThrow();
            assertThat(querySeen.get()).isEqualTo(attempt.query());
            assertThat(queries).hasValue(1);
            assertThat(dispatches).hasValue(0);
            assertThat(recovered.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(recovered.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
            assertThat(recovered.result()).doesNotContainKey("providerStatus")
                    .doesNotContainKey("providerReceiptDigest")
                    .doesNotContainKey("transcript");
        } finally {
            first.close();
        }

        MediaRuntime reopened = runtime(root, new LocalMediaRuntimeSupport.FileArtifactStore(root), exactStore,
                new LocalMediaRuntimeSupport.StreamStore(), provider);
        try {
            ProcessingJob readBack = reopened.job(
                    running.tenantId(), running.principalId(), running.jobId()).orElseThrow();
            assertThat(readBack.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(readBack.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
            assertThat(readBack.result()).doesNotContainKey("providerStatus")
                    .doesNotContainKey("providerReceiptDigest")
                    .doesNotContainKey("transcript");
            assertThat(queries).hasValue(1);
            assertThat(dispatches).hasValue(0);
        } finally {
            reopened.close();
        }
    }

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

            // J-20 fixture binding: after restart, authenticated cancellation is an
            // observation against the same canonical job. It cannot convert an
            // unresolved provider outcome into cancellation or create another dispatch.
            var cancelReplay = restarted.cancel("tenant-a", "principal-a", jobId);
            var readReplay = restarted.job("tenant-a", "principal-a", jobId).orElseThrow();
            assertThat(cancelReplay).isEqualTo(reconciled);
            assertThat(readReplay).isEqualTo(reconciled);
            assertThat(readReplay.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
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

    @Test
    void startupRecoveryLeavesPersistedTerminalJobsAndTheirFinalityUntouched() throws Exception {
        var root = Files.createTempDirectory("media-terminal-recovery-boundary-");
        var jobs = new LocalMediaRuntimeSupport.JobStore(false);
        var completed = new ProcessingJob(
                "job-completed", "request-completed", "tenant-a", "principal-a", "artifact-a",
                JobType.VISION, "remote", JobStatus.COMPLETED, java.time.Instant.now(),
                java.time.Instant.now(), java.time.Instant.now(), Map.of("result", "stored"), "", 4);
        var failed = new ProcessingJob(
                "job-failed", "request-failed", "tenant-a", "principal-a", "artifact-b",
                JobType.VISION, "remote", JobStatus.FAILED, java.time.Instant.now(),
                java.time.Instant.now(), java.time.Instant.now(), Map.of(), "PROVIDER_FAILED", 3);
        var cancelled = new ProcessingJob(
                "job-cancelled", "request-cancelled", "tenant-a", "principal-a", "artifact-c",
                JobType.VISION, "remote", JobStatus.CANCELLED, java.time.Instant.now(),
                java.time.Instant.now(), java.time.Instant.now(), Map.of(), "", 2);
        jobs.create(completed);
        jobs.create(failed);
        jobs.create(cancelled);

        var runtime = runtime(root, new LocalMediaRuntimeSupport.FileArtifactStore(root), jobs,
                new LocalMediaRuntimeSupport.StreamStore(), pendingProvider(
                        new CompletableFuture<>(), new AtomicInteger()));
        try {
            assertThat(jobs.find("tenant-a", completed.jobId())).contains(completed);
            assertThat(jobs.find("tenant-a", failed.jobId())).contains(failed);
            assertThat(jobs.find("tenant-a", cancelled.jobId())).contains(cancelled);
            assertThat(jobs.recoverable(10)).isEmpty();
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

    private static ProcessingJob runningSpeechJob() {
        return new ProcessingJob("stt-job", "stt-request", "tenant-stt", "principal-stt", "artifact-stt",
                JobType.SPEECH_TO_TEXT, "speech-provider", JobStatus.RUNNING, java.time.Instant.now(),
                java.time.Instant.now(), null, Map.of(), "", 2, "sha256:" + "d".repeat(64), "d".repeat(64));
    }

    private static ProcessingAttempt speechAttempt(ProcessingJob job) {
        return new ProcessingAttempt(job.tenantId(), job.jobId(), job.requestId(), 1, 7,
                job.requestFingerprint(), "speech-provider", "operation-1", "receipt-1",
                AttemptFinality.UNKNOWN, "", "", java.time.Instant.now());
    }

    private static String sha256(String value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8)));
    }

    private static MediaJobStore attemptStore(
            LocalMediaRuntimeSupport.JobStore jobs, ProcessingAttempt attempt) {
        return new MediaJobStore() {
            @Override public String storeId() { return jobs.storeId(); }
            @Override public ProcessingJob create(ProcessingJob job, String digest) { return jobs.create(job, digest); }
            @Override public ProcessingJob update(ProcessingJob expected, ProcessingJob updated) {
                return jobs.update(expected, updated);
            }
            @Override public ProcessingJob update(JobLease lease, ProcessingJob expected, ProcessingJob updated) {
                return jobs.update(lease, expected, updated);
            }
            @Override public Optional<ProcessingJob> find(String tenant, String id) { return jobs.find(tenant, id); }
            @Override public Optional<ProcessingAttempt> findProcessingAttempt(String tenant, String id, int number) {
                return tenant.equals(attempt.tenantId()) && id.equals(attempt.jobId())
                        && number == attempt.attemptNumber() ? Optional.of(attempt) : Optional.empty();
            }
            @Override public List<ProcessingJob> list(String tenant, int limit) { return jobs.list(tenant, limit); }
            @Override public JobLease claim(ProcessingJob expected, String owner, java.time.Instant expiry) {
                return jobs.claim(expected, owner, expiry);
            }
            @Override public boolean leaseValid(JobLease lease) { return jobs.leaseValid(lease); }
            @Override public void release(JobLease lease) { jobs.release(lease); }
            @Override public List<ProcessingJob> recoverable(int limit) { return jobs.recoverable(limit); }
            @Override public List<ProcessingJob> recoverableAfter(int limit, RecoveryCursor cursor) {
                return jobs.recoverableAfter(limit, cursor);
            }
            @Override public ProcessingJob reconcileExpired(
                    ProcessingJob expected, ProcessingJob updated,
                    com.ghatana.media.runtime.MediaLifecycleEvent event) {
                return jobs.update(expected, updated);
            }
            @Override public boolean durable() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public boolean ready() { return true; }
        };
    }

    private static MediaProcessingProvider speechProvider(
            AtomicInteger dispatches,
            java.util.function.Function<ProviderAttemptQuery, CompletableFuture<ProviderAttemptObservation>> lookup) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "speech-provider"; }
            @Override public String providerVersion() { return "speech-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 1; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                dispatches.incrementAndGet();
                return CompletableFuture.completedFuture(Map.of("transcript", "must not run"));
            }
            @Override public CompletableFuture<com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission>
                    processAttempt(ProcessingContext context,
                            com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext attempt) {
                dispatches.incrementAndGet();
                return CompletableFuture.completedFuture(
                        com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission.unknown());
            }
            @Override public CompletableFuture<com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation>
                    reconcileAttempt(ProviderAttemptQuery query) {
                return lookup.apply(query);
            }
        };
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
