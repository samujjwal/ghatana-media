package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk;
import com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity;
import com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation;
import com.ghatana.media.runtime.MediaRuntimeContracts.ConsentDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Proves provider-session close fencing for external Media streaming. */
class HttpMediaStreamingCloseFenceTest {
    private HttpServer server;
    private ExecutorService executor;

    @AfterEach
    void stopServer() {
        if (server != null) server.stop(0);
        if (executor != null) executor.shutdownNow();
    }

    @Test
    void closeThatWinsRejectsLaterFrameEvenFromStaleContext() throws Exception {
        AtomicInteger frameCalls = new AtomicInteger();
        AtomicInteger closeCalls = new AtomicInteger();
        startServer(frameCalls, closeCalls, null, null);
        HttpMediaStreamingProvider provider = provider();

        provider.closeSession(context("session-a", new Cancellation()));

        assertThatThrownBy(() -> provider.accept(
                        context("session-a", new Cancellation()), frame("session-a", 0)).join())
                .satisfies(failure -> assertThat(root(failure))
                        .isInstanceOf(CancellationException.class));
        assertThat(frameCalls).hasValue(0);
        assertThat(closeCalls).hasValue(1);
    }

    @Test
    void closeCancelsFrameThatWasAlreadyDispatched() throws Exception {
        AtomicInteger frameCalls = new AtomicInteger();
        AtomicInteger closeCalls = new AtomicInteger();
        CountDownLatch frameStarted = new CountDownLatch(1);
        CountDownLatch releaseFrame = new CountDownLatch(1);
        startServer(frameCalls, closeCalls, frameStarted, releaseFrame);
        HttpMediaStreamingProvider provider = provider();
        StreamContext context = context("session-b", new Cancellation());

        var future = provider.accept(context, frame("session-b", 0));
        assertThat(frameStarted.await(2, TimeUnit.SECONDS)).isTrue();

        provider.closeSession(context);
        releaseFrame.countDown();

        assertThatThrownBy(future::join)
                .satisfies(failure -> assertThat(root(failure))
                        .isInstanceOf(CancellationException.class));
        assertThat(frameCalls).hasValue(1);
        assertThat(closeCalls).hasValue(1);
    }

    private HttpMediaStreamingProvider provider() {
        return new HttpMediaStreamingProvider(Map.of(
                "MEDIA_HTTP_PROVIDER_ENDPOINT", endpoint(),
                "MEDIA_HTTP_PROVIDER_REGION", "us-west-2",
                "MEDIA_HTTP_PROVIDER_DATA_RETENTION", "NONE",
                "MEDIA_HTTP_PROVIDER_TIMEOUT_MS", "2000",
                "MEDIA_HTTP_PROVIDER_MAX_RESPONSE_BYTES", "4096"));
    }

    private StreamContext context(String sessionId, Cancellation cancellation) {
        Instant now = Instant.now();
        MediaGovernanceContext governance = new MediaGovernanceContext(
                "consent-a",
                "streaming",
                DataClassification.CONFIDENTIAL,
                "us",
                Set.of("us-west-2"),
                true,
                "delete-after-stream",
                false,
                false,
                "",
                BiometricSensitivity.NONE,
                AutomationRisk.ASSISTIVE);
        StreamSession session = new StreamSession(
                "tenant-a",
                sessionId,
                "principal-a",
                StreamKind.VIDEO,
                "http-media-streaming",
                StreamState.CONNECTED,
                -1,
                0,
                1024,
                0,
                now.plusSeconds(30),
                now,
                now,
                null,
                Map.of(),
                1);
        ConsentDecision consent = new ConsentDecision(
                true,
                "consent-authority",
                "consent-a",
                now,
                now.plusSeconds(3600),
                Set.of("streaming"),
                Set.of("us-west-2"),
                true,
                false);
        return new StreamContext(session, cancellation, consent, governance);
    }

    private StreamFrame frame(String sessionId, long sequence) {
        return new StreamFrame(
                "tenant-a",
                sessionId,
                "connection-token",
                sequence,
                new byte[] {1, 2, 3},
                false,
                Instant.now());
    }

    private void startServer(
            AtomicInteger frameCalls,
            AtomicInteger closeCalls,
            CountDownLatch frameStarted,
            CountDownLatch releaseFrame) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        executor = Executors.newCachedThreadPool();
        server.setExecutor(executor);
        server.createContext("/v1/streams/session-a/frames/0", exchange -> {
            frameCalls.incrementAndGet();
            respond(exchange, 200, "{\"acceptedSequence\":0,\"bufferedBytes\":3,\"backpressured\":false}");
        });
        server.createContext("/v1/streams/session-a/close", exchange -> {
            closeCalls.incrementAndGet();
            respond(exchange, 204, "");
        });
        server.createContext("/v1/streams/session-b/frames/0", exchange -> {
            frameCalls.incrementAndGet();
            if (frameStarted != null) frameStarted.countDown();
            if (releaseFrame != null) {
                try {
                    releaseFrame.await(2, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            respond(exchange, 200, "{\"acceptedSequence\":0,\"bufferedBytes\":3,\"backpressured\":false}");
        });
        server.createContext("/v1/streams/session-b/close", exchange -> {
            closeCalls.incrementAndGet();
            respond(exchange, 204, "");
        });
        server.start();
    }

    private String endpoint() {
        return "http://127.0.0.1:" + server.getAddress().getPort() + "/";
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        long responseLength = status == 204 ? -1L : bytes.length;
        exchange.sendResponseHeaders(status, responseLength);
        if (responseLength < 0) {
            exchange.close();
            return;
        }
        try (var output = exchange.getResponseBody()) {
            if (bytes.length > 0) output.write(bytes);
        } catch (IOException ignored) {
            // Active frame requests may be cancelled while the test server is responding.
        }
    }

    private static Throwable root(Throwable failure) {
        Throwable current = failure;
        while (current.getCause() != null) {
            Throwable cause = current.getCause();
            if (cause.equals(current)) {
                break;
            }
            current = cause;
        }
        return current;
    }
}
