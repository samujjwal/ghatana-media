package com.ghatana.media.launcher;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.audio.streaming.AudioStreamSession;
import com.ghatana.audio.streaming.CanonicalStreamFramePort;
import com.ghatana.audio.streaming.StreamFrameReconciler;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamAck;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSessionRequest;
import java.nio.file.Files;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
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
}
