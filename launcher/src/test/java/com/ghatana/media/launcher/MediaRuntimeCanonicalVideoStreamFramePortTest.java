package com.ghatana.media.launcher;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamAck;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSessionRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;
import com.ghatana.video.streaming.CanonicalVideoStreamFramePort;
import com.ghatana.video.streaming.VideoStreamSession;
import java.nio.file.Files;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

class MediaRuntimeCanonicalVideoStreamFramePortTest {

    @Test
    void videoFrameUsesCanonicalLeaseAndAckCursorAndPreservesWireMetadata() throws Exception {
        var root = Files.createTempDirectory("media-canonical-video-stream-");
        var provider = new VideoStreamingProvider();
        var runtime = runtime(root, provider, Duration.ofSeconds(2));

        try {
            var registration = runtime.openStream(request(provider, StreamKind.VIDEO));
            runtime.connectStream("tenant-video", registration.session().sessionId(), registration.connectionToken());
            var port = runtime.videoStreamFramePort(
                    "tenant-video", "principal-video", registration.session().sessionId(), registration.connectionToken());
            var binding = port.currentBinding(
                    "tenant-video", registration.session().sessionId(), "principal-video").orElseThrow();
            byte[] callerPayload = {0, 1, 2, 3, (byte) 0xfe};
            var frame = new VideoStreamSession.DecodedFrame(0, true, 12_345L, callerPayload);
            callerPayload[0] = 99;

            var result = port.offer(binding, frame);

            assertThat(result).isEqualTo(CanonicalVideoStreamFramePort.Result.acknowledged(0));
            assertThat(provider.calls()).isEqualTo(1);
            var decodedByProvider = new VideoStreamSession().decodeFrame(provider.receivedWireFrame());
            assertThat(decodedByProvider.sequenceNumber()).isZero();
            assertThat(decodedByProvider.keyFrame()).isTrue();
            assertThat(decodedByProvider.timestampMillis()).isEqualTo(12_345L);
            assertThat(decodedByProvider.payload()).containsExactly(0, 1, 2, 3, (byte) 0xfe);
            assertThat(runtime.stream("tenant-video", registration.session().sessionId())
                    .orElseThrow().lastSequence()).isZero();
            assertThat(binding.purposeRef()).isEqualTo("media.stream.video.capture");
        } finally {
            runtime.close();
        }
    }

    @Test
    void duplicateAndStaleVideoBindingsNeverRedispatch() throws Exception {
        var root = Files.createTempDirectory("media-canonical-video-stream-duplicate-");
        var provider = new VideoStreamingProvider();
        var runtime = runtime(root, provider, Duration.ofSeconds(2));

        try {
            var registration = runtime.openStream(request(provider, StreamKind.VIDEO));
            runtime.connectStream("tenant-video", registration.session().sessionId(), registration.connectionToken());
            var port = runtime.videoStreamFramePort(
                    "tenant-video", "principal-video", registration.session().sessionId(), registration.connectionToken());
            var firstBinding = port.currentBinding(
                    "tenant-video", registration.session().sessionId(), "principal-video").orElseThrow();
            var firstFrame = frame(0);
            assertThat(port.offer(firstBinding, firstFrame))
                    .isEqualTo(CanonicalVideoStreamFramePort.Result.acknowledged(0));
            assertThat(port.offer(firstBinding, firstFrame).disposition())
                    .isEqualTo(CanonicalVideoStreamFramePort.Disposition.NOT_ADMITTED);

            var nextBinding = port.currentBinding(
                    "tenant-video", registration.session().sessionId(), "principal-video").orElseThrow();
            assertThat(port.offer(nextBinding, frame(2)).disposition())
                    .isEqualTo(CanonicalVideoStreamFramePort.Disposition.NOT_ADMITTED);
            assertThat(provider.calls()).isEqualTo(1);
        } finally {
            runtime.close();
        }
    }

    @Test
    void unresolvedVideoProviderOutcomeRemainsUnknownAndCannotBeReplayed() throws Exception {
        var root = Files.createTempDirectory("media-canonical-video-stream-unknown-");
        var provider = new BlockingVideoStreamingProvider();
        var runtime = runtime(root, provider, Duration.ofMillis(50));

        try {
            var registration = runtime.openStream(request(provider, StreamKind.VIDEO));
            runtime.connectStream("tenant-video", registration.session().sessionId(), registration.connectionToken());
            var port = runtime.videoStreamFramePort(
                    "tenant-video", "principal-video", registration.session().sessionId(), registration.connectionToken());
            var binding = port.currentBinding(
                    "tenant-video", registration.session().sessionId(), "principal-video").orElseThrow();

            assertThat(port.offer(binding, frame(0)).disposition())
                    .isEqualTo(CanonicalVideoStreamFramePort.Disposition.OUTCOME_UNKNOWN);
            assertThat(port.offer(binding, frame(0)).disposition())
                    .isEqualTo(CanonicalVideoStreamFramePort.Disposition.OUTCOME_UNKNOWN);
            assertThat(provider.calls()).isEqualTo(1);
        } finally {
            runtime.close();
        }
    }

