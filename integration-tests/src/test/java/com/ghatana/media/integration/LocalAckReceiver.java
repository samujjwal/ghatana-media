package com.ghatana.media.integration;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A real, independent delivery destination for the J-22 tests: a loopback HTTP receiver with its own storage, its own
 * revocable upload credential and its own HMAC ACK key. It shares no code with the launcher's adapter; the wire
 * protocol is implemented here from the specification in {@code MediaDevHttpReceiverDestination}. It stores bytes it
 * is sent, hashes what it actually stored, and signs STATUS/PART documents bound to the caller's nonce.
 *
 * <p>Fault controls model what a real remote does: drop the connection after storing (lost ACK), drop it before
 * storing, stall after storing, revoke the credential (immediately or after N parts), corrupt the stored object,
 * sign with a wrong key, or claim another identity.
 */
final class LocalAckReceiver implements AutoCloseable {
    private static final int MAX_BODY = 4 * 1024 * 1024;

    private static final class Stored {
        final int size;
        final String declaredSha;
        byte[] data;
        int received;
        Stored(int size, String declaredSha) { this.size = size; this.declaredSha = declaredSha; this.data = new byte[size]; }
    }

    /** One accepted write, recorded for duplicate detection. */
    record PartWrite(String objectKey, int offset, int length) { }

    private final HttpServer server;
    private final String ackKey;
    private final Map<String, Stored> objects = new ConcurrentHashMap<>();
    private final List<PartWrite> partWrites = java.util.Collections.synchronizedList(new ArrayList<>());
    private final AtomicInteger putRequests = new AtomicInteger();
    private final AtomicInteger statusRequests = new AtomicInteger();
    private final AtomicInteger unauthorized = new AtomicInteger();
    private volatile String identity;
    private volatile String credential;
    private volatile boolean revoked;
    private volatile int revokeAfterStoredParts = -1;
    private volatile int dropAckAfterStoreRemaining;
    private volatile int dropBeforeStoreRemaining;
    private volatile int wrongKeySignatures;
    private volatile int wrongKeySkip;
    private volatile java.util.function.Consumer<PartWrite> afterPartStored;
    private volatile boolean corruptOnComplete;
    private volatile CountDownLatch stallAfterStore;
    private volatile CountDownLatch stalled = new CountDownLatch(1);
    private volatile int stallOnPartAtOrAfter = -1;
    private volatile String wrongKey = "an-entirely-different-ack-key-0123456789";

