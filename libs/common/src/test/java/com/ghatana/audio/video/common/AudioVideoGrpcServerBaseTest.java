package com.ghatana.audio.video.common;

import io.grpc.BindableService;
import io.grpc.ServerServiceDefinition;
import io.grpc.ServiceDescriptor;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * @doc.type class
 * @doc.purpose Verifies shared Media gRPC server transport security and service-resource lifecycle
 * @doc.layer product
 * @doc.pattern UnitTest
 */
class AudioVideoGrpcServerBaseTest {

    @Test
    void exposesConfiguredIdentityAndClosesBeforeStart() {
        CloseableNoOpService service = new CloseableNoOpService();
        TestServer server = new TestServer(0, service);

        assertThat(server.getPort()).isZero();
        assertThat(server.getServiceName()).isEqualTo("test-service");
        assertThat(server.isTlsEnabled()).isFalse();
        assertThatCode(server::close).doesNotThrowAnyException();
        assertThat(service.closeCount()).isEqualTo(1);
        assertThat(server.isShutdown()).isTrue();
    }

    @Test
    void startAndCloseStopsTrafficAndClosesServiceExactlyOnce() throws IOException {
        CloseableNoOpService service = new CloseableNoOpService();
        TestServer server = new TestServer(0, service);
        server.start();

        assertThat(server.isShutdown()).isFalse();
        server.close();
        server.close();

        assertThat(server.isShutdown()).isTrue();
        assertThat(service.closeCount()).isEqualTo(1);
    }

    @Test
    void rejectsInvalidConstructionAndStartAfterClose() {
        assertThatThrownBy(() -> new TestServer(-1, new CloseableNoOpService()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("port");
        assertThatThrownBy(() -> new TestServer(0, null))
                .isInstanceOf(NullPointerException.class)
                .hasMessageContaining("serviceImpl");

        TestServer server = new TestServer(0, new CloseableNoOpService());
        server.close();
        assertThatThrownBy(server::start)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("closed");
    }

    @Test
    void tlsTransportRejectsMissingOrUnsafeMaterialBeforeBinding() {
        assertThatThrownBy(() -> new TestServer(
                        0,
                        new CloseableNoOpService(),
                        AudioVideoGrpcServerBase.TransportSecurity.tls(
                                Path.of("/definitely/missing/cert.pem"),
                                Path.of("/definitely/missing/key.pem"))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("readable regular non-symlink file");
    }

    private static final class TestServer extends AudioVideoGrpcServerBase {
        private TestServer(int port, BindableService service) {
            super("test-service", port, service, List.of());
        }

        private TestServer(
                int port,
                BindableService service,
                TransportSecurity transportSecurity) {
            super("test-service", port, service, List.of(), transportSecurity);
        }
    }

    private static final class CloseableNoOpService
            implements BindableService, AutoCloseable {
        private final AtomicInteger closeCount = new AtomicInteger();

        @Override
        public ServerServiceDefinition bindService() {
            return ServerServiceDefinition.builder(
                            ServiceDescriptor.newBuilder("test.NoOpService").build())
                    .build();
        }

        @Override
        public void close() {
            closeCount.incrementAndGet();
        }

        private int closeCount() {
            return closeCount.get();
        }
    }
}
