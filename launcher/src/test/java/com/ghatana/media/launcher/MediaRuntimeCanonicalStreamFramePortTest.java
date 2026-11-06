package com.ghatana.media.launcher;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.audio.streaming.AudioStreamSession;
import com.ghatana.audio.streaming.CanonicalStreamFramePort;
import com.ghatana.audio.streaming.StreamFrameReconciler;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamSessionStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamAck;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSessionRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

class MediaRuntimeCanonicalStreamFramePortTest {

    @Test
    void framePayloadReachesLocalProviderExactlyAndResistsCallerAndProviderMutation() throws Exception {
        var root = Files.createTempDirectory("media-canonical-audio-stream-payload-");
        var expectedPayload = new byte[] {
            0x00, 0x7f, (byte) 0x80, (byte) 0xff, 0x11, 0x22, 0x33, 0x44,
            0x55, 0x66, 0x77, (byte) 0x88, (byte) 0x99, (byte) 0xaa, (byte) 0xbb, (byte) 0xcc, 0x0d
        };
        var callerPayload = expectedPayload.clone();
        var decodedFrame = new AudioStreamSession.DecodedFrame(0, 12_345L, callerPayload);
        var provider = new MutatingStreamingProvider(expectedPayload);
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 1, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(provider));

        try {
            var registration = runtime.openStream(request(provider, "correlation-payload"));
            runtime.connectStream("tenant-a", registration.session().sessionId(), registration.connectionToken());
            var port = runtime.audioStreamFramePort(
                    "tenant-a", "principal-a", registration.session().sessionId(), registration.connectionToken());
            var binding = port.currentBinding(
                    "tenant-a", registration.session().sessionId(), "principal-a").orElseThrow();

            callerPayload[0] = 0x5a;
            var result = port.offer(binding, decodedFrame);

            assertThat(result).isEqualTo(CanonicalStreamFramePort.Result.acknowledged(0));
            assertThat(provider.calls()).isEqualTo(1);
            assertThat(provider.receivedPayload()).containsExactly(expectedPayload);
            assertThat(provider.payloadAfterMutationAttempt()).containsExactly(expectedPayload);
            assertThat(decodedFrame.payload()).containsExactly(expectedPayload);
            String scrape = runtime.prometheusMetrics();
            assertThat(scrape).contains(
                    "media_capture_frames_total{contract_version=\"v1\",kind=\"audio\",outcome=\"success\",service=\"launcher\"} 1.0");
            assertThat(scrape).doesNotContain("session_id", "source_id", "tenant_id", "provider_id");
        } finally {
            runtime.close();
        }
    }

    @Test
    void frameAckUsesCanonicalStoreAndRejectsStaleOrDuplicateBinding() throws Exception {
        var root = Files.createTempDirectory("media-canonical-audio-stream-");
        var provider = new LocalStreamingProvider();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 1, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(provider));

        try {
            var registration = runtime.openStream(request(provider, "correlation-a"));
            runtime.connectStream("tenant-a", registration.session().sessionId(), registration.connectionToken());
            var port = runtime.audioStreamFramePort(
                    "tenant-a", "principal-a", registration.session().sessionId(), registration.connectionToken());
            assertThat(port).isInstanceOf(CanonicalStreamFramePort.class);
            assertThat(runtime.audioStreamFramePort(
                    "tenant-a", "principal-a", registration.session().sessionId(), "wrong-token")
                    .currentBinding("tenant-a", registration.session().sessionId(), "principal-a"))
                    .isEmpty();

            var firstBinding = port.currentBinding(
                    "tenant-a", registration.session().sessionId(), "principal-a").orElseThrow();
            assertThat(firstBinding.purposeRef()).isEqualTo("media.stream.audio.capture");
            var identity = new StreamFrameReconciler.SessionIdentity(
                    firstBinding.streamId(), firstBinding.tenantId(), firstBinding.principalId(),
                    firstBinding.purposeRef(), firstBinding.sessionRevision());
            var reconciler = StreamFrameReconciler.open(identity);
            assertThat(reconciler.offer(frame(1))).isEqualTo(StreamFrameReconciler.Disposition.HELD);
            assertThat(provider.calls()).isZero();
            assertThat(reconciler.offer(frame(0))).isEqualTo(StreamFrameReconciler.Disposition.DELIVERED);
            assertThat(port.offer(firstBinding, frame(0)))
                    .isEqualTo(CanonicalStreamFramePort.Result.acknowledged(0));
            assertThat(reconciler.nextAck()).isZero();

            var released = reconciler.takeDelivered();
            assertThat(released.sequenceNumber()).isEqualTo(1);
            var secondBinding = port.currentBinding(
                    "tenant-a", registration.session().sessionId(), "principal-a").orElseThrow();
            assertThat(port.offer(secondBinding, released))
                    .isEqualTo(CanonicalStreamFramePort.Result.acknowledged(1));
            assertThat(runtime.stream("tenant-a", registration.session().sessionId()).orElseThrow()
                    .lastSequence()).isEqualTo(1);

            assertThat(port.offer(firstBinding, frame(2)).disposition())
                    .isEqualTo(CanonicalStreamFramePort.Disposition.NOT_ADMITTED);
            assertThat(provider.calls()).isEqualTo(2);

            var duplicateBinding = port.currentBinding(
                    "tenant-a", registration.session().sessionId(), "principal-a").orElseThrow();
            assertThat(port.offer(duplicateBinding, frame(1)).disposition())
                    .isEqualTo(CanonicalStreamFramePort.Disposition.NOT_ADMITTED);
            assertThat(provider.calls()).isEqualTo(2);

            runtime.connectStream("tenant-a", registration.session().sessionId(), registration.connectionToken());
            assertThat(port.offer(duplicateBinding, frame(2)).disposition())
                    .isEqualTo(CanonicalStreamFramePort.Disposition.NOT_ADMITTED);
            assertThat(provider.calls()).isEqualTo(2);
        } finally {
            runtime.close();
        }
    }

    @Test
    void frameAckRequiresExactCanonicalStoreReadbackAndCannotBeRetriedBlindly() throws Exception {
        var root = Files.createTempDirectory("media-canonical-audio-stream-readback-");
        var provider = new LocalStreamingProvider();
        var backingStore = new LocalMediaRuntimeSupport.StreamStore();
        var hideCommittedReadback = new AtomicBoolean();
        MediaStreamSessionStore streamStore = (MediaStreamSessionStore) Proxy.newProxyInstance(
                MediaStreamSessionStore.class.getClassLoader(),
                new Class<?>[] {MediaStreamSessionStore.class},
                (proxy, method, arguments) -> {
                    if (method.getName().equals("find") && hideCommittedReadback.get()) {
                        return java.util.Optional.empty();
                    }
                    try {
                        Object result = method.invoke(backingStore, arguments);
                        if (method.getName().equals("recordFrame")) hideCommittedReadback.set(true);
                        return result;
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 1, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                streamStore,
                null,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(provider));

        try {
            var registration = runtime.openStream(request(provider, "correlation-readback"));
            runtime.connectStream("tenant-a", registration.session().sessionId(), registration.connectionToken());
            var port = runtime.audioStreamFramePort(
                    "tenant-a", "principal-a", registration.session().sessionId(), registration.connectionToken());
            var binding = port.currentBinding(
                    "tenant-a", registration.session().sessionId(), "principal-a").orElseThrow();

            assertThat(port.offer(binding, frame(0)).disposition())
                    .isEqualTo(CanonicalStreamFramePort.Disposition.OUTCOME_UNKNOWN);
            assertThat(port.offer(binding, frame(0)).disposition())
                    .isEqualTo(CanonicalStreamFramePort.Disposition.NOT_ADMITTED);
            assertThat(provider.calls()).isEqualTo(1);
        } finally {
            runtime.close();
        }
    }

    @Test
    void concurrentAudioSessionsKeepIndependentAckCursorsAt1_16And64Clients() throws Exception {
        var root = Files.createTempDirectory("media-canonical-audio-stream-concurrent-");
        var provider = new LocalStreamingProvider();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 1, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(provider));
        var executor = Executors.newFixedThreadPool(64);

        try {
            for (int clientCount : List.of(1, 16, 64)) {
                var bindings = new ArrayList<CanonicalStreamFramePort.Binding>(clientCount);
                var ports = new ArrayList<CanonicalStreamFramePort>(clientCount);
                var streamIds = new ArrayList<String>(clientCount);
                for (int i = 0; i < clientCount; i++) {
                    var registration = runtime.openStream(request(
                            provider, "correlation-audio-" + clientCount + "-" + i));
                    runtime.connectStream(
                            "tenant-a", registration.session().sessionId(), registration.connectionToken());
                    var port = runtime.audioStreamFramePort(
                            "tenant-a", "principal-a", registration.session().sessionId(),
                            registration.connectionToken());
                    ports.add(port);
                    streamIds.add(registration.session().sessionId());
                    bindings.add(port.currentBinding("tenant-a", registration.session().sessionId(),
                            "principal-a").orElseThrow());
                }

                int callsBefore = provider.calls();
                var results = new ArrayList<java.util.concurrent.Future<CanonicalStreamFramePort.Result>>(
                        clientCount);
                for (int i = 0; i < clientCount; i++) {
                    final int client = i;
                    results.add(executor.submit(() -> ports.get(client).offer(bindings.get(client), frame(0))));
                }
                for (var result : results) {
                    assertThat(result.get(5, TimeUnit.SECONDS))
                            .isEqualTo(CanonicalStreamFramePort.Result.acknowledged(0));
                }
                assertThat(provider.calls()).isEqualTo(callsBefore + clientCount);
                for (String streamId : streamIds) {
                    assertThat(runtime.stream("tenant-a", streamId).orElseThrow())
                            .satisfies(session -> {
                                assertThat(session.lastSequence()).isZero();
                                assertThat(session.inFlightSequence()).isNull();
                                assertThat(session.finality()).isEqualTo(StreamFinality.NONE);
                            });
                }
            }
        } finally {
            executor.shutdownNow();
            runtime.close();
        }
    }

    @Test
    void unresolvedProviderOutcomeNeverBecomesAckOrReplay() throws Exception {
        var root = Files.createTempDirectory("media-canonical-audio-stream-unknown-");
        var provider = new BlockingStreamingProvider();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofMillis(50), 1, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(provider));

        try {
            var registration = runtime.openStream(request(provider, "correlation-a"));
            runtime.connectStream("tenant-a", registration.session().sessionId(), registration.connectionToken());
            var port = runtime.audioStreamFramePort(
                    "tenant-a", "principal-a", registration.session().sessionId(), registration.connectionToken());
            var binding = port.currentBinding(
                    "tenant-a", registration.session().sessionId(), "principal-a").orElseThrow();

            assertThat(port.offer(binding, frame(0)).disposition())
                    .isEqualTo(CanonicalStreamFramePort.Disposition.OUTCOME_UNKNOWN);
            assertThat(port.offer(binding, frame(0)).disposition())
                    .isEqualTo(CanonicalStreamFramePort.Disposition.OUTCOME_UNKNOWN);
            assertThat(provider.calls()).isEqualTo(1);
            assertThat(runtime.prometheusMetrics())
                    .contains("media_capture_frames_total{contract_version=\"v1\",kind=\"audio\",outcome=\"unknown\",service=\"launcher\"}");
        } finally {
            runtime.close();
        }
    }

    @Test
    void canonicalAudioEosUsesNextCursorAndPreservesBackpressureFeedback() throws Exception {
        var root = Files.createTempDirectory("media-canonical-audio-stream-eos-");
        var provider = new FeedbackStreamingProvider();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 1, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(provider));

        try {
            var registration = runtime.openStream(request(provider, "correlation-audio-eos"));
            runtime.connectStream("tenant-a", registration.session().sessionId(), registration.connectionToken());
            var port = runtime.audioStreamFramePort(
                    "tenant-a", "principal-a", registration.session().sessionId(), registration.connectionToken());
            var binding = port.currentBinding(
                    "tenant-a", registration.session().sessionId(), "principal-a").orElseThrow();

            var frameFeedback = port.offerWithFeedback(binding, frame(0));

            assertThat(frameFeedback.result()).isEqualTo(CanonicalStreamFramePort.Result.acknowledged(0));
            assertThat(frameFeedback.feedbackAvailable()).isTrue();
            assertThat(frameFeedback.bufferedBytes()).isEqualTo(48);
            assertThat(frameFeedback.backpressured()).isTrue();

            var eosBinding = port.currentBinding(
                    "tenant-a", registration.session().sessionId(), "principal-a").orElseThrow();
            var eosFeedback = port.endOfStreamWithFeedback(eosBinding);

            assertThat(eosFeedback.result()).isEqualTo(CanonicalStreamFramePort.Result.acknowledged(1));
            assertThat(eosFeedback.feedbackAvailable()).isTrue();
            assertThat(eosFeedback.backpressured()).isTrue();
            assertThat(provider.lastFrameWasEndOfStream()).isTrue();
            assertThat(runtime.stream("tenant-a", registration.session().sessionId()).orElseThrow())
                    .satisfies(session -> {
                        assertThat(session.state()).isEqualTo(StreamState.DRAINING);
                        assertThat(session.finality()).isEqualTo(StreamFinality.NONE);
                        assertThat(session.lastSequence()).isEqualTo(1);
                        assertThat(session.inFlightSequence()).isNull();
                    });
            assertThat(port.currentBinding(
                    "tenant-a", registration.session().sessionId(), "principal-a")).isEmpty();
            assertThat(provider.calls()).isEqualTo(2);
        } finally {
            runtime.close();
        }
    }

    @Test
    void placeholderPurposeDoesNotProduceAFrameBinding() throws Exception {
        var root = Files.createTempDirectory("media-canonical-audio-stream-purpose-");
        var provider = new LocalStreamingProvider();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 1, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(provider));
        try {
            var registration = runtime.openStream(new StreamSessionRequest(
                    "tenant-a", "principal-a", "correlation-a", StreamKind.AUDIO,
                    provider.providerId(), 128, Duration.ofSeconds(30), java.util.Map.of()));
            runtime.connectStream("tenant-a", registration.session().sessionId(), registration.connectionToken());
            var port = runtime.audioStreamFramePort(
                    "tenant-a", "principal-a", registration.session().sessionId(), registration.connectionToken());

            assertThat(port.currentBinding(
                    "tenant-a", registration.session().sessionId(), "principal-a"))
                    .isEmpty();
        } finally {
            runtime.close();
        }
    }

    @Test
    void audioPortRejectsCanonicalVideoSessionKind() throws Exception {
        var root = Files.createTempDirectory("media-canonical-audio-stream-kind-");
        var provider = new VideoOnlyStreamingProvider();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 1, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(provider));
        try {
            var registration = runtime.openStream(new StreamSessionRequest(
                    "tenant-a", "principal-a", "correlation-video", StreamKind.VIDEO,
                    provider.providerId(), 128, Duration.ofSeconds(30), java.util.Map.of(),
                    new MediaGovernanceContext(
                            "consent-a", "media.stream.video.capture", "local", Set.of("local"), false, false)));
            runtime.connectStream("tenant-a", registration.session().sessionId(), registration.connectionToken());
            var port = runtime.audioStreamFramePort(
                    "tenant-a", "principal-a", registration.session().sessionId(), registration.connectionToken());
            var session = runtime.stream("tenant-a", "principal-a", registration.session().sessionId())
                    .orElseThrow();
            var forgedAudioBinding = new CanonicalStreamFramePort.Binding(
                    session.sessionId(), session.tenantId(), session.principalId(),
                    "media.stream.video.capture", session.reconnectCount(), session.version(),
                    session.lastSequence(), session.leaseExpiresAt());

            assertThat(port.currentBinding("tenant-a", session.sessionId(), "principal-a")).isEmpty();
            assertThat(port.offer(forgedAudioBinding, frame(0)).disposition())
                    .isEqualTo(CanonicalStreamFramePort.Disposition.NOT_ADMITTED);
            assertThat(provider.calls()).isZero();
        } finally {
            runtime.close();
        }
    }

    private static AudioStreamSession.DecodedFrame frame(int sequence) {
        return new AudioStreamSession.DecodedFrame(sequence, sequence * 20L, new byte[] {1, 2, 3});
    }

    private static StreamSessionRequest request(MediaStreamingProvider provider, String correlationId) {
        return new StreamSessionRequest(
                "tenant-a", "principal-a", correlationId, StreamKind.AUDIO,
                provider.providerId(), 128, Duration.ofSeconds(30), java.util.Map.of(),
                new MediaGovernanceContext(
                        "consent-a", "media.stream.audio.capture", "local", Set.of("local"), false, false));
    }

    private static final class LocalStreamingProvider implements MediaStreamingProvider {
        private final AtomicInteger calls = new AtomicInteger();

        @Override public String providerId() { return "local-audio-stream-provider"; }
        @Override public Set<StreamKind> capabilities() { return Set.of(StreamKind.AUDIO); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }

        @Override
        public CompletableFuture<StreamAck> accept(StreamContext context,
                com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame frame) {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(new StreamAck(frame.sequence(), frame.payload().length, false));
        }

        int calls() { return calls.get(); }
    }

    private static final class BlockingStreamingProvider implements MediaStreamingProvider {
        private final AtomicInteger calls = new AtomicInteger();

        @Override public String providerId() { return "blocking-local-audio-stream-provider"; }
        @Override public Set<StreamKind> capabilities() { return Set.of(StreamKind.AUDIO); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }

        @Override
        public CompletableFuture<StreamAck> accept(StreamContext context,
                com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame frame) {
            calls.incrementAndGet();
            return new CompletableFuture<>();
        }

        int calls() { return calls.get(); }
    }

    private static final class FeedbackStreamingProvider implements MediaStreamingProvider {
        private final AtomicInteger calls = new AtomicInteger();
        private final AtomicReference<Boolean> lastEndOfStream = new AtomicReference<>(false);

        @Override public String providerId() { return "feedback-local-audio-stream-provider"; }
        @Override public Set<StreamKind> capabilities() { return Set.of(StreamKind.AUDIO); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }

        @Override
        public CompletableFuture<StreamAck> accept(StreamContext context,
                com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame frame) {
            calls.incrementAndGet();
            lastEndOfStream.set(frame.endOfStream());
            return CompletableFuture.completedFuture(
                    new StreamAck(frame.sequence(), frame.endOfStream() ? 0 : 48, true));
        }

        int calls() { return calls.get(); }
        boolean lastFrameWasEndOfStream() { return lastEndOfStream.get(); }
    }

    private static final class MutatingStreamingProvider implements MediaStreamingProvider {
        private final byte[] expectedPayload;
        private final AtomicInteger calls = new AtomicInteger();
        private final AtomicReference<byte[]> receivedPayload = new AtomicReference<>();
        private final AtomicReference<byte[]> payloadAfterMutationAttempt = new AtomicReference<>();

        private MutatingStreamingProvider(byte[] expectedPayload) {
            this.expectedPayload = expectedPayload.clone();
        }

        @Override public String providerId() { return "mutating-local-audio-stream-provider"; }
        @Override public Set<StreamKind> capabilities() { return Set.of(StreamKind.AUDIO); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }

        @Override
        public CompletableFuture<StreamAck> accept(StreamContext context,
                com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame frame) {
            calls.incrementAndGet();
            byte[] providerView = frame.payload();
            receivedPayload.set(providerView.clone());
            providerView[0] ^= (byte) 0xff;
            byte[] afterMutationAttempt = frame.payload();
            payloadAfterMutationAttempt.set(afterMutationAttempt.clone());
            if (!java.util.Arrays.equals(expectedPayload, afterMutationAttempt)) {
                return CompletableFuture.failedFuture(
                        new AssertionError("provider mutation changed the original stream frame payload"));
            }
            return CompletableFuture.completedFuture(
                    new StreamAck(frame.sequence(), afterMutationAttempt.length, false));
        }

        int calls() { return calls.get(); }
        byte[] receivedPayload() { return receivedPayload.get().clone(); }
        byte[] payloadAfterMutationAttempt() { return payloadAfterMutationAttempt.get().clone(); }
    }

    private static final class VideoOnlyStreamingProvider implements MediaStreamingProvider {
        private final AtomicInteger calls = new AtomicInteger();

        @Override public String providerId() { return "local-video-only-stream-provider"; }
        @Override public Set<StreamKind> capabilities() { return Set.of(StreamKind.VIDEO); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }

        @Override
        public CompletableFuture<StreamAck> accept(StreamContext context,
                com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame frame) {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(new StreamAck(frame.sequence(), frame.payload().length, false));
        }

        int calls() { return calls.get(); }
    }
}
