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

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

class MediaRuntimeJobGovernanceTest {

    @Test
    void retryableProviderFailureUsesBoundedDeterministicFallbackWithActualProvenance() throws Exception {
        AtomicInteger primaryCalls = new AtomicInteger();
        AtomicInteger fallbackCalls = new AtomicInteger();
        MediaProcessingProvider primary = provider("primary", 0, primaryCalls,
                CompletableFuture.failedFuture(new CompletionException(new IOException("temporary outage"))),
                CancellationOutcome.UNSUPPORTED, true);
        MediaProcessingProvider fallback = provider("fallback", 1, fallbackCalls,
                CompletableFuture.completedFuture(Map.of("labels", List.of("safe"))),
                CancellationOutcome.UNSUPPORTED);
        var root = Files.createTempDirectory("media-fallback-");
        var runtime = runtime(root, List.of(primary, fallback));
        try {
            var artifact = artifact(runtime);
            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-fallback", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "", Map.of()));
            var terminal = awaitTerminal(runtime, accepted.jobId());
            assertThat(terminal.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(terminal.providerId()).isEqualTo("fallback");
            assertThat(terminal.result())
                    .containsEntry("providerId", "fallback")
                    .containsEntry("providerVersion", "fallback-v1")
                    .containsEntry("modelVersion", "fallback-v1")
                    .containsEntry("modality", "VISION")
                    .containsEntry("sourceArtifactRef", "urn:ghatana:media-artifact:" + artifact.artifactId())
                    .containsKey("provenanceRefs");
            assertThat(primaryCalls).hasValue(1);
            assertThat(fallbackCalls).hasValue(1);
        } finally {
            runtime.close();
        }
    }

    @Test
    void providerFailureWithoutSafeFallbackIsPersistedAsTerminalFailure() throws Exception {
        MediaProcessingProvider provider = provider(
                "failing", 0, new AtomicInteger(),
                CompletableFuture.failedFuture(new IllegalStateException("provider failure")),
                CancellationOutcome.UNSUPPORTED);
        var root = Files.createTempDirectory("media-provider-failure-");
        var runtime = runtime(root, List.of(provider));
        try {
            var artifact = artifact(runtime);
            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-provider-failure", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "failing", Map.of()));

            var terminal = awaitTerminal(runtime, accepted.jobId());

            assertThat(terminal.status()).isEqualTo(JobStatus.FAILED);
            assertThat(terminal.failureCode()).isEqualTo("PROCESSING_FAILED");
            assertThat(terminal.result()).containsEntry("failureType", "IllegalStateException");
        } finally {
            runtime.close();
        }
    }

    @Test
    void unconfirmedCancellationRemainsNonTerminalAndProviderOutcomeStillWins() throws Exception {
        CompletableFuture<Map<String, Object>> pending = new CompletableFuture<>();
        MediaProcessingProvider provider = provider(
                "remote", 0, new AtomicInteger(), pending,
                CancellationOutcome.REQUESTED_UNCONFIRMED);
        var root = Files.createTempDirectory("media-cancel-unconfirmed-");
        var runtime = runtime(root, List.of(provider));
        try {
            var artifact = artifact(runtime);
            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-cancel-unconfirmed", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "remote", Map.of()));

            var cancellationRequested = runtime.cancel("tenant-a", accepted.jobId());

            assertThat(cancellationRequested.status()).isEqualTo(JobStatus.RUNNING);
            assertThat(cancellationRequested.failureCode()).isBlank();
            assertThat(cancellationRequested.completedAt()).isNull();
            assertThat(cancellationRequested.result())
                    .containsEntry("cancellationOutcome", "REQUESTED_UNCONFIRMED")
                    .containsKey("cancellationRequestedAt");
            assertThat(pending).isNotCancelled();

            pending.complete(Map.of("labels", List.of("provider-completed-after-cancel-request")));
            var terminal = awaitTerminal(runtime, accepted.jobId());
            assertThat(terminal.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(terminal.result())
                    .containsEntry("providerId", "remote")
                    .containsEntry("labels", List.of("provider-completed-after-cancel-request"));
        } finally {
            runtime.close();
        }
    }

    @Test
    void confirmedCancellationIsTerminalAndCarriesProviderConfirmation() throws Exception {
        CompletableFuture<Map<String, Object>> pending = new CompletableFuture<>();
        MediaProcessingProvider provider = provider(
                "remote", 0, new AtomicInteger(), pending,
                CancellationOutcome.CONFIRMED);
        var root = Files.createTempDirectory("media-cancel-confirmed-");
        var runtime = runtime(root, List.of(provider));
        try {
            var artifact = artifact(runtime);
            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-cancel-confirmed", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "remote", Map.of()));

            var cancelled = runtime.cancel("tenant-a", accepted.jobId());

            assertThat(cancelled.status()).isEqualTo(JobStatus.CANCELLED);
            assertThat(cancelled.failureCode()).isEqualTo("CANCELLED");
            assertThat(cancelled.result())
                    .containsEntry("cancellationOutcome", "CONFIRMED");
        } finally {
            runtime.close();
        }
    }

    private static MediaRuntime runtime(
            java.nio.file.Path root, List<MediaProcessingProvider> providers) {
        return new MediaRuntime(
                new MediaRuntimeConfig(
                        true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                providers,
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static MediaProcessingProvider provider(
            String id,
            int priority,
            AtomicInteger calls,
            CompletableFuture<Map<String, Object>> response,
            CancellationOutcome cancellation) {
        return provider(id, priority, calls, response, cancellation, false);
    }

    private static MediaProcessingProvider provider(
            String id,
            int priority,
            AtomicInteger calls,
            CompletableFuture<Map<String, Object>> response,
            CancellationOutcome cancellation,
            boolean fallbackEligible) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return id; }
            @Override public String providerVersion() { return id + "-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return priority; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                calls.incrementAndGet();
                return response;
            }
            @Override public CancellationOutcome cancel(
                    String tenantId, String principalId, String correlationId, String jobId) {
                return cancellation;
            }
            @Override public boolean fallbackEligible(Throwable failure) {
                return fallbackEligible && failure instanceof IOException;
            }
        };
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact artifact(
            MediaRuntime runtime) throws Exception {
        byte[] bytes = "media".getBytes(StandardCharsets.UTF_8);
        var upload = runtime.beginUpload(new UploadRequest(
                "tenant-a", "principal-a", "clip.bin", "application/octet-stream", bytes.length,
                HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),
                "confidential", Duration.ofMinutes(10), Map.of()));
        runtime.appendChunk("tenant-a", upload.uploadId(), 0, bytes);
        return runtime.completeUpload("tenant-a", upload.uploadId());
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob awaitTerminal(
            MediaRuntime runtime, String jobId) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        var value = runtime.job("tenant-a", jobId).orElseThrow();
        while (!Set.of(JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED).contains(value.status())
                && System.nanoTime() < deadline) {
            Thread.sleep(10);
            value = runtime.job("tenant-a", jobId).orElseThrow();
        }
        return value;
    }
}
