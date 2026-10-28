package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactContentReadReceipt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaModalityContracts;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
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
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaArtifactContentReadTest {
    @Test
    void localStoreCopiesOnlyOwnedExactVersionWithinTheCallerByteCeiling() throws Exception {
        var root = Files.createTempDirectory("media-artifact-content-");
        var store = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        byte[] source = "verified-source-bytes".getBytes(StandardCharsets.UTF_8);
        var upload = store.begin(new UploadRequest("tenant-a", "principal-a", "clip.bin",
                "application/octet-stream", source.length, sha256(source), "CONFIDENTIAL",
                Duration.ofMinutes(5), Map.of()), "content-read-upload");
        store.append("tenant-a", "principal-a", upload.uploadId(), 0, source);
        var artifact = store.complete("tenant-a", "principal-a", upload.uploadId());

        ByteArrayOutputStream destination = new ByteArrayOutputStream();
        var receipt = store.copyContent("tenant-a", "principal-a", artifact.artifactId(),
                artifact.version(), destination, source.length).orElseThrow();
        assertThat(destination.toByteArray()).containsExactly(source);
        assertThat(receipt.version()).isEqualTo(artifact.version());
        assertThat(receipt.sha256()).isEqualTo(artifact.sha256());
        assertThat(receipt.bytesCopied()).isEqualTo(source.length);

        ByteArrayOutputStream wrongOwner = new ByteArrayOutputStream();
        assertThat(store.copyContent("tenant-a", "principal-b", artifact.artifactId(),
                artifact.version(), wrongOwner, source.length)).isEmpty();
        assertThat(wrongOwner.size()).isZero();

        ByteArrayOutputStream staleVersion = new ByteArrayOutputStream();
        assertThat(store.copyContent("tenant-a", "principal-a", artifact.artifactId(),
                ArtifactVersion.fromSha256("0".repeat(64)), staleVersion, source.length)).isEmpty();
        assertThat(staleVersion.size()).isZero();

        ByteArrayOutputStream tooSmall = new ByteArrayOutputStream();
        assertThatThrownBy(() -> store.copyContent("tenant-a", "principal-a", artifact.artifactId(),
                artifact.version(), tooSmall, source.length - 1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("MEDIA_ARTIFACT_READ_LIMIT");
        assertThat(tooSmall.size()).isZero();
        store.close();
    }


    @Test
    void closeWaitsForRegisteredArtifactCopyAndReadRemovesItsStage() throws Exception {
        var root = Files.createTempDirectory("media-runtime-close-read-");
        var tempDirectory = Path.of(System.getProperty("java.io.tmpdir"));
        byte[] source = "close-race-source".getBytes(StandardCharsets.UTF_8);
        var delegate = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        var upload = delegate.begin(new UploadRequest("tenant-a", "principal-a", "source.bin",
                "application/octet-stream", source.length, sha256(source), "CONFIDENTIAL",
                Duration.ofMinutes(5), Map.of()), "close-race-upload");
        delegate.append("tenant-a", "principal-a", upload.uploadId(), 0, source);
        var artifact = delegate.complete("tenant-a", "principal-a", upload.uploadId());
        CountDownLatch copyEntered = new CountDownLatch(1);
        CountDownLatch releaseCopy = new CountDownLatch(1);
        CountDownLatch storeClosed = new CountDownLatch(1);
        AtomicBoolean runtimeClosed = new AtomicBoolean();
        MediaArtifactStore blockingStore = new MediaArtifactStore() {
            @Override public String storeId() { return delegate.storeId(); }
            @Override public UploadSession begin(UploadRequest request, String key) { return delegate.begin(request, key); }
            @Override public UploadSession append(String tenant, String principal, String id, int index, byte[] bytes) {
                return delegate.append(tenant, principal, id, index, bytes);
            }
            @Override public MediaArtifact complete(String tenant, String principal, String id) {
                return delegate.complete(tenant, principal, id);
            }
            @Override public java.util.Optional<UploadSession> upload(String tenant, String id) {
                return delegate.upload(tenant, id);
            }
            @Override public java.util.Optional<MediaArtifact> artifact(String tenant, String id) {
                return delegate.artifact(tenant, id);
            }
            @Override public java.util.Optional<ArtifactContentReadReceipt> copyContent(
                    String tenant, String principal, String id, ArtifactVersion version,
                    java.io.OutputStream target, long maxBytes) throws java.io.IOException {
                copyEntered.countDown();
                try {
                    if (!releaseCopy.await(3, TimeUnit.SECONDS)) throw new java.io.IOException("test copy timed out");
                } catch (InterruptedException interruption) {
                    Thread.currentThread().interrupt();
                    throw new java.io.IOException("test copy interrupted", interruption);
                }
                return delegate.copyContent(tenant, principal, id, version, target, maxBytes);
            }
            @Override public boolean durable() { return delegate.durable(); }
            @Override public boolean productionEligible() { return delegate.productionEligible(); }
            @Override public boolean ready() { return delegate.ready(); }
            @Override public void close() { delegate.close(); storeClosed.countDown(); }
        };
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                blockingStore, new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(), null, List.of(),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        var output = new ByteArrayOutputStream();
        var read = CompletableFuture.supplyAsync(() -> {
            try {
                return runtime.copyArtifactContent("tenant-a", "principal-a", artifact.artifactId(),
                        artifact.version(), output, source.length);
            } catch (Exception failure) {
                throw new java.util.concurrent.CompletionException(failure);
            }
        });
        assertThat(copyEntered.await(2, TimeUnit.SECONDS)).isTrue();
        var close = CompletableFuture.runAsync(() -> {
            runtime.close();
            runtimeClosed.set(true);
        });
        try {
            long deadline = System.nanoTime() + Duration.ofSeconds(2).toNanos();
            boolean closeStarted = false;
            while (!closeStarted && System.nanoTime() < deadline) {
                try {
                    runtime.copyArtifactContent("tenant-a", "principal-a", artifact.artifactId(),
                            artifact.version(), new ByteArrayOutputStream(), 0);
                    throw new AssertionError("zero-byte read unexpectedly succeeded");
                } catch (IllegalStateException closing) {
                    closeStarted = true;
                } catch (IllegalArgumentException stillOpen) {
                    Thread.yield();
                }
            }
            assertThat(closeStarted).isTrue();
            assertThat(runtimeClosed).isFalse();
            assertThat(storeClosed.getCount()).isEqualTo(1);
            try (var staged = Files.list(tempDirectory)) {
                assertThat(staged.filter(path -> path.getFileName().toString()
                        .startsWith(runtime.artifactReadStagingPrefixForTests())).count()).isEqualTo(1);
            }
        } finally {
            releaseCopy.countDown();
        }
        assertThat(read.get(3, TimeUnit.SECONDS)).isPresent();
        close.get(3, TimeUnit.SECONDS);
        assertThat(output.toByteArray()).containsExactly(source);
        assertThat(storeClosed.getCount()).isZero();
        try (var staged = Files.list(tempDirectory)) {
            assertThat(staged.filter(path -> path.getFileName().toString()
                    .startsWith(runtime.artifactReadStagingPrefixForTests())).count()).isZero();
        }
    }

    @Test
    void closeFromAnActiveCopyCallbackFailsFastWithoutClosingRuntime() throws Exception {
        var root = Files.createTempDirectory("media-runtime-reentrant-close-");
        byte[] source = "reentrant-close-source".getBytes(StandardCharsets.UTF_8);
        var store = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        var upload = store.begin(new UploadRequest("tenant-a", "principal-a", "source.bin",
                "application/octet-stream", source.length, sha256(source), "CONFIDENTIAL",
                Duration.ofMinutes(5), Map.of()), "reentrant-close-upload");
        store.append("tenant-a", "principal-a", upload.uploadId(), 0, source);
        var artifact = store.complete("tenant-a", "principal-a", upload.uploadId());
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                store, new LocalMediaRuntimeSupport.JobStore(), new LocalMediaRuntimeSupport.StreamStore(),
                null, List.of(), List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        java.io.OutputStream reentrantTarget = new java.io.ByteArrayOutputStream() {
            @Override public void write(byte[] bytes, int offset, int length) {
                runtime.close();
            }
        };
        assertThatThrownBy(() -> runtime.copyArtifactContent("tenant-a", "principal-a", artifact.artifactId(),
                artifact.version(), reentrantTarget, source.length))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("active artifact copy");

        var recoveredOutput = new ByteArrayOutputStream();
        assertThat(runtime.copyArtifactContent("tenant-a", "principal-a", artifact.artifactId(),
                artifact.version(), recoveredOutput, source.length)).isPresent();
        assertThat(recoveredOutput.toByteArray()).containsExactly(source);
        runtime.close();
    }

    @Test
    void localProviderCanReadExactSourceWithinCanonicalDispatch() throws Exception {
        var root = Files.createTempDirectory("media-runtime-content-reader-");
        byte[] source = "source-bound-job-input".getBytes(StandardCharsets.UTF_8);
        AtomicReference<byte[]> copied = new AtomicReference<>();
        AtomicReference<ArtifactContentReadReceipt> contentReceipt = new AtomicReference<>();
        MediaProcessingProvider provider = new MediaProcessingProvider() {
            private final Instant profileCheckedAt = Instant.now();
            @Override public String providerId() { return "source-reader-provider"; }
            @Override public String providerVersion() { return "test-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public List<MediaModalityContracts.CapabilityProfile> capabilityProfiles() {
                var health = new MediaModalityContracts.ProviderHealth(providerId(), providerVersion(),
                        MediaModalityContracts.ProviderHealthStatus.HEALTHY,
                        MediaModalityContracts.DegradationPolicy.LOCAL_DIAGNOSTIC_ONLY, "", profileCheckedAt);
                return List.of(new MediaModalityContracts.CapabilityProfile(
                        providerId(), providerVersion(), JobType.VISION, Set.of(), Set.of(), Set.of(),
                        1920, 1080, Set.of("vision-model-v1"), Set.of(), ProcessingBoundary.LOCAL,
                        false, false, false, health, MediaModalityContracts.DegradationPolicy.LOCAL_DIAGNOSTIC_ONLY,
                        MediaModalityContracts.ExecutionBounds.defaults()));
            }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                try {
                    ByteArrayOutputStream output = new ByteArrayOutputStream();
                    ArtifactContentReadReceipt receipt = context.copySourceContentTo(output, source.length);
                    copied.set(output.toByteArray());
                    contentReceipt.set(receipt);
                    return CompletableFuture.completedFuture(Map.of("detections", List.of()));
                } catch (Exception failure) {
                    return CompletableFuture.failedFuture(failure);
                }
            }
        };
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null, List.of(provider), List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        try {
            var upload = runtime.beginUpload(new UploadRequest("tenant-a", "principal-a", "source.bin",
                    "application/octet-stream", source.length, sha256(source), "CONFIDENTIAL",
                    Duration.ofMinutes(5), Map.of()), "source-reader-upload");
            runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, source);
            var artifact = runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());
            var accepted = runtime.submit(new ProcessingJobRequest("source-reader-job", "tenant-a", "principal-a",
                    "source-reader-correlation", artifact.artifactId(), artifact.version().value(), JobType.VISION,
                    "", Map.of()));

            var deadline = System.nanoTime() + Duration.ofSeconds(3).toNanos();
            var persisted = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();
            while (persisted.status() == JobStatus.ACCEPTED || persisted.status() == JobStatus.RUNNING) {
                assertThat(System.nanoTime()).isLessThan(deadline);
                Thread.sleep(10);
                persisted = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();
            }

            assertThat(persisted.status()).as("job failure code: %s", persisted.failureCode())
                    .isEqualTo(JobStatus.COMPLETED);
            assertThat(copied.get()).containsExactly(source);
            assertThat(contentReceipt.get().version()).isEqualTo(artifact.version());
            assertThat(contentReceipt.get().sha256()).isEqualTo(artifact.sha256());
            assertThat(contentReceipt.get().bytesCopied()).isEqualTo(source.length);
            String metrics = runtime.prometheusMetrics();
            assertThat(metrics).contains("media_provider_profile_readiness")
                    .contains("provider_id=\"source-reader-provider\"")
                    .contains("model_profile=\"vision\"")
                    .contains("model_revision=\"vision-model-v1\"");
            assertThat(metrics).contains("media_provider_quality_observation_timestamp_seconds")
                    .contains("NaN");
        } finally {
            runtime.close();
        }
    }

    @Test
    void productionWaveTwoRequestsFailClosedBeforeJobAndProviderDispatchWithoutRightsResolver() throws Exception {
        var root = Files.createTempDirectory("media-runtime-source-rights-gate-");
        byte[] source = "rights-gated-source".getBytes(StandardCharsets.UTF_8);
        var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        AtomicInteger providerCalls = new AtomicInteger();
        MediaProcessingProvider provider = new MediaProcessingProvider() {
            @Override public String providerId() { return "rights-gated-provider"; }
            @Override public String providerVersion() { return "test-v1"; }
            @Override public Set<JobType> capabilities() {
                return Set.of(JobType.TEXT_TO_SPEECH, JobType.VISION, JobType.MULTIMODAL);
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return true; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                providerCalls.incrementAndGet();
                return CompletableFuture.completedFuture(Map.of("detections", List.of()));
            }
        };
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "production", 8094, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "postgresql", "postgresql", false, false, root),
                artifactStore, jobStore, new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(provider), List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        try {
            var upload = runtime.beginUpload(new UploadRequest("tenant-a", "principal-a", "source.bin",
                    "application/octet-stream", source.length, sha256(source), "CONFIDENTIAL",
                    Duration.ofMinutes(5), Map.of()), "rights-gated-upload");
            runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, source);
            var artifact = runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());

            for (JobType jobType : List.of(JobType.TEXT_TO_SPEECH, JobType.VISION, JobType.MULTIMODAL)) {
                var request = new ProcessingJobRequest("rights-gated-" + jobType, "tenant-a", "principal-a",
                        "rights-gated-correlation", artifact.artifactId(), artifact.version().value(), jobType,
                        "", Map.of());
                assertThatThrownBy(() -> runtime.submit(request))
                        .isInstanceOf(MediaCapabilityNotAdmittedException.class)
                        .hasMessageContaining("authoritative source rights resolver is unavailable");
            }

            assertThat(providerCalls).hasValue(0);
            assertThat(jobStore.countByStatus(JobStatus.ACCEPTED)).isZero();
            assertThat(jobStore.countByStatus(JobStatus.RUNNING)).isZero();
        } finally {
            runtime.close();
        }
    }

    @Test
    void processingContextsWithoutRuntimeAdmissionCannotReadSourceBytes() throws Exception {
        var temp = Files.createTempDirectory("media-no-source-reader-");
        byte[] source = "not-authorized".getBytes(StandardCharsets.UTF_8);
        var store = new LocalMediaRuntimeSupport.FileArtifactStore(temp);
        var upload = store.begin(new UploadRequest("tenant-a", "principal-a", "source.bin",
                "application/octet-stream", source.length, sha256(source), "CONFIDENTIAL",
                Duration.ofMinutes(5), Map.of()), "no-reader-upload");
        store.append("tenant-a", "principal-a", upload.uploadId(), 0, source);
        var artifact = store.complete("tenant-a", "principal-a", upload.uploadId());
        var request = new ProcessingJobRequest("no-reader-request", "tenant-a", "principal-a",
                "no-reader-correlation", artifact.artifactId(), artifact.version().value(), JobType.VISION,
                "", Map.of());
        var context = new ProcessingContext(request, artifact, new com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation());

        assertThatThrownBy(() -> context.copySourceContentTo(new ByteArrayOutputStream(), 1024))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("MEDIA_SOURCE_CONTENT_NOT_ADMITTED");
        store.close();
    }

    private static String sha256(byte[] bytes) throws Exception {
        return java.util.HexFormat.of().formatHex(
                java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
