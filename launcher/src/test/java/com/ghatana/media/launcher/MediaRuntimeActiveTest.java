package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSessionRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** @doc.type class @doc.purpose Verify active artifact, job, and stream lifecycle journeys */
class MediaRuntimeActiveTest {

    @Test
    void localRuntimeCompletesChecksumVerifiedUploadDiagnosticJobAndOrderedStream() throws Exception {
        var root = Files.createTempDirectory("media-runtime-");
        MediaRuntime runtime = MediaRuntime.compose(localEnvironment(root));
        try {
            byte[] content = "media-payload".getBytes(StandardCharsets.UTF_8);
            var upload = runtime.beginUpload(new UploadRequest(
                    "tenant-a", "principal-a", "clip.bin", "application/octet-stream", content.length,
                    sha256(content), "confidential", Duration.ofHours(2), Map.of("source", "test")));
            assertThat(runtime.upload("tenant-a", "principal-b", upload.uploadId())).isEmpty();
            runtime.appendChunk("tenant-a", upload.uploadId(), 0,
                    java.util.Arrays.copyOfRange(content, 0, 5));
            runtime.appendChunk("tenant-a", upload.uploadId(), 1,
                    java.util.Arrays.copyOfRange(content, 5, content.length));
            var artifact = runtime.completeUpload("tenant-a", upload.uploadId());
            assertThat(artifact.sha256()).isEqualTo(sha256(content));
            assertThat(artifact.expiresAt()).isAfter(Instant.now().plus(Duration.ofMinutes(90)));
            assertThat(runtime.artifact("tenant-b", artifact.artifactId())).isEmpty();
            assertThat(runtime.artifact("tenant-a", "principal-b", artifact.artifactId())).isEmpty();
            assertThatThrownBy(() -> runtime.submit(new ProcessingJobRequest(
                    "request-spoofed", "tenant-a", "principal-b", "correlation-spoofed",
                    artifact.artifactId(), JobType.VISION, "local-diagnostic", Map.of())))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("authenticated principal");

            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-a", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "local-diagnostic", Map.of()));
            assertThat(runtime.job("tenant-a", "principal-b", accepted.jobId())).isEmpty();
            assertThat(runtime.jobs("tenant-a", "principal-b", 100)).isEmpty();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            var job = accepted;
            while (!Set.of(JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED).contains(job.status())
                    && System.nanoTime() < deadline) {
                Thread.sleep(10);
                job = runtime.job("tenant-a", accepted.jobId()).orElseThrow();
            }
            assertThat(job.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(job.result()).containsEntry("rawMediaRead", false)
                    .containsEntry("sha256", artifact.sha256());

            var registration = runtime.openStream(new StreamSessionRequest(
                    "tenant-a", "principal-a", "correlation-stream", StreamKind.AUDIO,
                    "local-stream-diagnostic", 64, Duration.ofSeconds(30), Map.of("codec", "pcm")));
            assertThat(runtime.stream(
                    "tenant-a", "principal-b", registration.session().sessionId())).isEmpty();
            assertThatThrownBy(() -> runtime.connectStream(
                    "tenant-a", "principal-b", registration.session().sessionId(),
                    registration.connectionToken()))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("not found");
            var connected = runtime.connectStream(
                    "tenant-a", registration.session().sessionId(), registration.connectionToken());
            assertThat(connected.state()).isEqualTo(StreamState.CONNECTED);
            assertThat(connected.reconnectCount()).isEqualTo(1);

            var first = runtime.acceptFrame(new StreamFrame(
                    "tenant-a", connected.sessionId(), registration.connectionToken(),
                    0, "abc".getBytes(StandardCharsets.UTF_8), false, Instant.now()));
            assertThat(first.acceptedSequence()).isZero();
            assertThat(first.bufferedBytes()).isEqualTo(3);
            assertThat(first.backpressured()).isFalse();

            assertThatThrownBy(() -> runtime.acceptFrame(new StreamFrame(
                    "tenant-a", connected.sessionId(), registration.connectionToken(),
                    2, "gap".getBytes(StandardCharsets.UTF_8), false, Instant.now())))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("contiguous");

            var closed = runtime.closeStream(
                    "tenant-a", connected.sessionId(), registration.connectionToken());
            assertThat(closed.state()).isEqualTo(StreamState.CLOSED);
            assertThat(runtime.healthSnapshot())
                    .containsEntry("genericModelIntegration", "ai-inference-capability")
                    .containsEntry("streamStoreId", "local-stream-store");
        } finally {
            runtime.close();
        }
        assertThat(runtime.ready()).isFalse();
        assertThatThrownBy(runtime::providerIds).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void uploadAndStreamRejectOrderingChecksumTenantAndTokenViolations() throws Exception {
        var root = Files.createTempDirectory("media-runtime-errors-");
        MediaRuntime runtime = MediaRuntime.compose(localEnvironment(root));
        try {
            byte[] bytes = "abc".getBytes(StandardCharsets.UTF_8);
            var upload = runtime.beginUpload(new UploadRequest(
                    "tenant-a", "principal-a", "clip.bin", "application/octet-stream", bytes.length,
                    "0".repeat(64), "restricted", Duration.ofMinutes(10), Map.of()));
            assertThatThrownBy(() -> runtime.appendChunk("tenant-a", upload.uploadId(), 1, bytes))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("Expected chunk index 0");
            runtime.appendChunk("tenant-a", upload.uploadId(), 0, bytes);
            assertThatThrownBy(() -> runtime.completeUpload("tenant-a", upload.uploadId()))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("checksum");

            var registration = runtime.openStream(new StreamSessionRequest(
                    "tenant-a", "principal-a", "correlation-stream", StreamKind.VIDEO,
                    "local-stream-diagnostic", 4, Duration.ofSeconds(30), Map.of()));
            assertThatThrownBy(() -> runtime.connectStream(
                    "tenant-b", registration.session().sessionId(), registration.connectionToken()))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("not found");
            assertThatThrownBy(() -> runtime.connectStream(
                    "tenant-a", registration.session().sessionId(), "invalid-token"))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("token");
            runtime.connectStream("tenant-a", registration.session().sessionId(), registration.connectionToken());
            assertThatThrownBy(() -> runtime.acceptFrame(new StreamFrame(
                    "tenant-a", registration.session().sessionId(), registration.connectionToken(),
                    0, "12345".getBytes(StandardCharsets.UTF_8), false, Instant.now())))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("buffer limit");
        } finally {
            runtime.close();
        }
    }

    @Test
    void totalArtifactSizeIsBoundedBeforeUploadStateIsCreated() throws Exception {
        var root = Files.createTempDirectory("media-runtime-size-bound-");
        Map<String, String> environment = new java.util.HashMap<>(localEnvironment(root));
        environment.put("MEDIA_MAX_ARTIFACT_BYTES", "16");
        MediaRuntime runtime = MediaRuntime.compose(environment);
        try {
            assertThatThrownBy(() -> runtime.beginUpload(new UploadRequest(
                    "tenant-a", "principal-a", "oversized.bin", "application/octet-stream", 17,
                    "0".repeat(64), "restricted", Duration.ofMinutes(10), Map.of())))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("MEDIA_MAX_ARTIFACT_BYTES");
        } finally {
            runtime.close();
        }
    }

    private static Map<String, String> localEnvironment(java.nio.file.Path root) {
        return Map.of(
                "MEDIA_RUNTIME_ENABLED", "true",
                "MEDIA_RUNTIME_ENVIRONMENT", "local",
                "MEDIA_LOCAL_STORES_ENABLED", "true",
                "MEDIA_LOCAL_PROVIDER_ENABLED", "true",
                "MEDIA_LOCAL_STORAGE_ROOT", root.toString(),
                "MEDIA_MAX_CHUNK_BYTES", "16");
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
