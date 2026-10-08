package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaLifecycleEventPublisher;
import tools.jackson.databind.json.JsonMapper;
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
import java.util.ArrayList;
import java.util.List;
import java.nio.file.attribute.FileTime;
import com.sun.net.httpserver.HttpServer;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** @doc.type class @doc.purpose Verify active artifact, job, and stream lifecycle journeys */
class MediaRuntimeActiveTest {

    @Test
    void lifecycleEventsAreEmittedOnlyForAtomicUploadTransitions() throws Exception {
        var root = Files.createTempDirectory("media-runtime-upload-lifecycle-");
        byte[] content = "one-transition".getBytes(StandardCharsets.UTF_8);
        UploadRequest request = new UploadRequest("tenant-events", "principal-a", "clip.bin",
                "application/octet-stream", content.length, sha256(content), "RESTRICTED",
                Duration.ofMinutes(10), Map.of());
        List<String> events = java.util.Collections.synchronizedList(new ArrayList<>());
        MediaLifecycleEventPublisher recorder = new MediaLifecycleEventPublisher() {
            @Override public String publisherId() { return "test-recorder"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public void publish(MediaLifecycleEvent event) { events.add(event.eventType()); }
        };

        MediaRuntime first = uploadRuntime(root, recorder);
        try {
            var pool = java.util.concurrent.Executors.newFixedThreadPool(8);
            try {
                var starts = new ArrayList<java.util.concurrent.Future<?>>();
                for (int i = 0; i < 8; i++) {
                    starts.add(pool.submit(() -> first.beginUpload(request, "event-key")));
                }
                var firstUpload = ((java.util.concurrent.Future<com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession>) starts.get(0)).get();
                for (var started : starts) {
                    assertThat(((java.util.concurrent.Future<com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession>) started).get().uploadId())
                            .isEqualTo(firstUpload.uploadId());
                }
            } finally {
                pool.shutdownNow();
            }
        } finally {
            first.close();
        }

        MediaRuntime recovered = uploadRuntime(root, recorder);
        try {
            var replay = recovered.beginUpload(request, "event-key");
            recovered.appendChunk("tenant-events", "principal-a", replay.uploadId(), 0, content);
            var artifact = recovered.completeUpload("tenant-events", "principal-a", replay.uploadId());
            assertThat(recovered.completeUpload("tenant-events", "principal-a", replay.uploadId())).isEqualTo(artifact);
        } finally {
            recovered.close();
        }
        MediaRuntime finalReplay = uploadRuntime(root, recorder);
        try {
            var replay = finalReplay.beginUpload(request, "event-key");
            finalReplay.completeUpload("tenant-events", "principal-a", replay.uploadId());
        } finally {
            finalReplay.close();
        }
        assertThat(events).containsExactly("media.upload.started", "media.artifact.completed");
    }

    private static MediaRuntime uploadRuntime(java.nio.file.Path root, MediaLifecycleEventPublisher publisher) {
        MediaRuntimeConfig config = MediaRuntimeConfig.fromEnvironment(localEnvironment(root));
        return new MediaRuntime(config,
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                MediaSemanticRedactionRuntime.disabled(config.jobTimeout()),
                publisher,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    @Test
    void localRuntimeCompletesChecksumVerifiedUploadDiagnosticJobAndOrderedStream() throws Exception {
        var root = Files.createTempDirectory("media-runtime-");
        MediaRuntime runtime = MediaRuntime.compose(localEnvironment(root));
        try {
            byte[] content = "media-payload".getBytes(StandardCharsets.UTF_8);
            var upload = runtime.beginUpload(new UploadRequest(
                    "tenant-a", "principal-a", "clip.bin", "application/octet-stream", content.length,
                    sha256(content), "CONFIDENTIAL", Duration.ofHours(2), Map.of("source", "test")), "active-upload");
            assertThat(runtime.upload("tenant-a", "principal-b", upload.uploadId())).isEmpty();
            runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0,
                    java.util.Arrays.copyOfRange(content, 0, 5));
            runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 1,
                    java.util.Arrays.copyOfRange(content, 5, content.length));
            var artifact = runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());
            assertThat(artifact.sha256()).isEqualTo(sha256(content));
            assertThat(artifact.expiresAt()).isAfter(Instant.now().plus(Duration.ofMinutes(90)));
            assertThat(runtime.artifact("tenant-b", "principal-a", artifact.artifactId())).isEmpty();
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
            assertThatThrownBy(() -> runtime.job("tenant-a", accepted.jobId()))
                    .isInstanceOf(SecurityException.class);
            assertThatThrownBy(() -> runtime.jobs("tenant-a", 100))
                    .isInstanceOf(SecurityException.class);
            assertThatThrownBy(() -> runtime.cancel("tenant-a", accepted.jobId()))
                    .isInstanceOf(SecurityException.class);
            assertThatThrownBy(() -> runtime.cancel("tenant-a", "principal-b", accepted.jobId()))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("not found");
            assertThat(runtime.job("tenant-a", "principal-a", accepted.jobId())).isPresent();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            var job = accepted;
            while (!Set.of(JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED).contains(job.status())
                    && System.nanoTime() < deadline) {
                Thread.sleep(10);
                job = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();
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
                    "0".repeat(64), "RESTRICTED", Duration.ofMinutes(10), Map.of()), "invalid-checksum-upload");
            assertThatThrownBy(() -> runtime.appendChunk("tenant-a", "principal-b", upload.uploadId(), 0, bytes))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("Open upload session not found");
            assertThatThrownBy(() -> runtime.completeUpload("tenant-a", "principal-b", upload.uploadId()))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("not found");
            assertThat(runtime.upload("tenant-a", "principal-a", upload.uploadId()).orElseThrow().bytesReceived())
                    .isZero();
            assertThatThrownBy(() -> runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 1, bytes))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("Expected chunk index 0");
            runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, bytes);
            assertThatThrownBy(() -> runtime.completeUpload("tenant-a", "principal-a", upload.uploadId()))
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
    void uploadBeginReplayIsPrincipalScopedPayloadBoundAndCompletionReturnsSameArtifact() throws Exception {
        var root = Files.createTempDirectory("media-runtime-upload-replay-");
        MediaRuntime runtime = MediaRuntime.compose(localEnvironment(root));
        try {
        byte[] content = "replay-safe-123".getBytes(StandardCharsets.UTF_8);
            UploadRequest request = new UploadRequest("tenant-a", "principal-a", "clip.bin",
                    "application/octet-stream", content.length, sha256(content), "RESTRICTED",
                    Duration.ofMinutes(10), Map.of("source", "test"));
            var first = runtime.beginUpload(request, "same-key");
            var replay = runtime.beginUpload(request, "same-key");
            assertThat(replay.uploadId()).isEqualTo(first.uploadId());
            assertThat(replay.createdAt()).isEqualTo(first.createdAt());
            assertThat(replay.expiresAt()).isEqualTo(first.expiresAt());
            assertThatThrownBy(() -> runtime.beginUpload(new UploadRequest(
                    "tenant-a", "principal-a", "changed.bin", "application/octet-stream", content.length,
                    sha256(content), "RESTRICTED", Duration.ofMinutes(10), Map.of("source", "test")), "same-key"))
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("different upload request");
            var otherPrincipal = runtime.beginUpload(new UploadRequest("tenant-a", "principal-b", "clip.bin",
                    "application/octet-stream", content.length, sha256(content), "RESTRICTED",
                    Duration.ofMinutes(10), Map.of("source", "test")), "same-key");
            assertThat(otherPrincipal.uploadId()).isNotEqualTo(first.uploadId());
            assertThatThrownBy(() -> runtime.beginUpload(request))
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("Idempotency-Key");

            runtime.appendChunk("tenant-a", "principal-a", first.uploadId(), 0, content);
            var completed = runtime.completeUpload("tenant-a", "principal-a", first.uploadId());
            var repeated = runtime.completeUpload("tenant-a", "principal-a", first.uploadId());
            assertThat(repeated).isEqualTo(completed);
            assertThat(Files.readAllBytes(java.nio.file.Path.of(java.net.URI.create(completed.objectReference()))))
                    .containsExactly(content);
        } finally {
            runtime.close();
        }
    }

    @Test
    void concurrentLocalUploadBeginReplaysAtomicallyToOneSession() throws Exception {
        var root = Files.createTempDirectory("media-runtime-upload-concurrent-");
        var store = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        var pool = java.util.concurrent.Executors.newFixedThreadPool(8);
        var ready = new java.util.concurrent.CountDownLatch(8);
        var start = new java.util.concurrent.CountDownLatch(1);
        try {
            byte[] bytes = "payload".getBytes(StandardCharsets.UTF_8);
            UploadRequest request = new UploadRequest("tenant-concurrent", "principal-a", "clip.bin",
                    "application/octet-stream", bytes.length, sha256(bytes), "RESTRICTED",
                    Duration.ofMinutes(10), Map.of());
            var futures = java.util.stream.IntStream.range(0, 8).mapToObj(index -> pool.submit(() -> {
                ready.countDown();
                start.await();
                return store.begin(request, "shared-key");
            })).toList();
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            var uploadIds = new java.util.HashSet<String>();
            for (var future : futures) uploadIds.add(future.get(5, TimeUnit.SECONDS).uploadId());
            assertThat(uploadIds).hasSize(1);
            try (var paths = Files.list(root.resolve("uploads"))) {
                assertThat(paths.count()).isEqualTo(1);
            }
        } finally {
            start.countDown();
            pool.shutdownNow();
            store.close();
        }
    }

    @Test
    void localUploadManifestsRecoverReplayAndFinalizationWithoutChangingIdentityOrBytes() throws Exception {
        var root = Files.createTempDirectory("media-runtime-upload-recovery-");
        byte[] content = "restart-safe-media".getBytes(StandardCharsets.UTF_8);
        UploadRequest request = new UploadRequest("tenant-recovery", "principal-a", "clip.bin",
                "application/octet-stream", content.length, sha256(content), "RESTRICTED",
                Duration.ofMinutes(10), Map.of("source", "recovery"));
        var firstStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        var upload = firstStore.begin(request, "durable-key");
        firstStore.append("tenant-recovery", "principal-a", upload.uploadId(), 0, content);
        var originalArtifact = firstStore.complete("tenant-recovery", "principal-a", upload.uploadId());
        firstStore.close();

        var recovered = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        try {
        var replay = recovered.begin(request, "durable-key");
            assertThat(replay.uploadId()).isEqualTo(upload.uploadId());
            assertThat(replay.status()).isEqualTo(com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus.COMPLETED);
            assertThat(replay.createdAt()).isEqualTo(upload.createdAt());
            assertThat(replay.expiresAt()).isEqualTo(upload.expiresAt());
            assertThat(recovered.complete("tenant-recovery", "principal-a", upload.uploadId()))
                    .isEqualTo(originalArtifact);
            assertThat(Files.readAllBytes(java.nio.file.Path.of(java.net.URI.create(originalArtifact.objectReference()))))
                    .containsExactly(content);
            assertThatThrownBy(() -> recovered.begin(new UploadRequest(
                    "tenant-recovery", "principal-a", "changed.bin", "application/octet-stream", content.length,
                    sha256(content), "RESTRICTED", Duration.ofMinutes(10), Map.of("source", "recovery")),
                    "durable-key"))
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("different upload request");
            var otherPrincipal = recovered.begin(new UploadRequest("tenant-recovery", "principal-b", "clip.bin",
                    "application/octet-stream", content.length, sha256(content), "RESTRICTED",
                    Duration.ofMinutes(10), Map.of("source", "recovery")), "durable-key");
            assertThat(otherPrincipal.uploadId()).isNotEqualTo(upload.uploadId());
            var otherTenant = recovered.begin(new UploadRequest("other-tenant", "principal-a", "clip.bin",
                    "application/octet-stream", content.length, sha256(content), "RESTRICTED",
                    Duration.ofMinutes(10), Map.of("source", "recovery")), "durable-key");
            assertThat(otherTenant.uploadId()).isNotEqualTo(upload.uploadId());
        } finally {
            recovered.close();
        }
    }

    @Test
    void closedLocalArtifactStoreRejectsEveryOperationAndFreshStoreRecoversIdempotency() throws Exception {
        var root = Files.createTempDirectory("media-runtime-upload-closed-");
        byte[] content = "closed-store-fence".getBytes(StandardCharsets.UTF_8);
        UploadRequest request = new UploadRequest("tenant-closed", "principal-a", "clip.bin",
                "application/octet-stream", content.length, sha256(content), "RESTRICTED",
                Duration.ofMinutes(10), Map.of());
        var closedStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        var upload = closedStore.begin(request, "closed-store-key");
        closedStore.append("tenant-closed", "principal-a", upload.uploadId(), 0, content);
        var artifact = closedStore.complete("tenant-closed", "principal-a", upload.uploadId());
        closedStore.close();

        assertThat(closedStore.ready()).isFalse();
        assertThatThrownBy(() -> closedStore.begin(request, "closed-store-key"))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("store is closed");
        assertThatThrownBy(() -> closedStore.append("tenant-closed", "principal-a", upload.uploadId(), 1, content))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("store is closed");
        assertThatThrownBy(() -> closedStore.complete("tenant-closed", "principal-a", upload.uploadId()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("store is closed");
        assertThatThrownBy(() -> closedStore.upload("tenant-closed", upload.uploadId()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("store is closed");
        assertThatThrownBy(() -> closedStore.artifact("tenant-closed", artifact.artifactId()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("store is closed");

        var recovered = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        try {
            var replay = recovered.begin(request, "closed-store-key");
            assertThat(replay.uploadId()).isEqualTo(upload.uploadId());
            assertThat(recovered.complete("tenant-closed", "principal-a", upload.uploadId())).isEqualTo(artifact);
            assertThat(Files.readAllBytes(java.nio.file.Path.of(
                    java.net.URI.create(artifact.objectReference())))).containsExactly(content);
        } finally {
            recovered.close();
        }
    }

    @Test
    void localChunkDuplicateRequiresPersistedReceiptAndSurvivesRestartAndConcurrency() throws Exception {
        var root = Files.createTempDirectory("media-runtime-chunk-receipt-");
        byte[] firstChunk = "chunk-one".getBytes(StandardCharsets.UTF_8);
        byte[] secondChunk = "chunk-two".getBytes(StandardCharsets.UTF_8);
        byte[] completeBytes = new byte[firstChunk.length + secondChunk.length];
        System.arraycopy(firstChunk, 0, completeBytes, 0, firstChunk.length);
        System.arraycopy(secondChunk, 0, completeBytes, firstChunk.length, secondChunk.length);
        UploadRequest request = new UploadRequest("tenant-chunks", "principal-a", "clip.bin",
                "application/octet-stream", completeBytes.length, sha256(completeBytes), "INTERNAL",
                Duration.ofMinutes(10), Map.of());
        var initial = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        var upload = initial.begin(request, "chunk-receipt-key");
        assertThatThrownBy(() -> initial.append("tenant-chunks", "principal-a", upload.uploadId(), -1, firstChunk))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("must not be negative");
        var accepted = initial.append("tenant-chunks", "principal-a", upload.uploadId(), 0, firstChunk);
        java.nio.file.Path part = root.resolve("uploads").resolve(upload.uploadId() + ".part");
        FileTime fixedMtime = FileTime.fromMillis(1_000_000L);
        Files.setLastModifiedTime(part, fixedMtime);
        assertThat(initial.append("tenant-chunks", "principal-a", upload.uploadId(), 0, firstChunk))
                .isEqualTo(accepted);
        assertThat(Files.getLastModifiedTime(part)).isEqualTo(fixedMtime);
        assertThatThrownBy(() -> initial.append("tenant-chunks", "principal-a", upload.uploadId(), 0,
                "chunk-alt".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("different content");
        assertThat(Files.getLastModifiedTime(part)).isEqualTo(fixedMtime);
        initial.close();

        var recovered = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        try {
            var pool = java.util.concurrent.Executors.newFixedThreadPool(8);
            try {
                var retries = new ArrayList<java.util.concurrent.Future<com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession>>();
                for (int i = 0; i < 8; i++) {
                    retries.add(pool.submit(() -> recovered.append(
                            "tenant-chunks", "principal-a", upload.uploadId(), 0, firstChunk)));
                }
                for (var retry : retries) assertThat(retry.get()).isEqualTo(accepted);
            } finally {
                pool.shutdownNow();
            }
            assertThat(Files.getLastModifiedTime(part)).isEqualTo(fixedMtime);
            var next = recovered.append("tenant-chunks", "principal-a", upload.uploadId(), 1, secondChunk);
            assertThat(next.bytesReceived()).isEqualTo(completeBytes.length);
            assertThat(next.nextChunkIndex()).isEqualTo(2);
        } finally {
            recovered.close();
        }
    }

    @Test
    void localRecoveryRejectsChunkBytesThatNoLongerMatchPersistedReceipt() throws Exception {
        var root = Files.createTempDirectory("media-runtime-chunk-receipt-tamper-");
        byte[] bytes = "stable-chunk".getBytes(StandardCharsets.UTF_8);
        UploadRequest request = new UploadRequest("tenant-chunk-tamper", "principal-a", "clip.bin",
                "application/octet-stream", bytes.length + 1, sha256(bytes), "CONFIDENTIAL",
                Duration.ofMinutes(10), Map.of());
        var store = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        var upload = store.begin(request, "chunk-tamper-key");
        store.append("tenant-chunk-tamper", "principal-a", upload.uploadId(), 0, bytes);
        store.close();
        java.nio.file.Path part = root.resolve("uploads").resolve(upload.uploadId() + ".part");
        Files.write(part, "faulty-chunk".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> new LocalMediaRuntimeSupport.FileArtifactStore(root))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("chunk receipt chain is invalid");
    }

    @Test
    void progressedLegacyManifestWithoutChunkReceiptsFailsClosed() throws Exception {
        var root = Files.createTempDirectory("media-runtime-chunk-receipt-legacy-");
        byte[] bytes = "stable-chunk".getBytes(StandardCharsets.UTF_8);
        UploadRequest request = new UploadRequest("tenant-chunk-legacy", "principal-a", "clip.bin",
                "application/octet-stream", bytes.length + 1, sha256(bytes), "INTERNAL",
                Duration.ofMinutes(10), Map.of());
        var store = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        var upload = store.begin(request, "chunk-legacy-key");
        store.append("tenant-chunk-legacy", "principal-a", upload.uploadId(), 0, bytes);
        store.close();
        java.nio.file.Path manifest = root.resolve("metadata").resolve(upload.uploadId() + ".json");
        var mapper = JsonMapper.builder().addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();
        var legacyManifest = (tools.jackson.databind.node.ObjectNode) mapper.readTree(Files.readString(manifest));
        legacyManifest.remove("chunkReceipts");
        Files.writeString(manifest, mapper.writeValueAsString(legacyManifest));
        assertThatThrownBy(() -> new LocalMediaRuntimeSupport.FileArtifactStore(root))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("chunk receipt count does not match upload progress");
    }

    @Test
    void localAppendFailsClosedWhenUploadPathBecomesSymlink() throws Exception {
        var root = Files.createTempDirectory("media-runtime-upload-symlink-");
        var outside = Files.createTempFile("media-outside-upload-", ".bin");
        byte[] content = "protected".getBytes(StandardCharsets.UTF_8);
        UploadRequest request = new UploadRequest("tenant-symlink", "principal-a", "clip.bin",
                "application/octet-stream", content.length, sha256(content), "INTERNAL",
                Duration.ofMinutes(10), Map.of());
        var store = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        try {
            var upload = store.begin(request, "symlink-key");
            java.nio.file.Path part = root.resolve("uploads").resolve(upload.uploadId() + ".part");
            Files.delete(part);
            Files.createSymbolicLink(part, outside);
            assertThatThrownBy(() -> store.append("tenant-symlink", "principal-a", upload.uploadId(), 0, content))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining("non-symlink");
            assertThat(Files.readAllBytes(outside)).isEmpty();
            assertThat(store.ready()).isFalse();
        } finally {
            store.close();
        }
    }

    @Test
    void uploadHttpRejectsUnknownClassificationBeforeCreatingSession() throws Exception {
        var root = Files.createTempDirectory("media-runtime-classification-http-");
        MediaRuntime runtime = MediaRuntime.compose(localEnvironment(root));
        HttpServer server = HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", new MediaHttpHandler(runtime));
        server.start();
        try {
            var client = java.net.http.HttpClient.newHttpClient();
            String endpoint = "http://127.0.0.1:" + server.getAddress().getPort();
            String body = "{\"tenantId\":\"tenant-http\",\"principalId\":\"principal-a\","
                    + "\"fileName\":\"clip.bin\",\"contentType\":\"application/octet-stream\","
                    + "\"expectedSizeBytes\":1,\"expectedSha256\":\"" + sha256(new byte[] { 1 }) + "\","
                    + "\"classification\":\"SECRET\",\"retention\":\"PT1M\",\"metadata\":{}}";
            var response = client.send(
                    java.net.http.HttpRequest.newBuilder(java.net.URI.create(endpoint + "/api/v1/artifacts/uploads"))
                            .header("Content-Type", "application/json")
                            .header("X-Tenant-Id", "tenant-http")
                            .header("X-Principal-Id", "principal-a")
                            .header("Idempotency-Key", "invalid-classification")
                            .POST(java.net.http.HttpRequest.BodyPublishers.ofString(body))
                            .build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            assertThat(response.statusCode()).isEqualTo(400);
            assertThat(response.body()).contains("INVALID_REQUEST");

            var valid = client.send(java.net.http.HttpRequest.newBuilder(
                            java.net.URI.create(endpoint + "/api/v1/artifacts/uploads"))
                    .header("Content-Type", "application/json")
                    .header("X-Tenant-Id", "tenant-http")
                    .header("X-Principal-Id", "principal-a")
                    .header("Idempotency-Key", "valid-classification")
                    .POST(java.net.http.HttpRequest.BodyPublishers.ofString(body.replace("SECRET", "INTERNAL")))
                    .build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            assertThat(valid.statusCode()).isEqualTo(201);
            String uploadId = valid.body().replaceAll("(?s).*\\\"uploadId\\\":\\\"([^\\\"]+)\\\".*", "$1");
            var negativeIndex = client.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(
                            endpoint + "/api/v1/artifacts/uploads/" + uploadId + "/chunks/-1"))
                    .header("Content-Type", "application/octet-stream")
                    .header("X-Tenant-Id", "tenant-http")
                    .header("X-Principal-Id", "principal-a")
                    .PUT(java.net.http.HttpRequest.BodyPublishers.ofByteArray(new byte[] { 1 }))
                    .build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            assertThat(negativeIndex.statusCode()).isEqualTo(400);
            assertThat(negativeIndex.body()).contains("INVALID_REQUEST");
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void expiredLocalUploadCannotCompleteAndPersistsExpiredState() throws Exception {
        var root = Files.createTempDirectory("media-runtime-expired-complete-");
        byte[] content = "expired-complete".getBytes(StandardCharsets.UTF_8);
        UploadRequest request = new UploadRequest("tenant-expired-local", "principal-a", "clip.bin",
                "application/octet-stream", content.length, sha256(content), "RESTRICTED",
                Duration.ofMinutes(10), Map.of());
        var initial = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        var upload = initial.begin(request, "expired-complete-key");
        initial.append("tenant-expired-local", "principal-a", upload.uploadId(), 0, content);
        initial.close();
        java.nio.file.Path manifestPath = root.resolve("metadata").resolve(upload.uploadId() + ".json");
        var mapper = JsonMapper.builder().addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();
        var manifest = (tools.jackson.databind.node.ObjectNode) mapper.readTree(Files.readString(manifestPath));
        manifest.put("expiresAt", 1L);
        Files.writeString(manifestPath, mapper.writeValueAsString(manifest));

        var expired = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        try {
            assertThatThrownBy(() -> expired.complete("tenant-expired-local", "principal-a", upload.uploadId()))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining("Upload session expired");
            assertThat(expired.upload("tenant-expired-local", upload.uploadId()).orElseThrow().status())
                    .isEqualTo(com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus.EXPIRED);
            try (var paths = Files.list(root.resolve("artifacts"))) {
                assertThat(paths.toList()).isEmpty();
            }
        } finally {
            expired.close();
        }
    }

    @Test
    void expiredLocalCompletionMapsToHttp409WithoutCreatingArtifact() throws Exception {
        var root = Files.createTempDirectory("media-runtime-expired-http-");
        byte[] content = "expired-http-complete".getBytes(StandardCharsets.UTF_8);
        UploadRequest request = new UploadRequest("tenant-expired-http", "principal-a", "clip.bin",
                "application/octet-stream", content.length, sha256(content), "INTERNAL",
                Duration.ofMinutes(10), Map.of());
        var initial = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        var upload = initial.begin(request, "expired-http-key");
        initial.append("tenant-expired-http", "principal-a", upload.uploadId(), 0, content);
        initial.close();
        java.nio.file.Path manifestPath = root.resolve("metadata").resolve(upload.uploadId() + ".json");
        var mapper = JsonMapper.builder().addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();
        var manifest = (tools.jackson.databind.node.ObjectNode) mapper.readTree(Files.readString(manifestPath));
        manifest.put("expiresAt", 1L);
        Files.writeString(manifestPath, mapper.writeValueAsString(manifest));

        MediaRuntime runtime = MediaRuntime.compose(localEnvironment(root));
        HttpServer server = HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", new MediaHttpHandler(runtime));
        server.start();
        try {
            var response = java.net.http.HttpClient.newHttpClient().send(
                    java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"
                                    + server.getAddress().getPort() + "/api/v1/artifacts/uploads/"
                                    + upload.uploadId() + "/complete"))
                            .header("X-Tenant-Id", "tenant-expired-http")
                            .header("X-Principal-Id", "principal-a")
                            .POST(java.net.http.HttpRequest.BodyPublishers.noBody())
                            .build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            assertThat(response.statusCode()).isEqualTo(409);
            assertThat(runtime.upload("tenant-expired-http", "principal-a", upload.uploadId())
                    .orElseThrow().status()).isEqualTo(com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus.EXPIRED);
            try (var artifacts = Files.list(root.resolve("artifacts"))) {
                assertThat(artifacts.toList()).isEmpty();
            }
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void localRecoveryFinishesPersistedFinalizationButRejectsUncertainChunkWrite() throws Exception {
        var root = Files.createTempDirectory("media-runtime-upload-crash-");
        byte[] content = "recover-finalization".getBytes(StandardCharsets.UTF_8);
        UploadRequest request = new UploadRequest("tenant-crash", "principal-a", "clip.bin",
                "application/octet-stream", content.length, sha256(content), "RESTRICTED",
                Duration.ofMinutes(10), Map.of());
        java.util.concurrent.atomic.AtomicInteger replacements = new java.util.concurrent.atomic.AtomicInteger();
        var failing = new LocalMediaRuntimeSupport.FileArtifactStore(root, path -> {
            if (replacements.incrementAndGet() == 4) throw new java.io.IOException("injected completed-manifest failure");
        });
        var upload = failing.begin(request, "crash-finalize-key");
        failing.append("tenant-crash", "principal-a", upload.uploadId(), 0, content);
        assertThatThrownBy(() -> failing.complete("tenant-crash", "principal-a", upload.uploadId()))
                .isInstanceOf(IllegalStateException.class);
        assertThat(failing.ready()).isFalse();
        failing.close();

        var recovered = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        try {
            var replay = recovered.begin(request, "crash-finalize-key");
            assertThat(replay.uploadId()).isEqualTo(upload.uploadId());
            var completed = recovered.complete("tenant-crash", "principal-a", upload.uploadId());
            assertThat(completed.artifactId()).isNotBlank();
            assertThat(Files.readAllBytes(java.nio.file.Path.of(java.net.URI.create(completed.objectReference()))))
                    .containsExactly(content);
        } finally {
            recovered.close();
        }

        var uncertainRoot = Files.createTempDirectory("media-runtime-upload-uncertain-chunk-");
        java.util.concurrent.atomic.AtomicInteger chunkReplacements = new java.util.concurrent.atomic.AtomicInteger();
        var uncertain = new LocalMediaRuntimeSupport.FileArtifactStore(uncertainRoot, path -> {
            if (chunkReplacements.incrementAndGet() == 2) throw new java.io.IOException("injected progress-manifest failure");
        });
        var uncertainUpload = uncertain.begin(request, "uncertain-chunk-key");
        assertThatThrownBy(() -> uncertain.append("tenant-crash", "principal-a",
                uncertainUpload.uploadId(), 0, content)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> uncertain.append("tenant-crash", "principal-a",
                uncertainUpload.uploadId(), 0, content)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("failed closed");
        uncertain.close();
        assertThatThrownBy(() -> new LocalMediaRuntimeSupport.FileArtifactStore(uncertainRoot))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("bytes and manifest progress disagree");
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
                    "0".repeat(64), "RESTRICTED", Duration.ofMinutes(10), Map.of()), "oversized-upload"))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("MEDIA_MAX_ARTIFACT_BYTES");
        } finally {
            runtime.close();
        }
    }

    @Test
    void principalScopedReadsHideCrossTenantWrongPrincipalAndMissingObjectsAndRejectClosedRuntime()
            throws Exception {
        var root = Files.createTempDirectory("media-runtime-scoped-reads-");
        MediaRuntime runtime = MediaRuntime.compose(localEnvironment(root));
        byte[] content = "media-payload".getBytes(StandardCharsets.UTF_8);
        var upload = runtime.beginUpload(new UploadRequest(
                "tenant-a", "principal-a", "clip.bin", "application/octet-stream", content.length,
                sha256(content), "CONFIDENTIAL", Duration.ofHours(2), Map.of()), "scoped-read-upload");
        assertThat(runtime.upload("tenant-a", "principal-a", upload.uploadId())).isPresent();
        assertThat(runtime.upload("tenant-a", "principal-b", upload.uploadId())).isEmpty();
        assertThat(runtime.upload("tenant-b", "principal-a", upload.uploadId())).isEmpty();
        assertThat(runtime.upload("tenant-a", "principal-a", "missing-upload")).isEmpty();
        assertThatThrownBy(() -> runtime.upload("tenant-a", upload.uploadId()))
                .isInstanceOf(SecurityException.class);

        runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, content);
        var artifact = runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());
        assertThat(runtime.artifact("tenant-a", "principal-a", artifact.artifactId())).isPresent();
        assertThat(runtime.artifact("tenant-a", "principal-b", artifact.artifactId())).isEmpty();
        assertThat(runtime.artifact("tenant-b", "principal-a", artifact.artifactId())).isEmpty();
        assertThat(runtime.artifact("tenant-a", "principal-a", "missing-artifact")).isEmpty();
        assertThatThrownBy(() -> runtime.artifact("tenant-a", artifact.artifactId()))
                .isInstanceOf(SecurityException.class);

        var job = runtime.submit(new ProcessingJobRequest(
                "request-scoped-read", "tenant-a", "principal-a", "correlation-scoped-read",
                artifact.artifactId(), JobType.VISION, "local-diagnostic", Map.of()));
        assertThat(runtime.job("tenant-a", "principal-a", job.jobId())).isPresent();
        assertThat(runtime.job("tenant-a", "principal-b", job.jobId())).isEmpty();
        assertThat(runtime.job("tenant-b", "principal-a", job.jobId())).isEmpty();
        assertThat(runtime.job("tenant-a", "principal-a", "missing-job")).isEmpty();
        assertThat(runtime.jobs("tenant-a", "principal-b", 100)).isEmpty();
        runtime.close();

        assertThatThrownBy(() -> runtime.upload("tenant-a", "principal-a", upload.uploadId()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("closed");
        assertThatThrownBy(() -> runtime.artifact("tenant-a", "principal-a", artifact.artifactId()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("closed");
        assertThatThrownBy(() -> runtime.job("tenant-a", "principal-a", job.jobId()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("closed");
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
