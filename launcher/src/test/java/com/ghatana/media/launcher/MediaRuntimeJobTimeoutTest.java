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

/** Verifies timed-out local jobs cancel provider work and cannot complete after terminal persistence. */
class MediaRuntimeJobTimeoutTest {

    @Test
    void timeoutCancelsProviderWorkAndPersistsOneTerminalFailure() throws Exception {
        var root = Files.createTempDirectory("media-job-timeout-");
        var provider = new BlockingProcessingProvider();
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
                List.of(provider),
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
                    "confidential",
                    Duration.ofHours(1),
                    Map.of()));
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

            assertThat(terminal.status()).isEqualTo(JobStatus.FAILED);
            assertThat(terminal.failureCode()).isEqualTo("PROCESSING_TIMEOUT");
            assertThat(provider.cancellation()).isNotNull();
            assertThat(provider.cancellation().cancelled()).isTrue();
            assertThat(provider.future().isCancelled()).isTrue();
            assertThat(provider.future().complete(Map.of("late", true))).isFalse();

            long terminalVersion = terminal.version();
            Thread.sleep(20);
            var persisted = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();
            assertThat(persisted.status()).isEqualTo(JobStatus.FAILED);
            assertThat(persisted.failureCode()).isEqualTo("PROCESSING_TIMEOUT");
            assertThat(persisted.version()).isEqualTo(terminalVersion);
            assertThat(persisted.result()).doesNotContainKey("late");
        } finally {
            runtime.close();
        }
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static final class BlockingProcessingProvider implements MediaProcessingProvider {
        private final CompletableFuture<Map<String, Object>> future = new CompletableFuture<>();
        private final AtomicReference<Cancellation> cancellation = new AtomicReference<>();

        @Override public String providerId() { return "blocking-processing-provider"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }

        @Override
        public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            cancellation.set(context.cancellation());
            return future;
        }

        Cancellation cancellation() { return cancellation.get(); }
        CompletableFuture<Map<String, Object>> future() { return future; }
    }
}
