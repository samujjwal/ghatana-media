package com.ghatana.media.launcher;

import com.ghatana.audio.streaming.AudioStreamSession;
import com.ghatana.audio.streaming.CanonicalStreamFramePort;
import com.ghatana.media.provider.aws.PostgresqlMediaStreamSessionStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamAck;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSessionRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Separate JVM seed and recovery phases for canonical PostgreSQL audio stream state. */
public final class MediaRuntimePostgresqlAudioStreamRestartWorker {
    private static final String PRINCIPAL_ID = "principal-audio-restart";
    private static final String PROVIDER_ID = "fixture-audio-streaming-provider";
    private static final String PURPOSE = "media.stream.audio.capture";

    private record RuntimeFixture(MediaRuntime runtime, CountingLocalStreamingProvider provider) { }

    private MediaRuntimePostgresqlAudioStreamRestartWorker() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 4) throw new IllegalArgumentException("mode, binding file, marker, tenant required");
        String mode = args[0];
        Path bindingFile = Path.of(args[1]);
        Path marker = Path.of(args[2]);
        String tenantId = args[3];
        switch (mode) {
            case "seed" -> seedAndWait(bindingFile, marker, tenantId);
            case "recover" -> recover(bindingFile, marker, tenantId);
            default -> throw new IllegalArgumentException("unsupported audio restart mode: " + mode);
        }
    }

    private static void seedAndWait(Path bindingFile, Path marker, String tenantId) throws Exception {
        Path root = marker.getParent().resolve("media-audio-runtime-root");
        Files.createDirectories(root);
        RuntimeFixture fixture = newRuntime(root);
        MediaRuntime runtime = fixture.runtime();
        try {
            var registration = runtime.openStream(new StreamSessionRequest(
                    tenantId, PRINCIPAL_ID, "audio-restart-correlation", StreamKind.AUDIO,
                    PROVIDER_ID, 128, Duration.ofMinutes(5), Map.of(), governance()));
            runtime.connectStream(tenantId, registration.session().sessionId(), registration.connectionToken());
            CanonicalStreamFramePort port = runtime.audioStreamFramePort(
                    tenantId, PRINCIPAL_ID, registration.session().sessionId(), registration.connectionToken());
            CanonicalStreamFramePort.Binding binding = port.currentBinding(
                    tenantId, registration.session().sessionId(), PRINCIPAL_ID).orElseThrow();
            require(binding.lastAcknowledgedSequence() == -1, "new audio session must start before frame zero");
            require(port.offer(binding, frame(0)).equals(CanonicalStreamFramePort.Result.acknowledged(0)),
                    "seed frame zero must be acknowledged by the canonical store");
            require(runtime.stream(tenantId, binding.streamId()).orElseThrow().lastSequence() == 0,
                    "frame zero cursor must be durable before process termination");

            Properties properties = new Properties();
            properties.setProperty("tenantId", binding.tenantId());
            properties.setProperty("principalId", binding.principalId());
            properties.setProperty("streamId", binding.streamId());
            properties.setProperty("purposeRef", binding.purposeRef());
            properties.setProperty("sessionRevision", Long.toString(binding.sessionRevision()));
            properties.setProperty("storeVersion", Long.toString(binding.storeVersion()));
            properties.setProperty("lastAcknowledgedSequence", Long.toString(binding.lastAcknowledgedSequence()));
            properties.setProperty("leaseExpiresAt", binding.leaseExpiresAt().toString());
            properties.setProperty("connectionToken", registration.connectionToken());
            try (var output = Files.newOutputStream(bindingFile)) {
                properties.store(output, "synthetic caller-held token and pre-ACK binding for restart test");
            }
            write(marker, "FRAME_ZERO_ACKNOWLEDGED");
            // The parent terminates this process after the durable ACK marker appears.
            while (true) Thread.sleep(60_000);
        } finally {
            runtime.close();
        }
    }

    private static void recover(Path bindingFile, Path marker, String tenantId) throws Exception {
        Properties properties = new Properties();
        try (var input = Files.newInputStream(bindingFile)) {
            properties.load(input);
        }
        CanonicalStreamFramePort.Binding preRestartBinding = new CanonicalStreamFramePort.Binding(
                properties.getProperty("streamId"), properties.getProperty("tenantId"),
                properties.getProperty("principalId"), properties.getProperty("purposeRef"),
                Long.parseLong(properties.getProperty("sessionRevision")),
                Long.parseLong(properties.getProperty("storeVersion")),
                Long.parseLong(properties.getProperty("lastAcknowledgedSequence")),
                Instant.parse(properties.getProperty("leaseExpiresAt")));
        String token = properties.getProperty("connectionToken");
        Path root = marker.getParent().resolve("media-audio-runtime-root");
        RuntimeFixture fixture = newRuntime(root);
        MediaRuntime runtime = fixture.runtime();
        try {
            runtime.connectStream(tenantId, preRestartBinding.streamId(), token);
            CanonicalStreamFramePort port = runtime.audioStreamFramePort(
                    tenantId, PRINCIPAL_ID, preRestartBinding.streamId(), token);
            CanonicalStreamFramePort.Binding resumed = port.currentBinding(
                    tenantId, preRestartBinding.streamId(), PRINCIPAL_ID).orElseThrow();

            require(resumed.streamId().equals(preRestartBinding.streamId()), "stream identity changed on restart");
            require(resumed.tenantId().equals(preRestartBinding.tenantId()), "tenant binding changed on restart");
            require(resumed.principalId().equals(preRestartBinding.principalId()), "principal changed on restart");
            require(resumed.purposeRef().equals(PURPOSE), "source-defined stream purpose changed on restart");
            require(resumed.sessionRevision() == preRestartBinding.sessionRevision() + 1,
                    "reconnect generation must advance after restart");
            require(resumed.lastAcknowledgedSequence() == 0,
                    "frame zero ACK cursor must be restored from PostgreSQL");

            // Old generation and duplicate sequence are refused before any provider invocation.
            require(port.offer(preRestartBinding, frame(1)).disposition()
                            == CanonicalStreamFramePort.Disposition.NOT_ADMITTED,
                    "pre-restart binding must not submit into the new connection generation");
            require(port.offer(resumed, frame(0)).disposition()
                            == CanonicalStreamFramePort.Disposition.NOT_ADMITTED,
                    "durably acknowledged frame zero must not be replayed");
            require(fixture.provider().calls() == 0,
                    "stale and duplicate frames must not invoke the provider");

            require(port.offer(resumed, frame(1)).equals(CanonicalStreamFramePort.Result.acknowledged(1)),
                    "frame one must be the next accepted sequence after restart");
            require(fixture.provider().calls() == 1, "only the new frame may invoke the provider");
            var durable = runtime.stream(tenantId, resumed.streamId()).orElseThrow();
            require(durable.lastSequence() == 1, "next frame ACK must be durable after process restart");
            require(durable.reconnectCount() == 2, "durable reconnect generation must be two");
            write(marker, "DURABLE_CURSOR_AND_REPLAY_FENCE_VERIFIED");
        } finally {
            runtime.close();
        }
    }

    private static RuntimeFixture newRuntime(Path root) {
        CountingLocalStreamingProvider provider = new CountingLocalStreamingProvider();
        MediaRuntime runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "test", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(5), 1, "", "", false, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new PostgresqlMediaStreamSessionStore(),
                null,
                List.of(),
                List.of(provider));
        return new RuntimeFixture(runtime, provider);
    }

    private static MediaGovernanceContext governance() {
        return new MediaGovernanceContext("synthetic-local-consent", PURPOSE, "local", Set.of("local"),
                false, false);
    }

    private static AudioStreamSession.DecodedFrame frame(int sequence) {
        return new AudioStreamSession.DecodedFrame(sequence, sequence * 20L, new byte[] {1, 2, 3});
    }

    private static void write(Path marker, String value) throws Exception {
        Files.writeString(marker, value, StandardCharsets.UTF_8);
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static final class CountingLocalStreamingProvider implements MediaStreamingProvider {
        private final AtomicInteger calls = new AtomicInteger();

        @Override public String providerId() { return PROVIDER_ID; }
        @Override public Set<StreamKind> capabilities() { return Set.of(StreamKind.AUDIO); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }

        @Override
        public CompletableFuture<StreamAck> accept(StreamContext context, StreamFrame frame) {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(new StreamAck(frame.sequence(), frame.payload().length, false));
        }

        int calls() { return calls.get(); }
    }
}
