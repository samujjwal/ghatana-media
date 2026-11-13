package dev.ghatana.documentintelligence.client;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static dev.ghatana.documentintelligence.client.DocumentIntelligenceClient.*;
import static org.junit.jupiter.api.Assertions.*;

/**
 * Adversarial transport tests for the frozen document-intelligence.v1 client: malformed and
 * oversized responses, cancellation ambiguity (only a generation-bound confirmed DELETE is
 * terminal) and cross-tenant denial. v1 has no status GET; none of these tests invents one.
 */
class DocumentIntelligenceClientAdversarialTest {
    private static final Scope TENANT_A = new Scope("tenant-a", "principal-a");
    private static final Scope TENANT_B = new Scope("tenant-b", "principal-b");
    private static final int MAX_RESPONSE = 4 * 1024;

    private HttpServer server;
    private DocumentIntelligenceClient client;
    private final AtomicInteger parseCalls = new AtomicInteger();
    private final AtomicInteger deleteCalls = new AtomicInteger();
    private volatile int parseStatus = 200;
    private volatile byte[] parseBody = new byte[0];
    private volatile int deleteStatus = 200;
    private volatile String deleteMode = "ack"; // ack | not-cancelled | wrong-generation | wrong-operation | malformed | oversized | empty
    private volatile boolean holdParse;
    private volatile String providersBody = "{}";
    private volatile int providersStatus = 200;
    private final CountDownLatch parseEntered = new CountDownLatch(1);
    private final CountDownLatch releaseParse = new CountDownLatch(1);

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/parse", this::parse);
        server.createContext("/v1/providers", this::providers);
        server.createContext("/v1/operations/", this::delete);
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
        client = new DocumentIntelligenceClient(new Config(URI.create("http://127.0.0.1:" + server.getAddress().getPort()),
                Duration.ofSeconds(2), 64 * 1024, MAX_RESPONSE, 50), ignored -> "test-credential");
    }

    @AfterEach
    void stop() { releaseParse.countDown(); server.stop(0); }

    @Test
    void contractVersionIsTheFrozenV1ProtocolIdentity() throws Exception {
        assertEquals("document-intelligence.v1", PROTOCOL_VERSION);
        Path schema = Path.of("..", "..", "contracts", "schemas", "v1", "request-metadata.schema.json");
        if (Files.exists(schema)) { // present in the Media source tree, absent when the client is built from a published sources jar
            assertTrue(Files.readString(schema).contains("\"document-intelligence.v1\""));
        }
    }

    @Test
    void malformedSuccessBodiesNeverBecomeSuccess() throws Exception {
        String[] malformed = {
                "not json at all",
                "",
                "[]",
                "{}",
                ok().replace("document-intelligence.v1", "document-intelligence.v2"),
                ok().replace("\"operationId\":\"op-x\"", "\"operationId\":\"other-op\""),
                ok().replace("\"providerRef\":\"di.ocr.en\",\"pages\"", "\"providerRef\":\"di.ocr.other\",\"pages\""),
                ok().replace("\"x\":0,\"y\":0,\"width\":1,\"height\":1}}]}],\"tables\"", "\"x\":0.5,\"y\":0,\"width\":1,\"height\":1}}]}],\"tables\""),
                ok().replace("\"pages\":[", "\"pages\":{\"a\":[").replace("\"tables\":[]}],", "\"tables\":[]}]},"),
        };
        int i = 0;
        for (String body : malformed) {
            parseBody = body.getBytes(StandardCharsets.UTF_8);
            OperationResult result = client.parse(request(TENANT_A, "malformed-" + i++));
            assertNotEquals(State.SUCCEEDED, result.state(), body);
            assertEquals(State.UNKNOWN, result.state(), body);
            assertTrue(result.parsedDocument().isEmpty());
            assertTrue(result.retryable());
        }
    }

    @Test
    void oversizedSuccessAndErrorResponsesAreBoundedAndAmbiguous() throws Exception {
        parseBody = ok().replace("fixture", "x".repeat(MAX_RESPONSE * 2)).getBytes(StandardCharsets.UTF_8);
        OperationResult oversized = client.parse(request(TENANT_A, "oversized-ok"));
        assertEquals(State.UNKNOWN, oversized.state());
        assertEquals("UNKNOWN_OUTCOME", oversized.failureCode());
        assertTrue(oversized.parsedDocument().isEmpty());

        parseStatus = 422;
        parseBody = ("{\"protocolVersion\":\"document-intelligence.v1\",\"operationId\":\"oversized-err\",\"code\":\"INVALID_REQUEST\",\"retryable\":false,\"pad\":\""
                + "y".repeat(MAX_RESPONSE * 2) + "\"}").getBytes(StandardCharsets.UTF_8);
        OperationResult oversizedError = client.parse(request(TENANT_A, "oversized-err"));
        assertEquals(State.UNKNOWN, oversizedError.state());
    }

    @Test
    void serverErrorsAreUnknownAndWellFormedClientErrorsAreFailedNotSuccess() throws Exception {
        parseStatus = 503;
        parseBody = "{}".getBytes(StandardCharsets.UTF_8);
        assertEquals(State.UNKNOWN, client.parse(request(TENANT_A, "five-hundred")).state());

        parseStatus = 429;
        parseBody = ("{\"protocolVersion\":\"document-intelligence.v1\",\"operationId\":\"busy\",\"code\":\"PROVIDER_BUSY\",\"retryable\":true}")
                .getBytes(StandardCharsets.UTF_8);
        OperationResult busy = client.parse(request(TENANT_A, "busy"));
        assertEquals(State.FAILED, busy.state());
        assertEquals("PROVIDER_BUSY", busy.failureCode());
        assertTrue(busy.retryable());
    }

    @Test
    void malformedOrOversizedProviderCatalogFailsClosed() {
        providersBody = "{\"protocolVersion\":\"document-intelligence.v1\",\"providers\":\"nope\"}";
        assertEquals("INVALID_RESPONSE", assertThrows(ClientException.class, () -> client.providers(TENANT_A, Duration.ofSeconds(1))).code());
        providersBody = "{\"protocolVersion\":\"document-intelligence.v9\",\"providers\":[]}";
        assertEquals("INVALID_RESPONSE", assertThrows(ClientException.class, () -> client.providers(TENANT_A, Duration.ofSeconds(1))).code());
        providersBody = "{\"protocolVersion\":\"document-intelligence.v1\",\"providers\":[],\"pad\":\"" + "z".repeat(MAX_RESPONSE * 2) + "\"}";
        assertEquals("UNKNOWN_OUTCOME", assertThrows(ClientException.class, () -> client.providers(TENANT_A, Duration.ofSeconds(1))).code());
        providersStatus = 500;
        providersBody = "{}";
        assertEquals("PROVIDER_UNAVAILABLE", assertThrows(ClientException.class, () -> client.providers(TENANT_A, Duration.ofSeconds(1))).code());
        providersStatus = 200;
        providersBody = "{\"protocolVersion\":\"document-intelligence.v1\",\"providers\":[{\"providerRef\":\"di.ocr.en\",\"providerVersion\":\"1\",\"mediaTypes\":[\"image/png\"],\"languages\":[\"en\"],\"loaded\":true,\"ready\":false}]}";
        ProviderCatalog catalog = assertDoesNotThrow(() -> client.providers(TENANT_A, Duration.ofSeconds(1)));
        assertFalse(catalog.providers().get(0).ready());
    }

    @Test
    void onlyAGenerationBoundPositiveAcknowledgementIsTerminalCancellation() throws Exception {
        String[] ambiguousModes = {"not-cancelled", "wrong-generation", "wrong-operation", "malformed", "oversized", "empty"};
        for (String mode : ambiguousModes) {
            deleteMode = mode;
            String id = "cancel-" + mode;
            beginHeldParse(id);
            OperationResult cancel = client.cancel(TENANT_A, id);
            assertEquals(State.UNKNOWN, cancel.state(), mode);
            assertEquals("UNKNOWN_OUTCOME", cancel.failureCode(), mode);
            assertTrue(cancel.retryable(), mode);
            assertEquals(State.UNKNOWN, client.status(TENANT_A, id).state(), mode);
        }
        deleteMode = "ack";
        deleteStatus = 500; // a 5xx with an otherwise perfect body is still not confirmed
        beginHeldParse("cancel-500");
        assertEquals(State.UNKNOWN, client.cancel(TENANT_A, "cancel-500").state());
        deleteStatus = 200;
        // A later confirmed DELETE for the same generation is the only transition to CANCELLED.
        OperationResult confirmed = client.cancel(TENANT_A, "cancel-500");
        assertEquals(State.CANCELLED, confirmed.state());
        assertFalse(confirmed.retryable());
    }

    @Test
    void lateProviderSuccessCannotOverwriteConfirmedCancellation() throws Exception {
        deleteMode = "ack";
        var executor = Executors.newSingleThreadExecutor();
        try {
            parseBody = ok().getBytes(StandardCharsets.UTF_8);
            holdParse = true;
            var parsing = executor.submit(() -> client.parse(request(TENANT_A, "late-success")));
            assertTrue(parseEntered.await(2, TimeUnit.SECONDS));
            assertEquals(State.CANCELLED, client.cancel(TENANT_A, "late-success").state());
            releaseParse.countDown();
            assertEquals(State.CANCELLED, parsing.get(3, TimeUnit.SECONDS).state());
            assertEquals(State.CANCELLED, client.status(TENANT_A, "late-success").state());
        } finally { executor.shutdownNow(); }
    }

    @Test
    void crossTenantCallersCannotReadCancelOrCollideWithAnotherTenantsOperation() throws Exception {
        parseBody = ok().getBytes(StandardCharsets.UTF_8);
        OperationResult mine = client.parse(request(TENANT_A, "shared-id"));
        assertEquals(State.SUCCEEDED, mine.state());

        // Tenant B sees nothing for the same operation id and its cancel never reaches the wire.
        OperationResult status = client.status(TENANT_B, "shared-id");
        assertEquals(State.UNKNOWN, status.state());
        assertTrue(status.parsedDocument().isEmpty());
        assertNull(status.operationGeneration());
        assertEquals(State.UNKNOWN, client.cancel(TENANT_B, "shared-id").state());
        assertEquals(0, deleteCalls.get());

        // Same principal id under another tenant is a different scope key.
        Scope sameNameOtherTenant = new Scope("tenant-b", TENANT_A.principalId());
        assertEquals(State.UNKNOWN, client.status(sameNameOtherTenant, "shared-id").state());

        // Tenant B's own operation with the same id is independent and not an idempotency conflict.
        OperationResult theirs = client.parse(request(TENANT_B, "shared-id"));
        assertEquals(State.SUCCEEDED, theirs.state());
        assertEquals(2, parseCalls.get());
        assertNotEquals(mine.operationGeneration(), theirs.operationGeneration());
    }

    @Test
    void sourceBoundToAnotherTenantOrPrincipalIsDeniedBeforeAnyNetworkCall() throws Exception {
        byte[] bytes = png();
        SourceBinding foreignTenant = new SourceBinding("tenant-b", "principal-a", "src", "v1", digest(bytes));
        SourceBinding foreignPrincipal = new SourceBinding("tenant-a", "principal-b", "src", "v1", digest(bytes));
        for (SourceBinding source : new SourceBinding[] {foreignTenant, foreignPrincipal}) {
            assertThrows(IllegalArgumentException.class, () -> client.parse(new ParseRequest(
                    TENANT_A, source, "denied", null, "di.ocr.en", "image/png", "en", Duration.ofSeconds(1),
                    Map.of("maxPages", 1), bytes)));
        }
        assertEquals(0, parseCalls.get());
    }

    @Test
    void thereIsNoStatusEndpointRoundTripAndEndpointRejectsRedirectsAndInsecureRemotes() {
        assertThrows(IllegalArgumentException.class, () -> new Config(URI.create("http://di.example.org"),
                Duration.ofSeconds(1), 1024, 1024, 1));
        assertThrows(IllegalArgumentException.class, () -> new Config(URI.create("https://user:pw@di.example.org"),
                Duration.ofSeconds(1), 1024, 1024, 1));
        assertEquals(State.UNKNOWN, client.status(TENANT_A, "never-submitted").state());
        assertEquals(0, parseCalls.get() + deleteCalls.get());
    }

    private void beginHeldParse(String operationId) throws Exception {
        // A transport timeout leaves the operation ambiguous (UNKNOWN) with its generation reserved.
        parseStatus = 200;
        holdParse = true;
        var shortClient = client;
        var executor = Executors.newSingleThreadExecutor();
        try {
            var future = executor.submit(() -> shortClient.parse(new ParseRequest(TENANT_A,
                    sourceFor(TENANT_A), operationId, null, "di.ocr.en", "image/png", "en", Duration.ofMillis(150),
                    Map.of("maxPages", 2), png())));
            assertEquals(State.UNKNOWN, future.get(5, TimeUnit.SECONDS).state());
        } finally { executor.shutdownNow(); holdParse = false; }
    }

    private ParseRequest request(Scope scope, String operationId) throws Exception {
        return new ParseRequest(scope, sourceFor(scope), operationId, null, "di.ocr.en", "image/png", "en",
                Duration.ofSeconds(2), Map.of("maxPages", 2, "maxLines", 100), png());
    }

    private static SourceBinding sourceFor(Scope scope) throws Exception {
        return new SourceBinding(scope.tenantId(), scope.principalId(), "source-1", "version-1", digest(png()));
    }

    private static byte[] png() { return new byte[] {(byte) 0x89, 'P', 'N', 'G', 0, 1, 2, 3}; }

    private static String digest(byte[] bytes) throws Exception {
        return "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static String ok() {
        return """
                {"protocolVersion":"document-intelligence.v1","operationId":"op-x","providerRef":"di.ocr.en",
                 "pages":[{"pageNumber":1,"blocks":[{"blockId":"b1","kind":"TEXT","boundingRegion":{"x":0,"y":0,"width":1,"height":1},
                 "lines":[{"lineId":"l1","text":"fixture","boundingRegion":{"x":0,"y":0,"width":1,"height":1}}]}],"tables":[]}],
                 "providerProvenance":{"providerRef":"di.ocr.en","providerVersion":"worker-test"},"quality":{"parseConfidence":0.9}}
                """.replaceAll("\\n\\s*", "");
    }

    private void parse(HttpExchange exchange) throws IOException {
        parseCalls.incrementAndGet();
        byte[] request = exchange.getRequestBody().readAllBytes();
        String text = new String(request, StandardCharsets.ISO_8859_1);
        String operationId = metadata(text, "operationId");
        if (holdParse) {
            parseEntered.countDown();
            try { releaseParse.await(3, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
        byte[] response = new String(parseBody, StandardCharsets.UTF_8)
                .replace("op-x", operationId).replace("\"operationId\":\"oversized-err\"", "\"operationId\":\"" + operationId + "\"")
                .replace("\"operationId\":\"busy\"", "\"operationId\":\"" + operationId + "\"")
                .getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(parseStatus, response.length == 0 ? -1 : response.length);
        if (response.length > 0) exchange.getResponseBody().write(response);
        exchange.close();
    }

    private void providers(HttpExchange exchange) throws IOException {
        byte[] response = providersBody.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(providersStatus, response.length);
        exchange.getResponseBody().write(response);
        exchange.close();
    }

    private void delete(HttpExchange exchange) throws IOException {
        deleteCalls.incrementAndGet();
        String operationId = exchange.getRequestURI().getPath().substring("/v1/operations/".length());
        String generation = exchange.getRequestHeaders().getFirst("X-Operation-Generation");
        String body = switch (deleteMode) {
            case "not-cancelled" -> ack(operationId, generation, false);
            case "wrong-generation" -> ack(operationId, "f".repeat(32), true);
            case "wrong-operation" -> ack("someone-else", generation, true);
            case "malformed" -> "{{{";
            case "oversized" -> ack(operationId, generation, true).replace("}", ",\"pad\":\"" + "p".repeat(MAX_RESPONSE * 2) + "\"}");
            case "empty" -> "";
            default -> ack(operationId, generation, true);
        };
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(deleteStatus, bytes.length == 0 ? -1 : bytes.length);
        if (bytes.length > 0) exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static String ack(String operationId, String generation, boolean cancelled) {
        return "{\"protocolVersion\":\"document-intelligence.v1\",\"operationId\":\"" + operationId
                + "\",\"operationGeneration\":\"" + generation + "\",\"cancelled\":" + cancelled + "}";
    }

    private static String metadata(String multipart, String key) {
        int at = multipart.indexOf("\"" + key + "\":\"");
        if (at < 0) return "unknown";
        int start = at + key.length() + 4;
        return multipart.substring(start, multipart.indexOf('"', start));
    }
}
