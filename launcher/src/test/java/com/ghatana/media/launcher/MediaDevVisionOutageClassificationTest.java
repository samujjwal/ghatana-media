package com.ghatana.media.launcher;

import com.ghatana.audio.video.vision.local.LocalVisionSidecarClient;
import com.ghatana.audio.video.vision.local.LocalVisionSidecarClient.SidecarRejectedException;
import com.ghatana.audio.video.vision.local.LocalVisionSidecarClient.SidecarUnavailableException;
import com.ghatana.audio.video.vision.local.LocalVisionSidecarClient.SidecarUnavailableException.Reach;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * How a lost vision sidecar call is classified (J-27): a refused connection is {@code NOT_REACHED} (nothing ran), a
 * response that never arrives is {@code TIMED_OUT}, a connection reset mid-call is {@code CONNECTION_LOST} (the model
 * may have run), and a sidecar 5xx (a model failure such as GPU memory exhaustion) is a provider outage rather than
 * an input refusal. The lane mapping is checked against the same classes the routes use.
 */
class MediaDevVisionOutageClassificationTest {
    private static final String TOKEN = "fixture-only-token-0123456789abcdef";
    private static final byte[] IMAGE = "FIXTURE_ONLY image bytes".getBytes(StandardCharsets.UTF_8);

