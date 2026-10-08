package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaJobRequestFingerprint;
import com.ghatana.media.runtime.MediaJobRequestFingerprint.ProviderDescriptor;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CompletionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

class MediaRuntimeJobGovernanceTest {

    @Test
    void submissionDigestAndProviderObserveTheSameDeepParameterSnapshot() throws Exception {
        var root = Files.createTempDirectory("media-runtime-request-snapshot-");
        AtomicReference<Map<String, Object>> observed = new AtomicReference<>();
        CountDownLatch dispatched = new CountDownLatch(1);
        MediaProcessingProvider snapshotProvider = new MediaProcessingProvider() {
            @Override public String providerId() { return "snapshot-provider"; }
            @Override public String providerVersion() { return "snapshot-v1"; }
            @Override public String modelVersion(JobType modality) { return "snapshot-model-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 1; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                observed.set(context.request().parameters());
                dispatched.countDown();
                return CompletableFuture.completedFuture(Map.of("accepted", true));
            }
        };
        MediaRuntime runtime = runtime(root, List.of(snapshotProvider));
        try {
            var artifact = artifact(runtime);
            Map<String, Object> nested = new LinkedHashMap<>();
            nested.put("value", "before");
            List<Object> values = new ArrayList<>();
            values.add(nested);
            int[] array = {3, 4};
            Map<String, Object> parameters = new LinkedHashMap<>();
            parameters.put("values", values);
            parameters.put("array", array);
            ProcessingJobRequest request = new ProcessingJobRequest(
                    "request-snapshot", "tenant-a", "principal-a", "correlation-snapshot",
                    artifact.artifactId(), JobType.VISION, "snapshot-provider", parameters);
            String expectedFingerprint = MediaJobRequestFingerprint.compute(request,
                    List.of(new ProviderDescriptor("snapshot-provider", "snapshot-v1", "snapshot-model-v1")));

            nested.put("value", "mutated-before-submit");
            values.add(Map.of("value", "late-before-submit"));
            array[0] = 99;
            var accepted = runtime.submit(request);
            nested.put("value", "mutated-after-submit");
            array[1] = 99;

            assertThat(dispatched.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(accepted.requestFingerprint()).isEqualTo(expectedFingerprint);
            Map<String, Object> providerPayload = observed.get();
            assertThat(((Map<?, ?>) ((List<?>) providerPayload.get("values")).get(0)).get("value"))
                    .isEqualTo("before");
            assertThat((int[]) providerPayload.get("array")).containsExactly(3, 4);
            var observedRequest = new ProcessingJobRequest(
                    request.requestId(), request.tenantId(), request.principalId(), request.correlationId(),
                    request.artifactId(), request.jobType(), request.providerHint(), providerPayload,
                    request.governanceContext());
            assertThat(MediaJobRequestFingerprint.compute(observedRequest,
                    List.of(new ProviderDescriptor("snapshot-provider", "snapshot-v1", "snapshot-model-v1"))))
                    .isEqualTo(accepted.requestFingerprint());
        } finally {
            runtime.close();
        }
    }

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

            var cancellationRequested = runtime.cancel("tenant-a", "principal-a", accepted.jobId());

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

            var cancelled = runtime.cancel("tenant-a", "principal-a", accepted.jobId());

            assertThat(cancelled.status()).isEqualTo(JobStatus.CANCELLED);
            assertThat(cancelled.failureCode()).isEqualTo("CANCELLED");
            assertThat(cancelled.result())
                    .containsEntry("cancellationOutcome", "CONFIRMED");
        } finally {
            runtime.close();
        }
    }

    @Test
    void lateCancellationConfirmationCannotOverwriteCompletedProviderOutcome() throws Exception {
        CompletableFuture<Map<String, Object>> pending = new CompletableFuture<>();
        CountDownLatch cancellationEntered = new CountDownLatch(1);
        CountDownLatch allowCancellationReturn = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        MediaProcessingProvider provider = new MediaProcessingProvider() {
            @Override public String providerId() { return "remote"; }
            @Override public String providerVersion() { return "remote-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                calls.incrementAndGet();
                return pending;
            }
            @Override public CancellationOutcome cancel(String tenantId, String principalId,
                                                         String correlationId, String jobId) {
                cancellationEntered.countDown();
                try {
                    if (!allowCancellationReturn.await(5, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("test cancellation release timed out");
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(interrupted);
                }
                return CancellationOutcome.CONFIRMED;
            }
        };
        var root = Files.createTempDirectory("media-cancel-completion-race-");
        var runtime = runtime(root, List.of(provider));
        var cancelExecutor = Executors.newSingleThreadExecutor();
        try {
            var artifact = artifact(runtime);
            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-cancel-race", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "remote", Map.of()));
            var cancellation = cancelExecutor.submit(() -> runtime.cancel("tenant-a", "principal-a", accepted.jobId()));
            assertThat(cancellationEntered.await(5, TimeUnit.SECONDS)).isTrue();

            pending.complete(Map.of("labels", List.of("completed")));
            var completed = awaitTerminal(runtime, accepted.jobId());
            assertThat(completed.status()).isEqualTo(JobStatus.COMPLETED);
            allowCancellationReturn.countDown();

            assertThat(cancellation.get(5, TimeUnit.SECONDS).status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow().status())
                    .isEqualTo(JobStatus.COMPLETED);
            assertThat(calls).hasValue(1);
        } finally {
            allowCancellationReturn.countDown();
            cancelExecutor.shutdownNow();
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
        runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, bytes);
        return runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob awaitTerminal(
            MediaRuntime runtime, String jobId) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        var value = runtime.job("tenant-a", "principal-a", jobId).orElseThrow();
        while (!Set.of(JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED).contains(value.status())
                && System.nanoTime() < deadline) {
            Thread.sleep(10);
            value = runtime.job("tenant-a", "principal-a", jobId).orElseThrow();
        }
        return value;
    }
}
