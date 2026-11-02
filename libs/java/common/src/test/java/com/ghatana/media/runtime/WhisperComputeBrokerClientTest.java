package com.ghatana.media.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import com.ghatana.media.runtime.WhisperComputeContracts.Request;
import com.ghatana.media.runtime.WhisperComputeContracts.Result;
import com.ghatana.media.runtime.WhisperComputeContracts.Status;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class WhisperComputeBrokerClientTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TOKEN = "0123456789abcdef0123456789abcdef";
    private static final UUID ID = UUID.fromString("9cc0baff-674e-4d67-a1aa-96f7e5bc2202");
    private static final byte[] WAV = new byte[] {1, 2, 3, 4};
    private static final String INPUT = sha(WAV);
    private static final String MODEL = "a".repeat(64);

    @TempDir Path temp;

    @Test void executeUsesAuthenticatedBoundedFrameAndAcceptsTypedSuccess() throws Exception {
        try (FakeBroker broker = new FakeBroker(temp, (request) -> {
            JsonNode payload = request.get("payload");
            assertThat(payload.get("op").textValue()).isEqualTo("WHISPER_EXECUTE");
            assertThat(payload.get("invocationId").textValue()).isEqualTo(ID.toString());
            assertThat(payload.has("uid")).isFalse();
            assertThat(payload.has("path")).isFalse();
            String exactPayload = JSON.writeValueAsString(payload);
            assertThat(request.get("proof").textValue()).isEqualTo(hmac(TOKEN,
                    request.get("nonce").textValue() + "\n" + request.get("ts").longValue()
                            + "\n" + exactPayload));
            assertThat(request.get("wavBase64")).isNull();
            assertThat(Base64.getDecoder().decode(payload.get("wavBase64").textValue())).containsExactly(WAV);
            return success(request, "hello world");
        })) {
            Result result = broker.client().execute(request(WAV));
            assertThat(result.status()).isEqualTo(Status.SUCCESS);
            assertThat(result.transcript()).isEqualTo("hello world");
            assertThat(broker.requestLength()).isLessThanOrEqualTo(WhisperComputeBrokerClient.MAX_REQUEST_BYTES);
        }
    }

    @Test void statusAndCancelReturnTypedNonSuccessAndDeadlineWithoutSuccessCoercion() throws Exception {
        try (FakeBroker broker = new FakeBroker(temp, request -> {
            String op = request.get("payload").get("op").textValue();
            assertThat(op).isIn("WHISPER_STATUS", "WHISPER_CANCEL");
            assertThat(request.get("payload").has("wavBase64")).isFalse();
            return result(request, "DEADLINE_EXCEEDED", null, "", false, false, false);
        })) {
            Result result = broker.client().cancel(ID, "base", "en-US", INPUT);
            assertThat(result.status()).isEqualTo(Status.DEADLINE_EXCEEDED);
            assertThat(result.transcript()).isEmpty();
            assertThat(result.complete()).isFalse();
        }
        try (FakeBroker broker = new FakeBroker(temp, request -> success(request, "complete transcript"))) {
            Result result = broker.client().status(ID, "base", "en-US", INPUT);
            assertThat(result.status()).isEqualTo(Status.SUCCESS);
            assertThat(result.complete()).isTrue();
            assertThat(result.endOfTask()).isTrue();
        }
    }

    @Test void identityMismatchAndBadProofBecomeUnknownOutcome() throws Exception {
        try (FakeBroker broker = new FakeBroker(temp, request -> {
            ObjectNode response = successBody(request, "hello");
            response.put("invocationId", UUID.randomUUID().toString());
            return signedOuter(request, response);
        })) {
            assertThat(broker.client().execute(request(WAV)).status()).isEqualTo(Status.UNKNOWN_OUTCOME);
        }
    }

    @Test void badResponseProofAndInvalidModelDigestBecomeUnknownOutcome() throws Exception {
        try (FakeBroker broker = new FakeBroker(temp, request -> {
            ObjectNode body = successBody(request, "hello");
            byte[] response = signedOuter(request, body);
            JsonNode outer = JSON.readTree(response);
            ((ObjectNode) outer.get("body")).put("proof", "0".repeat(64));
            return JSON.writeValueAsBytes(outer);
        })) {
            assertThat(broker.client().execute(request(WAV)).status()).isEqualTo(Status.UNKNOWN_OUTCOME);
        }
        try (FakeBroker broker = new FakeBroker(temp, request -> {
            ObjectNode body = successBody(request, "hello").put("modelSha256", "not-a-digest");
            return signedOuter(request, body);
        })) {
            assertThat(broker.client().execute(request(WAV)).status()).isEqualTo(Status.UNKNOWN_OUTCOME);
        }
    }

    @Test void missingResponseAfterCompleteWriteBecomesUnknownOutcome() throws Exception {
        try (FakeBroker broker = new FakeBroker(temp, request -> null)) {
            assertThat(broker.client().execute(request(WAV)).status()).isEqualTo(Status.UNKNOWN_OUTCOME);
        }
    }

    @Test void oversizedResponseBecomesUnknownOutcome() throws Exception {
        try (FakeBroker broker = new FakeBroker(temp, request -> new byte[WhisperComputeBrokerClient.MAX_RESPONSE_BYTES + 1])) {
            assertThat(broker.client().execute(request(WAV)).status()).isEqualTo(Status.UNKNOWN_OUTCOME);
        }
    }

    @Test void maximumDtoInputStillFitsRequestFrame() throws Exception {
        byte[] max = new byte[WhisperComputeContracts.MAX_WAV_BYTES];
        Request maximum = request(max);
        try (FakeBroker broker = new FakeBroker(temp, request -> {
            assertThat(request.get("payload").get("wavBase64").textValue().length()).isEqualTo(5_592_408);
            return success(request, "ok");
        })) {
            assertThat(broker.client().execute(maximum).status()).isEqualTo(Status.SUCCESS);
            assertThat(broker.requestLength()).isLessThanOrEqualTo(WhisperComputeBrokerClient.MAX_REQUEST_BYTES);
        }
    }

    @Test void executeWaitsPastThirtySecondsWhenBudgetAllowsIt() throws Exception {
        try (FakeBroker broker = new FakeBroker(temp, request -> {
            Thread.sleep(30_250);
            return success(request, "after thirty seconds");
        })) {
            Request longBudget = request(WAV, 40_000);
            assertThat(broker.client().execute(longBudget).transcript()).isEqualTo("after thirty seconds");
        }
    }

    @Test void executionDeadlineAfterTransmissionReturnsUnknownOutcome() throws Exception {
        try (FakeBroker broker = new FakeBroker(temp, request -> {
            Thread.sleep(400);
            return success(request, "too late");
        })) {
            WhisperComputeBrokerClient client = new WhisperComputeBrokerClient(broker.socket, broker.token,
                    Duration.ofSeconds(1), Duration.ofSeconds(1), Duration.ofSeconds(2), Duration.ofMillis(50));
            assertThat(client.execute(request(WAV, 100)).status()).isEqualTo(Status.UNKNOWN_OUTCOME);
        }
    }

    @Test void expiredSharedDeadlineReturnsExactPreDispatchDeadlineWithoutOpeningSocket() throws Exception {
        Path token = temp.resolve("token");
        Files.writeString(token, TOKEN, StandardCharsets.UTF_8);
        Files.setPosixFilePermissions(token, PosixFilePermissions.fromString("rw-------"));
        var client = new WhisperComputeBrokerClient(temp.resolve("missing.sock"), token);
        java.util.concurrent.atomic.AtomicLong nanos = new java.util.concurrent.atomic.AtomicLong(0);
        var deadline = MediaRuntimeContracts.ProcessingContext.MonotonicDeadline.after(Duration.ofNanos(1), nanos::get);
        nanos.incrementAndGet();

        Result result = client.execute(request(WAV), deadline);

        assertThat(result.status()).isEqualTo(Status.DEADLINE_EXCEEDED);
        assertThat(result.invocationId()).isEqualTo(ID);
    }

    @Test void sharedDeadlineCannotWidenRequestComputeBudget() throws Exception {
        java.util.concurrent.atomic.AtomicLong nanos = new java.util.concurrent.atomic.AtomicLong(0);
        var sharedDeadline = MediaRuntimeContracts.ProcessingContext.MonotonicDeadline.after(
                Duration.ofSeconds(10), nanos::get);
        try (FakeBroker broker = new FakeBroker(temp, request -> {
            assertThat(request.get("payload").get("remainingBudgetMillis").longValue()).isEqualTo(1_500);
            return result(request, "DEADLINE_EXCEEDED", null, "", false, false, false);
        })) {
            Result response = broker.client().execute(request(WAV, 1_500), sharedDeadline);
            assertThat(response.status()).isEqualTo(Status.DEADLINE_EXCEEDED);
        }
    }

    @Test void requestComputeBudgetCannotWidenShorterSharedDeadline() throws Exception {
        java.util.concurrent.atomic.AtomicLong nanos = new java.util.concurrent.atomic.AtomicLong(0);
        var sharedDeadline = MediaRuntimeContracts.ProcessingContext.MonotonicDeadline.after(
                Duration.ofMillis(1_500), nanos::get);
        try (FakeBroker broker = new FakeBroker(temp, request -> {
            assertThat(request.get("payload").get("remainingBudgetMillis").longValue()).isEqualTo(1_500);
            return result(request, "DEADLINE_EXCEEDED", null, "", false, false, false);
        })) {
            Result response = broker.client().execute(request(WAV, 10_000), sharedDeadline);
            assertThat(response.status()).isEqualTo(Status.DEADLINE_EXCEEDED);
        }
    }

    @Test void connectFailureBeforeAnyRequestBytesIsTypedNoEffect() throws Exception {
        Path token = temp.resolve("token-connect");
        Files.writeString(token, TOKEN, StandardCharsets.UTF_8);
        Files.setPosixFilePermissions(token, PosixFilePermissions.fromString("rw-------"));
        var client = new WhisperComputeBrokerClient(temp.resolve("absent.sock"), token);

        Result result = client.execute(request(WAV));

        assertThat(result.status()).isEqualTo(Status.NOT_ADMITTED);
        assertThat(result.complete()).isFalse();
    }

    @Test void boundedByUsesTheSameInjectedMonotonicClock() {
        java.util.concurrent.atomic.AtomicLong nanos = new java.util.concurrent.atomic.AtomicLong(100);
        var parent = MediaRuntimeContracts.ProcessingContext.MonotonicDeadline.after(Duration.ofSeconds(10), nanos::get);
        var bounded = parent.boundedBy(Duration.ofMillis(5));
        assertThat(bounded.remainingBudgetMillis()).isEqualTo(5);
        nanos.addAndGet(Duration.ofMillis(5).toNanos());
        assertThat(bounded.expired()).isTrue();
        assertThat(parent.expired()).isFalse();
    }

    @Test void tokenSymlinkAndNonRegularFileAreRejectedBeforeRead() throws Exception {
        Path target = temp.resolve("real-token");
        Files.writeString(target, TOKEN, StandardCharsets.UTF_8);
        Files.setPosixFilePermissions(target, PosixFilePermissions.fromString("rw-------"));
        Path link = temp.resolve("token-link");
        Files.createSymbolicLink(link, target);
        WhisperComputeBrokerClient symlinkClient = new WhisperComputeBrokerClient(temp.resolve("missing.sock"), link);
        assertThatThrownBy(() -> symlinkClient.execute(request(WAV))).isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("must not be a symlink");

        Path directory = temp.resolve("token-directory");
        Files.createDirectory(directory);
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
        WhisperComputeBrokerClient directoryClient = new WhisperComputeBrokerClient(
                temp.resolve("missing.sock"), directory);
        assertThatThrownBy(() -> directoryClient.execute(request(WAV))).isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("regular file");
    }

    private static Request request(byte[] wav) {
        return request(wav, 5_000);
    }
    private static Request request(byte[] wav, long budgetMillis) {
        return new Request(ID, "base", "en-US", sha(wav), wav, budgetMillis);
    }
    private static byte[] success(JsonNode request, String transcript) throws Exception {
        return signedOuter(request, successBody(request, transcript));
    }
    private static ObjectNode successBody(JsonNode request, String transcript) {
        return resultBody(request, "SUCCESS", MODEL, transcript, true, true, false);
    }
    private static byte[] result(JsonNode request, String status, String model, String transcript,
            boolean complete, boolean end, boolean tokenLimit) throws Exception {
        return signedOuter(request, resultBody(request, status, model, transcript, complete, end, tokenLimit));
    }
    private static ObjectNode resultBody(JsonNode request, String status, String model, String transcript,
            boolean complete, boolean end, boolean tokenLimit) {
        JsonNode identity = request.get("payload");
        ObjectNode body = JSON.createObjectNode().put("status", status)
                .put("invocationId", identity.get("invocationId").textValue())
                .put("profileId", identity.get("profileId").textValue())
                .put("inputSha256", identity.get("sourceSha256").textValue());
        if (model != null) body.put("modelSha256", model);
        if (!transcript.isEmpty()) body.put("transcriptBase64",
                Base64.getEncoder().encodeToString(transcript.getBytes(StandardCharsets.UTF_8)));
        body.put("complete", complete).put("endOfTask", end).put("tokenLimitReached", tokenLimit);
        return body;
    }
    private static byte[] signedOuter(JsonNode request, ObjectNode body) throws Exception {
        String bodyWithoutProof = JSON.writeValueAsString(body);
        String proof = hmac(TOKEN, "response\n" + request.get("nonce").textValue() + "\n"
                + request.get("ts").longValue() + "\n" + bodyWithoutProof);
        body.put("proof", proof);
        ObjectNode outer = JSON.createObjectNode();
        outer.put("status", 0);
        outer.set("body", body);
        return JSON.writeValueAsBytes(outer);
    }
    private static String hmac(String token, String input) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return HexFormat.of().formatHex(mac.doFinal(input.getBytes(StandardCharsets.UTF_8)));
    }
    private static String sha(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    @FunctionalInterface private interface Responder { byte[] respond(JsonNode request) throws Exception; }
    private static final class FakeBroker implements AutoCloseable {
        private final Path socket;
        private final Path token;
        private final java.nio.channels.ServerSocketChannel server;
        private final Thread thread;
        private volatile Throwable failure;
        private volatile int requestLength;
        private FakeBroker(Path dir, Responder responder) throws Exception {
            socket = dir.resolve("broker.sock"); token = dir.resolve("token");
            Files.writeString(token, TOKEN, StandardCharsets.UTF_8);
            Files.setPosixFilePermissions(token, PosixFilePermissions.fromString("rw-------"));
            server = java.nio.channels.ServerSocketChannel.open(StandardProtocolFamily.UNIX);
            server.bind(UnixDomainSocketAddress.of(socket));
            thread = new Thread(() -> {
                try (var channel = server.accept();
                        var input = new DataInputStream(java.nio.channels.Channels.newInputStream(channel));
                        var output = new DataOutputStream(java.nio.channels.Channels.newOutputStream(channel))) {
                    requestLength = input.readInt();
                    byte[] requestBytes = input.readNBytes(requestLength);
                    JsonNode request = JSON.readTree(requestBytes);
                    byte[] response = responder.respond(request);
                    if (response != null) { output.writeInt(response.length); output.write(response); output.flush(); }
                } catch (java.io.IOException closedByBoundedClient) {
                    // Expected when the client rejects an oversized response and closes its socket.
                } catch (Throwable problem) { failure = problem; }
            });
            thread.start();
        }
        private WhisperComputeBrokerClient client() { return new WhisperComputeBrokerClient(socket, token); }
        private int requestLength() { return requestLength; }
        @Override public void close() throws Exception {
            server.close(); thread.join(2_000);
            if (failure != null && !(failure instanceof java.io.EOFException)) throw new AssertionError(failure);
            Files.deleteIfExists(socket); Files.deleteIfExists(token);
        }
    }
}
