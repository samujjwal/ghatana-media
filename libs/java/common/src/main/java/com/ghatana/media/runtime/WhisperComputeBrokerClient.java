package com.ghatana.media.runtime;

import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import com.ghatana.media.runtime.WhisperComputeContracts.Request;
import com.ghatana.media.runtime.WhisperComputeContracts.Result;
import com.ghatana.media.runtime.WhisperComputeContracts.Status;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.nio.channels.SocketChannel;
import java.nio.channels.ReadableByteChannel;
import java.nio.file.LinkOption;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.io.ByteArrayOutputStream;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Authenticated, compute-only client for the host Whisper Unix-socket broker. */
public final class WhisperComputeBrokerClient implements WhisperComputeClient {
    public static final int MAX_REQUEST_BYTES = 8 * 1024 * 1024;
    public static final int MAX_RESPONSE_BYTES = 1024 * 1024;
    private static final java.time.Duration CONNECT_TIMEOUT = java.time.Duration.ofSeconds(2);
    private static final java.time.Duration WRITE_TIMEOUT = java.time.Duration.ofSeconds(2);
    private static final java.time.Duration SHORT_CALL_TIMEOUT = java.time.Duration.ofSeconds(30);
    private static final java.time.Duration PROTOCOL_GRACE = java.time.Duration.ofSeconds(1);
    private static final long MAX_EXECUTE_CALL_MILLIS = WhisperComputeContracts.MAX_REMAINING_BUDGET_MILLIS;
    private static final ObjectMapper JSON = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build());

    private final Path socketPath;
    private final Path tokenFile;
    private final java.time.Duration connectTimeout;
    private final java.time.Duration writeTimeout;
    private final java.time.Duration shortCallTimeout;
    private final java.time.Duration protocolGrace;
    private final SecureRandom random = new SecureRandom();

    public WhisperComputeBrokerClient(Path socketPath, Path tokenFile) {
        this(socketPath, tokenFile, CONNECT_TIMEOUT, WRITE_TIMEOUT, SHORT_CALL_TIMEOUT, PROTOCOL_GRACE);
    }

    WhisperComputeBrokerClient(Path socketPath, Path tokenFile, java.time.Duration connectTimeout,
            java.time.Duration writeTimeout, java.time.Duration shortCallTimeout) {
        this(socketPath, tokenFile, connectTimeout, writeTimeout, shortCallTimeout, PROTOCOL_GRACE);
    }

    WhisperComputeBrokerClient(Path socketPath, Path tokenFile, java.time.Duration connectTimeout,
            java.time.Duration writeTimeout, java.time.Duration shortCallTimeout,
            java.time.Duration protocolGrace) {
        this.socketPath = Objects.requireNonNull(socketPath, "socketPath");
        this.tokenFile = Objects.requireNonNull(tokenFile, "tokenFile");
        this.connectTimeout = positive(connectTimeout, "connectTimeout");
        this.writeTimeout = positive(writeTimeout, "writeTimeout");
        this.shortCallTimeout = positive(shortCallTimeout, "shortCallTimeout");
        this.protocolGrace = Objects.requireNonNull(protocolGrace, "protocolGrace");
        if (protocolGrace.isNegative() || protocolGrace.compareTo(java.time.Duration.ofSeconds(5)) > 0) {
            throw new IllegalArgumentException("protocolGrace must be between 0 and 5 seconds");
        }
    }

    public Result execute(Request request) throws IOException {
        Objects.requireNonNull(request, "request");
        return execute(request, MediaRuntimeContracts.ProcessingContext.MonotonicDeadline.after(
                java.time.Duration.ofMillis(request.remainingBudgetMillis())));
    }

    @Override public Result execute(Request request,
            MediaRuntimeContracts.ProcessingContext.MonotonicDeadline sharedDeadline) throws IOException {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(sharedDeadline, "sharedDeadline");
        if (sharedDeadline.expired()) return deadlineExceeded(request);
        byte[] wav = request.wavPayload();
        String digest = sha256(wav);
        if (!MessageDigest.isEqual(digest.getBytes(StandardCharsets.US_ASCII),
                request.sourceSha256().getBytes(StandardCharsets.US_ASCII))) {
            throw new IOException("WAV digest changed after request validation");
        }
        ObjectNode payload = JSON.createObjectNode();
        payload.put("op", "WHISPER_EXECUTE");
        identity(payload, request.invocationId(), request.profileId(), request.locale(), digest);
        payload.put("wavBase64", Base64.getEncoder().encodeToString(wav));
        return call(payload, request.invocationId(), request.profileId(), digest,
                deadline(executeCallTimeoutMillis(request.remainingBudgetMillis())), sharedDeadline);
    }

    private static Result deadlineExceeded(Request request) {
        return new Result(request.invocationId(), request.profileId(), request.sourceSha256(), null, "",
                Status.DEADLINE_EXCEEDED, false, false, false);
    }

    public Result status(UUID invocationId, String profileId, String locale, String sourceSha256)
            throws IOException {
        return identityOperation("WHISPER_STATUS", invocationId, profileId, locale, sourceSha256);
    }

    public Result cancel(UUID invocationId, String profileId, String locale, String sourceSha256)
            throws IOException {
        return identityOperation("WHISPER_CANCEL", invocationId, profileId, locale, sourceSha256);
    }

    private Result identityOperation(String op, UUID invocationId, String profileId, String locale,
            String sourceSha256) throws IOException {
        long callDeadline = deadline(shortCallTimeout);
        Objects.requireNonNull(invocationId, "invocationId");
        locale = validateIdentity(invocationId, profileId, locale, sourceSha256);
        ObjectNode payload = JSON.createObjectNode();
        payload.put("op", op);
        identity(payload, invocationId, profileId, locale, sourceSha256);
        return call(payload, invocationId, profileId, sourceSha256, callDeadline);
    }

    private Result call(ObjectNode payload, UUID invocationId, String profileId, String inputDigest,
            long callDeadline) throws IOException {
        return call(payload, invocationId, profileId, inputDigest, callDeadline, null);
    }

    private Result call(ObjectNode payload, UUID invocationId, String profileId, String inputDigest,
            long callDeadline, MediaRuntimeContracts.ProcessingContext.MonotonicDeadline sharedDeadline)
            throws IOException {
        String token = readToken();
        if (sharedDeadline != null && sharedDeadline.expired()) {
            return new Result(invocationId, profileId, inputDigest, null, "",
                    Status.DEADLINE_EXCEEDED, false, false, false);
        }
        long ts = System.currentTimeMillis();
        if (sharedDeadline != null) {
            long remaining = sharedDeadline.remainingBudgetMillis();
            if (remaining == 0) return new Result(invocationId, profileId, inputDigest, null, "",
                    Status.DEADLINE_EXCEEDED, false, false, false);
            payload.put("remainingBudgetMillis", remaining);
        }
        String payloadJson = writeJson(payload);
        String nonce = HexFormat.of().formatHex(randomBytes(16));
        ObjectNode envelope = JSON.createObjectNode();
        envelope.put("nonce", nonce);
        envelope.put("ts", ts);
        envelope.put("proof", hmac(token, nonce + "\n" + ts + "\n" + payloadJson));
        try {
            envelope.set("payload", JSON.readTree(payloadJson));
        } catch (Exception impossible) {
            throw new IOException("Could not form broker request", impossible);
        }
        byte[] request = writeJson(envelope).getBytes(StandardCharsets.UTF_8);
        if (request.length == 0 || request.length > MAX_REQUEST_BYTES) {
            throw new IOException("Whisper broker request exceeds its framed byte limit");
        }
        byte[] response;
        try {
            if (sharedDeadline != null && sharedDeadline.expired()) {
                return new Result(invocationId, profileId, inputDigest, null, "",
                        Status.DEADLINE_EXCEEDED, false, false, false);
            }
            if (sharedDeadline != null) {
                callDeadline = Math.min(callDeadline, deadlineNanos(sharedDeadline.remainingNanos()));
            }
            response = exchange(request, callDeadline, sharedDeadline);
        } catch (PreTransmissionNoEffectException expired) {
            return new Result(invocationId, profileId, inputDigest, null, "",
                    expired.status, false, false, false);
        } catch (UnknownOutcomeException unknown) {
            return unknown(invocationId, profileId, inputDigest);
        }
        try {
            return parseResponse(response, token, nonce, ts, invocationId, profileId, inputDigest);
        } catch (Exception malformed) {
            return unknown(invocationId, profileId, inputDigest);
        }
    }

    private Result parseResponse(byte[] responseBytes, String token, String nonce, long ts,
            UUID invocationId, String profileId, String inputDigest) throws Exception {
        String responseText = strictUtf8(responseBytes);
        JsonNode outer = JSON.readTree(responseText);
        requireExactFields(outer, Set.of("status", "body"), Set.of("status", "body"));
        if (!outer.isObject() || !outer.has("status") || !outer.get("status").canConvertToInt()
                || outer.get("status").intValue() != 0 || !outer.has("body")
                || !outer.get("body").isObject()) throw new IOException("Invalid broker envelope");
        ObjectNode body = ((ObjectNode) outer.get("body")).deepCopy();
        JsonNode proofNode = body.remove("proof");
        if (proofNode == null || !proofNode.isTextual()) throw new IOException("Missing response proof");
        String bodyWithoutProof = writeJson(body);
        String expected = hmac(token, "response\n" + nonce + "\n" + ts + "\n" + bodyWithoutProof);
        if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII),
                proofNode.textValue().getBytes(StandardCharsets.US_ASCII))) {
            throw new IOException("Invalid response proof");
        }
        requireExactFields(body, Set.of("status", "invocationId", "profileId", "inputSha256",
                "modelSha256", "transcriptBase64", "complete", "endOfTask", "tokenLimitReached"),
                Set.of("status", "invocationId", "profileId", "inputSha256", "complete",
                        "endOfTask", "tokenLimitReached"));
        if (!body.get("invocationId").isTextual()
                || !invocationId.toString().equals(body.get("invocationId").textValue())
                || !textEquals(body, "profileId", profileId)
                || !textEquals(body, "inputSha256", inputDigest)) {
            throw new IOException("Broker response identity mismatch");
        }
        if (!body.get("status").isTextual() || !body.get("complete").isBoolean()
                || !body.get("endOfTask").isBoolean() || !body.get("tokenLimitReached").isBoolean()) {
            throw new IOException("Malformed typed response fields");
        }
        Status status;
        try { status = Status.valueOf(body.get("status").textValue()); }
        catch (IllegalArgumentException invalid) { throw new IOException("Unknown broker status", invalid); }
        String model = nullableText(body, "modelSha256");
        String transcript = "";
        if (body.has("transcriptBase64")) {
            if (!body.get("transcriptBase64").isTextual()) throw new IOException("Invalid transcript encoding");
            byte[] decoded = Base64.getDecoder().decode(body.get("transcriptBase64").textValue());
            if (decoded.length > WhisperComputeContracts.MAX_TRANSCRIPT_CHARS * 4L) {
                throw new IOException("Transcript exceeds its encoded byte bound");
            }
            transcript = strictUtf8(decoded);
        }
        return new Result(invocationId, profileId, inputDigest, model, transcript, status,
                body.get("complete").booleanValue(), body.get("endOfTask").booleanValue(),
                body.get("tokenLimitReached").booleanValue());
    }

    private byte[] exchange(byte[] request, long callDeadline,
            MediaRuntimeContracts.ProcessingContext.MonotonicDeadline sharedDeadline) throws IOException {
        try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX);
                Selector selector = Selector.open()) {
            channel.configureBlocking(false);
            try {
                if (!channel.connect(UnixDomainSocketAddress.of(socketPath))) {
                    SelectionKey key = channel.register(selector, SelectionKey.OP_CONNECT);
                    long connectDeadline = Math.min(callDeadline, deadline(connectTimeout));
                    while (!channel.finishConnect()) {
                        if (!awaitReady(selector, key, SelectionKey.OP_CONNECT, connectDeadline)) {
                            if (sharedDeadline != null && sharedDeadline.expired()) {
                                throw new PreTransmissionNoEffectException(Status.DEADLINE_EXCEEDED);
                            }
                            throw new PreTransmissionNoEffectException(Status.NOT_ADMITTED);
                        }
                    }
                }
            } catch (PreTransmissionNoEffectException knownNoEffect) {
                throw knownNoEffect;
            } catch (IOException connectFailure) {
                throw new PreTransmissionNoEffectException(Status.NOT_ADMITTED);
            }
            ByteBuffer framed = ByteBuffer.allocate(4 + request.length).putInt(request.length).put(request);
            framed.flip();
            SelectionKey key = channel.keyFor(selector);
            if (key == null) key = channel.register(selector, SelectionKey.OP_WRITE);
            else key.interestOps(SelectionKey.OP_WRITE);
            long writeDeadline = Math.min(callDeadline, deadline(writeTimeout));
            int sentBytes = 0;
            while (framed.hasRemaining()) {
                if (sharedDeadline != null && sharedDeadline.expired()) {
                    if (sentBytes == 0) throw new PreTransmissionNoEffectException(Status.DEADLINE_EXCEEDED);
                    throw new UnknownOutcomeException(new IOException("deadline elapsed after request transmission began"));
                }
                if (System.nanoTime() >= writeDeadline) {
                    if (sentBytes == 0) {
                        throw new PreTransmissionNoEffectException(sharedDeadline != null && sharedDeadline.expired()
                                ? Status.DEADLINE_EXCEEDED : Status.NOT_ADMITTED);
                    }
                    throw new IOException("Broker request write timed out before completion");
                }
                int written = channel.write(framed);
                sentBytes += written;
                if (written == 0 && !awaitReady(selector, key, SelectionKey.OP_WRITE, writeDeadline)) {
                    if (sentBytes == 0) {
                        throw new PreTransmissionNoEffectException(sharedDeadline != null && sharedDeadline.expired()
                                ? Status.DEADLINE_EXCEEDED : Status.NOT_ADMITTED);
                    }
                    throw new IOException("Broker request write timed out before completion");
                }
            }
            try { channel.shutdownOutput(); }
            catch (IOException shutdownFailure) { throw new UnknownOutcomeException(shutdownFailure); }
            key.interestOps(SelectionKey.OP_READ);
            try {
                ByteBuffer header = ByteBuffer.allocate(4);
                if (readFully(channel, selector, key, header, callDeadline) != 4) {
                    throw new IOException("Truncated broker response header");
                }
                header.flip();
                int length = header.getInt();
                if (length < 0 || length > MAX_RESPONSE_BYTES) throw new IOException("Broker response out of bounds");
                ByteBuffer body = ByteBuffer.allocate(length);
                if (readFully(channel, selector, key, body, callDeadline) != length) {
                    throw new IOException("Truncated broker response body");
                }
                return body.array();
            } catch (IOException failure) {
                throw new UnknownOutcomeException(failure);
            }
        }
    }

    private String readToken() throws IOException {
        try {
            if (Files.isSymbolicLink(tokenFile)) throw new IOException("Whisper broker token must not be a symlink");
            BasicFileAttributes attributes = Files.readAttributes(tokenFile, BasicFileAttributes.class,
                    LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isRegularFile()) throw new IOException("Whisper broker token must be a regular file");
            if (!Files.getPosixFilePermissions(tokenFile, LinkOption.NOFOLLOW_LINKS)
                    .equals(PosixFilePermissions.fromString("rw-------"))) {
                throw new IOException("Whisper broker token must have owner-only 0600 permissions");
            }
        } catch (UnsupportedOperationException unsupported) {
            throw new IOException("Owner-only token permissions cannot be verified", unsupported);
        }
        byte[] tokenBytes;
        try (ReadableByteChannel channel = Files.newByteChannel(tokenFile,
                Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS));
                ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            ByteBuffer buffer = ByteBuffer.allocate(512);
            while (channel.read(buffer) >= 0) {
                buffer.flip();
                if (bytes.size() + buffer.remaining() > 4096) throw new IOException("Whisper broker token is too large");
                byte[] chunk = new byte[buffer.remaining()];
                buffer.get(chunk);
                bytes.write(chunk);
                buffer.clear();
            }
            tokenBytes = bytes.toByteArray();
        }
        String token;
        try { token = strictUtf8(tokenBytes).trim(); }
        catch (CharacterCodingException malformed) { throw new IOException("Whisper broker token is not UTF-8", malformed); }
        if (token.length() < 32 || token.length() > 4096) throw new IOException("Invalid Whisper broker token");
        return token;
    }

    private static String validateIdentity(UUID invocationId, String profileId, String locale, String digest) {
        Objects.requireNonNull(invocationId, "invocationId");
        if (profileId == null || profileId.length() > 128 || !profileId.matches("[A-Za-z0-9][A-Za-z0-9._:-]*"))
            throw new IllegalArgumentException("profileId must be a bounded identifier");
        if (digest == null || !digest.matches("[0-9a-f]{64}"))
            throw new IllegalArgumentException("sourceSha256 must be a lowercase SHA-256 digest");
        if (locale == null || locale.isBlank() || locale.length() > 35 || !locale.equals(locale.trim()))
            throw new IllegalArgumentException("locale must be a valid BCP-47 language tag");
        java.util.Locale parsed = new java.util.Locale.Builder().setLanguageTag(locale).build();
        if (parsed.getLanguage().isBlank() || "und".equals(parsed.toLanguageTag()))
            throw new IllegalArgumentException("locale must include a language subtag");
        return parsed.toLanguageTag();
    }

    private static void identity(ObjectNode payload, UUID invocationId, String profileId, String locale,
            String digest) {
        payload.put("invocationId", invocationId.toString());
        payload.put("profileId", profileId);
        payload.put("locale", locale);
        payload.put("sourceSha256", digest);
    }

    private static void requireExactFields(JsonNode object, Set<String> allowed, Set<String> required)
            throws IOException {
        ((ObjectNode) object).properties().forEach(entry -> {
            if (!allowed.contains(entry.getKey())) throw new IllegalArgumentException(entry.getKey());
        });
        for (String field : required) if (!object.has(field)) throw new IOException("Missing field " + field);
    }
    private static boolean textEquals(JsonNode node, String field, String value) {
        return node.has(field) && node.get(field).isTextual() && value.equals(node.get(field).textValue());
    }
    private static String nullableText(JsonNode node, String field) throws IOException {
        if (!node.has(field)) return null;
        if (!node.get(field).isTextual()) throw new IOException("Invalid " + field);
        return node.get(field).textValue();
    }
    private static Result unknown(UUID id, String profile, String digest) {
        return new Result(id, profile, digest, null, "", Status.UNKNOWN_OUTCOME, false, false, false);
    }
    private static String writeJson(JsonNode node) throws IOException { return JSON.writeValueAsString(node); }
    private static String strictUtf8(byte[] bytes) throws CharacterCodingException {
        return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
    }
    private static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static String hmac(String token, String message) throws IOException {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception failure) { throw new IOException("Broker HMAC unavailable", failure); }
    }
    private byte[] randomBytes(int size) { byte[] bytes = new byte[size]; random.nextBytes(bytes); return bytes; }
    private static java.time.Duration positive(java.time.Duration value, String name) {
        Objects.requireNonNull(value, name);
        if (value.isNegative() || value.isZero()) throw new IllegalArgumentException(name + " must be positive");
        return value;
    }
    private static long deadline(java.time.Duration timeout) { return System.nanoTime() + timeout.toNanos(); }
    private static long deadline(long millis) { return System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(millis); }
    private static long deadlineNanos(long nanos) { return System.nanoTime() + nanos; }

    private static final class PreTransmissionNoEffectException extends IOException {
        private final Status status;
        private PreTransmissionNoEffectException(Status status) { this.status = status; }
    }
    private long executeCallTimeoutMillis(long remainingBudgetMillis) {
        long withGrace = remainingBudgetMillis + protocolGrace.toMillis();
        return Math.min(MAX_EXECUTE_CALL_MILLIS, withGrace);
    }
    private static boolean awaitReady(Selector selector, SelectionKey key, int operation, long deadline)
            throws IOException {
        while (true) {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) return false;
            key.interestOps(operation);
            int ready = selector.select(Math.max(1, TimeUnit.NANOSECONDS.toMillis(remaining)));
            if (ready == 0) continue;
            var iterator = selector.selectedKeys().iterator();
            while (iterator.hasNext()) {
                SelectionKey selected = iterator.next(); iterator.remove();
                if (selected == key && selected.isValid() && (selected.readyOps() & operation) != 0) return true;
            }
        }
    }
    private static int readFully(SocketChannel channel, Selector selector, SelectionKey key,
            ByteBuffer buffer, long deadline) throws IOException {
        int total = 0;
        while (buffer.hasRemaining()) {
            if (System.nanoTime() >= deadline) throw new IOException("Broker response timed out");
            int read = channel.read(buffer);
            if (read < 0) return total;
            total += read;
            if (read == 0 && !awaitReady(selector, key, SelectionKey.OP_READ, deadline))
                throw new IOException("Broker response timed out");
        }
        return total;
    }
    private static final class UnknownOutcomeException extends IOException {
        private UnknownOutcomeException(Throwable cause) { super("Broker result unavailable after request write", cause); }
    }
}
