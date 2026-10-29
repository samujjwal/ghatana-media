package com.ghatana.audio.video.vision.video;

import java.io.IOException;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
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
 * Docker directly in this mode: it sends one bounded worker launch over an
 * owner-only Unix socket with an HMAC-SHA256 proof under a 0600 broker token.
 */
public final class MediaOciBrokerClient implements MediaOciBroker {

    private final Path socketPath;
    private final Path tokenFile;
    private final SecureRandom random = new SecureRandom();

    public MediaOciBrokerClient(Path socketPath, Path tokenFile) {
        this.socketPath = java.util.Objects.requireNonNull(socketPath, "socketPath");
        this.tokenFile = java.util.Objects.requireNonNull(tokenFile, "tokenFile");
    }

    @Override
    public WorkerResult execute(WorkerLaunch launch) throws IOException {
        String token = Files.readString(tokenFile).trim();
        if (token.length() < 32) throw new IOException("Broker token is too short");
        String nonce = HexFormat.of().formatHex(randomBytes(16));
        StringBuilder payload = new StringBuilder("{");
        payload.append("\"image\":\"").append(escape(launch.imageDigest())).append("\",");
        payload.append("\"name\":\"").append(escape(launch.containerName())).append("\",");
        payload.append("\"executable\":\"").append(escape(launch.executable())).append("\",");
        payload.append("\"source\":").append(launch.sourceFile() == null
                ? "null" : "\"" + escape(launch.sourceFile()) + "\"").append(',');
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
        String proof;
        try {
            proof = hmac(token, nonce + "\n" + payload);
        } catch (Exception failure) {
            throw new IOException("Broker proof unavailable", failure);
        }
        String request = "{\"nonce\":\"" + nonce + "\",\"proof\":\"" + proof
                + "\",\"payload\":" + payload + "}";
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
        try (SocketChannel channel = SocketChannel.open(java.net.StandardProtocolFamily.UNIX)) {
            channel.connect(UnixDomainSocketAddress.of(socketPath));
            ByteBuffer out = ByteBuffer.allocate(4 + bytes.length);
            out.putInt(bytes.length);
            out.put(bytes);
            out.flip();
            while (out.hasRemaining()) channel.write(out);
            channel.shutdownOutput();
            ByteBuffer header = ByteBuffer.allocate(4);
            if (readFully(channel, header) < 4) throw new IOException("Broker truncated response");
            header.flip();
            int length = header.getInt();
            if (length < 0 || length > 128 * 1024) throw new IOException("Broker response out of bounds");
            ByteBuffer body = ByteBuffer.allocate(length);
            if (readFully(channel, body) < length) throw new IOException("Broker truncated response body");
            return new String(body.array(), StandardCharsets.UTF_8);
        }
    }

    private static int readFully(SocketChannel channel, ByteBuffer buffer) throws IOException {
        int total = 0;
        while (buffer.hasRemaining()) {
            int n = channel.read(buffer);
            if (n < 0) return total;
            total += n;
        }
        return total;
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
