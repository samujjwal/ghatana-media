package dev.ghatana.documentintelligence.client;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static dev.ghatana.documentintelligence.client.DocumentIntelligenceClient.*;
import static org.junit.jupiter.api.Assertions.*;

class DocumentIntelligenceClientTest {
    private static final Scope SCOPE = new Scope("tenant-a", "principal-a");
    private static final String PNG = "image/png";
    private static final String SUCCESS = """
            {"protocolVersion":"document-intelligence.v1","operationId":"op-1","providerRef":"di.ocr.en",
             "pages":[{"pageNumber":1,"blocks":[{"blockId":"b1","kind":"TEXT","boundingRegion":{"x":0,"y":0,"width":1,"height":1},
             "lines":[{"lineId":"l1","text":"fixture","boundingRegion":{"x":0,"y":0,"width":1,"height":1}}]}],"tables":[]}],
             "providerProvenance":{"providerRef":"di.ocr.en","providerVersion":"worker-test"},"quality":{"parseConfidence":0.9}}
            """;

    private HttpServer server;
    private AtomicInteger parseCalls;
    private AtomicInteger deleteCalls;
    private AtomicReference<byte[]> requestBody;
    private AtomicReference<String> operationGeneration;
    private volatile String parseResponse;
    private volatile boolean blockParse;
    private volatile boolean loseCancelAck;
    private CountDownLatch parseEntered;
    private CountDownLatch releaseParse;
    private DocumentIntelligenceClient client;

    @BeforeEach
    void start() throws IOException {
        parseCalls = new AtomicInteger();
        deleteCalls = new AtomicInteger();
        requestBody = new AtomicReference<>();
        operationGeneration = new AtomicReference<>();
        parseResponse = SUCCESS;
        parseEntered = new CountDownLatch(1);
        releaseParse = new CountDownLatch(1);
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/parse", this::parse);
        server.createContext("/v1/operations/", this::cancel);
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
        client = new DocumentIntelligenceClient(new Config(
                java.net.URI.create("http://127.0.0.1:" + server.getAddress().getPort()),
                Duration.ofSeconds(2), 64 * 1024, 64 * 1024, 20), ignored -> "test-credential");
    }

    @AfterEach
    void stop() { releaseParse.countDown(); server.stop(0); }

    @Test
    void validatesTenantAndDigestLocallyAndBoundsUploadBeforeDispatch() throws Exception {
        byte[] bytes = new byte[128];
        SourceBinding source = source(SCOPE, bytes);
        assertThrows(IllegalArgumentException.class, () -> client.parse(request(
                new Scope("tenant-b", SCOPE.principalId()), source, "wrong-tenant", null, bytes)));
        assertThrows(IllegalArgumentException.class, () -> client.parse(request(
                SCOPE, new SourceBinding(SCOPE.tenantId(), SCOPE.principalId(), "source-1", "version-1",
                        "sha256:" + "0".repeat(64)), "wrong-digest", null, bytes)));
        byte[] tooLargeBytes = new byte[128 * 1024];
        OperationResult tooLarge = client.parse(request(SCOPE, source(SCOPE, tooLargeBytes), "too-large", null, tooLargeBytes));
        assertEquals(State.FAILED, tooLarge.state());
        assertEquals("SOURCE_TOO_LARGE", tooLarge.failureCode());
        assertEquals(0, parseCalls.get());
    }

    @Test
    void sendsOnlyFrozenV1MetadataWithOperationGenerationAndCorrelatesResponse() throws Exception {
        byte[] bytes = pngBytes();
        OperationResult result = client.parse(request(SCOPE, source(SCOPE, bytes), "op-1", null, bytes));
        assertEquals(State.SUCCEEDED, result.state());
        assertEquals("document-intelligence.v1", result.parsedDocument().get("protocolVersion"));
        assertEquals("op-1", result.parsedDocument().get("operationId"));
        String multipart = new String(requestBody.get(), StandardCharsets.ISO_8859_1);
        assertEquals(operationGeneration.get(), extractMetadataString(multipart, "operationGeneration"));
        assertTrue(operationGeneration.get().matches("[0-9a-f]{32}"));
        assertTrue(multipart.contains("\"providerRef\":\"di.ocr.en\""));
        assertFalse(multipart.contains("tenant-a"));
        assertFalse(multipart.contains("principal-a"));
        assertFalse(multipart.contains("source-1"));
        assertFalse(multipart.contains("consent"));
        assertEquals(result, client.status(SCOPE, "op-1"));
        assertEquals(State.UNKNOWN, client.status(new Scope("tenant-b", "principal-b"), "op-1").state());
        var restartedClient = new DocumentIntelligenceClient(new Config(
                java.net.URI.create("http://127.0.0.1:" + server.getAddress().getPort()),
                Duration.ofSeconds(2), 64 * 1024, 64 * 1024, 20), ignored -> "test-credential");
        assertEquals(State.UNKNOWN, restartedClient.status(SCOPE, "op-1").state());
        assertEquals("OPERATION_UNKNOWN", restartedClient.status(SCOPE, "op-1").failureCode());
    }