    @Test
    void adapterRejectsWrongTenantPrincipalTokenKindAndOversizedEncodedFrame() throws Exception {
        var root = Files.createTempDirectory("media-canonical-video-stream-scope-");
        var provider = new VideoStreamingProvider();
        var runtime = runtime(root, provider, Duration.ofSeconds(2));

        try {
            var registration = runtime.openStream(request(provider, StreamKind.VIDEO));
            runtime.connectStream("tenant-video", registration.session().sessionId(), registration.connectionToken());
            var port = runtime.videoStreamFramePort(
                    "tenant-video", "principal-video", registration.session().sessionId(), registration.connectionToken());

            assertThat(port.currentBinding("tenant-other", registration.session().sessionId(), "principal-video"))
                    .isEmpty();
            assertThat(port.currentBinding("tenant-video", registration.session().sessionId(), "principal-other"))
                    .isEmpty();
            assertThat(runtime.videoStreamFramePort("tenant-video", "principal-video",
                    registration.session().sessionId(), "wrong-token")
                    .currentBinding("tenant-video", registration.session().sessionId(), "principal-video"))
                    .isEmpty();
            var binding = port.currentBinding(
                    "tenant-video", registration.session().sessionId(), "principal-video").orElseThrow();
            assertThat(port.offer(binding, new VideoStreamSession.DecodedFrame(
                    0, true, 10L, new byte[runtime.config().maximumChunkBytes()])))
                    .isEqualTo(CanonicalVideoStreamFramePort.Result.notAdmitted(
                            "video frame wire payload is outside the admitted non-empty bound"));
            assertThat(provider.calls()).isZero();

            var audioProvider = new AudioStreamingProvider();
            var audioRuntime = runtime(root, audioProvider, Duration.ofSeconds(2));
            try {
                var audioRegistration = audioRuntime.openStream(request(audioProvider, StreamKind.AUDIO));
                audioRuntime.connectStream("tenant-video", audioRegistration.session().sessionId(),
                        audioRegistration.connectionToken());
                var wrongKind = audioRuntime.videoStreamFramePort(
                        "tenant-video", "principal-video", audioRegistration.session().sessionId(),
                        audioRegistration.connectionToken());
                assertThat(wrongKind.currentBinding("tenant-video", audioRegistration.session().sessionId(),
                        "principal-video")).isEmpty();
            } finally {
                audioRuntime.close();
            }
        } finally {
            runtime.close();
        }
    }

    @Test
    void expiredCanonicalVideoLeaseCannotDispatchAFrame() throws Exception {
        var root = Files.createTempDirectory("media-canonical-video-stream-expired-");
        var provider = new VideoStreamingProvider();
        var streamStore = new LocalMediaRuntimeSupport.StreamStore();
        var runtime = runtime(root, provider, Duration.ofSeconds(2), streamStore);
        String connectionToken = "expired-video-connection-token";
        Instant now = Instant.now();
        Instant expiredAt = now.minusSeconds(1);
        String sessionId = "expired-video-session";
        var expiredSession = new com.ghatana.media.runtime.MediaRuntimeContracts.StreamSession(
                "tenant-video", sessionId, "principal-video", StreamKind.VIDEO,
                provider.providerId(), com.ghatana.media.runtime.MediaRuntimeContracts.StreamState.CONNECTED,
                -1, 0, 512, 1, expiredAt, now.minusSeconds(60), now.minusSeconds(2), null,
                Map.of("governance.purpose", "media.stream.video.capture"), 1);
        streamStore.create(expiredSession, tokenHash(connectionToken));

        try {
            var port = runtime.videoStreamFramePort(
                    "tenant-video", "principal-video", sessionId, connectionToken);
            assertThat(port.currentBinding("tenant-video", sessionId, "principal-video")).isEmpty();
            var staleBinding = new CanonicalVideoStreamFramePort.Binding(
                    sessionId, "tenant-video", "principal-video", "media.stream.video.capture",
                    1, 1, -1, expiredAt);

            assertThat(port.offer(staleBinding, frame(0)).disposition())
                    .isEqualTo(CanonicalVideoStreamFramePort.Disposition.LEASE_EXPIRED);
            assertThat(provider.calls()).isZero();
            assertThat(runtime.stream("tenant-video", "principal-video", sessionId).orElseThrow())
                    .satisfies(current -> {
                        assertThat(current.lastSequence()).isEqualTo(-1);
                        assertThat(current.inFlightSequence()).isNull();
                    });
        } finally {
            runtime.close();
        }
    }

