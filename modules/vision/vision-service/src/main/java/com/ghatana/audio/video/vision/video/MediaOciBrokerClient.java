package com.ghatana.audio.video.vision.video;

import java.io.IOException;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.nio.channels.SocketChannel;
import java.nio.channels.Channels;
import java.nio.file.LinkOption;
import java.nio.file.StandardOpenOption;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HexFormat;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Media-side client for the authenticated host OCI broker. The JVM never invokes
 * Docker directly in this mode: it sends one bounded worker launch over a
 * broker-owned, peer-group-only Unix socket with an HMAC-SHA256 proof under a
 * separate peer-owned 0600 client-token copy.
 */
public final class MediaOciBrokerClient implements MediaOciBroker {

    private static final int MAX_REQUEST_BYTES = 64 * 1024;
    private static final int MAX_RESPONSE_BYTES = 128 * 1024;
    private static final java.time.Duration DEFAULT_CONNECT_TIMEOUT = java.time.Duration.ofSeconds(2);
    private static final java.time.Duration DEFAULT_WRITE_TIMEOUT = java.time.Duration.ofSeconds(2);
    private static final java.time.Duration DEFAULT_RESPONSE_TIMEOUT = java.time.Duration.ofSeconds(30);

    private final Path socketPath;
    private final Path tokenFile;
    private final java.time.Duration connectTimeout;
    private final java.time.Duration writeTimeout;
    private final java.time.Duration responseTimeout;
    private final SecureRandom random = new SecureRandom();

    public MediaOciBrokerClient(Path socketPath, Path tokenFile) {
        this(socketPath, tokenFile, DEFAULT_CONNECT_TIMEOUT, DEFAULT_WRITE_TIMEOUT,
                DEFAULT_RESPONSE_TIMEOUT);
    }

    MediaOciBrokerClient(Path socketPath, Path tokenFile, java.time.Duration connectTimeout,
            java.time.Duration writeTimeout, java.time.Duration responseTimeout) {
        this.socketPath = java.util.Objects.requireNonNull(socketPath, "socketPath");
        this.tokenFile = java.util.Objects.requireNonNull(tokenFile, "tokenFile");
        this.connectTimeout = positive(connectTimeout, "connectTimeout");
        this.writeTimeout = positive(writeTimeout, "writeTimeout");
        this.responseTimeout = positive(responseTimeout, "responseTimeout");
    }