    private static LocalVisionSidecarClient client(int port, Duration timeout) {
        return new LocalVisionSidecarClient(URI.create("http://127.0.0.1:" + port), TOKEN, timeout);
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) { return socket.getLocalPort(); }
    }

    @Test
    void aClosedPortIsNotReachedBecauseNothingRan() throws Exception {
        LocalVisionSidecarClient client = client(freePort(), Duration.ofSeconds(5));
        assertThatThrownBy(() -> client.analyze(IMAGE, List.of("detect"), 16))
                .isInstanceOfSatisfying(SidecarUnavailableException.class, e -> assertThat(e.reach()).isEqualTo(Reach.NOT_REACHED));
        assertThat(client.health(Duration.ofSeconds(2)).state()).isEqualTo(LocalVisionSidecarClient.Health.State.UNREACHABLE);
    }

    @Test
    void aSidecarThatAcceptsButNeverAnswersTimesOutAndIsNotUnknown() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            try { Thread.sleep(5_000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            exchange.close();
        });
        server.start();
        try {
            LocalVisionSidecarClient client = client(server.getAddress().getPort(), Duration.ofMillis(700));
            assertThatThrownBy(() -> client.analyze(IMAGE, List.of("detect"), 16))
                    .isInstanceOfSatisfying(SidecarUnavailableException.class, e -> assertThat(e.reach()).isEqualTo(Reach.TIMED_OUT));
            assertThat(client.health(Duration.ofMillis(500)).state()).isEqualTo(LocalVisionSidecarClient.Health.State.TIMED_OUT);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void aConnectionResetMidCallIsLostBecauseTheModelMayHaveRun() throws Exception {
        AtomicBoolean stop = new AtomicBoolean();
        try (ServerSocket server = new ServerSocket(0, 5, java.net.InetAddress.getLoopbackAddress())) {
            Thread acceptor = new Thread(() -> {
                while (!stop.get()) {
                    try (Socket socket = server.accept()) {
                        socket.getInputStream().readNBytes(64); // the request reached the sidecar
                        socket.setSoLinger(true, 0);            // then it dies: RST
                    } catch (IOException ignored) { }
                }
            }, "fixture-sidecar-acceptor");
            acceptor.setDaemon(true);
            acceptor.start();
            LocalVisionSidecarClient client = client(server.getLocalPort(), Duration.ofSeconds(5));
            assertThatThrownBy(() -> client.analyze(IMAGE, List.of("detect"), 16))
                    .isInstanceOfSatisfying(SidecarUnavailableException.class, e -> assertThat(e.reach()).isEqualTo(Reach.CONNECTION_LOST));
            stop.set(true);
        }
    }

    @Test
    void aSidecarModelFailureIsAProviderOutageAndAnInputRefusalIsNot() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicBoolean oom = new AtomicBoolean(true);
        server.createContext("/", exchange -> {
            exchange.getRequestBody().readAllBytes();
            byte[] body = (oom.get() ? "{\"error\":\"INFERENCE_FAILED\",\"type\":\"OutOfMemoryError\"}"
                    : "{\"error\":\"BAD_IMAGE\"}").getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(oom.get() ? 500 : 400, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            LocalVisionSidecarClient client = client(server.getAddress().getPort(), Duration.ofSeconds(5));
            assertThatThrownBy(() -> client.analyze(IMAGE, List.of("detect"), 16))
                    .isInstanceOfSatisfying(SidecarRejectedException.class, e -> {
                        assertThat(e.status()).isEqualTo(500);
                        assertThat(MediaDevVisionRuntime.providerFailure(e)).as("GPU OOM is an outage").isTrue();
                    });
            oom.set(false);
            assertThatThrownBy(() -> client.analyze(IMAGE, List.of("detect"), 16))
                    .isInstanceOfSatisfying(SidecarRejectedException.class,
                            e -> assertThat(MediaDevVisionRuntime.providerFailure(e)).as("bad input is not an outage").isFalse());
            assertThat(MediaDevVisionRuntime.providerFailure(new SidecarRejectedException(401, "UNAUTHORIZED"))).isTrue();
        } finally {
            server.stop(0);
        }
    }

    @Test
    void laneMappingNeverTurnsALostCallIntoSuccessOrOneOutcomeIntoAnother() {
        var notReached = new SidecarUnavailableException("x", null, Reach.NOT_REACHED);
        var timedOut = new SidecarUnavailableException("x", null, Reach.TIMED_OUT);
        var lost = new SidecarUnavailableException("x", null, Reach.CONNECTION_LOST);
        assertThat(MediaDevVisionRuntime.sidecarOutage(notReached, 0, 8))
                .isInstanceOf(MediaDevVisionRuntime.VisionUnavailableException.class);
        // Earlier frames already ran, so a refused connection part-way is UNKNOWN, not "nothing ran".
        assertThat(MediaDevVisionRuntime.sidecarOutage(notReached, 3, 8))
                .isInstanceOfSatisfying(MediaDevVisionTrackingRuntime.VisionOutcomeUnknownException.class, e -> {
                    assertThat(e.framesCompleted()).isEqualTo(3);
                    assertThat(e.framesPlanned()).isEqualTo(8);
                });
        assertThat(MediaDevVisionRuntime.sidecarOutage(timedOut, 0, 1)).isInstanceOf(MediaDevVisionRuntime.VisionTimeoutException.class);
        assertThat(MediaDevVisionRuntime.sidecarOutage(lost, 0, 1))
                .isInstanceOf(MediaDevVisionTrackingRuntime.VisionOutcomeUnknownException.class);
        assertThat(new SidecarUnavailableException("legacy", null).reach()).isEqualTo(Reach.CONNECTION_LOST);
    }

    @Test
    void outageCodesAreClassifiedOnceWithTheSharedVocabulary() {
        assertThat(MediaDevOutage.classify("SPEECH_RUNTIME_UNAVAILABLE")).get().extracting(c -> c.outcome().name()).isEqualTo("UNAVAILABLE");
        assertThat(MediaDevOutage.classify("RENDER_OUTCOME_UNKNOWN")).get().extracting(c -> c.lane().name()).isEqualTo("RENDER");
        assertThat(MediaDevOutage.classify("VISION_TIMEOUT")).get().extracting(c -> c.outcome().name()).isEqualTo("TIMEOUT");
        assertThat(MediaDevOutage.classify("GROUNDED_UNAVAILABLE")).isPresent();
        assertThat(MediaDevOutage.classify("VIDEO_OUTCOME_UNKNOWN")).get().extracting(c -> c.lane().name()).isEqualTo("VIDEO");
        assertThat(MediaDevOutage.classify("/dev/v1/speech/syntheses", "SPEECH_OUTCOME_UNKNOWN")).get()
                .extracting(c -> c.lane().name()).isEqualTo("SPEECH_SYNTHESIZE");
        assertThat(MediaDevOutage.classify("/dev/v1/speech/transcriptions", "SPEECH_TIMEOUT")).get()
                .extracting(c -> c.lane().name()).isEqualTo("SPEECH_TRANSCRIBE");
        assertThat(MediaDevOutage.classify("RIGHTS_DENIED")).isEmpty();
        assertThat(MediaDevOutage.classify("LOCAL_MODEL_NOT_ADMITTED")).as("not admitted is a refusal, not an outage").isEmpty();
        assertThat(MediaDevOutage.classify(null)).isEmpty();
        var enriched = MediaDevOutage.enrich(MediaDevOutage.classify("SPEECH_TIMEOUT").orElseThrow(), java.util.Map.of("lane", "x"));
        assertThat(enriched).containsEntry("outcome", "TIMEOUT").containsEntry("fallback", "NONE").containsEntry("lane", "x");
    }
}