    @Test
    void concurrentVideoSessionsKeepIndependentAckCursorsAt1_16And64Clients() throws Exception {
        var root = Files.createTempDirectory("media-canonical-video-stream-concurrent-");
        var provider = new VideoStreamingProvider();
        var runtime = runtime(root, provider, Duration.ofSeconds(2));
        var executor = Executors.newFixedThreadPool(64);

        try {
            for (int clientCount : List.of(1, 16, 64)) {
                var bindings = new ArrayList<CanonicalVideoStreamFramePort.Binding>(clientCount);
                var ports = new ArrayList<CanonicalVideoStreamFramePort>(clientCount);
                var streamIds = new ArrayList<String>(clientCount);
                for (int i = 0; i < clientCount; i++) {
                    var registration = runtime.openStream(request(
                            provider, StreamKind.VIDEO, "correlation-video-" + clientCount + "-" + i));
                    runtime.connectStream(
                            "tenant-video", registration.session().sessionId(), registration.connectionToken());
                    var port = runtime.videoStreamFramePort(
                            "tenant-video", "principal-video", registration.session().sessionId(),
                            registration.connectionToken());
                    ports.add(port);
                    streamIds.add(registration.session().sessionId());
                    bindings.add(port.currentBinding("tenant-video", registration.session().sessionId(),
                            "principal-video").orElseThrow());
                }

                int callsBefore = provider.calls();
                var results = new ArrayList<java.util.concurrent.Future<CanonicalVideoStreamFramePort.Result>>(
                        clientCount);
                for (int i = 0; i < clientCount; i++) {
                    final int client = i;
                    results.add(executor.submit(() -> ports.get(client).offer(bindings.get(client), frame(0))));
                }
                for (var result : results) {
                    assertThat(result.get(5, TimeUnit.SECONDS))
                            .isEqualTo(CanonicalVideoStreamFramePort.Result.acknowledged(0));
                }
                assertThat(provider.calls()).isEqualTo(callsBefore + clientCount);
                for (String streamId : streamIds) {
                    assertThat(runtime.stream("tenant-video", "principal-video", streamId).orElseThrow())
                            .satisfies(session -> {
                                assertThat(session.lastSequence()).isZero();
                                assertThat(session.inFlightSequence()).isNull();
                            });
                }
            }
        } finally {
            executor.shutdownNow();
            executor.awaitTermination(5, TimeUnit.SECONDS);
            runtime.close();
        }
    }

    @Test
    void canonicalEosUsesNextCursorAndFeedbackPreservesProviderBackpressure() throws Exception {
        var root = Files.createTempDirectory("media-canonical-video-stream-eos-");
        var provider = new VideoStreamingProvider(true);
        var runtime = runtime(root, provider, Duration.ofSeconds(2));

        try {
            var registration = runtime.openStream(request(provider, StreamKind.VIDEO));
            runtime.connectStream("tenant-video", registration.session().sessionId(), registration.connectionToken());
            var port = runtime.videoStreamFramePort(
                    "tenant-video", "principal-video", registration.session().sessionId(), registration.connectionToken());
            var binding = port.currentBinding(
                    "tenant-video", registration.session().sessionId(), "principal-video").orElseThrow();

            var frameFeedback = port.offerWithFeedback(binding, frame(0));

            assertThat(frameFeedback.result()).isEqualTo(CanonicalVideoStreamFramePort.Result.acknowledged(0));
            assertThat(frameFeedback.feedbackAvailable()).isTrue();
            assertThat(frameFeedback.bufferedBytes()).isEqualTo(32);
            assertThat(frameFeedback.backpressured()).isTrue();

            var eosBinding = port.currentBinding(
                    "tenant-video", registration.session().sessionId(), "principal-video").orElseThrow();
            var eosFeedback = port.endOfStreamWithFeedback(eosBinding);

            assertThat(eosFeedback.result()).isEqualTo(CanonicalVideoStreamFramePort.Result.acknowledged(1));
            assertThat(eosFeedback.feedbackAvailable()).isTrue();
            assertThat(eosFeedback.backpressured()).isTrue();
            var decodedEos = new VideoStreamSession().decodeFrame(provider.receivedWireFrame());
            assertThat(decodedEos.sequenceNumber()).isEqualTo(1);
            assertThat(decodedEos.payload()).isEmpty();
            assertThat(decodedEos.timestampMillis()).isZero();
            assertThat(provider.lastFrameWasEndOfStream()).isTrue();
            assertThat(runtime.stream("tenant-video", "principal-video", registration.session().sessionId())
                    .orElseThrow())
                    .satisfies(session -> {
                        assertThat(session.state()).isEqualTo(StreamState.DRAINING);
                        assertThat(session.finality()).isEqualTo(StreamFinality.NONE);
                        assertThat(session.lastSequence()).isEqualTo(1);
                        assertThat(session.inFlightSequence()).isNull();
                    });
            assertThat(port.currentBinding(
                    "tenant-video", registration.session().sessionId(), "principal-video")).isEmpty();
            assertThat(port.offer(eosBinding, frame(2)).disposition())
                    .isEqualTo(CanonicalVideoStreamFramePort.Disposition.NOT_ADMITTED);
            assertThat(provider.calls()).isEqualTo(2);
        } finally {
            runtime.close();
        }
    }