    @Test
    void rejectsMalformedGenerationAndConflictingOperationReplayBeforeDispatch() throws Exception {
        byte[] bytes = pngBytes();
        SourceBinding source = source(SCOPE, bytes);
        assertThrows(IllegalArgumentException.class, () -> request(SCOPE, source, "bad-gen", "ABC", bytes));
        OperationResult first = client.parse(request(SCOPE, source, "same-id", "a".repeat(32), bytes));
        assertEquals(State.SUCCEEDED, first.state());
        OperationResult conflict = client.parse(request(SCOPE, source(SCOPE, new byte[] {1, 2, 3}),
                "same-id", "a".repeat(32), new byte[] {1, 2, 3}));
        assertEquals(State.FAILED, conflict.state());
        assertEquals("IDEMPOTENCY_CONFLICT", conflict.failureCode());
        assertEquals(1, parseCalls.get());
    }

    @Test
    void concurrentSameOperationReservesOnceAndReplaysKnownResult() throws Exception {
        blockParse = true;
        byte[] bytes = pngBytes();
        ParseRequest request = request(SCOPE, source(SCOPE, bytes), "concurrent-id", "e".repeat(32), bytes);
        var executor = Executors.newSingleThreadExecutor();
        try {
            var firstParsing = executor.submit(() -> client.parse(request));
            assertTrue(parseEntered.await(2, TimeUnit.SECONDS));

            OperationResult concurrent = client.parse(request);
            assertEquals(State.UNKNOWN, concurrent.state());
            assertEquals("OPERATION_IN_PROGRESS", concurrent.failureCode());
            assertEquals(1, parseCalls.get());

            releaseParse.countDown();
            OperationResult first = firstParsing.get(3, TimeUnit.SECONDS);
            assertEquals(State.SUCCEEDED, first.state());
            assertEquals(first, client.parse(request));
            assertEquals(1, parseCalls.get());
        } finally {
            releaseParse.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void generationBoundCancellationRequiresMatchingPositiveAcknowledgement() throws Exception {
        blockParse = true;
        byte[] bytes = pngBytes();
        SourceBinding source = source(SCOPE, bytes);
        var executor = Executors.newSingleThreadExecutor();
        try {
            var parsing = executor.submit(() -> client.parse(request(SCOPE, source, "cancel-me", null, bytes)));
            assertTrue(parseEntered.await(2, TimeUnit.SECONDS));
            OperationResult cancelled = client.cancel(SCOPE, "cancel-me");
            assertEquals(State.CANCELLED, cancelled.state());
            assertEquals(operationGeneration.get(), cancelled.operationGeneration());
            releaseParse.countDown();
            assertEquals(State.CANCELLED, parsing.get(3, TimeUnit.SECONDS).state());
            assertEquals(1, deleteCalls.get());
        } finally { executor.shutdownNow(); }
    }

    @Test
    void timeoutAndLostCancelAcknowledgementRemainUnknown() throws Exception {
        blockParse = true;
        byte[] bytes = pngBytes();
        var slowClient = new DocumentIntelligenceClient(new Config(
                java.net.URI.create("http://127.0.0.1:" + server.getAddress().getPort()),
                Duration.ofSeconds(1), 64 * 1024, 64 * 1024, 20), ignored -> "test-credential");
        OperationResult timedOut = slowClient.parse(request(SCOPE, source(SCOPE, bytes), "timeout", "b".repeat(32), bytes,
                Duration.ofMillis(100)));
        assertEquals(State.UNKNOWN, timedOut.state());
        assertEquals("UNKNOWN_OUTCOME", timedOut.failureCode());

        releaseParse.countDown();
        blockParse = false;
        OperationResult completed = client.parse(request(SCOPE, source(SCOPE, bytes), "cancel-ack", "c".repeat(32), bytes));
        assertEquals(State.SUCCEEDED, completed.state());
        loseCancelAck = true;
        OperationResult unknownCancel = client.cancel(SCOPE, "cancel-ack");
        // A completed operation is already terminal locally; no cancel is sent and success remains known.
        assertEquals(State.SUCCEEDED, unknownCancel.state());

        blockParse = true;
        parseEntered = new CountDownLatch(1);
        releaseParse = new CountDownLatch(1);
        var executor = Executors.newSingleThreadExecutor();
        try {
            var parsing = executor.submit(() -> client.parse(request(SCOPE, source(SCOPE, bytes), "lost-cancel", "d".repeat(32), bytes)));
            assertTrue(parseEntered.await(2, TimeUnit.SECONDS));
            OperationResult lost = client.cancel(SCOPE, "lost-cancel");
            assertEquals(State.UNKNOWN, lost.state());
            assertEquals("UNKNOWN_OUTCOME", lost.failureCode());
            releaseParse.countDown();
            parsing.get(3, TimeUnit.SECONDS);
        } finally { executor.shutdownNow(); }
    }

    private void parse(HttpExchange exchange) throws IOException {
        parseCalls.incrementAndGet();
        byte[] body = exchange.getRequestBody().readAllBytes();
        requestBody.set(body);
        operationGeneration.set(exchange.getRequestHeaders().getFirst("X-Operation-Generation"));
        if (blockParse) {
            parseEntered.countDown();
            try { releaseParse.await(3, TimeUnit.SECONDS); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        }
        String response = parseResponse.replace("\"operationId\":\"op-1\"", "\"operationId\":\"" + extractMetadataString(new String(body, StandardCharsets.ISO_8859_1), "operationId") + "\"");
        byte[] responseBytes = response.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(200, responseBytes.length);
        exchange.getResponseBody().write(responseBytes);
        exchange.close();
    }

    private void cancel(HttpExchange exchange) throws IOException {
        deleteCalls.incrementAndGet();
        if (loseCancelAck) {
            exchange.sendResponseHeaders(200, 0);
            exchange.close();
            return;
        }
        String operationId = exchange.getRequestURI().getPath().substring("/v1/operations/".length());
        String generation = exchange.getRequestHeaders().getFirst("X-Operation-Generation");
        byte[] response = ("{\"protocolVersion\":\"document-intelligence.v1\",\"operationId\":\"" + operationId
                + "\",\"operationGeneration\":\"" + generation + "\",\"cancelled\":true}")
                .getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(200, response.length);
        exchange.getResponseBody().write(response);
        exchange.close();
    }

    private static ParseRequest request(Scope scope, SourceBinding source, String operationId,
                                        String generation, byte[] bytes) {
        return request(scope, source, operationId, generation, bytes, Duration.ofSeconds(2));
    }

    private static ParseRequest request(Scope scope, SourceBinding source, String operationId,
                                        String generation, byte[] bytes, Duration timeout) {
        return new ParseRequest(scope, source, operationId, generation, "di.ocr.en", PNG,
                "en", timeout, Map.of("maxPages", 2, "maxLines", 100), bytes);
    }

    private static SourceBinding source(Scope scope, byte[] bytes) throws Exception {
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        return new SourceBinding(scope.tenantId(), scope.principalId(), "source-1", "version-1", "sha256:" + digest);
    }

    private static byte[] pngBytes() { return new byte[] {(byte) 0x89, 'P', 'N', 'G', 0, 1, 2, 3}; }

    private static String extractMetadataString(String multipart, String key) {
        int keyIndex = multipart.indexOf("\"" + key + "\":\"");
        assertTrue(keyIndex >= 0, "metadata field " + key + " exists");
        int start = keyIndex + key.length() + 4;
        int end = multipart.indexOf('"', start);
        return multipart.substring(start, end);
    }
}
