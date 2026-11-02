package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptStart;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobLease;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactStore;
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
import java.util.concurrent.TimeUnit;
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
