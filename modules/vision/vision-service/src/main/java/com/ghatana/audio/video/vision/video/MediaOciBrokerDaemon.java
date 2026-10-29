package com.ghatana.audio.video.vision.video;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Narrow authenticated host/CRI broker for production OCI vision workers.
 *
 * <p>This is a separate privileged helper process — the Media JVM never holds the
 * Docker socket or CLI. It listens on an owner-only Unix domain socket and
 * accepts a single bounded operation: launch one sandboxed worker against a
 * digest-pinned image. Every request must carry an HMAC-SHA256 proof over the
 * request body under a shared broker token supplied via a 0600 file; the token
 * itself never crosses the socket.
 *
 * <p>The broker enforces the sandbox server-side: network=none, read-only root
 * fs, no capabilities, unprivileged uid, cgroup memory/CPU/PID/fd ceilings,
 * exactly one read-only source mount and one private output mount, entrypoint
 * restricted to ffmpeg/ffprobe inside the pinned image. Callers cannot widen any
 * of it — only the executable name, bounded arguments, bounded output ceiling,
 * source file and output directory are request fields.
 */
public final class MediaOciBrokerDaemon {

    private static final Pattern IMAGE = Pattern.compile("(?:[^\\s,@]+@)?sha256:[a-f0-9]{64}");
    private static final Pattern NAME = Pattern.compile("[a-z0-9][a-z0-9_.-]{0,127}");
    private static final Pattern EXECUTABLE = Pattern.compile("ffmpeg|ffprobe");
    private static final Pattern CONTAINER_ID = Pattern.compile("[a-f0-9]{64}");
    private static final long MEMORY_BYTES = 1_610_612_736L;
    private static final long CPU_NANOS = 2_000_000_000L;
    private static final int PID_LIMIT = 32;
    private static final int FD_LIMIT = 64;
    private static final long OUTPUT_FILE_LIMIT = 512L * 1024 * 1024;
    private static final int MAX_ARGS = 64;
    private static final int MAX_REQUEST_BYTES = 64 * 1024;
    private static final int OUTPUT_TAIL = 8192;

    private MediaOciBrokerDaemon() { }