    @Override
    public WorkerResult execute(WorkerLaunch launch) throws IOException {
        if (!MediaOciBrokerPolicy.ownerOnlyFile(tokenFile)) {
            throw new IOException("Broker token file must be a regular owner-only file");
        }
        String token;
        try (var channel = Files.newByteChannel(tokenFile,
                     java.util.Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS));
             var input = Channels.newInputStream(channel)) {
            byte[] encoded = input.readNBytes(4097);
            if (encoded.length > 4096) throw new IOException("Broker token file is too large");
            token = new String(encoded, StandardCharsets.UTF_8).trim();
        }
        if (token.length() < 32) throw new IOException("Broker token is too short");
        String nonce = HexFormat.of().formatHex(randomBytes(16));
        StringBuilder payload = new StringBuilder("{");
        payload.append("\"image\":\"").append(escape(launch.imageDigest())).append("\",");
        payload.append("\"name\":\"").append(escape(launch.containerName())).append("\",");
        payload.append("\"executable\":\"").append(escape(launch.executable())).append("\",");
        payload.append("\"source\":").append(launch.sourceFile() == null
                ? "null" : "\"" + escape(launch.sourceFile()) + "\"").append(',');
        payload.append("\"sourceSha256\":").append(launch.sourceSha256() == null
                ? "null" : "\"" + escape(launch.sourceSha256()) + "\"").append(',');
        payload.append("\"output\":").append(launch.outputDirectory() == null
                ? "null" : "\"" + escape(launch.outputDirectory()) + "\"").append(',');
        payload.append("\"args\":[");
        for (int i = 0; i < launch.workerArgs().size(); i++) {
            if (i > 0) payload.append(',');
            payload.append('"').append(escape(launch.workerArgs().get(i))).append('"');
        }
        payload.append("],");
        payload.append("\"timeoutMs\":").append(launch.timeout().toMillis()).append(',');
        payload.append("\"outputLimit\":").append(launch.maximumOutputBytes()).append(',');
        payload.append("\"uid\":").append(launch.uid()).append(',');
        payload.append("\"gid\":").append(launch.gid()).append('}');
        long issuedAt = System.currentTimeMillis();
        String proof;
        try {
            proof = hmac(token, nonce + "\n" + issuedAt + "\n" + payload);
        } catch (Exception failure) {
            throw new IOException("Broker proof unavailable", failure);
        }
        String request = "{\"nonce\":\"" + nonce + "\",\"ts\":" + issuedAt
                + ",\"proof\":\"" + proof + "\",\"payload\":" + payload + "}";
        String response = exchange(request);
        long status = number(response, "status", -1);
        String body = unquote(field(response, "body"));
        if (status != 0) {
            throw new IOException("OCI broker rejected the worker launch: " + body);
        }
        return new WorkerResult(
                !bool(body, "timedOut", false),
                (int) number(body, "exitCode", -1),
                bool(body, "timedOut", false),
                bool(body, "oomKilled", false),
                bool(body, "outputExceeded", false),
                unquote(field(body, "tail")));
    }

    private String exchange(String request) throws IOException {
        byte[] bytes = request.getBytes(StandardCharsets.UTF_8);
        if (bytes.length == 0 || bytes.length > MAX_REQUEST_BYTES) {
            throw new IOException("Broker request exceeds its framed byte limit");
        }
        try (SocketChannel channel = SocketChannel.open(java.net.StandardProtocolFamily.UNIX)) {
            channel.configureBlocking(false);
            try (Selector selector = Selector.open()) {
                long connectDeadline = deadline(connectTimeout);
                if (!channel.connect(UnixDomainSocketAddress.of(socketPath))) {
                    SelectionKey key = channel.register(selector, SelectionKey.OP_CONNECT);
                    while (!channel.finishConnect()) {
                        if (!awaitReady(selector, key, SelectionKey.OP_CONNECT, connectDeadline)) {
                            throw new IOException("Broker connection timed out before request transmission");
                        }
                    }
                }
                ByteBuffer out = ByteBuffer.allocate(4 + bytes.length);
                out.putInt(bytes.length);
                out.put(bytes);
                out.flip();
                SelectionKey key = channel.keyFor(selector);
                if (key == null) key = channel.register(selector, SelectionKey.OP_WRITE);
                else key.interestOps(SelectionKey.OP_WRITE);
                long writeDeadline = deadline(writeTimeout);
                while (out.hasRemaining()) {
                    if (System.nanoTime() >= writeDeadline) {
                        throw new IOException("Broker request write timed out before completion");
                    }
                    if (channel.write(out) == 0
                            && !awaitReady(selector, key, SelectionKey.OP_WRITE, writeDeadline)) {
                        throw new IOException("Broker request write timed out before completion");
                    }
                }
                if (System.nanoTime() >= writeDeadline) {
                    throw new UnknownOutcomeException(
                            "UNKNOWN_OUTCOME: broker may have accepted the completed launch request",
                            new IOException("Broker request write deadline elapsed"));
                }
                try {
                    channel.shutdownOutput();
                } catch (IOException shutdownFailure) {
                    throw new UnknownOutcomeException(
                            "UNKNOWN_OUTCOME: broker may have accepted the completed launch request",
                            shutdownFailure);
                }
                key.interestOps(SelectionKey.OP_READ);
                long responseDeadline = deadline(responseTimeout);
                try {
                    ByteBuffer header = ByteBuffer.allocate(4);
                    if (readFully(channel, selector, key, header, responseDeadline) < 4) {
                        throw new IOException("Broker truncated response");
                    }
                    header.flip();
                    int length = header.getInt();
                    if (length < 0 || length > MAX_RESPONSE_BYTES) {
                        throw new IOException("Broker response out of bounds");
                    }
                    ByteBuffer body = ByteBuffer.allocate(length);
                    if (readFully(channel, selector, key, body, responseDeadline) < length) {
                        throw new IOException("Broker truncated response body");
                    }
                    return new String(body.array(), StandardCharsets.UTF_8);
                } catch (IOException responseFailure) {
                    throw new UnknownOutcomeException(
                            "UNKNOWN_OUTCOME: broker did not return a complete launch result", responseFailure);
                }
            }
        }
    }

    private static int readFully(SocketChannel channel, Selector selector, SelectionKey key,
            ByteBuffer buffer, long deadline) throws IOException {
        int total = 0;
        while (buffer.hasRemaining()) {
            if (System.nanoTime() >= deadline) throw new IOException("Broker response read timed out");
            int n = channel.read(buffer);
            if (n < 0) return total;
            total += n;
            if (n == 0 && !awaitReady(selector, key, SelectionKey.OP_READ, deadline)) {
                throw new IOException("Broker response read timed out");
            }
        }
        return total;
    }

    private static boolean awaitReady(Selector selector, SelectionKey key, int operation, long deadline)
            throws IOException {
        while (true) {
            long remainingNanos = deadline - System.nanoTime();
            if (remainingNanos <= 0) return false;
            key.interestOps(operation);
            long millis = Math.max(1L, java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(remainingNanos));
            int ready = selector.select(millis);
            if (ready == 0) continue;
            var selected = selector.selectedKeys().iterator();
            while (selected.hasNext()) {
                SelectionKey selectedKey = selected.next();
                selected.remove();
                if (selectedKey == key && selectedKey.isValid()
                        && (selectedKey.readyOps() & operation) != 0) return true;
            }
        }
    }

    private static long deadline(java.time.Duration timeout) {
        return System.nanoTime() + timeout.toNanos();
    }

    private static java.time.Duration positive(java.time.Duration value, String name) {
        java.time.Duration duration = java.util.Objects.requireNonNull(value, name);
        if (duration.isZero() || duration.isNegative()) {
            throw new IllegalArgumentException(name + " must be positive");
        }
        return duration;
    }

    /** A launch was completely written, but no definitive broker result arrived. */
    public static final class UnknownOutcomeException extends IOException {
        public UnknownOutcomeException(String message, Throwable cause) { super(message, cause); }
        public String code() { return "UNKNOWN_OUTCOME"; }
    }

    private byte[] randomBytes(int length) {
        byte[] value = new byte[length];
        random.nextBytes(value);
        return value;
    }

    private static String hmac(String token, String message) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return HexFormat.of().formatHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
    }

    private static String field(String json, String name) {
        String key = "\"" + name + "\":\"";
        int start = json.indexOf(key);
        if (start < 0) return null;
        int cursor = start + key.length();
        boolean escaped = false;
        for (int i = cursor; i < json.length(); i++) {
            char c = json.charAt(i);
            if (escaped) { escaped = false; continue; }
            if (c == '\\') { escaped = true; continue; }
            if (c == '"') return json.substring(cursor, i);
        }
        return null;
    }

    private static long number(String json, String name, long fallback) {
        String key = "\"" + name + "\":";
        int start = json.indexOf(key);
        if (start < 0) return fallback;
        int end = start + key.length();
        int cursor = end;
        while (cursor < json.length()
                && (Character.isDigit(json.charAt(cursor)) || json.charAt(cursor) == '-')) cursor++;
        try {
            return Long.parseLong(json.substring(end, cursor));
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private static boolean bool(String json, String name, boolean fallback) {
        String key = "\"" + name + "\":";
        int start = json.indexOf(key);
        if (start < 0) return fallback;
        return json.startsWith("true", start + key.length());
    }

    private static String unquote(String value) {
        return value == null ? "" : value.replace("\\n", "\n").replace("\\r", "\r")
                .replace("\\t", "\t").replace("\\\"", "\"").replace("\\\\", "\\");
    }

    private static String escape(String value) {
        StringBuilder out = new StringBuilder();
        for (char c : value.toCharArray()) {
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> out.append(c < 0x20 ? String.format("\\u%04x", (int) c) : c);
            }
        }
        return out.toString();
    }
}