    LocalAckReceiver(String identity, String credential, String ackKey) throws IOException {
        this.identity = identity;
        this.credential = credential;
        this.ackKey = ackKey;
        this.server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        this.server.createContext("/v1/objects/", this::handle);
        this.server.setExecutor(Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "local-ack-receiver");
            thread.setDaemon(true);
            return thread;
        }));
        this.server.start();
    }

    String url() { return "http://127.0.0.1:" + server.getAddress().getPort(); }
    String credential() { return credential; }
    String ackKey() { return ackKey; }

    // ---- fault controls ----
    void revokeCredential() { revoked = true; }
    void restoreCredential() { revoked = false; revokeAfterStoredParts = -1; }
    void revokeAfterStoredParts(int parts) { revokeAfterStoredParts = partWrites.size() + parts; }
    /** Runs synchronously after a first-time part is stored and before it is acknowledged. */
    void afterPartStored(java.util.function.Consumer<PartWrite> hook) { afterPartStored = hook; }
    void dropAckAfterStore(int times) { dropAckAfterStoreRemaining = times; }
    void dropBeforeStore(int times) { dropBeforeStoreRemaining = times; }
    void signWithWrongKey(int skipSigned, int times) { wrongKeySkip = skipSigned; wrongKeySignatures = times; }
    void corruptStoredObjectOnComplete(boolean on) { corruptOnComplete = on; }
    void claimIdentity(String other) { identity = other; }

    /** The next PUT at or after {@code offset} is stored, then its response is withheld until released or closed. */
    void stallAfterStoreAtOffset(int offset) {
        stalled = new CountDownLatch(1);
        stallAfterStore = new CountDownLatch(1);
        stallOnPartAtOrAfter = offset;
    }
    boolean awaitStall(long seconds) throws InterruptedException { return stalled.await(seconds, TimeUnit.SECONDS); }
    void releaseStall() { CountDownLatch latch = stallAfterStore; if (latch != null) latch.countDown(); stallOnPartAtOrAfter = -1; }

    // ---- observations ----
    int putRequests() { return putRequests.get(); }
    int statusRequests() { return statusRequests.get(); }
    int unauthorizedRequests() { return unauthorized.get(); }
    List<PartWrite> partWrites() { synchronized (partWrites) { return List.copyOf(partWrites); } }
    long storedObjects() { return objects.size(); }
    int received(String objectKey) { Stored stored = objects.get(objectKey); return stored == null ? 0 : stored.received; }
    byte[] storedBytes(String objectKey) {
        Stored stored = objects.get(objectKey);
        return stored == null || stored.received != stored.size ? null : stored.data.clone();
    }
    /** Plants an object another party wrote, to model a pre-existing foreign object at a destination key. */
    void plant(String objectKey, byte[] bytes) {
        Stored stored = new Stored(bytes.length, sha256(bytes));
        stored.data = bytes.clone();
        stored.received = bytes.length;
        objects.put(objectKey, stored);
    }

    private void handle(HttpExchange exchange) throws IOException {
        try {
            String path = exchange.getRequestURI().getPath();
            String key = path.substring("/v1/objects/".length());
            boolean part = key.endsWith("/parts");
            if (part) key = key.substring(0, key.length() - "/parts".length());
            if (!key.matches("[0-9a-f]{64}")) { respond(exchange, 404, new byte[0], null, false); return; }
            if ("PUT".equals(exchange.getRequestMethod())) putRequests.incrementAndGet();
            else statusRequests.incrementAndGet();
            if (revoked || !("Bearer " + credential).equals(exchange.getRequestHeaders().getFirst("Authorization"))) {
                unauthorized.incrementAndGet();
                exchange.getRequestBody().readNBytes(MAX_BODY + 1);
                respond(exchange, 401, "{\"error\":\"credential\"}".getBytes(StandardCharsets.UTF_8), null, false);
                return;
            }
            String nonce = exchange.getRequestHeaders().getFirst("X-Ack-Nonce");
            if (part && "PUT".equals(exchange.getRequestMethod())) put(exchange, key, nonce);
            else if (!part && "GET".equals(exchange.getRequestMethod())) status(exchange, key, nonce);
            else respond(exchange, 405, new byte[0], null, false);
        } catch (RuntimeException failure) {
            respond(exchange, 500, new byte[0], null, false);
        }
    }

    private void put(HttpExchange exchange, String key, String nonce) throws IOException {
        byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY + 1);
        if (dropBeforeStoreRemaining > 0) { dropBeforeStoreRemaining--; exchange.close(); return; }
        int offset = Integer.parseInt(exchange.getRequestURI().getQuery().replace("offset=", ""));
        String partSha = exchange.getRequestHeaders().getFirst("X-Part-Sha256");
        int size = Integer.parseInt(exchange.getRequestHeaders().getFirst("X-Object-Size"));
        String declared = exchange.getRequestHeaders().getFirst("X-Object-Sha256");
        if (!sha256(body).equals(partSha)) { respond(exchange, 422, "{\"error\":\"part digest\"}".getBytes(StandardCharsets.UTF_8), null, false); return; }
        boolean replay = false;
        synchronized (this) {
            Stored stored = objects.computeIfAbsent(key, ignored -> new Stored(size, declared));
            if (stored.size != size || !stored.declaredSha.equals(declared) || offset + body.length > stored.size) {
                respond(exchange, 409, "{\"error\":\"object identity\"}".getBytes(StandardCharsets.UTF_8), null, false);
                return;
            }
            if (offset < stored.received) {
                if (!Arrays.equals(body, Arrays.copyOfRange(stored.data, offset, offset + body.length))) {
                    respond(exchange, 409, "{\"error\":\"replay differs\"}".getBytes(StandardCharsets.UTF_8), null, false);
                    return;
                }
                replay = true;
            } else if (offset > stored.received) {
                respond(exchange, 409, ("{\"error\":\"gap\",\"received\":" + stored.received + "}").getBytes(StandardCharsets.UTF_8), null, false);
                return;
            } else {
                System.arraycopy(body, 0, stored.data, offset, body.length);
                stored.received += body.length;
                PartWrite write = new PartWrite(key, offset, body.length);
                partWrites.add(write);
                if (afterPartStored != null) afterPartStored.accept(write);
                if (stored.received == stored.size && corruptOnComplete) stored.data[stored.size / 2] ^= 0x55;
                if (revokeAfterStoredParts > 0 && partWrites.size() >= revokeAfterStoredParts) revoked = true;
            }
        }
        if (dropAckAfterStoreRemaining > 0 && !replay) { dropAckAfterStoreRemaining--; exchange.close(); return; }
        if (stallOnPartAtOrAfter >= 0 && offset >= stallOnPartAtOrAfter && !replay) {
            stalled.countDown();
            try { stallAfterStore.await(10, TimeUnit.MINUTES); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            exchange.close();
            return;
        }
        String json = "{\"v\":1,\"kind\":\"PART\",\"identity\":\"" + identity + "\",\"destinationId\":\"dev-http-receiver\","
                + "\"objectKey\":\"" + key + "\",\"nonce\":\"" + nonce + "\",\"offset\":" + offset
                + ",\"nextOffset\":" + (offset + body.length) + ",\"partSha256\":\"" + partSha + "\",\"ackId\":\""
                + UUID.randomUUID() + "\"}";
        respond(exchange, 200, json.getBytes(StandardCharsets.UTF_8), null, true);
    }

    private void status(HttpExchange exchange, String key, String nonce) throws IOException {
        Stored stored = objects.get(key);
        String state = stored == null ? "ABSENT" : stored.received == stored.size ? "COMPLETE" : "PARTIAL";
        String sha = "COMPLETE".equals(state) ? sha256(stored.data) : "";
        String json = "{\"v\":1,\"kind\":\"STATUS\",\"identity\":\"" + identity + "\",\"destinationId\":\"dev-http-receiver\","
                + "\"objectKey\":\"" + key + "\",\"nonce\":\"" + nonce + "\",\"state\":\"" + state
                + "\",\"receivedBytes\":" + (stored == null ? 0 : stored.received) + ",\"size\":" + (stored == null ? 0 : stored.size)
                + ",\"sha256\":\"" + sha + "\",\"ackId\":\"" + UUID.randomUUID() + "\"}";
        respond(exchange, 200, json.getBytes(StandardCharsets.UTF_8), null, true);
    }

    private void respond(HttpExchange exchange, int status, byte[] body, String ignored, boolean signed) throws IOException {
        if (signed) {
            String key = ackKey;
            if (wrongKeySkip > 0) wrongKeySkip--;
            else if (wrongKeySignatures > 0) { wrongKeySignatures--; key = wrongKey; }
            exchange.getResponseHeaders().set("X-Ack-Signature", "v1=" + hmac(key, body));
        }
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, body.length == 0 ? -1 : body.length);
        if (body.length > 0) try (var out = exchange.getResponseBody()) { out.write(body); }
        exchange.close();
    }

    static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (java.security.NoSuchAlgorithmException failure) { throw new IllegalStateException(failure); }
    }

    private static String hmac(String key, byte[] body) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(body));
        } catch (java.security.GeneralSecurityException failure) { throw new IllegalStateException(failure); }
    }

    @Override public void close() {
        releaseStall();
        server.stop(0);
    }
}
