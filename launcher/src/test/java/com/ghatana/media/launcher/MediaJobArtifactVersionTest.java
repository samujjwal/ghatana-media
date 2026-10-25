package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadBeginResult;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadCompletionResult;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

class MediaJobArtifactVersionTest {
    @Test
    void capturesArtifactVersionAndFailsBeforeProviderDispatchWhenPinnedReadIsStale() throws Exception {
        var root = Files.createTempDirectory("media-job-artifact-version-");
        var backingStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        var artifacts = new StaleVersionStore(backingStore);
        var providerCalls = new AtomicInteger();
        MediaProcessingProvider provider = new MediaProcessingProvider() {
            @Override public String providerId() { return "counting-provider"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                providerCalls.incrementAndGet();
                return CompletableFuture.completedFuture(Map.of("ok", true));
            }
            @Override public CancellationOutcome cancel(
                    String tenantId, String principalId, String correlationId, String jobId) {
                return CancellationOutcome.UNSUPPORTED;
            }
        };
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                artifacts,
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(provider),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        try {
            byte[] bytes = "version-pinned-media".getBytes(StandardCharsets.UTF_8);
            var upload = runtime.beginUpload(new UploadRequest(
                    "tenant-a", "principal-a", "clip.bin", "application/octet-stream", bytes.length,
                    sha256(bytes), "CONFIDENTIAL", Duration.ofMinutes(10), Map.of()), "artifact-version-upload");
            runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, bytes);
            MediaArtifact artifact = runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());

            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-versioned", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), artifact.version().value(), JobType.VISION, "", Map.of()));

            var deadline = System.nanoTime() + Duration.ofSeconds(3).toNanos();
            var persisted = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();
            while (persisted.status() == JobStatus.ACCEPTED || persisted.status() == JobStatus.RUNNING) {
                assertThat(System.nanoTime()).isLessThan(deadline);
                Thread.sleep(10);
                persisted = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();
            }

            assertThat(accepted.expectedArtifactVersion()).isEqualTo(artifact.version().value());
            assertThat(persisted.expectedArtifactVersion()).isEqualTo(artifact.version().value());
            assertThat(persisted.status()).isEqualTo(JobStatus.FAILED);
            assertThat(persisted.failureCode()).isEqualTo("ARTIFACT_VERSION_STALE");
            assertThat(providerCalls).hasValue(0);
        } finally {
            runtime.close();
        }
    }

    private static String sha256(byte[] bytes) throws Exception {
        return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static final class StaleVersionStore implements MediaArtifactStore {
        private final LocalMediaRuntimeSupport.FileArtifactStore delegate;
        private final AtomicInteger versionedReads = new AtomicInteger();

        private StaleVersionStore(LocalMediaRuntimeSupport.FileArtifactStore delegate) {
            this.delegate = delegate;
        }

        @Override public String storeId() { return delegate.storeId(); }
        @Override public UploadSession begin(UploadRequest request, String idempotencyKey) {
            return delegate.begin(request, idempotencyKey);
        }
        @Override public UploadBeginResult beginWithDisposition(UploadRequest request, String idempotencyKey) {
            return delegate.beginWithDisposition(request, idempotencyKey);
        }
        @Override public UploadSession append(String tenantId, String principalId, String uploadId, int chunkIndex, byte[] bytes) {
            return delegate.append(tenantId, principalId, uploadId, chunkIndex, bytes);
        }
        @Override public MediaArtifact complete(String tenantId, String principalId, String uploadId) {
            return delegate.complete(tenantId, principalId, uploadId);
        }
        @Override public UploadCompletionResult completeWithDisposition(
                String tenantId, String principalId, String uploadId) {
            return delegate.completeWithDisposition(tenantId, principalId, uploadId);
        }
        @Override public Optional<UploadSession> upload(String tenantId, String uploadId) {
            return delegate.upload(tenantId, uploadId);
        }
        @Override public Optional<MediaArtifact> artifact(String tenantId, String artifactId) {
            return delegate.artifact(tenantId, artifactId);
        }
        @Override public Optional<MediaArtifact> artifact(
                String tenantId, String artifactId, com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion version) {
            if (versionedReads.incrementAndGet() == 1) {
                return delegate.artifact(tenantId, artifactId, version);
            }
            return Optional.empty();
        }
        @Override public boolean durable() { return delegate.durable(); }
        @Override public boolean productionEligible() { return delegate.productionEligible(); }
        @Override public boolean ready() { return delegate.ready(); }
        @Override public void close() { delegate.close(); }
    }
}
