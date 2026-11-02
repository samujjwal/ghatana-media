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
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaOciBrokerClientTest {

    @TempDir Path root;

    @Test
    void stalledBrokerResponseTimesOutAsUnknownOutcomeWithoutRetry() throws Exception {
        Path socketPath = root.resolve("broker.sock");
        Path tokenFile = root.resolve("broker.token");
        Files.writeString(tokenFile, "t".repeat(64));
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

    private static MediaOciBroker.WorkerLaunch launch() {
        return new MediaOciBroker.WorkerLaunch("worker@sha256:" + "a".repeat(64),
                "media-vision-test", "ffmpeg", List.of("-nostdin", "-hide_banner", "-loglevel", "error",
                "-i", "/source/input", "-y", "/output/result.out"), null, null, null,
                501, 20, 1024, Duration.ofSeconds(5));
    }

    private static void readFully(SocketChannel channel, ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) {
            if (channel.read(buffer) < 0) throw new IOException("client truncated request");
        }
    }
}
