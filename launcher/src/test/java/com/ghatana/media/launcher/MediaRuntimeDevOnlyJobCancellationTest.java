package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome;
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
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaRuntimeDevOnlyJobCancellationTest {
    @Test
    void sameCancellationIdentityReplaysDurableOutcomeWithoutSecondProviderDispatch() throws Exception {
        var root = Files.createTempDirectory("media-dev-cancel-replay-");
        var providerCancels = new AtomicInteger();
        var cooperativeSignals = new AtomicInteger();
        var provider = provider(providerCancels, CancellationOutcome.UNSUPPORTED, false, cooperativeSignals);
        var runtime = runtime(root, provider);
        try {
            var artifact = artifact(runtime);
            var job = runtime.submit(new ProcessingJobRequest(
                    "cancel-replay-submit", "tenant-dev", "principal-dev", "cancel-replay-correlation",
                    artifact.artifactId(), JobType.VISION, "cancel-test-local", Map.of()));
            awaitRunning(runtime, job.jobId());

            assertThatThrownBy(() -> runtime.cancelLocalDevelopmentJob(
                    "tenant-dev", "principal-dev", job.jobId(), "cancel-wrong-version", Long.MAX_VALUE))
                    .isInstanceOf(MediaRuntime.DevJobCancellationVersionConflictException.class);
            assertThat(providerCancels).hasValue(0);

            var first = runtime.cancelLocalDevelopmentJob(
                    "tenant-dev", "principal-dev", job.jobId(), "cancel-request-1", null);
            var replay = runtime.cancelLocalDevelopmentJob(
                    "tenant-dev", "principal-dev", job.jobId(), "cancel-request-1", null);

            assertThat(first.scope()).isEqualTo("DEV_ONLY");
            assertThat(first.outcome()).isEqualTo("REQUESTED_UNCONFIRMED");
            assertThat(first.replayed()).isFalse();
            assertThat(first.job().status()).isEqualTo(JobStatus.RUNNING);
            assertThat(cooperativeSignals).hasValue(1);
            assertThat(replay.outcome()).isEqualTo(first.outcome());
            assertThat(replay.replayed()).isTrue();
            assertThat(replay.job().status()).isEqualTo(JobStatus.RUNNING);
            assertThat(providerCancels).hasValue(1);
            assertThat(cooperativeSignals).hasValue(1);
            assertThat(replay.job().result()).containsKey("devOnlyCancellation");
            assertThatThrownBy(() -> runtime.cancelLocalDevelopmentJob(
                    "tenant-dev", "principal-dev", job.jobId(), "cancel-request-2", null))
                    .isInstanceOf(MediaRuntime.DevJobCancellationConflictException.class);
            assertThat(providerCancels).hasValue(1);
        } finally {
            runtime.close();
        }
    }

    @Test
    void providerExceptionRemainsUnknownAndSameKeyReplayDoesNotRedispatch() throws Exception {
        var root = Files.createTempDirectory("media-dev-cancel-unknown-");
        var providerCancels = new AtomicInteger();
        var cooperativeSignals = new AtomicInteger();
        var provider = provider(providerCancels, CancellationOutcome.UNSUPPORTED, true, cooperativeSignals);
        var runtime = runtime(root, provider);
        try {
            var artifact = artifact(runtime);
            var job = runtime.submit(new ProcessingJobRequest(
                    "cancel-unknown-submit", "tenant-dev", "principal-dev", "cancel-unknown-correlation",
                    artifact.artifactId(), JobType.VISION, "cancel-test-local", Map.of()));
            awaitRunning(runtime, job.jobId());

            var first = runtime.cancelLocalDevelopmentJob(
                    "tenant-dev", "principal-dev", job.jobId(), "cancel-request-unknown", null);
            var replay = runtime.cancelLocalDevelopmentJob(
                    "tenant-dev", "principal-dev", job.jobId(), "cancel-request-unknown", null);

            assertThat(first.outcome()).isEqualTo("OUTCOME_UNKNOWN");
            assertThat(replay.outcome()).isEqualTo("OUTCOME_UNKNOWN");
            assertThat(replay.replayed()).isTrue();
            assertThat(providerCancels).hasValue(1);
            assertThat(cooperativeSignals).hasValue(0);
        } finally {
            runtime.close();
        }
    }

    @Test
    void localDevelopmentCancellationRefusesNonDevRuntimeBeforeProviderCall() throws Exception {
        var root = Files.createTempDirectory("media-dev-cancel-profile-");
        var providerCancels = new AtomicInteger();
        var provider = provider(providerCancels, CancellationOutcome.UNSUPPORTED, false, new AtomicInteger());
        var runtime = runtime(root, "local", provider);
        try {
            var artifact = artifact(runtime);
            var job = runtime.submit(new ProcessingJobRequest(
                    "cancel-profile-submit", "tenant-dev", "principal-dev", "cancel-profile-correlation",
                    artifact.artifactId(), JobType.VISION, "cancel-test-local", Map.of()));
            assertThatThrownBy(() -> runtime.cancelLocalDevelopmentJob(
                    "tenant-dev", "principal-dev", job.jobId(), "cancel-request-profile", null))
                    .isInstanceOf(MediaRuntime.DevJobCancellationNotAdmittedException.class);
            assertThat(providerCancels).hasValue(0);
        } finally {
            runtime.close();
        }
    }

    private static MediaProcessingProvider provider(
            AtomicInteger cancellationCalls,
            CancellationOutcome cancellationOutcome,
            boolean throwOnCancel,
            AtomicInteger cooperativeSignals) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "cancel-test-local"; }
            @Override public String providerVersion() { return "cancel-test-local-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                context.cancellation().onCancel(cooperativeSignals::incrementAndGet);
                return new CompletableFuture<>();
            }
            @Override public CancellationOutcome cancel(
                    String tenantId, String principalId, String correlationId, String jobId) {
                cancellationCalls.incrementAndGet();
                if (throwOnCancel) throw new IllegalStateException("cancel reply was lost");
                return cancellationOutcome;
            }
        };
    }

    private static MediaRuntime runtime(java.nio.file.Path root, MediaProcessingProvider provider) {
        return runtime(root, "dev", provider);
    }

    private static MediaRuntime runtime(
            java.nio.file.Path root, String profile, MediaProcessingProvider provider) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, profile, 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(5), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(provider), List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact artifact(MediaRuntime runtime)
            throws Exception {
        byte[] bytes = "dev-cancellation-test".getBytes(StandardCharsets.UTF_8);
        var digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        var upload = runtime.beginUpload(new UploadRequest("tenant-dev", "principal-dev", "clip.bin",
                "application/octet-stream", bytes.length, digest, "CONFIDENTIAL", Duration.ofMinutes(1), Map.of()),
                "dev-cancel-upload");
        runtime.appendChunk("tenant-dev", "principal-dev", upload.uploadId(), 0, bytes);
        return runtime.completeUpload("tenant-dev", "principal-dev", upload.uploadId());
    }

    private static void awaitRunning(MediaRuntime runtime, String jobId) throws Exception {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            JobStatus status = runtime.job("tenant-dev", "principal-dev", jobId).orElseThrow().status();
            if (status == JobStatus.RUNNING) return;
            if (status != JobStatus.ACCEPTED) throw new AssertionError("job left active state before cancellation: " + status);
            Thread.sleep(5);
        }
        throw new AssertionError("job did not become RUNNING before cancellation");
    }
}
