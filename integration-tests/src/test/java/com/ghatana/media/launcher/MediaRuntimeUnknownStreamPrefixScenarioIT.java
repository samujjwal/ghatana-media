package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamAck;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSessionRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Source-free J-29 recovery regression: an ambiguous later frame preserves the
 * acknowledged prefix and fences retries of the unknown frame.
 */
@Tag("integration")
class MediaRuntimeUnknownStreamPrefixScenarioIT {

    @Test
    void ambiguousFrameAfterAcknowledgedPrefixDoesNotAdvanceCursorOrRepeatProviderEffect() throws Exception {
        var root = Files.createTempDirectory("media-j29-unknown-prefix-");
        var provider = new PrefixThenUnknownStreamingProvider();
        var streamStore = new LocalMediaRuntimeSupport.StreamStore();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofMillis(75), 1, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                streamStore,
                null,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(provider));

        try {
            var registration = runtime.openStream(new StreamSessionRequest(
                    "tenant-j29", "principal-j29", "correlation-j29", StreamKind.AUDIO,
                    provider.providerId(), 128, Duration.ofSeconds(30), Map.of()));
            var connected = runtime.connectStream(
                    "tenant-j29", registration.session().sessionId(), registration.connectionToken());

            var firstAck = runtime.acceptFrame(new StreamFrame(
                    "tenant-j29", connected.sessionId(), registration.connectionToken(), 0,
                    "frame-zero".getBytes(StandardCharsets.UTF_8), false, Instant.now()));
            assertThat(firstAck.acceptedSequence()).isZero();

            assertThatThrownBy(() -> runtime.acceptFrame(new StreamFrame(
                    "tenant-j29", connected.sessionId(), registration.connectionToken(), 1,
                    "frame-one-ambiguous".getBytes(StandardCharsets.UTF_8), false, Instant.now())))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessage("Media stream frame processing timed out")
                    .hasRootCauseInstanceOf(TimeoutException.class);

            var afterUnknown = runtime.stream("tenant-j29", connected.sessionId()).orElseThrow();
            assertThat(afterUnknown.lastSequence())
                    .as("the durable acknowledged prefix remains frame zero")
                    .isZero();
            assertThat(afterUnknown.state()).isEqualTo(StreamState.FAILED);
            assertThat(afterUnknown.finality()).isEqualTo(StreamFinality.UNKNOWN);
            assertThat(afterUnknown.inFlightSequence()).isEqualTo(1);
            assertThat(provider.cancellation()).isNotNull();
            assertThat(provider.cancellation().cancelled()).isTrue();
            assertThat(provider.calls()).isEqualTo(2);

            assertThatThrownBy(() -> runtime.acceptFrame(new StreamFrame(
                    "tenant-j29", connected.sessionId(), registration.connectionToken(), 1,
                    "frame-one-ambiguous".getBytes(StandardCharsets.UTF_8), false, Instant.now())))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessage("Media stream is not connected");
            assertThat(provider.calls()).isEqualTo(2);
            assertThat(runtime.stream("tenant-j29", connected.sessionId()).orElseThrow().lastSequence())
                    .isZero();
        } finally {
            runtime.close();
        }
    }

    private static final class PrefixThenUnknownStreamingProvider implements MediaStreamingProvider {
        private final AtomicInteger calls = new AtomicInteger();
        private final AtomicReference<Cancellation> cancellation = new AtomicReference<>();

        @Override public String providerId() { return "j29-prefix-unknown-provider"; }
        @Override public Set<StreamKind> capabilities() { return Set.of(StreamKind.AUDIO); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }

        @Override
        public CompletableFuture<StreamAck> accept(StreamContext context, StreamFrame frame) {
            cancellation.set(context.cancellation());
            if (calls.incrementAndGet() == 1) {
                return CompletableFuture.completedFuture(
                        new StreamAck(frame.sequence(), frame.payload().length, false));
            }
            // Simulate a transport loss after dispatch: cancellation cannot prove
            // that the provider did not effect frame one.
            return new CompletableFuture<>();
        }

        int calls() { return calls.get(); }
        Cancellation cancellation() { return cancellation.get(); }
    }
}
