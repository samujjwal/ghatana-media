package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamAck;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSessionRequest;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Verifies timeout cancellation prevents late local stream acknowledgement and persistence. */
class MediaRuntimeStreamTimeoutTest {

    @Test
    void timeoutCancelsProviderWorkAndPreservesPersistedSequence() throws Exception {
        var root = Files.createTempDirectory("media-stream-timeout-");
        var provider = new BlockingStreamingProvider();
        var streamStore = new LocalMediaRuntimeSupport.StreamStore();
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
                streamStore,
                null,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(provider));

        try {
            var registration = runtime.openStream(new StreamSessionRequest(
                    "tenant-a",
                    "principal-a",
                    "correlation-a",
                    StreamKind.AUDIO,
                    provider.providerId(),
                    128,
                    Duration.ofSeconds(30),
                    java.util.Map.of()));
            var connected = runtime.connectStream(
                    "tenant-a",
                    registration.session().sessionId(),
                    registration.connectionToken());

            assertThatThrownBy(() -> runtime.acceptFrame(new StreamFrame(
                    "tenant-a",
                    connected.sessionId(),
                    registration.connectionToken(),
                    0,
                    "frame".getBytes(StandardCharsets.UTF_8),
                    false,
                    Instant.now())))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessage("Media stream frame processing timed out")
                    .hasRootCauseInstanceOf(TimeoutException.class);

            assertThat(provider.cancellation()).isNotNull();
            assertThat(provider.cancellation().cancelled()).isTrue();
            assertThat(provider.future().isCancelled()).isTrue();
            assertThat(provider.future().complete(new StreamAck(0, 5, false))).isFalse();

            var persisted = runtime.stream("tenant-a", connected.sessionId()).orElseThrow();
            assertThat(persisted.lastSequence()).isEqualTo(connected.lastSequence());
            assertThat(persisted.bufferedBytes()).isEqualTo(connected.bufferedBytes());
            assertThat(persisted.version()).isEqualTo(connected.version());
        } finally {
            runtime.close();
        }
    }

    private static final class BlockingStreamingProvider implements MediaStreamingProvider {
        private final CompletableFuture<StreamAck> future = new CompletableFuture<>();
        private final AtomicReference<Cancellation> cancellation = new AtomicReference<>();

        @Override public String providerId() { return "blocking-stream-provider"; }
        @Override public Set<StreamKind> capabilities() { return Set.of(StreamKind.AUDIO); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }

        @Override
        public CompletableFuture<StreamAck> accept(StreamContext context, StreamFrame frame) {
            cancellation.set(context.cancellation());
            return future;
        }

        Cancellation cancellation() { return cancellation.get(); }
        CompletableFuture<StreamAck> future() { return future; }
    }
}
