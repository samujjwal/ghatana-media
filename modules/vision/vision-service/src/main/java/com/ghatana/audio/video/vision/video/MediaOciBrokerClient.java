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
import java.util.List;

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
    private static final int MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
    private static final java.time.Duration DEFAULT_CONNECT_TIMEOUT = java.time.Duration.ofSeconds(2);
    private static final java.time.Duration DEFAULT_WRITE_TIMEOUT = java.time.Duration.ofSeconds(2);
    private static final java.time.Duration DEFAULT_RESPONSE_TIMEOUT = java.time.Duration.ofMinutes(16);

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
        long status;
        String encodedBody;
        try {
            status = requiredNumber(response, "status");
            encodedBody = field(response, "body");
            if (encodedBody == null) throw new IOException("Broker response body is missing or malformed");
        } catch (IOException malformedEnvelope) {
            throw new UnknownOutcomeException("UNKNOWN_OUTCOME: broker response envelope is invalid", malformedEnvelope);
        }
        String body;
        try {
            body = unquote(encodedBody);
        } catch (IOException malformedBody) {
            throw new UnknownOutcomeException("UNKNOWN_OUTCOME: broker response body is malformed", malformedBody);
        }
        if (status == -1 || status == -2) {
            throw new IOException("OCI broker rejected the worker launch: " + body);
        }
        if (status != 0) {
            throw new UnknownOutcomeException("UNKNOWN_OUTCOME: broker returned an unsupported status",
                    new IOException("Unsupported OCI broker status: " + status));
        }
        String responseProof;
        int proofStart;
        try {
            responseProof = unquote(field(body, "proof"));
            proofStart = body.lastIndexOf(",\"proof\":");
        } catch (IOException malformedProof) {
            throw new UnknownOutcomeException("UNKNOWN_OUTCOME: broker response proof field is malformed",
                    malformedProof);
        }
        if (proofStart < 0 || !body.endsWith("}") || responseProof == null
                || !responseProof.matches("[0-9a-f]{64}")) {
            throw new UnknownOutcomeException("UNKNOWN_OUTCOME: broker worker response is not authenticated",
                    new IOException("Broker worker response proof is missing or malformed"));
        }
        String unsignedBody = body.substring(0, proofStart) + "}";
        String expectedProof;
        try {
            expectedProof = hmac(token, "response\n" + nonce + "\n" + issuedAt + "\n" + unsignedBody);
        } catch (Exception failure) {
            throw new UnknownOutcomeException("UNKNOWN_OUTCOME: broker response proof could not be verified", failure);
        }
        if (!MessageDigest.isEqual(expectedProof.getBytes(StandardCharsets.US_ASCII),
                responseProof.getBytes(StandardCharsets.US_ASCII))) {
            throw new UnknownOutcomeException("UNKNOWN_OUTCOME: broker worker response proof did not match",
                    new IOException("Broker worker response proof mismatch"));
        }
        List<OutputFile> outputFiles;
        int exitCode;
        boolean timedOut;
        boolean oomKilled;
        boolean outputExceeded;
        boolean outputRejected;
        long outputBytes;
        String outputTail;
        String decodedOutputTail;
        try {
            long exitCodeValue = requiredNumber(body, "exitCode");
            if (exitCodeValue < Integer.MIN_VALUE || exitCodeValue > Integer.MAX_VALUE) {
                throw new IOException("Broker exit code is outside the supported range");
            }
            exitCode = (int) exitCodeValue;
            timedOut = requiredBoolean(body, "timedOut");
            oomKilled = requiredBoolean(body, "oomKilled");
            outputExceeded = requiredBoolean(body, "outputExceeded");
            outputRejected = requiredBoolean(body, "outputRejected");
            outputBytes = requiredNumber(body, "outputBytes");
            outputTail = field(body, "tail");
            if (outputTail == null) throw new IOException("Broker worker response tail is missing or malformed");
            decodedOutputTail = unquote(outputTail);
            outputFiles = parseOutputFiles(body);
            validateOutputManifest(launch, outputBytes, outputFiles, exitCode, timedOut,
                    oomKilled, outputExceeded, outputRejected);
        } catch (IOException malformed) {
            throw new UnknownOutcomeException("UNKNOWN_OUTCOME: broker returned an invalid output manifest", malformed);
        }
        return new WorkerResult(
                !timedOut,
                exitCode,
                timedOut,
                oomKilled,
                outputExceeded,
                outputRejected,
                decodedOutputTail,
                outputBytes,
                outputFiles);
    }

    private static List<OutputFile> parseOutputFiles(String body) throws IOException {
        String array = rawArray(body, "files");
        if (array == null) throw new IOException("Output manifest is missing");
        List<OutputFile> files = new java.util.ArrayList<>();
        java.util.Set<String> names = new java.util.HashSet<>();
        int cursor = 1;
        while (true) {
            cursor = skipWhitespace(array, cursor);
            if (cursor >= array.length()) throw new IOException("Output manifest array is truncated");
            if (array.charAt(cursor) == ']') break;
            if (array.charAt(cursor) != '{') throw new IOException("Output manifest entry is malformed");
            int end = objectEnd(array, cursor);
            if (end < 0) throw new IOException("Output manifest entry is truncated");
            String item = array.substring(cursor, end + 1);
            String name = unquote(field(item, "name"));
            long size = requiredNumber(item, "size");
            String sha256 = unquote(field(item, "sha256"));
            if (name == null || !name.matches("frame_[0-9]{4,}\\.(?:jpg|jpeg|png|bmp|tiff)|frame\\.(?:jpg|jpeg|png|bmp|tiff)|audio\\.pcm")
                    || !names.add(name) || size <= 0 || sha256 == null || !sha256.matches("[0-9a-f]{64}")) {
                throw new IOException("Output manifest entry is outside the admitted file shape");
            }
            files.add(new OutputFile(name, size, sha256));
            if (files.size() > 10_000) throw new IOException("Output manifest exceeds the file-count limit");
            cursor = end + 1;
            cursor = skipWhitespace(array, cursor);
            if (cursor >= array.length()) throw new IOException("Output manifest array is truncated");
            if (array.charAt(cursor) == ',') {
                cursor = skipWhitespace(array, cursor + 1);
                if (cursor >= array.length() || array.charAt(cursor) == ']' || array.charAt(cursor) == ',') {
                    throw new IOException("Output manifest has a trailing or empty entry");
                }
            } else if (array.charAt(cursor) != ']') {
                throw new IOException("Output manifest separator is malformed");
            }
        }
        return List.copyOf(files);
    }

    private static void validateOutputManifest(WorkerLaunch launch, long declaredBytes,
            List<OutputFile> files, int exitCode, boolean timedOut, boolean oomKilled,
            boolean outputExceeded, boolean outputRejected) throws IOException {
        long measuredBytes = 0;
        for (OutputFile file : files) {
            if (file.size() > 32L * 1024 * 1024 || measuredBytes > Long.MAX_VALUE - file.size()) {
                throw new IOException("Output manifest exceeds a per-file or arithmetic bound");
            }
            measuredBytes += file.size();
        }
        if (declaredBytes < 0 || declaredBytes != measuredBytes
                || declaredBytes > launch.maximumOutputBytes()
                || launch.outputDirectory() == null && (declaredBytes != 0 || !files.isEmpty())) {
            throw new IOException("Output manifest byte total does not match the authorized request");
        }
        if ((timedOut || oomKilled || exitCode != 0 || outputExceeded || outputRejected)
                && (declaredBytes != 0 || !files.isEmpty())) {
            throw new IOException("Terminally unsuccessful worker response cannot carry output files");
        }
        if ((outputExceeded || outputRejected) && (declaredBytes != 0 || !files.isEmpty())) {
            throw new IOException("Rejected or over-limit output cannot carry files");
        }
    }

    private static String rawArray(String json, String name) throws IOException {
        int cursor = skipWhitespace(json, 0);
        if (cursor >= json.length() || json.charAt(cursor) != '{') {
            throw new IOException("Broker worker response is not a JSON object");
        }
        int objectDepth = 1;
        int arrayDepth = 0;
        int occurrences = 0;
        String result = null;
        cursor++;
        while (cursor < json.length()) {
            char current = json.charAt(cursor);
            if (current == '"') {
                int keyStart = cursor + 1;
                int keyEnd = jsonStringEnd(json, keyStart);
                String key = unquote(json.substring(keyStart, keyEnd));
                int afterKey = skipWhitespace(json, keyEnd + 1);
                if (objectDepth == 1 && arrayDepth == 0 && key.equals(name)
                        && afterKey < json.length() && json.charAt(afterKey) == ':') {
                    occurrences++;
                    int valueStart = skipWhitespace(json, afterKey + 1);
                    if (valueStart >= json.length() || json.charAt(valueStart) != '[') {
                        throw new IOException("Output manifest field is not an array");
                    }
                    int end = arrayEnd(json, valueStart);
                    if (end < 0) throw new IOException("Output manifest array is truncated");
                    result = json.substring(valueStart, end + 1);
                    cursor = end + 1;
                } else {
                    cursor = keyEnd + 1;
                }
            } else {
                if (current == '{') objectDepth++;
                else if (current == '}') objectDepth--;
                else if (current == '[') arrayDepth++;
                else if (current == ']') arrayDepth--;
                cursor++;
            }
        }
        if (occurrences != 1 || result == null) {
            throw new IOException("Output manifest field is missing or duplicated");
        }
        return result;
    }

    private static int arrayEnd(String json, int open) {
        int depth = 0;
        boolean inString = false;
        boolean escaped = false;
        for (int i = open; i < json.length(); i++) {
            char current = json.charAt(i);
            if (escaped) { escaped = false; continue; }
            if (inString) {
                if (current == '\\') escaped = true;
                else if (current == '"') inString = false;
                continue;
            }
            if (current == '"') inString = true;
            else if (current == '[') depth++;
            else if (current == ']' && --depth == 0) return i;
        }
        return -1;
    }

    private static int objectEnd(String text, int open) {
        int depth = 0;
        boolean inString = false;
        boolean escaped = false;
        for (int i = open; i < text.length(); i++) {
            char c = text.charAt(i);
            if (escaped) { escaped = false; continue; }
            if (inString) {
                if (c == '\\') escaped = true;
                else if (c == '"') inString = false;
                continue;
            }
            if (c == '"') inString = true;
            else if (c == '{') depth++;
            else if (c == '}' && --depth == 0) return i;
        }
        return -1;
    }

    private static int skipWhitespace(String value, int cursor) {
        while (cursor < value.length() && Character.isWhitespace(value.charAt(cursor))) cursor++;
        return cursor;
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

    private static String field(String json, String name) throws IOException {
        int objectDepth = 0;
        int arrayDepth = 0;
        int occurrences = 0;
        String result = null;
        for (int cursor = 0; cursor < json.length();) {
            char current = json.charAt(cursor);
            if (current == '"') {
                int keyStart = cursor + 1;
                int keyEnd = jsonStringEnd(json, keyStart);
                String key = json.substring(keyStart, keyEnd);
                int afterKey = keyEnd + 1;
                while (afterKey < json.length() && Character.isWhitespace(json.charAt(afterKey))) afterKey++;
                if (objectDepth == 1 && arrayDepth == 0 && key.equals(name)
                        && afterKey < json.length() && json.charAt(afterKey) == ':') {
                    int valueStart = afterKey + 1;
                    while (valueStart < json.length() && Character.isWhitespace(json.charAt(valueStart))) valueStart++;
                    if (valueStart >= json.length() || json.charAt(valueStart) != '"') {
                        throw new IOException("Broker JSON field is not a string: " + name);
                    }
                    int valueContentStart = valueStart + 1;
                    int valueEnd = jsonStringEnd(json, valueContentStart);
                    occurrences++;
                    result = json.substring(valueContentStart, valueEnd);
                    cursor = valueEnd + 1;
                } else {
                    cursor = keyEnd + 1;
                }
            } else {
                if (current == '{') objectDepth++;
                else if (current == '}') objectDepth--;
                else if (current == '[') arrayDepth++;
                else if (current == ']') arrayDepth--;
                cursor++;
            }
        }
        if (occurrences > 1) throw new IOException("Broker JSON field is duplicated: " + name);
        return result;
    }

    private static int jsonStringEnd(String json, int contentStart) throws IOException {
        boolean escaped = false;
        for (int cursor = contentStart; cursor < json.length(); cursor++) {
            char value = json.charAt(cursor);
            if (escaped) escaped = false;
            else if (value == '\\') escaped = true;
            else if (value == '"') return cursor;
        }
        throw new IOException("Broker JSON contains an unterminated string");
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

    private static long requiredNumber(String json, String name) throws IOException {
        String token = primitiveValue(json, name);
        if (!token.matches("-?(?:0|[1-9][0-9]*)")) {
            throw new IOException("Broker worker response field is not an integer: " + name);
        }
        try {
            return Long.parseLong(token);
        } catch (NumberFormatException outOfRange) {
            throw new IOException("Broker worker response integer is out of range: " + name, outOfRange);
        }
    }

    private static boolean requiredBoolean(String json, String name) throws IOException {
        return switch (primitiveValue(json, name)) {
            case "true" -> true;
            case "false" -> false;
            default -> throw new IOException("Broker worker response field is not a boolean: " + name);
        };
    }

    private static String primitiveValue(String json, String name) throws IOException {
        int objectDepth = 0;
        int arrayDepth = 0;
        int occurrences = 0;
        String result = null;
        for (int cursor = 0; cursor < json.length();) {
            char current = json.charAt(cursor);
            if (current == '"') {
                int stringStart = cursor + 1;
                int end = stringStart;
                boolean escaped = false;
                for (; end < json.length(); end++) {
                    char value = json.charAt(end);
                    if (escaped) escaped = false;
                    else if (value == '\\') escaped = true;
                    else if (value == '"') break;
                }
                if (end >= json.length()) throw new IOException("Broker response contains an unterminated JSON string");
                String key = json.substring(stringStart, end);
                int afterString = end + 1;
                while (afterString < json.length() && Character.isWhitespace(json.charAt(afterString))) afterString++;
                if (objectDepth == 1 && arrayDepth == 0 && key.equals(name)
                        && afterString < json.length() && json.charAt(afterString) == ':') {
                    occurrences++;
                    int valueStart = afterString + 1;
                    while (valueStart < json.length() && Character.isWhitespace(json.charAt(valueStart))) valueStart++;
                    if (valueStart >= json.length() || json.charAt(valueStart) == '"'
                            || json.charAt(valueStart) == '{' || json.charAt(valueStart) == '[') {
                        throw new IOException("Broker worker response field is not a primitive: " + name);
                    }
                    int valueEnd = valueStart;
                    while (valueEnd < json.length() && json.charAt(valueEnd) != ','
                            && json.charAt(valueEnd) != '}' && json.charAt(valueEnd) != ']'
                            && !Character.isWhitespace(json.charAt(valueEnd))) valueEnd++;
                    if (valueEnd == valueStart) throw new IOException("Broker worker response field is empty: " + name);
                    result = json.substring(valueStart, valueEnd);
                }
                cursor = end + 1;
            } else {
                if (current == '{') objectDepth++;
                else if (current == '}') objectDepth--;
                else if (current == '[') arrayDepth++;
                else if (current == ']') arrayDepth--;
                cursor++;
            }
        }
        if (occurrences != 1 || result == null) {
            throw new IOException("Broker worker response field is missing or duplicated: " + name);
        }
        return result;
    }

    private static boolean bool(String json, String name, boolean fallback) {
        String key = "\"" + name + "\":";
        int start = json.indexOf(key);
        if (start < 0) return fallback;
        return json.startsWith("true", start + key.length());
    }

    private static String unquote(String value) throws IOException {
        if (value == null) return "";
        StringBuilder decoded = new StringBuilder(value.length());
        for (int cursor = 0; cursor < value.length(); cursor++) {
            char current = value.charAt(cursor);
            if (current != '\\') {
                decoded.append(current);
                continue;
            }
            if (++cursor >= value.length()) throw new IOException("Broker JSON string ends with an escape");
            char escaped = value.charAt(cursor);
            switch (escaped) {
                case '"' -> decoded.append('"');
                case '\\' -> decoded.append('\\');
                case '/' -> decoded.append('/');
                case 'b' -> decoded.append('\b');
                case 'f' -> decoded.append('\f');
                case 'n' -> decoded.append('\n');
                case 'r' -> decoded.append('\r');
                case 't' -> decoded.append('\t');
                case 'u' -> {
                    if (cursor + 4 >= value.length()) throw new IOException("Broker JSON unicode escape is truncated");
                    int codeUnit = 0;
                    for (int offset = 1; offset <= 4; offset++) {
                        int digit = Character.digit(value.charAt(cursor + offset), 16);
                        if (digit < 0) throw new IOException("Broker JSON unicode escape is malformed");
                        codeUnit = (codeUnit << 4) | digit;
                    }
                    decoded.append((char) codeUnit);
                    cursor += 4;
                }
                default -> throw new IOException("Broker JSON contains an invalid escape");
            }
        }
        return decoded.toString();
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
