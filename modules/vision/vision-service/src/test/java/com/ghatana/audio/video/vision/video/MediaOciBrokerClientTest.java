package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.Selector;
import java.nio.channels.SelectionKey;
import java.nio.channels.SocketChannel;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaOciBrokerClientTest {

    @TempDir Path root;

    @Test
    void stalledBrokerResponseTimesOutAsUnknownOutcomeWithoutRetry() throws Exception {
        Path socketPath = root.resolve("broker.sock");
        Path tokenFile = root.resolve("broker.token");
        Files.writeString(tokenFile, "t".repeat(64));
        Files.setPosixFilePermissions(tokenFile, PosixFilePermissions.fromString("rw-------"));
        CountDownLatch completeRequestReceived = new CountDownLatch(1);
        CountDownLatch allowServerClose = new CountDownLatch(1);
        AtomicInteger acceptedConnections = new AtomicInteger();
        ExecutorService serverExecutor = Executors.newSingleThreadExecutor();

        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socketPath));
            Future<?> serverTask = serverExecutor.submit(() -> {
                try (SocketChannel connection = server.accept()) {
                    acceptedConnections.incrementAndGet();
                    ByteBuffer header = ByteBuffer.allocate(4);
                    readFully(connection, header);
                    header.flip();
                    int length = header.getInt();
                    assertThat(length).isBetween(1, 64 * 1024);
                    readFully(connection, ByteBuffer.allocate(length));
                    completeRequestReceived.countDown();
                    assertThat(allowServerClose.await(5, TimeUnit.SECONDS)).isTrue();
                } catch (Exception failure) {
                    throw new RuntimeException(failure);
                }
                try {
                    server.configureBlocking(false);
                    try (Selector selector = Selector.open()) {
                        server.register(selector, SelectionKey.OP_ACCEPT);
                        if (selector.select(250) > 0) {
                            try (SocketChannel retry = server.accept()) {
                                if (retry != null) acceptedConnections.incrementAndGet();
                            }
                        }
                    }
                    return null;
                } catch (Exception failure) {
                    throw new RuntimeException(failure);
                }
            });

            var client = new MediaOciBrokerClient(socketPath, tokenFile,
                    Duration.ofSeconds(1), Duration.ofSeconds(1), Duration.ofMillis(150));
            assertThatThrownBy(() -> client.execute(launch()))
                    .isInstanceOf(MediaOciBrokerClient.UnknownOutcomeException.class)
                    .satisfies(failure -> assertThat(
                            ((MediaOciBrokerClient.UnknownOutcomeException) failure).code())
                            .isEqualTo("UNKNOWN_OUTCOME"));
            assertThat(completeRequestReceived.await(1, TimeUnit.SECONDS))
                    .as("broker must have received the complete request before the response timeout")
                    .isTrue();
            allowServerClose.countDown();
            serverTask.get(2, TimeUnit.SECONDS);
            assertThat(acceptedConnections.get()).as("client must not retry an ambiguous launch").isEqualTo(1);
        } finally {
            allowServerClose.countDown();
            serverExecutor.shutdownNow();
            assertThat(serverExecutor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void clientRejectsBroadlyReadableOrSymlinkedTokenFilesBeforeConnecting() throws Exception {
        Path socketPath = root.resolve("missing-broker.sock");
        Path tokenFile = root.resolve("broker.token");
        Files.writeString(tokenFile, "t".repeat(4097));
        Files.setPosixFilePermissions(tokenFile, PosixFilePermissions.fromString("rw-------"));
        var client = new MediaOciBrokerClient(socketPath, tokenFile);
        assertThatThrownBy(() -> client.execute(launch()))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("too large");

        Files.writeString(tokenFile, "t".repeat(64));
        Files.setPosixFilePermissions(tokenFile, PosixFilePermissions.fromString("rw-r--r--"));
        assertThatThrownBy(() -> client.execute(launch()))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("owner-only");

        Path target = root.resolve("private-token");
        Files.writeString(target, "t".repeat(64));
        Files.setPosixFilePermissions(target, PosixFilePermissions.fromString("rw-------"));
        Files.delete(tokenFile);
        Files.createSymbolicLink(tokenFile, target.getFileName());
        assertThat(Files.isSymbolicLink(tokenFile)).isTrue();
        assertThatThrownBy(() -> client.execute(launch()))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("owner-only");
    }

    @Test
    void clientAcceptsOnlyNonceBoundSignedOutputManifest() throws Exception {
        Path socketPath = root.resolve("signed-broker.sock");
        Path tokenFile = root.resolve("signed-broker.token");
        String token = "s".repeat(64);
        Files.writeString(tokenFile, token);
        Files.setPosixFilePermissions(tokenFile, PosixFilePermissions.fromString("rw-------"));
        ExecutorService serverExecutor = Executors.newSingleThreadExecutor();
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socketPath));
            Future<?> serverTask = serverExecutor.submit(() -> {
                try (SocketChannel connection = server.accept()) {
                    String request = readFrame(connection);
                    String nonce = jsonString(request, "nonce");
                    long timestamp = jsonNumber(request, "ts");
                    String unsigned = "{\"exitCode\":0,\"timedOut\":false,\"oomKilled\":false,"
                            + "\"outputBytes\":3,\"outputExceeded\":false,\"outputRejected\":false,"
                            + "\"files\":[{\"name\":\"frame.png\",\"size\":3,\"sha256\":\""
                            + sha("png".getBytes()) + "\"}],\"tail\":\"codec\\nline\"}";
                    String proof = hmac(token, "response\n" + nonce + "\n" + timestamp + "\n" + unsigned);
                    String signedBody = unsigned.substring(0, unsigned.length() - 1)
                            + ",\"proof\":\"" + proof + "\"}";
                    writeFrame(connection, "{\"status\":0,\"body\":" + json(signedBody) + "}");
                } catch (Exception failure) {
                    throw new RuntimeException(failure);
                }
            });

            MediaOciBrokerClient client = new MediaOciBrokerClient(socketPath, tokenFile,
                    Duration.ofSeconds(1), Duration.ofSeconds(1), Duration.ofSeconds(2));
            MediaOciBroker.WorkerLaunch launch = new MediaOciBroker.WorkerLaunch(
                    "worker@sha256:" + "a".repeat(64), "media-vision-test", "ffmpeg",
                    List.of("-nostdin", "-hide_banner", "-loglevel", "error", "-i", "/source/input",
                            "-y", "/output/frame.png"),
                    "/tmp/source", "b".repeat(64),
                    "/tmp/media-vision-output-00000000-0000-0000-0000-000000000000",
                    501, 20, 1024, Duration.ofSeconds(5));
            MediaOciBroker.WorkerResult result = client.execute(launch);
            serverTask.get(2, TimeUnit.SECONDS);
            assertThat(result.completed()).isTrue();
            assertThat(result.outputBytes()).isEqualTo(3);
            assertThat(result.outputFiles()).containsExactly(new MediaOciBroker.OutputFile(
                    "frame.png", 3, sha("png".getBytes())));
            assertThat(result.outputTail()).isEqualTo("codec\nline");
        } finally {
            serverExecutor.shutdownNow();
            assertThat(serverExecutor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void clientTreatsInvalidResponseMacAsUnknownWithoutRetry() throws Exception {
        Path socketPath = root.resolve("tampered-broker.sock");
        Path tokenFile = root.resolve("tampered-broker.token");
        Files.writeString(tokenFile, "z".repeat(64));
        Files.setPosixFilePermissions(tokenFile, PosixFilePermissions.fromString("rw-------"));
        AtomicInteger acceptedConnections = new AtomicInteger();
        ExecutorService serverExecutor = Executors.newSingleThreadExecutor();
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socketPath));
            Future<?> serverTask = serverExecutor.submit(() -> {
                try (SocketChannel connection = server.accept()) {
                    acceptedConnections.incrementAndGet();
                    readFrame(connection);
                    String unsigned = "{\"exitCode\":0,\"timedOut\":false,\"oomKilled\":false,"
                            + "\"outputBytes\":0,\"outputExceeded\":false,\"outputRejected\":false,"
                            + "\"files\":[],\"tail\":\"\"}";
                    String signedBody = unsigned.substring(0, unsigned.length() - 1)
                            + ",\"proof\":\"" + "0".repeat(64) + "\"}";
                    writeFrame(connection, "{\"status\":0,\"body\":" + json(signedBody) + "}");
                } catch (Exception failure) {
                    throw new RuntimeException(failure);
                }
            });
            MediaOciBrokerClient client = new MediaOciBrokerClient(socketPath, tokenFile,
                    Duration.ofSeconds(1), Duration.ofSeconds(1), Duration.ofSeconds(2));
            assertThatThrownBy(() -> client.execute(launch()))
                    .isInstanceOf(MediaOciBrokerClient.UnknownOutcomeException.class)
                    .hasMessageContaining("response proof did not match");
            serverTask.get(2, TimeUnit.SECONDS);
            assertThat(acceptedConnections.get()).isEqualTo(1);
        } finally {
            serverExecutor.shutdownNow();
            assertThat(serverExecutor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void clientTreatsSignedResponseWithMissingTerminalFieldsAsUnknown() throws Exception {
        Path socketPath = root.resolve("incomplete-broker.sock");
        Path tokenFile = root.resolve("incomplete-broker.token");
        String token = "i".repeat(64);
        Files.writeString(tokenFile, token);
        Files.setPosixFilePermissions(tokenFile, PosixFilePermissions.fromString("rw-------"));
        ExecutorService serverExecutor = Executors.newSingleThreadExecutor();
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socketPath));
            Future<?> serverTask = serverExecutor.submit(() -> {
                try (SocketChannel connection = server.accept()) {
                    String request = readFrame(connection);
                    String nonce = jsonString(request, "nonce");
                    long timestamp = jsonNumber(request, "ts");
                    String unsigned = "{\"exitCode\":0,\"oomKilled\":false,"
                            + "\"outputBytes\":0,\"outputExceeded\":false,\"outputRejected\":false,"
                            + "\"files\":[],\"tail\":\"\"}";
                    String proof = hmac(token, "response\n" + nonce + "\n" + timestamp + "\n" + unsigned);
                    String signedBody = unsigned.substring(0, unsigned.length() - 1)
                            + ",\"proof\":\"" + proof + "\"}";
                    writeFrame(connection, "{\"status\":0,\"body\":" + json(signedBody) + "}");
                } catch (Exception failure) {
                    throw new RuntimeException(failure);
                }
            });

            MediaOciBrokerClient client = new MediaOciBrokerClient(socketPath, tokenFile,
                    Duration.ofSeconds(1), Duration.ofSeconds(1), Duration.ofSeconds(2));
            assertThatThrownBy(() -> client.execute(launch()))
                    .isInstanceOf(MediaOciBrokerClient.UnknownOutcomeException.class)
                    .hasMessageContaining("invalid output manifest")
                    .hasRootCauseMessage("Broker worker response field is missing or duplicated: timedOut");
            serverTask.get(2, TimeUnit.SECONDS);
        } finally {
            serverExecutor.shutdownNow();
            assertThat(serverExecutor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void clientTreatsMissingOuterStatusAsUnknown() throws Exception {
        Path socketPath = root.resolve("missing-status-broker.sock");
        Path tokenFile = root.resolve("missing-status-broker.token");
        Files.writeString(tokenFile, "m".repeat(64));
        Files.setPosixFilePermissions(tokenFile, PosixFilePermissions.fromString("rw-------"));
        AtomicInteger acceptedConnections = new AtomicInteger();
        ExecutorService serverExecutor = Executors.newSingleThreadExecutor();
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socketPath));
            Future<?> serverTask = serverExecutor.submit(() -> {
                try (SocketChannel connection = server.accept()) {
                    acceptedConnections.incrementAndGet();
                    readFrame(connection);
                    writeFrame(connection, "{\"body\":\"unauthenticated\"}");
                } catch (Exception failure) {
                    throw new RuntimeException(failure);
                }
            });
            MediaOciBrokerClient client = new MediaOciBrokerClient(socketPath, tokenFile,
                    Duration.ofSeconds(1), Duration.ofSeconds(1), Duration.ofSeconds(2));
            assertThatThrownBy(() -> client.execute(launch()))
                    .isInstanceOf(MediaOciBrokerClient.UnknownOutcomeException.class)
                    .hasMessageContaining("response envelope is invalid");
            serverTask.get(2, TimeUnit.SECONDS);
            assertThat(acceptedConnections.get()).isEqualTo(1);
        } finally {
            serverExecutor.shutdownNow();
            assertThat(serverExecutor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void clientTreatsSignedMalformedDiagnosticEscapeAsUnknown() throws Exception {
        Path socketPath = root.resolve("malformed-tail-broker.sock");
        Path tokenFile = root.resolve("malformed-tail-broker.token");
        String token = "d".repeat(64);
        Files.writeString(tokenFile, token);
        Files.setPosixFilePermissions(tokenFile, PosixFilePermissions.fromString("rw-------"));
        ExecutorService serverExecutor = Executors.newSingleThreadExecutor();
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socketPath));
            Future<?> serverTask = serverExecutor.submit(() -> {
                try (SocketChannel connection = server.accept()) {
                    String request = readFrame(connection);
                    String nonce = jsonString(request, "nonce");
                    long timestamp = jsonNumber(request, "ts");
                    String unsigned = "{\"exitCode\":0,\"timedOut\":false,\"oomKilled\":false,"
                            + "\"outputBytes\":0,\"outputExceeded\":false,\"outputRejected\":false,"
                            + "\"files\":[],\"tail\":\"bad\\q\"}";
                    String proof = hmac(token, "response\n" + nonce + "\n" + timestamp + "\n" + unsigned);
                    String signedBody = unsigned.substring(0, unsigned.length() - 1)
                            + ",\"proof\":\"" + proof + "\"}";
                    writeFrame(connection, "{\"status\":0,\"body\":" + json(signedBody) + "}");
                } catch (Exception failure) {
                    throw new RuntimeException(failure);
                }
            });
            MediaOciBrokerClient client = new MediaOciBrokerClient(socketPath, tokenFile,
                    Duration.ofSeconds(1), Duration.ofSeconds(1), Duration.ofSeconds(2));
            assertThatThrownBy(() -> client.execute(launch()))
                    .isInstanceOf(MediaOciBrokerClient.UnknownOutcomeException.class)
                    .hasMessageContaining("invalid output manifest")
                    .hasRootCauseMessage("Broker JSON contains an invalid escape");
            serverTask.get(2, TimeUnit.SECONDS);
        } finally {
            serverExecutor.shutdownNow();
            assertThat(serverExecutor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void clientTreatsMalformedOutputManifestAsUnknown() throws Exception {
        String file = "\"name\":\"frame.png\",\"size\":3,\"sha256\":\"" + "a".repeat(64) + "\"";
        String prefix = "{\"exitCode\":0,\"timedOut\":false,\"oomKilled\":false,"
                + "\"outputBytes\":3,\"outputExceeded\":false,\"outputRejected\":false,\"files\":";
        String suffix = ",\"tail\":\"\"}";
        assertSignedManifestUnknown("m1", prefix + "[{\"name\":\"frame.png\",\"size\":3junk,\"sha256\":\""
                        + "a".repeat(64) + "\"}]" + suffix,
                "Broker worker response field is not an integer: size");
        assertSignedManifestUnknown("m2", prefix + "[{\"name\":\"frame.png\",\"size\":3,\"size\":3,\"sha256\":\""
                        + "a".repeat(64) + "\"}]" + suffix,
                "Broker worker response field is missing or duplicated: size");
        assertSignedManifestUnknown("m3", prefix + "[{" + file + "},]" + suffix,
                "Output manifest has a trailing or empty entry");
        assertSignedManifestUnknown("m4", prefix + "[],\"files\":[]" + suffix,
                "Output manifest field is missing or duplicated");
    }

    @Test
    void clientTreatsExplicitPreDispatchRejectionAsDefinitive() throws Exception {
        Path socketPath = root.resolve("rejected-broker.sock");
        Path tokenFile = root.resolve("rejected-broker.token");
        Files.writeString(tokenFile, "r".repeat(64));
        Files.setPosixFilePermissions(tokenFile, PosixFilePermissions.fromString("rw-------"));
        ExecutorService serverExecutor = Executors.newSingleThreadExecutor();
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socketPath));
            Future<?> serverTask = serverExecutor.submit(() -> {
                try (SocketChannel connection = server.accept()) {
                    readFrame(connection);
                    writeFrame(connection, "{\"status\":-2,\"body\":\"rejected\"}");
                } catch (Exception failure) {
                    throw new RuntimeException(failure);
                }
            });
            MediaOciBrokerClient client = new MediaOciBrokerClient(socketPath, tokenFile,
                    Duration.ofSeconds(1), Duration.ofSeconds(1), Duration.ofSeconds(2));
            assertThatThrownBy(() -> client.execute(launch()))
                    .isInstanceOf(IOException.class)
                    .isNotInstanceOf(MediaOciBrokerClient.UnknownOutcomeException.class)
                    .hasMessageContaining("rejected");
            serverTask.get(2, TimeUnit.SECONDS);
        } finally {
            serverExecutor.shutdownNow();
            assertThat(serverExecutor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    private static MediaOciBroker.WorkerLaunch launch() {
        return new MediaOciBroker.WorkerLaunch("worker@sha256:" + "a".repeat(64),
                "media-vision-test", "ffmpeg", List.of("-nostdin", "-hide_banner", "-loglevel", "error",
                "-i", "/source/input", "-y", "/output/frame.png"), null, null, null,
                501, 20, 1024, Duration.ofSeconds(5));
    }

    private void assertSignedManifestUnknown(String suffix, String unsigned, String rootCause) throws Exception {
        Path socketPath = root.resolve(suffix + ".sock");
        Path tokenFile = root.resolve(suffix + ".token");
        String token = "v".repeat(64);
        Files.writeString(tokenFile, token);
        Files.setPosixFilePermissions(tokenFile, PosixFilePermissions.fromString("rw-------"));
        ExecutorService serverExecutor = Executors.newSingleThreadExecutor();
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socketPath));
            Future<?> serverTask = serverExecutor.submit(() -> {
                try (SocketChannel connection = server.accept()) {
                    String request = readFrame(connection);
                    String nonce = jsonString(request, "nonce");
                    long timestamp = jsonNumber(request, "ts");
                    String proof = hmac(token, "response\n" + nonce + "\n" + timestamp + "\n" + unsigned);
                    String signedBody = unsigned.substring(0, unsigned.length() - 1)
                            + ",\"proof\":\"" + proof + "\"}";
                    writeFrame(connection, "{\"status\":0,\"body\":" + json(signedBody) + "}");
                } catch (Exception failure) {
                    throw new RuntimeException(failure);
                }
            });
            MediaOciBrokerClient client = new MediaOciBrokerClient(socketPath, tokenFile,
                    Duration.ofSeconds(1), Duration.ofSeconds(1), Duration.ofSeconds(2));
            assertThatThrownBy(() -> client.execute(launch()))
                    .isInstanceOf(MediaOciBrokerClient.UnknownOutcomeException.class)
                    .hasMessageContaining("invalid output manifest")
                    .hasRootCauseMessage(rootCause);
            serverTask.get(2, TimeUnit.SECONDS);
        } finally {
            serverExecutor.shutdownNow();
            assertThat(serverExecutor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    private static void readFully(SocketChannel channel, ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) {
            if (channel.read(buffer) < 0) throw new IOException("client truncated request");
        }
    }

    private static String readFrame(SocketChannel channel) throws IOException {
        ByteBuffer header = ByteBuffer.allocate(Integer.BYTES);
        readFully(channel, header);
        header.flip();
        int length = header.getInt();
        if (length <= 0 || length > 64 * 1024) throw new IOException("request frame is out of bounds");
        ByteBuffer body = ByteBuffer.allocate(length);
        readFully(channel, body);
        return new String(body.array(), StandardCharsets.UTF_8);
    }

    private static void writeFrame(SocketChannel channel, String value) throws IOException {
        byte[] body = value.getBytes(StandardCharsets.UTF_8);
        ByteBuffer frame = ByteBuffer.allocate(Integer.BYTES + body.length);
        frame.putInt(body.length).put(body).flip();
        while (frame.hasRemaining()) channel.write(frame);
    }

    private static String jsonString(String json, String name) {
        java.util.regex.Matcher matcher = java.util.regex.Pattern
                .compile("\\\"" + java.util.regex.Pattern.quote(name) + "\\\":\\\"([^\\\"]*)\\\"")
                .matcher(json);
        if (!matcher.find()) throw new IllegalArgumentException("Missing JSON string field " + name);
        return matcher.group(1);
    }

    private static long jsonNumber(String json, String name) {
        java.util.regex.Matcher matcher = java.util.regex.Pattern
                .compile("\\\"" + java.util.regex.Pattern.quote(name) + "\\\":([0-9]+)")
                .matcher(json);
        if (!matcher.find()) throw new IllegalArgumentException("Missing JSON number field " + name);
        return Long.parseLong(matcher.group(1));
    }

    private static String json(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static String hmac(String token, String value) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return HexFormat.of().formatHex(mac.doFinal(value.getBytes(StandardCharsets.UTF_8)));
    }
}