    private static VideoStreamSession.DecodedFrame frame(int sequence) {
        return new VideoStreamSession.DecodedFrame(sequence, sequence == 0, sequence * 33L,
                new byte[] {1, 2, 3, 4});
    }

    private static MediaRuntime runtime(java.nio.file.Path root, MediaStreamingProvider provider,
            Duration timeout) {
        return runtime(root, provider, timeout, new LocalMediaRuntimeSupport.StreamStore());
    }

    private static MediaRuntime runtime(java.nio.file.Path root, MediaStreamingProvider provider,
            Duration timeout, LocalMediaRuntimeSupport.StreamStore streamStore) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        timeout, 1, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                streamStore,
                null,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(provider));
    }

    private static StreamSessionRequest request(MediaStreamingProvider provider, StreamKind kind) {
        return request(provider, kind, "correlation-video");
    }

    private static StreamSessionRequest request(
            MediaStreamingProvider provider, StreamKind kind, String correlationId) {
        String purpose = "media.stream." + kind.name().toLowerCase(java.util.Locale.ROOT) + ".capture";
        return new StreamSessionRequest(
                "tenant-video", "principal-video", correlationId, kind,
                provider.providerId(), 512, Duration.ofSeconds(30), java.util.Map.of(),
                new MediaGovernanceContext("consent-video", purpose,
                        "local", Set.of("local"), false, false));
    }

    private static String tokenHash(String token) throws Exception {
        return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                .digest(token.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    private static class VideoStreamingProvider implements MediaStreamingProvider {
        private final AtomicInteger calls = new AtomicInteger();
        private final AtomicReference<byte[]> receivedWireFrame = new AtomicReference<>();
        private final AtomicReference<Boolean> lastEndOfStream = new AtomicReference<>(false);
        private final boolean backpressured;

        private VideoStreamingProvider() {
            this(false);
        }

        private VideoStreamingProvider(boolean backpressured) {
            this.backpressured = backpressured;
        }

        @Override public String providerId() { return "local-video-stream-provider"; }
        @Override public Set<StreamKind> capabilities() { return Set.of(StreamKind.VIDEO); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }

        @Override
        public CompletableFuture<StreamAck> accept(StreamContext context,
                com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame frame) {
            recordCall();
            byte[] payload = frame.payload();
            receivedWireFrame.set(payload);
            lastEndOfStream.set(frame.endOfStream());
            return CompletableFuture.completedFuture(
                    new StreamAck(frame.sequence(), backpressured ? 32 : payload.length, backpressured));
        }

        int calls() { return calls.get(); }
        byte[] receivedWireFrame() { return receivedWireFrame.get().clone(); }
        boolean lastFrameWasEndOfStream() { return lastEndOfStream.get(); }
        protected void recordCall() { calls.incrementAndGet(); }
    }

    private static final class BlockingVideoStreamingProvider extends VideoStreamingProvider {
        @Override public String providerId() { return "blocking-local-video-stream-provider"; }

        @Override
        public CompletableFuture<StreamAck> accept(StreamContext context,
                com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame frame) {
            // Preserve the base provider's counter while making its outcome ambiguous.
            recordCall();
            return new CompletableFuture<>();
        }
    }

    private static final class AudioStreamingProvider implements MediaStreamingProvider {
        @Override public String providerId() { return "local-audio-stream-provider"; }
        @Override public Set<StreamKind> capabilities() { return Set.of(StreamKind.AUDIO); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }
        @Override public CompletableFuture<StreamAck> accept(StreamContext context,
                com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame frame) {
            return CompletableFuture.completedFuture(new StreamAck(frame.sequence(), frame.payload().length, false));
        }
    }
}
