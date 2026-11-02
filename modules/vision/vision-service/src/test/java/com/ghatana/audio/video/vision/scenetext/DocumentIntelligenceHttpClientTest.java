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
    private volatile String cancelResponseMode = "confirmed";
    private volatile int parseStatus = 409;
    private volatile String parseBody = errorEnvelope("operation-1", "PROVIDER_FAILED");
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
            String operationId = exchange.getRequestURI().getRawPath().substring("/v1/operations/".length());
            String generation = exchange.getRequestHeaders().getFirst("x-operation-generation");
            String body = switch (cancelResponseMode) {
                case "false" -> cancelAck(operationId, generation, false);
                case "wrong-generation" -> cancelAck(operationId, "0".repeat(32), true);
                case "extra-field" -> cancelAck(operationId, generation, true).replace("}", ",\"extra\":true}");
                case "malformed" -> "{not-json";
                default -> cancelAck(operationId, generation, true);
            };
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.createContext("/v1/parse", exchange -> {
            byte[] body = parseBody.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("content-type", "application/json");
            exchange.sendResponseHeaders(parseStatus, body.length);
            exchange.getResponseBody().write(body);
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
        assertThatThrownBy(() -> client(Duration.ofSeconds(20)).providers(Cancellation.none()))
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
    void cancellationRequiresExactFrozenAcknowledgment() {
        DocumentIntelligenceHttpClient client = client();
        String generation = "a".repeat(32);
        assertThat(client.cancel("operation-1", generation)).isTrue();
        cancelResponseMode = "false";
        assertThat(client.cancel("operation-1", generation)).isFalse();
        cancelResponseMode = "wrong-generation";
        assertThat(client.cancel("operation-1", generation)).isFalse();
        cancelResponseMode = "extra-field";
        assertThat(client.cancel("operation-1", generation)).isFalse();
        cancelResponseMode = "malformed";
        assertThat(client.cancel("operation-1", generation)).isFalse();
        assertThat(cancelRequests).hasValue(5);
    }

    @Test
    void parseErrorMustCarryTheRequestOperationIdentity() {
        DocumentIntelligenceHttpClient client = client();
        parseBody = errorEnvelope("different-operation", "PROVIDER_FAILED");
        assertThatThrownBy(() -> client.parse(parseRequest(), Cancellation.none()))
                .isInstanceOfSatisfying(DocumentIntelligenceException.class,
                        failure -> assertThat(failure.kind()).isEqualTo(Kind.INVALID_RESPONSE));

        parseBody = "{\"protocolVersion\":\"document-intelligence.v1\",\"code\":\"PROVIDER_FAILED\",\"retryable\":true}";
        assertThatThrownBy(() -> client.parse(parseRequest(), Cancellation.none()))
                .isInstanceOfSatisfying(DocumentIntelligenceException.class,
                        failure -> assertThat(failure.kind()).isEqualTo(Kind.INVALID_RESPONSE));
    }

    @Test
    void duplicateOperationErrorIsReportedAsUnknownOutcome() {
        parseBody = errorEnvelope("operation-1", "DUPLICATE_OPERATION");
        assertThatThrownBy(() -> client().parse(parseRequest(), Cancellation.none()))
                .isInstanceOfSatisfying(DocumentIntelligenceException.class,
                        failure -> assertThat(failure.kind()).isEqualTo(Kind.UNKNOWN_OUTCOME));
    }

    @Test
    void activeDuplicateInvalidRequestEnvelopeIsUnknownOutcome() {
        // The worker's active-operation duplicate response is the ordinary public
        // INVALID_REQUEST envelope and carries operationId but no generation.
        parseStatus = 400;
        parseBody = errorEnvelope("operation-1", "INVALID_REQUEST", false);
        assertThatThrownBy(() -> client().parse(parseRequest(), Cancellation.none()))
                .isInstanceOfSatisfying(DocumentIntelligenceException.class,
                        failure -> assertThat(failure.kind()).isEqualTo(Kind.UNKNOWN_OUTCOME));
    }

    @Test
    void activeDuplicateEnvelopeWithMismatchedOperationIdIsInvalidResponse() {
        parseStatus = 400;
        parseBody = errorEnvelope("different-operation", "INVALID_REQUEST", false);
        assertThatThrownBy(() -> client().parse(parseRequest(), Cancellation.none()))
                .isInstanceOfSatisfying(DocumentIntelligenceException.class,
                        failure -> assertThat(failure.kind()).isEqualTo(Kind.INVALID_RESPONSE));
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
        return client(Duration.ofSeconds(3));
    }

    private static String cancelAck(String operationId, String generation, boolean cancelled) {
        return "{\"protocolVersion\":\"document-intelligence.v1\",\"operationId\":\"" + operationId
                + "\",\"operationGeneration\":\"" + generation + "\",\"cancelled\":" + cancelled + "}";
    }

    private static String errorEnvelope(String operationId, String code) {
        return errorEnvelope(operationId, code, true);
    }

    private static String errorEnvelope(String operationId, String code, boolean retryable) {
        return "{\"protocolVersion\":\"document-intelligence.v1\",\"operationId\":\"" + operationId
                + "\",\"code\":\"" + code + "\",\"retryable\":" + retryable + "}";
    }

    private static DocumentIntelligenceV1.ParseRequest parseRequest() {
        return new DocumentIntelligenceV1.ParseRequest("operation-1", "a".repeat(32), "di.ocr.en", "image/png",
                java.util.Optional.empty(), 1000, java.util.Map.of(), new byte[] {1, 2, 3});
    }

    private DocumentIntelligenceHttpClient client(Duration timeout) {
        return new DocumentIntelligenceHttpClient(
                URI.create("http://127.0.0.1:" + server.getAddress().getPort()), HttpClient.newHttpClient(),
                timeout, 1024, EndpointPolicy.loopback("127.0.0.1"), 4);
    }
}
