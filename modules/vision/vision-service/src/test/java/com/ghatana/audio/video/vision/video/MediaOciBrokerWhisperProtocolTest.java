package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;

/** Model-free authenticated protocol tests. They do not establish OCI or model qualification. */
class MediaOciBrokerWhisperProtocolTest {
    private static final String TOKEN = "t".repeat(64);
    private static final String PROFILE = "whisper.reference.v1";
    private static final String INPUT = digest(new byte[] {1, 2, 3});

    @TempDir Path root;

    @Test
    void authenticatedExecuteReturnsSignedNotAdmittedWithoutFixedWorkerProtocol() throws Exception {
        String nonce = "nonce-0123456789abcdef";
        String payload = executePayload("AQID", INPUT, PROFILE);
        String request = envelope(nonce, payload);
        String response = exchange(request, new MediaOciBrokerPolicy.NonceReplayGuard());

        assertThat(response).contains("\"status\":0", "\"status\":\"NOT_ADMITTED\"",
                "\"invocationId\":\"" + UUID.fromString("123e4567-e89b-12d3-a456-426614174000") + "\"");
        String body = bodyObject(response);
        String proof = field(body, "proof");
        String unsigned = body.substring(0, body.lastIndexOf(",\"proof\":")) + "}";
        long timestamp = Long.parseLong(fieldNumber(request, "ts"));
        assertThat(proof).isEqualTo(hmac(TOKEN, "response\n" + nonce + "\n" + timestamp + "\n" + unsigned));
    }

    @Test
    void invalidProofAndReplayedNonceAreRejectedBeforeWhisperDispatch() throws Exception {
        var guard = new MediaOciBrokerPolicy.NonceReplayGuard();
        String nonce = "nonce-abcdef0123456789";
        String envelope = envelope(nonce, executePayload("AQID", INPUT, PROFILE));
        String unauthenticated = envelope.replace(field(envelope, "proof"), "bad-proof");
        assertThat(exchange(unauthenticated, guard)).contains("\"status\":-1", "unauthenticated");
        assertThat(exchange(envelope, guard)).contains("\"status\":0", "NOT_ADMITTED");
        assertThat(exchange(envelope, guard)).contains("\"status\":-1", "unauthenticated");
    }

    @Test
    void mismatchedUnixPeerIdentityIsRejectedBeforeHmacHandling() throws Exception {
        String request = envelope("nonce-peer-0123456789", executePayload("AQID", INPUT, PROFILE));
        assertThat(exchange(request, new MediaOciBrokerPolicy.NonceReplayGuard(), "different-user"))
                .contains("\"status\":-1", "unauthenticated")
                .doesNotContain("NOT_ADMITTED");
    }

    @Test
    void oversizedInputAndCallerWorkerAuthorityAreRejected() throws Exception {
        byte[] oversized = new byte[MediaOciBrokerPolicy.MAX_WHISPER_INPUT_BYTES + 1];
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(oversized));
        String oversizedPayload = executePayload(Base64.getEncoder().encodeToString(oversized), digest, PROFILE);
        assertThat(exchange(envelope("nonce-oversize-0123456789", oversizedPayload),
                new MediaOciBrokerPolicy.NonceReplayGuard())).contains("\"status\":\"INVALID_REQUEST\"");