    public static void main(String[] args) throws Exception {
        String socketPath = System.getenv("MEDIA_OCI_BROKER_SOCKET");
        String tokenFile = System.getenv("MEDIA_OCI_BROKER_TOKEN_FILE");
        String sourceRoot = System.getenv("MEDIA_OCI_BROKER_SOURCE_ROOT");
        String outputRoot = System.getenv("MEDIA_OCI_BROKER_OUTPUT_ROOT");
        String docker = System.getenv().getOrDefault("MEDIA_OCI_BROKER_DOCKER_CLI", "docker");
        if (blank(socketPath) || blank(tokenFile) || blank(sourceRoot) || blank(outputRoot)) {
            System.err.println("MEDIA_OCI_BROKER_SOCKET, _TOKEN_FILE, _SOURCE_ROOT and _OUTPUT_ROOT are required");
            System.exit(2);
        }
        String token = Files.readString(Path.of(tokenFile)).trim();
        if (token.length() < 32) {
            System.err.println("Broker token must be at least 32 bytes");
            System.exit(2);
        }
        Path root = Path.of(sourceRoot).toRealPath();
        Path out = Path.of(outputRoot).toRealPath();
        Path socket = Path.of(socketPath);
        Files.deleteIfExists(socket);
        try (ServerSocketChannel server = ServerSocketChannel.open(
                java.net.StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socket));
            Files.setPosixFilePermissions(socket, PosixFilePermissions.fromString("rw-------"));
            System.err.println("Media OCI broker listening on " + socket);
            while (true) {
                try (SocketChannel client = server.accept()) {
                    handle(client, token, docker, root, out);
                } catch (Exception failure) {
                    System.err.println("broker request failed: " + failure.getClass().getSimpleName());
                }
            }
        }
    }

    private static void handle(SocketChannel client, String token, String docker,
            Path sourceRoot, Path outputRoot) throws Exception {
        byte[] body = readFrame(client, MAX_REQUEST_BYTES);
        if (body == null) { writeResult(client, -1, "unauthenticated"); return; }
        String request = new String(body, StandardCharsets.UTF_8);
        String expected = field(request, "proof");
        String nonce = field(request, "nonce");
        String payload = object(request, "payload");
        if (expected == null || nonce == null || payload == null
                || nonce.length() < 16 || nonce.length() > 128) {
            writeResult(client, -1, "unauthenticated"); return;
        }
        if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                hmac(token, nonce + "\n" + payload).getBytes(StandardCharsets.UTF_8))) {
            writeResult(client, -1, "unauthenticated"); return;
        }
        String image = field(payload, "image");
        String name = field(payload, "name");
        String executable = field(payload, "executable");
        String source = field(payload, "source");
        String output = field(payload, "output");
        List<String> workerArgs = array(payload, "args");
        long timeout = number(payload, "timeoutMs", 60_000, 1_000, 900_000);
        long outLimit = number(payload, "outputLimit", OUTPUT_FILE_LIMIT, 1, OUTPUT_FILE_LIMIT);
        long uid = number(payload, "uid", 0, 1, Integer.MAX_VALUE);
        long gid = number(payload, "gid", 0, 0, Integer.MAX_VALUE);
        if (image == null || !IMAGE.matcher(image).matches()
                || name == null || !NAME.matcher(name).matches()
                || executable == null || !EXECUTABLE.matcher(executable).matches()
                || uid <= 0 || workerArgs.size() > MAX_ARGS) {
            writeResult(client, -2, "rejected"); return;
        }
        Path sourcePath = source == null ? null : Path.of(source).toRealPath();
        Path outputPath = output == null ? null : Path.of(output).toRealPath();
        if (sourcePath != null && (!sourcePath.startsWith(sourceRoot)
                || !Files.isRegularFile(sourcePath))) {
            writeResult(client, -2, "rejected"); return;
        }
        if (outputPath != null
                && (!outputPath.startsWith(outputRoot) || !Files.isDirectory(outputPath))) {
            writeResult(client, -2, "rejected"); return;
        }
        writeResult(client, 0, runWorker(docker, image, name, executable, workerArgs,
                sourcePath, outputPath, uid, gid, Duration.ofMillis(timeout), outLimit));
    }

    private static String runWorker(String docker, String image, String name,
            String executable, List<String> workerArgs, Path source, Path output,
            long uid, long gid, Duration timeout, long outputLimit) throws IOException {
        List<String> create = new ArrayList<>(List.of(docker, "create", "--name", name,
                "--pull=never", "--platform=linux/arm64",
                "--label", "com.ghatana.media.vision.worker=true",
                "--memory=" + MEMORY_BYTES, "--memory-swap=" + MEMORY_BYTES, "--cpus=2",
                "--pids-limit=" + PID_LIMIT, "--ulimit=nofile=" + FD_LIMIT + ":" + FD_LIMIT,
                "--ulimit=fsize=" + outputLimit + ":" + outputLimit,
                "--network=none", "--read-only", "--cap-drop=ALL",
                "--security-opt=no-new-privileges:true", "--init", "--stop-timeout=2",
                "--tmpfs", "/tmp:rw,nosuid,nodev,exec,size=128m,nr_inodes=4096",
                "--user=" + uid + ":" + gid, "--workdir=/tmp",
                "--env=HOME=/tmp", "--env=TMPDIR=/tmp", "--env=PATH=/usr/bin:/bin",
                "--env=LANG=C.UTF-8", "--env=LC_ALL=C.UTF-8"));
        if (source != null) {
            create.addAll(List.of("--mount",
                    "type=bind,source=" + source + ",target=/source/input,readonly"));
        }
        if (output != null) {
            create.addAll(List.of("--mount", "type=bind,source=" + output + ",target=/output"));
        }
        create.add("--entrypoint=/usr/bin/" + executable);
        create.add(image);
        create.addAll(workerArgs);
        try {
            CommandResult created = run(create, Duration.ofSeconds(15));
            String id = created.output().trim();
            if (created.exitCode() != 0 || !CONTAINER_ID.matcher(id).matches()) {
                remove(docker, name);
                return "create-failed";
            }
            CommandResult started = run(List.of(docker, "start", "--attach", id), timeout);
            boolean timedOut = started.timedOut();
            if (timedOut) kill(docker, id);
            CommandResult oom = run(List.of(docker, "inspect",
                    "--format", "{{.State.OOMKilled}}", id), Duration.ofSeconds(10));
            long outputBytes = output != null && Files.exists(output)
                    ? Files.walk(output).filter(Files::isRegularFile)
                            .mapToLong(p -> { try { return Files.size(p); } catch (IOException e) { return 0L; } })
                            .sum() : 0L;
            remove(docker, id);
            String tail = started.output().length() > OUTPUT_TAIL
                    ? started.output().substring(started.output().length() - OUTPUT_TAIL)
                    : started.output();
            return "{\"exitCode\":" + (timedOut ? -1 : started.exitCode())
                    + ",\"timedOut\":" + timedOut
                    + ",\"oomKilled\":" + oom.output().trim().equals("true")
                    + ",\"outputBytes\":" + outputBytes
                    + ",\"outputExceeded\":" + (outputBytes > outputLimit)
                    + ",\"tail\":" + json(tail) + "}";
        } catch (IOException failure) {
            remove(docker, name);
            throw failure;
        }
    }

    private static CommandResult run(List<String> command, Duration timeout) throws IOException {
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        StringBuilder captured = new StringBuilder();
        Thread drain = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null && captured.length() < 1_000_000) {
                    captured.append(line).append('\n');
                }
            } catch (IOException ignored) { }
        });
        drain.setDaemon(true);
        drain.start();
        try {
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                process.destroyForcibly();
                process.waitFor(2, TimeUnit.SECONDS);
                return new CommandResult(-1, captured.toString(), true);
            }
            return new CommandResult(process.exitValue(), captured.toString(), false);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
            return new CommandResult(-1, captured.toString(), true);
        }
    }

    private static void remove(String docker, String id) throws IOException {
        run(List.of(docker, "rm", "--force", id), Duration.ofSeconds(5));
    }

    private static void kill(String docker, String id) throws IOException {
        run(List.of(docker, "kill", "--signal=KILL", id), Duration.ofSeconds(5));
    }

    private static byte[] readFrame(SocketChannel channel, int limit) throws IOException {
        ByteBuffer header = ByteBuffer.allocate(4);
        int read = readFully(channel, header);
        if (read < 4) return null;
        header.flip();
        int length = header.getInt();
        if (length < 0 || length > limit) return null;
        ByteBuffer body = ByteBuffer.allocate(length);
        if (readFully(channel, body) < length) return null;
        return body.array();
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

    private static void writeResult(SocketChannel channel, int status, String jsonBody)
            throws IOException {
        String frame = "{\"status\":" + status + ",\"body\":" + json(jsonBody) + "}";
        byte[] bytes = frame.getBytes(StandardCharsets.UTF_8);
        ByteBuffer out = ByteBuffer.allocate(4 + bytes.length);
        out.putInt(bytes.length);
        out.put(bytes);
        out.flip();
        while (out.hasRemaining()) channel.write(out);
    }

    /** Extracts a raw nested object value ({...}) with balanced braces. */
    private static String object(String json, String name) {
        String key = "\"" + name + "\":";
        int start = json.indexOf(key);
        if (start < 0) return null;
        int open = start + key.length();
        if (open >= json.length() || json.charAt(open) != '{') return null;
        int depth = 0;
        boolean inString = false;
        boolean escaped = false;
        for (int i = open; i < json.length(); i++) {
            char c = json.charAt(i);
            if (escaped) { escaped = false; continue; }
            if (inString) {
                if (c == '\\') escaped = true;
                else if (c == '"') inString = false;
                continue;
            }
            if (c == '"') inString = true;
            else if (c == '{') depth++;
            else if (c == '}') {
                depth--;
                if (depth == 0) return json.substring(open, i + 1);
            }
        }
        return null;
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
            if (c == '"') return unescape(json.substring(cursor, i));
        }
        return null;
    }

    private static List<String> array(String json, String name) {
        String key = "\"" + name + "\":[";
        int start = json.indexOf(key);
        if (start < 0) return List.of();
        int end = json.indexOf(']', start + key.length());
        if (end < 0) return List.of();
        String inside = json.substring(start + key.length(), end).trim();
        List<String> values = new ArrayList<>();
        if (inside.isEmpty()) return values;
        int cursor = 0;
        while (cursor < inside.length()) {
            int open = inside.indexOf('"', cursor);
            if (open < 0) break;
            int close = inside.indexOf('"', open + 1);
            if (close < 0) break;
            values.add(unescape(inside.substring(open + 1, close)));
            cursor = close + 1;
        }
        return values;
    }

    private static long number(String json, String name, long fallback, long min, long max) {
        String key = "\"" + name + "\":";
        int start = json.indexOf(key);
        if (start < 0) return fallback;
        int end = start + key.length();
        int cursor = end;
        while (cursor < json.length() && (Character.isDigit(json.charAt(cursor)) || json.charAt(cursor) == '-')) cursor++;
        try {
            long value = Long.parseLong(json.substring(end, cursor));
            return Math.max(min, Math.min(value, max));
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private static String json(String value) {
        StringBuilder out = new StringBuilder("\"");
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
        return out.append('"').toString();
    }

    private static String unescape(String value) {
        return value.replace("\\n", "\n").replace("\\r", "\r")
                .replace("\\t", "\t").replace("\\\"", "\"").replace("\\\\", "\\");
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }

    private record CommandResult(int exitCode, String output, boolean timedOut) { }
}
