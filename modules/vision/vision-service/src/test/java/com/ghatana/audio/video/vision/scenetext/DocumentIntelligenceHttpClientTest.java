package com.ghatana.audio.video.vision.scenetext;

import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceException.Kind;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceHttpClient.EndpointPolicy;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.Cancellation;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Transport-boundary tests for the DI v1 client; the local server is a wire fixture only. */
class DocumentIntelligenceHttpClientTest {

    private HttpServer server;
    private volatile byte[] providersBody = "{\"protocolVersion\":\"document-intelligence.v1\",\"providers\":[]}"
            .getBytes(StandardCharsets.UTF_8);
    private volatile boolean declareLength = true;
    private volatile CountDownLatch gate;
    private final AtomicInteger cancelRequests = new AtomicInteger();

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/providers", exchange -> {
            try {
                if (gate != null) gate.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            byte[] body = providersBody;
            exchange.getResponseHeaders().add("content-type", "application/json");
            if (declareLength) {
                exchange.sendResponseHeaders(200, body.length);
            } else {
                exchange.sendResponseHeaders(200, 0); // chunked, undeclared length
            }
            if (body.length > 0) exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.createContext("/v1/operations/", exchange -> {
            cancelRequests.incrementAndGet();
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
        server.start();
    }

    @AfterEach
    void stop() {
        if (gate != null) gate.countDown();
        server.stop(0);
    }

    @Test
    void oversizedDeclaredResponseIsRejectedWithoutBuffering() {
        providersBody = new byte[33 * 1024 * 1024];
        assertThatThrownBy(() -> client().providers(Cancellation.none()))
                .isInstanceOfSatisfying(DocumentIntelligenceException.class,
                        failure -> assertThat(failure.kind()).isEqualTo(Kind.INVALID_RESPONSE));
    }

    @Test
    void oversizedUndeclaredResponseIsBoundedDuringReceipt() {
        declareLength = false;
        providersBody = new byte[33 * 1024 * 1024];
        assertThatThrownBy(() -> client().providers(Cancellation.none()))
                .isInstanceOfSatisfying(DocumentIntelligenceException.class,
                        failure -> assertThat(failure.kind()).isEqualTo(Kind.INVALID_RESPONSE));
    }

    @Test
    void hostOutsideAllowlistIsRefusedAtConstruction() {
        assertThatThrownBy(() -> new DocumentIntelligenceHttpClient(
                URI.create("http://127.0.0.1:1"), HttpClient.newHttpClient(), Duration.ofSeconds(1), 1024,
                new EndpointPolicy(Set.of("di.internal"), false, Set.of()), 1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("allowlist");
    }

    @Test
    void plaintextNonLoopbackRequiresExplicitPermission() {
        assertThatThrownBy(() -> new DocumentIntelligenceHttpClient(
                URI.create("http://di.internal:8080"), HttpClient.newHttpClient(), Duration.ofSeconds(1), 1024,
                new EndpointPolicy(Set.of("di.internal"), false, Set.of()), 1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("plaintext");
        // Explicitly permitted plaintext host constructs cleanly.
        new DocumentIntelligenceHttpClient(URI.create("http://di.internal:8080"), HttpClient.newHttpClient(),
                Duration.ofSeconds(1), 1024,
                new EndpointPolicy(Set.of("di.internal"), false, Set.of("di.internal")), 1);
        // TLS-required policy refuses any plaintext scheme.
        assertThatThrownBy(() -> new DocumentIntelligenceHttpClient(
                URI.create("http://127.0.0.1:1"), HttpClient.newHttpClient(), Duration.ofSeconds(1), 1024,
                new EndpointPolicy(Set.of("127.0.0.1"), true, Set.of("127.0.0.1")), 1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("TLS");
        // HTTPS is always accepted for an allowlisted host.
        new DocumentIntelligenceHttpClient(URI.create("https://di.internal:8443"), HttpClient.newHttpClient(),
                Duration.ofSeconds(1), 1024,
                new EndpointPolicy(Set.of("di.internal"), true, Set.of()), 1);
    }

    @Test
    void redirectFollowingClientIsRejected() {
        HttpClient following = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.ALWAYS).build();
        assertThatThrownBy(() -> new DocumentIntelligenceHttpClient(
                URI.create("http://127.0.0.1:1"), following, Duration.ofSeconds(1), 1024,
                EndpointPolicy.loopback("127.0.0.1"), 1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("redirect");
    }

    @Test
    void cancellationRejectsInvalidOperationIdsBeforeNetworkEffect() {
        DocumentIntelligenceHttpClient client = client();
        for (String operationId : new String[] {"", "../other-operation", "op?cancel=all", "a".repeat(257)}) {
            assertThatThrownBy(() -> client.cancel(operationId, "a".repeat(32)))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("operation identity");
        }
        assertThat(cancelRequests).hasValue(0);
    }

    @Test
    void concurrencyBoundRejectsOverflowAsUnavailable() throws Exception {
        gate = new CountDownLatch(1);
        DocumentIntelligenceHttpClient client = new DocumentIntelligenceHttpClient(
                URI.create("http://127.0.0.1:" + server.getAddress().getPort()), HttpClient.newHttpClient(),
                Duration.ofSeconds(10), 1024, EndpointPolicy.loopback("127.0.0.1"), 1);
        AtomicLong unavailable = new AtomicLong();
        var first = java.util.concurrent.CompletableFuture.runAsync(() -> {
            try { client.providers(Cancellation.none()); }
            catch (DocumentIntelligenceException ignored) { }
        });
        // Give the single slot time to be taken, then the second caller must fail fast.
        Thread.sleep(200);
        try { client.providers(Cancellation.none()); }
        catch (DocumentIntelligenceException failure) {
            if (failure.kind() == Kind.UNAVAILABLE) unavailable.incrementAndGet();
        }
        gate.countDown();
        first.get(5, TimeUnit.SECONDS);
        assertThat(unavailable.get()).isEqualTo(1);
    }

    private DocumentIntelligenceHttpClient client() {
        return new DocumentIntelligenceHttpClient(
                URI.create("http://127.0.0.1:" + server.getAddress().getPort()), HttpClient.newHttpClient(),
                Duration.ofSeconds(3), 1024, EndpointPolicy.loopback("127.0.0.1"), 4);
    }
}
