package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptStart;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobLease;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaJobStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingAttempt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/** Verifies timed-out local jobs cancel provider work and cannot complete after terminal persistence. */
class MediaRuntimeJobTimeoutTest {

    @Test
    void preflightDeadlineExpiryProvesNoProviderEffectAndFinalizesAttempt() throws Exception {
        var root = Files.createTempDirectory("media-job-preflight-deadline-");
        var artifactReads = new AtomicInteger();
        var artifacts = expireBudgetDuringVersionedRead(
                new LocalMediaRuntimeSupport.FileArtifactStore(root), artifactReads);
        var delegateJobs = new LocalMediaRuntimeSupport.JobStore();
        var noEffectFinalizations = new AtomicInteger();
        var finalizedAttempt = new AtomicReference<ProcessingAttempt>();
        MediaJobStore jobs = durableFinalityTrackingStore(
                delegateJobs, noEffectFinalizations, finalizedAttempt);
        var provider = new BlockingProcessingProvider();
        var fallback = new CountingFallbackProvider();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(
                        true,
                        "local",
                        8093,
                        1_024,
                        64,
                        1_024,
                        Duration.ofMillis(50),
                        1,
                        "",
                        "",
                        true,
                        false,
                        root),
                artifacts,
                jobs,
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(provider, fallback),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        try {
            byte[] content = "media-preflight-deadline".getBytes(StandardCharsets.UTF_8);
            var upload = runtime.beginUpload(new UploadRequest(
                    "tenant-a", "principal-a", "clip.bin", "application/octet-stream", content.length,
                    sha256(content), "CONFIDENTIAL", Duration.ofHours(1), Map.of()),
                    "job-preflight-deadline-upload");
            runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, content);
            var artifact = runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());

            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-preflight-deadline", "tenant-a", "principal-a", "correlation-preflight-deadline",
                    artifact.artifactId(), JobType.VISION, provider.providerId(), Map.of()));
            var terminal = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();

            assertThat(artifactReads).hasValue(1);
            assertThat(terminal.status()).isEqualTo(JobStatus.FAILED);
            assertThat(terminal.failureCode()).isEqualTo("PROCESSING_DEADLINE_EXCEEDED_BEFORE_PROVIDER");
            assertThat(terminal.result())
                    .containsEntry("providerOutcome", "NO_EFFECT_PROVEN")
                    .containsEntry("deadlineOutcome", "EXPIRED_BEFORE_PROVIDER_HANDOFF");
            assertThat(provider.processCalls()).hasValue(0);
            assertThat(fallback.calls()).hasValue(0);
            assertThat(noEffectFinalizations).hasValue(1);
            assertThat(finalizedAttempt.get()).isNotNull()
                    .extracting(ProcessingAttempt::finality)
                    .isEqualTo(AttemptFinality.NO_EFFECT_PROVEN);
        } finally {
            runtime.close();
        }
    }

    @Test
    void timeoutPreservesUnknownProviderOutcomeAndDoesNotFallback() throws Exception {
        var root = Files.createTempDirectory("media-job-timeout-");
        var provider = new BlockingProcessingProvider();
        var fallback = new CountingFallbackProvider();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(
                        true,
                        "local",
                        8093,
                        1_024,
                        64,
                        1_024,
                        Duration.ofMillis(50),
                        1,
                        "",
                        "",
                        true,
                        false,
                        root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(provider, fallback),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));

        try {
            byte[] content = "media-job".getBytes(StandardCharsets.UTF_8);
            var upload = runtime.beginUpload(new UploadRequest(
                    "tenant-a",
                    "principal-a",
                    "clip.bin",
                    "application/octet-stream",
                    content.length,
                    sha256(content),
                    "CONFIDENTIAL",
                    Duration.ofHours(1),
                    Map.of()), "job-timeout-upload");
            runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, content);
            var artifact = runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());

            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-a",
                    "tenant-a",
                    "principal-a",
                    "correlation-a",
                    artifact.artifactId(),
                    JobType.VISION,
                    provider.providerId(),
                    Map.of()));

            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            var terminal = accepted;
            while (terminal.status() == JobStatus.ACCEPTED || terminal.status() == JobStatus.RUNNING) {
                assertThat(System.nanoTime()).isLessThan(deadline);
                Thread.sleep(10);
                terminal = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();
            }

            assertThat(terminal.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(terminal.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
            assertThat(terminal.result()).containsEntry("providerOutcome", "UNKNOWN");
            assertThat(fallback.calls()).hasValue(0);
            assertThat(provider.cancellation()).isNotNull();
            assertThat(provider.cancellation().cancelled()).isTrue();
            assertThat(provider.future().isCancelled()).isTrue();
            assertThat(provider.future().complete(Map.of("late", true))).isFalse();

            long terminalVersion = terminal.version();
            Thread.sleep(20);
            var persisted = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();
            assertThat(persisted.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(persisted.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
            assertThat(persisted.version()).isEqualTo(terminalVersion);
            assertThat(persisted.result()).doesNotContainKey("late");
        } finally {
            runtime.close();
        }
    }

    @Test
    void synchronousProviderReturnAfterDeadlineCannotCompleteJobSuccessfully() throws Exception {
        var root = Files.createTempDirectory("media-job-late-synchronous-provider-");
        var provider = new BudgetExpirySuccessProvider();
        var fallback = new CountingFallbackProvider();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(
                        true,
                        "local",
                        8093,
                        1_024,
                        64,
                        1_024,
                        Duration.ofSeconds(1),
                        1,
                        "",
                        "",
                        true,
                        false,
                        root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(provider, fallback),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));

        try {
            byte[] content = "media-job-late-synchronous-provider".getBytes(StandardCharsets.UTF_8);
            var upload = runtime.beginUpload(new UploadRequest(
                    "tenant-a", "principal-a", "clip.bin", "application/octet-stream", content.length,
                    sha256(content), "CONFIDENTIAL", Duration.ofHours(1), Map.of()),
                    "job-late-sync-provider-upload");
            runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, content);
            var artifact = runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());

            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-late-sync-provider", "tenant-a", "principal-a", "correlation-late-sync-provider",
                    artifact.artifactId(), JobType.VISION, provider.providerId(), Map.of()));

            assertThat(provider.entered().await(3, TimeUnit.SECONDS)).isTrue();
            long terminalDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            var terminal = accepted;
            while (terminal.status() == JobStatus.ACCEPTED || terminal.status() == JobStatus.RUNNING) {
                assertThat(System.nanoTime()).isLessThan(terminalDeadline);
                Thread.sleep(10);
                terminal = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();
            }

            assertThat(provider.processCalls()).hasValue(1);
            assertThat(fallback.calls()).hasValue(0);
            assertThat(terminal.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(terminal.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
            assertThat(terminal.result()).containsEntry("providerOutcome", "UNKNOWN").doesNotContainKey("late");
        } finally {
            runtime.close();
        }
    }

    @Test
    void finalizationThatCrossesDeadlineAfterProviderSuccessCannotCommitCompletedJob() throws Exception {
        var root = Files.createTempDirectory("media-job-finalization-deadline-");
        var provider = new ImmediateSuccessProvider();
        var fallback = new CountingFallbackProvider();
        var finalizationEntered = new CountDownLatch(1);
        var releaseFinalization = new CountDownLatch(1);
        var jobs = deadlineAwareFinalizationStore(
                new LocalMediaRuntimeSupport.JobStore(), finalizationEntered, releaseFinalization);
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(
                        true,
                        "local",
                        8093,
                        1_024,
                        64,
                        1_024,
                        Duration.ofSeconds(3),
                        1,
                        "",
                        "",
                        true,
                        false,
                        root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                jobs,
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(provider, fallback),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        CompletableFuture<ProcessingJob> submission = null;

        try {
            byte[] content = "media-job-finalization-deadline".getBytes(StandardCharsets.UTF_8);
            var upload = runtime.beginUpload(new UploadRequest(
                    "tenant-a", "principal-a", "clip.bin", "application/octet-stream", content.length,
                    sha256(content), "CONFIDENTIAL", Duration.ofHours(1), Map.of()),
                    "job-finalization-deadline-upload");
            runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, content);
            var artifact = runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());

            var request = new ProcessingJobRequest(
                    "request-finalization-deadline", "tenant-a", "principal-a", "correlation-finalization-deadline",
                    artifact.artifactId(), JobType.VISION, provider.providerId(), Map.of());
            // submit() invokes the provider synchronously, so keep it off this test thread while the
            // controlled finalization lookup is held.
            submission = CompletableFuture.supplyAsync(() -> runtime.submit(request));

            assertThat(finalizationEntered.await(3, TimeUnit.SECONDS)).isTrue();
            assertThat(provider.completedBeforeDeadline()).isTrue();
            var budget = provider.deadline().get();
            long expiryWaitDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (!budget.expired() && System.nanoTime() < expiryWaitDeadline) {
                TimeUnit.NANOSECONDS.sleep(Math.min(budget.remainingNanos(),
                        TimeUnit.MILLISECONDS.toNanos(10)));
            }
            assertThat(budget.expired()).isTrue();
            releaseFinalization.countDown();
            var accepted = submission.get(5, TimeUnit.SECONDS);

            long terminalWaitDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            var terminal = accepted;
            while (terminal.status() == JobStatus.ACCEPTED || terminal.status() == JobStatus.RUNNING) {
                assertThat(System.nanoTime()).isLessThan(terminalWaitDeadline);
                Thread.sleep(10);
                terminal = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();
            }

            assertThat(provider.processCalls()).hasValue(1);
            assertThat(fallback.calls()).hasValue(0);
            assertThat(terminal.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(terminal.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
            assertThat(terminal.result()).isEmpty();
            assertThat(jobs.findProcessingAttempt("tenant-a", accepted.jobId(), 1))
                    .get().extracting(ProcessingAttempt::finality).isEqualTo(AttemptFinality.SUCCEEDED);
        } finally {
            releaseFinalization.countDown();
            if (submission != null) {
                try { submission.get(5, TimeUnit.SECONDS); } catch (Exception ignored) { }
            }
            runtime.close();
        }
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static MediaArtifactStore expireBudgetDuringVersionedRead(
            MediaArtifactStore delegate, AtomicInteger versionedReads) {
        return (MediaArtifactStore) Proxy.newProxyInstance(
                MediaArtifactStore.class.getClassLoader(), new Class<?>[] {MediaArtifactStore.class},
                (proxy, method, args) -> {
                    if ("artifact".equals(method.getName()) && args != null && args.length == 3
                            && versionedReads.getAndIncrement() == 0) {
                        Thread.sleep(200);
                    }
                    try {
                        return method.invoke(delegate, args);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    private static MediaJobStore durableFinalityTrackingStore(
            LocalMediaRuntimeSupport.JobStore delegate,
            AtomicInteger noEffectFinalizations,
            AtomicReference<ProcessingAttempt> finalizedAttempt) {
        // Exercise the runtime's durable-store branch without treating this in-memory double
        // as database evidence; the PostgreSQL adapter has separate atomic-finality tests.
        return (MediaJobStore) Proxy.newProxyInstance(
                MediaJobStore.class.getClassLoader(), new Class<?>[] {MediaJobStore.class},
                (proxy, method, args) -> {
                    if ("durable".equals(method.getName())) return true;
                    if ("startAttempt".equals(method.getName()) && args != null && args.length == 5) {
                        ProcessingJob accepted = (ProcessingJob) args[0];
                        ProcessingJob runningCandidate = (ProcessingJob) args[1];
                        JobLease lease = (JobLease) args[2];
                        int attemptNumber = (int) args[3];
                        String fingerprint = (String) args[4];
                        ProcessingJob running = delegate.update(accepted, runningCandidate);
                        ProcessingAttempt attempt = new ProcessingAttempt(
                                accepted.tenantId(), accepted.jobId(), accepted.requestId(), attemptNumber,
                                lease.fencingToken(), fingerprint, running.providerId(), "", "",
                                AttemptFinality.UNKNOWN, "", "", java.time.Instant.now());
                        return new AttemptStart(running, attempt);
                    }
                    if ("markPreDispatchNoEffect".equals(method.getName()) && args != null && args.length == 4) {
                        ProcessingJob expected = (ProcessingJob) args[0];
                        ProcessingAttempt attempt = (ProcessingAttempt) args[1];
                        ProcessingJob failed = (ProcessingJob) args[2];
                        noEffectFinalizations.incrementAndGet();
                        finalizedAttempt.set(new ProcessingAttempt(
                                attempt.tenantId(), attempt.jobId(), attempt.requestId(), attempt.attemptNumber(),
                                attempt.fencingToken(), attempt.requestFingerprint(), attempt.providerId(), "", "",
                                AttemptFinality.NO_EFFECT_PROVEN, "", "", java.time.Instant.now()));
                        return delegate.update(expected, failed);
                    }
                    try {
                        return method.invoke(delegate, args);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    private static MediaJobStore deadlineAwareFinalizationStore(
            LocalMediaRuntimeSupport.JobStore delegate,
            CountDownLatch finalizationEntered,
            CountDownLatch releaseFinalization) {
        AtomicReference<ProcessingAttempt> attempt = new AtomicReference<>();
        return (MediaJobStore) Proxy.newProxyInstance(
                MediaJobStore.class.getClassLoader(), new Class<?>[] {MediaJobStore.class},
                (proxy, method, args) -> {
                    try {
                        switch (method.getName()) {
                            case "durable" -> { return true; }
                            case "startAttempt" -> {
                                ProcessingJob accepted = (ProcessingJob) args[0];
                                ProcessingJob running = (ProcessingJob) args[1];
                                JobLease lease = (JobLease) args[2];
                                delegate.update(lease, accepted, running);
                                ProcessingAttempt started = new ProcessingAttempt(
                                        accepted.tenantId(), accepted.jobId(), accepted.requestId(),
                                        (Integer) args[3], lease.fencingToken(), (String) args[4],
                                        running.providerId(), "", "", AttemptFinality.UNKNOWN,
                                        "", "", java.time.Instant.now());
                                attempt.set(started);
                                return new AttemptStart(running, started);
                            }
                            case "recordProviderReceipt" -> {
                                ProcessingAttempt current = (ProcessingAttempt) args[0];
                                ProcessingAttempt updated = new ProcessingAttempt(
                                        current.tenantId(), current.jobId(), current.requestId(),
                                        current.attemptNumber(), current.fencingToken(), current.requestFingerprint(),
                                        current.providerId(), (String) args[2], (String) args[3],
                                        AttemptFinality.UNKNOWN, "", "", java.time.Instant.now());
                                attempt.set(updated);
                                return updated;
                            }
                            case "findProcessingAttempt" -> { return java.util.Optional.ofNullable(attempt.get()); }
                            case "commitFinalOutcome" -> {
                                if (args.length == 6
                                        && args[5] instanceof ProcessingContext.MonotonicDeadline jobBudget) {
                                    finalizationEntered.countDown();
                                    if (!releaseFinalization.await(5, TimeUnit.SECONDS)) {
                                        throw new IllegalStateException("Timed out waiting to release finalization commit");
                                    }
                                    while (!jobBudget.expired()) {
                                        TimeUnit.MILLISECONDS.sleep(1);
                                    }
                                }
                                return method.invoke(delegate, args);
                            }
                            case "recordProviderSuccessWithUnknownJob" -> {
                                ProcessingJob expected = (ProcessingJob) args[0];
                                ProcessingAttempt current = (ProcessingAttempt) args[1];
                                ProcessingJob unknown = (ProcessingJob) args[2];
                                var observation = (com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation)
                                        args[3];
                                assertThat(observation.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
                                assertThat(((com.ghatana.media.runtime.MediaLifecycleEvent) args[4]).attributes())
                                        .isEmpty();
                                attempt.set(new ProcessingAttempt(
                                        current.tenantId(), current.jobId(), current.requestId(),
                                        current.attemptNumber(), current.fencingToken(), current.requestFingerprint(),
                                        current.providerId(), current.providerOperationId(), current.providerReceiptId(),
                                        AttemptFinality.SUCCEEDED, "", observation.provenanceDigest(),
                                        observation.observedAt()));
                                return delegate.update(expected, unknown);
                            }
                            default -> { return method.invoke(delegate, args); }
                        }
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    private static final class BlockingProcessingProvider implements MediaProcessingProvider {
        private final CompletableFuture<Map<String, Object>> future = new CompletableFuture<>();
        private final AtomicReference<Cancellation> cancellation = new AtomicReference<>();
        private final AtomicInteger processCalls = new AtomicInteger();

        @Override public String providerId() { return "blocking-processing-provider"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }

        @Override
        public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            processCalls.incrementAndGet();
            cancellation.set(context.cancellation());
            return future;
        }

        Cancellation cancellation() { return cancellation.get(); }
        CompletableFuture<Map<String, Object>> future() { return future; }
        AtomicInteger processCalls() { return processCalls; }
    }

    private static final class BudgetExpirySuccessProvider implements MediaProcessingProvider {
        private final AtomicInteger processCalls = new AtomicInteger();
        private final CountDownLatch entered = new CountDownLatch(1);

        @Override public String providerId() { return "budget-expiry-success-provider"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }

        @Override
        public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            processCalls.incrementAndGet();
            entered.countDown();
            try {
                while (!context.deadlineBudget().expired()) {
                    TimeUnit.NANOSECONDS.sleep(Math.min(context.deadlineBudget().remainingNanos(),
                            TimeUnit.MILLISECONDS.toNanos(10)));
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("provider was interrupted before its late result", interrupted);
            }
            return CompletableFuture.completedFuture(Map.of("late", true));
        }

        CountDownLatch entered() { return entered; }
        AtomicInteger processCalls() { return processCalls; }
    }

    private static final class ImmediateSuccessProvider implements MediaProcessingProvider {
        private final AtomicInteger processCalls = new AtomicInteger();
        private final CountDownLatch returned = new CountDownLatch(1);
        private final AtomicReference<ProcessingContext.MonotonicDeadline> deadline = new AtomicReference<>();
        private final AtomicBoolean completedBeforeDeadline = new AtomicBoolean();

        @Override public String providerId() { return "immediate-success-provider"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }

        @Override
        public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            processCalls.incrementAndGet();
            var capturedDeadline = context.deadlineBudget();
            deadline.set(capturedDeadline);
            completedBeforeDeadline.set(!capturedDeadline.expired());
            returned.countDown();
            return CompletableFuture.completedFuture(Map.of("caption", "on-time-provider-success"));
        }

        @Override
        public java.util.Optional<com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptIdentity>
                prepareAttemptIdentity(ProcessingJobRequest request, MediaArtifact artifact,
                        com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext attempt) {
            return java.util.Optional.of(new com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptIdentity(
                    "operation-finalization", "receipt-finalization"));
        }

        @Override
        public CompletableFuture<com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission> processAttempt(
                ProcessingContext context, com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext attempt) {
            processCalls.incrementAndGet();
            var capturedDeadline = context.deadlineBudget();
            deadline.set(capturedDeadline);
            completedBeforeDeadline.set(!capturedDeadline.expired());
            returned.countDown();
            return CompletableFuture.completedFuture(new com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission(
                    AttemptFinality.SUCCEEDED, attempt.providerOperationId(), attempt.providerReceiptId(),
                    Map.of("caption", "on-time-provider-success"), "a".repeat(64), java.time.Instant.now()));
        }

        CountDownLatch returned() { return returned; }
        AtomicReference<ProcessingContext.MonotonicDeadline> deadline() { return deadline; }
        boolean completedBeforeDeadline() { return completedBeforeDeadline.get(); }
        AtomicInteger processCalls() { return processCalls; }
    }

    private static final class CountingFallbackProvider implements MediaProcessingProvider {
        private final AtomicInteger calls = new AtomicInteger();

        @Override public String providerId() { return "fallback-processing-provider"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 2; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(Map.of("duplicate", true));
        }

        AtomicInteger calls() { return calls; }
    }
}