        String forged = executePayload("AQID", INPUT, PROFILE);
        forged = forged.substring(0, forged.length() - 1) + ",\"executable\":\"/bin/sh\"}";
        assertThat(exchange(envelope("nonce-authority-012345678", forged),
                new MediaOciBrokerPolicy.NonceReplayGuard())).contains("\"status\":\"INVALID_REQUEST\"");
    }

    @Test
    void statusAndCancelWithoutAnAdmittedWorkerStayNotAdmitted() throws Exception {
        var guard = new MediaOciBrokerPolicy.NonceReplayGuard();
        for (String operation : new String[] {"WHISPER_STATUS", "WHISPER_CANCEL"}) {
            String payload = "{\"op\":\"" + operation + "\",\"invocationId\":\""
                    + UUID.fromString("123e4567-e89b-12d3-a456-426614174000")
                    + "\",\"profileId\":\"unconfigured-profile\",\"locale\":\"en\",\"sourceSha256\":\""
                    + INPUT + "\"}";
            assertThat(exchange(envelope("nonce-" + operation + "-0123456789", payload), guard))
                    .contains("\"status\":\"NOT_ADMITTED\"");
        }
    }

    @Test
    void authenticatedBudgetUsesSignedTimestampAndFailsAtBoundaryOrClockRollback() {
        long issuedAt = 1_000_000L;
        assertThat(MediaOciBrokerDaemon.remainingAuthenticatedBudget(issuedAt, 500, issuedAt + 499))
                .isEqualTo(1);
        assertThat(MediaOciBrokerDaemon.remainingAuthenticatedBudget(issuedAt, 500, issuedAt + 500))
                .isZero();
        assertThat(MediaOciBrokerDaemon.remainingAuthenticatedBudget(issuedAt, 500, issuedAt - 1))
                .isZero();
        assertThat(MediaOciBrokerDaemon.remainingAuthenticatedBudget(issuedAt, 0, issuedAt))
                .isZero();
    }

    private String exchange(String request, MediaOciBrokerPolicy.NonceReplayGuard nonces) throws Exception {
        return exchange(request, nonces, "test-peer");
    }

    private String exchange(String request, MediaOciBrokerPolicy.NonceReplayGuard nonces,
                             String actualPeerUser) throws Exception {
        Path socket = Path.of("/tmp", "mb-" + UUID.randomUUID() + ".sock");
        var policy = new MediaOciBrokerPolicy.Policy(Set.of(), 501, 20, root, root);
        ExecutorService serverExecutor = Executors.newSingleThreadExecutor();
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socket));
            Future<?> handled = serverExecutor.submit(() -> {
                try (SocketChannel accepted = server.accept()) {
                    MediaOciBrokerDaemon.handle(accepted, TOKEN, "docker", policy, nonces,
                            "test-peer", channel -> actualPeerUser);
                } catch (Exception failure) {
                    throw new RuntimeException(failure);
                }
            });
            try (SocketChannel client = SocketChannel.open(StandardProtocolFamily.UNIX)) {
                client.connect(UnixDomainSocketAddress.of(socket));
                byte[] bytes = request.getBytes(StandardCharsets.UTF_8);
                ByteBuffer frame = ByteBuffer.allocate(bytes.length + 4).putInt(bytes.length).put(bytes);
                frame.flip();
                while (frame.hasRemaining()) client.write(frame);
                client.shutdownOutput();
                ByteBuffer header = ByteBuffer.allocate(4);
                readFully(client, header);
                header.flip();
                int length = header.getInt();
                assertThat(length).isBetween(1, MediaOciBrokerPolicy.MAX_WHISPER_RESPONSE_BYTES);
                ByteBuffer body = ByteBuffer.allocate(length);
                readFully(client, body);
                handled.get();
                return StandardCharsets.UTF_8.decode(body.flip()).toString();
            }
        } finally {
            serverExecutor.shutdownNow();
            Files.deleteIfExists(socket);
        }
    }

    private static String executePayload(String base64, String digest, String profile) {
        return "{\"op\":\"WHISPER_EXECUTE\",\"invocationId\":\""
                + UUID.fromString("123e4567-e89b-12d3-a456-426614174000")
                + "\",\"profileId\":\"" + profile + "\",\"locale\":\"en\",\"sourceSha256\":\""
                + digest + "\",\"remainingBudgetMillis\":1000,\"wavBase64\":\"" + base64 + "\"}";
    }

    private static String envelope(String nonce, String payload) throws Exception {
        long timestamp = System.currentTimeMillis();
        return "{\"nonce\":\"" + nonce + "\",\"ts\":" + timestamp + ",\"proof\":\""
                + hmac(TOKEN, nonce + "\n" + timestamp + "\n" + payload) + "\",\"payload\":" + payload + "}";
    }

    private static String bodyObject(String response) {
        int start = response.indexOf("\"body\":") + "\"body\":".length();
        return response.substring(start, response.length() - 1);
    }

    private static String field(String json, String key) {
        String marker = "\"" + key + "\":\"";
        int start = json.indexOf(marker);
        if (start < 0) return null;
        start += marker.length();
        int end = json.indexOf('"', start);
        return end < 0 ? null : json.substring(start, end);
    }

    private static String fieldNumber(String json, String key) {
        String marker = "\"" + key + "\":";
        int start = json.indexOf(marker) + marker.length();
        int end = start;
        while (end < json.length() && Character.isDigit(json.charAt(end))) end++;
        return json.substring(start, end);
    }

    private static String hmac(String token, String message) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return HexFormat.of().formatHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
    }

    private static String digest(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    private static void readFully(SocketChannel channel, ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) if (channel.read(buffer) < 0) throw new IOException("truncated broker response");
    }
}
