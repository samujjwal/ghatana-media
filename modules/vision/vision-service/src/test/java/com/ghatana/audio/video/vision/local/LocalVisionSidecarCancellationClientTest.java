package com.ghatana.audio.video.vision.local;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

class LocalVisionSidecarCancellationClientTest {
    @Test
    void timedOutInferenceRequestsBestEffortCancellationForItsExactOperationId() throws Exception {
        String token = LocalVisionTestFixtures.FIXTURE_TOKEN;
        CountDownLatch inferenceEntered = new CountDownLatch(1);
        CountDownLatch cancellationReceived = new CountDownLatch(1);
        CountDownLatch releaseInference = new CountDownLatch(1);
        AtomicReference<String> operationId = new AtomicReference<>();
        AtomicReference<String> cancellationPath = new AtomicReference<>();
        AtomicReference<String> cancellationAuthorization = new AtomicReference<>();

        var serverExecutor = Executors.newCachedThreadPool();
        var callerExecutor = Executors.newSingleThreadExecutor();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(serverExecutor);
        server.createContext("/", exchange -> {
            try {
                if (!("Bearer " + token).equals(exchange.getRequestHeaders().getFirst("Authorization"))) {
                    respond(exchange, 401, "{\"error\":\"UNAUTHORIZED\"}");
                    return;
                }
                if ("POST".equals(exchange.getRequestMethod()) && "/v1/analyze".equals(exchange.getRequestURI().getPath())) {
                    exchange.getRequestBody().readAllBytes();
                    operationId.set(exchange.getRequestHeaders().getFirst("X-Ghatana-Operation-Id"));
                    inferenceEntered.countDown();
                    releaseInference.await(3, TimeUnit.SECONDS);
                    try {
                        respond(exchange, 200, "{\"results\":{},\"imageSize\":{\"width\":1,\"height\":1}}");
                    } catch (IOException clientTimedOut) {
                        // The client correctly abandons this response after its deadline.
                    }
                    return;
                }
                if ("DELETE".equals(exchange.getRequestMethod())) {
                    cancellationPath.set(exchange.getRequestURI().getPath());
                    cancellationAuthorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
                    cancellationReceived.countDown();
                    releaseInference.countDown();
                    respond(exchange, 202, "{\"state\":\"CANCEL_REQUESTED\"}");
                    return;
                }
                respond(exchange, 404, "{\"error\":\"NOT_FOUND\"}");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } finally {
                exchange.close();
            }
        });

        server.start();
        try {
            var client = new LocalVisionSidecarClient(
                    URI.create("http://127.0.0.1:" + server.getAddress().getPort()), token, Duration.ofMillis(250));
            Future<LocalVisionSidecarClient.SidecarUnavailableException.Reach> result = callerExecutor.submit(() -> {
                try {
                    client.analyze(new byte[] { 1, 2, 3 }, List.of("caption"), 1);
                    throw new AssertionError("timed out inference unexpectedly returned a result");
                } catch (LocalVisionSidecarClient.SidecarUnavailableException unavailable) {
                    return unavailable.reach();
                }
            });

            assertThat(inferenceEntered.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(result.get(3, TimeUnit.SECONDS))
                    .isEqualTo(LocalVisionSidecarClient.SidecarUnavailableException.Reach.TIMED_OUT);
            assertThat(cancellationReceived.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(operationId.get()).isNotNull();
            assertThat(UUID.fromString(operationId.get()).toString()).isEqualTo(operationId.get());
            assertThat(cancellationPath.get()).isEqualTo("/v1/operations/" + operationId.get());
            assertThat(cancellationAuthorization.get()).isEqualTo("Bearer " + token);
        } finally {
            releaseInference.countDown();
            server.stop(0);
            callerExecutor.shutdownNow();
            serverExecutor.shutdownNow();
        }
    }

    private static void respond(com.sun.net.httpserver.HttpExchange exchange, int status, String body)
            throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }
}
