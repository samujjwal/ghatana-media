package com.ghatana.audio.video.common;

import io.grpc.BindableService;
import io.grpc.CallOptions;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import io.grpc.MethodDescriptor;
import io.grpc.ServerServiceDefinition;
import io.grpc.ServiceDescriptor;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.ServerCalls;
import io.grpc.stub.ClientCalls;
import com.ghatana.audio.video.common.health.ServerReadinessLifecycle;
import com.ghatana.audio.video.common.observability.MetricsServerInterceptor;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

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
        assertThat(server.isReady()).isFalse();
        server.close();
        server.close();

        assertThat(server.isShutdown()).isTrue();
        assertThat(service.closeCount()).isEqualTo(1);
    }

    @Test
    void lifecycleControlsReadinessAndIsSetNotServingBeforeServiceDrain() throws IOException {
        FakeReadinessLifecycle readiness = new FakeReadinessLifecycle(true);
        CloseableNoOpService service = new CloseableNoOpService(readiness::isServing);
        TestServer server = new TestServer(0, service, readiness);

        assertThat(server.isReady()).isFalse();
        server.start();
        assertThat(readiness.readyAttempts()).isEqualTo(1);
        assertThat(server.isReady()).isTrue();

        server.close();
        assertThat(server.isReady()).isFalse();
        assertThat(service.closeObservedNotServing()).isTrue();
        assertThat(readiness.closeCount()).isEqualTo(1);
    }

    @Test
    void missingRequiredReadinessCheckKeepsStartedServerNotServing() throws IOException {
        FakeReadinessLifecycle readiness = new FakeReadinessLifecycle(false);
        TestServer server = new TestServer(0, new CloseableNoOpService(), readiness);

        server.start();

        assertThat(readiness.readyAttempts()).isEqualTo(1);
        assertThat(readiness.isServing()).isFalse();
        assertThat(server.isReady()).isFalse();

        server.close();
    }

    @Test
    void exposesProviderReadinessThroughTheSharedMetricsScrape() throws IOException {
        MetricsServerInterceptor metrics = MetricsServerInterceptor.getInstance();
        metrics.reset();
        FakeReadinessLifecycle readiness = new FakeReadinessLifecycle(true);
        TestServer server = new TestServer(
                "stt-service", 0, new CloseableNoOpService(readiness::isServing), readiness);

        assertThat(metrics.scrape()).contains("av_service_readiness{service=\"stt\"} 0");
        server.start();
        assertThat(metrics.scrape()).contains("av_service_readiness{service=\"stt\"} 1");

        server.close();
        assertThat(metrics.scrape()).doesNotContain("av_service_readiness{service=\"stt\"");
    }

    @Test
    void failedGrpcBindMarksDownAndClosesReadinessAndServiceResources() throws IOException {
        try (ServerSocket occupiedPort = new ServerSocket(0)) {
            FakeReadinessLifecycle readiness = new FakeReadinessLifecycle(true);
            CloseableNoOpService service = new CloseableNoOpService(readiness::isServing);
            TestServer server = new TestServer(occupiedPort.getLocalPort(), service, readiness);

            assertThatThrownBy(server::start).isInstanceOf(IOException.class);

            assertThat(readiness.isServing()).isFalse();
            assertThat(readiness.readyAttempts()).isZero();
            assertThat(readiness.closeCount()).isEqualTo(1);
            assertThat(service.closeCount()).isEqualTo(1);
            assertThat(service.closeObservedNotServing()).isTrue();
            assertThatCode(server::close).doesNotThrowAnyException();
            assertThat(readiness.closeCount()).isEqualTo(1);
            assertThat(service.closeCount()).isEqualTo(1);
        }
    }

    @Test
    void rejectsInvalidConstructionAndStartAfterClose() {
        assertThatThrownBy(() -> new TestServer(-1, new CloseableNoOpService()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("port");
        assertThatThrownBy(() -> new TestServer(0, null))
                .isInstanceOf(NullPointerException.class)
                .hasMessageContaining("serviceImpl");
        assertThatThrownBy(() -> new TestServer(0, new CloseableNoOpService(), 0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("maxInboundMessageSize");

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

    @Test
    void configuredInboundLimitRejectsOversizedTransportMessageBeforeServiceDispatch() throws Exception {
        AtomicInteger dispatches = new AtomicInteger();
        BindableService service = payloadService(dispatches);
        int port = findAvailablePort();
        TestServer server = new TestServer(port, service, 64);
        server.start();

        ManagedChannel channel = ManagedChannelBuilder.forAddress("127.0.0.1", port)
                .usePlaintext()
                .build();
        try {
            StatusRuntimeException failure = org.assertj.core.api.Assertions.catchThrowableOfType(
                    () -> ClientCalls.blockingUnaryCall(
                            channel, payloadMethod(), CallOptions.DEFAULT, "x".repeat(1024)),
                    StatusRuntimeException.class);

            assertThat(failure).isNotNull();
            assertThat(failure.getStatus().getCode()).isEqualTo(Status.Code.RESOURCE_EXHAUSTED);
            assertThat(dispatches).hasValue(0);
        } finally {
            channel.shutdownNow();
            server.close();
        }
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

        private TestServer(int port, BindableService service, ServerReadinessLifecycle readiness) {
            super("test-service", port, service, List.of(), TransportSecurity.plaintext(), readiness);
        }

        private TestServer(int port, BindableService service, int maxInboundMessageSize) {
            super("test-service", port, service, List.of(), TransportSecurity.plaintext(), null,
                    maxInboundMessageSize);
        }

        private TestServer(
                String serviceName,
                int port,
                BindableService service,
                ServerReadinessLifecycle readiness) {
            super(serviceName, port, service, List.of(), TransportSecurity.plaintext(), readiness);
        }
    }

    private static BindableService payloadService(AtomicInteger dispatches) {
        return () -> ServerServiceDefinition.builder("test.PayloadService")
                .addMethod(payloadMethod(), ServerCalls.asyncUnaryCall((request, observer) -> {
                    dispatches.incrementAndGet();
                    observer.onNext("accepted");
                    observer.onCompleted();
                }))
                .build();
    }

    private static MethodDescriptor<String, String> payloadMethod() {
        return MethodDescriptor.<String, String>newBuilder()
                .setType(MethodDescriptor.MethodType.UNARY)
                .setFullMethodName(MethodDescriptor.generateFullMethodName(
                        "test.PayloadService", "Send"))
                .setRequestMarshaller(STRING_MARSHALLER)
                .setResponseMarshaller(STRING_MARSHALLER)
                .build();
    }

    private static final MethodDescriptor.Marshaller<String> STRING_MARSHALLER =
            new MethodDescriptor.Marshaller<>() {
                @Override
                public InputStream stream(String value) {
                    return new ByteArrayInputStream(value.getBytes(StandardCharsets.UTF_8));
                }

                @Override
                public String parse(InputStream stream) {
                    try {
                        return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
                    } catch (IOException failure) {
                        throw new IllegalStateException("Unable to parse test payload", failure);
                    }
                }
            };

    private static int findAvailablePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static final class CloseableNoOpService
            implements BindableService, AutoCloseable {
        private final AtomicInteger closeCount = new AtomicInteger();
        private final BooleanSupplier readiness;
        private volatile boolean closeObservedNotServing;

        private CloseableNoOpService() {
            this(() -> false);
        }

        private CloseableNoOpService(BooleanSupplier readiness) {
            this.readiness = readiness;
        }

        @Override
        public ServerServiceDefinition bindService() {
            return ServerServiceDefinition.builder(
                            ServiceDescriptor.newBuilder("test.NoOpService").build())
                    .build();
        }

        @Override
        public void close() {
            closeObservedNotServing = !readiness.getAsBoolean();
            closeCount.incrementAndGet();
        }

        private int closeCount() {
            return closeCount.get();
        }

        private boolean closeObservedNotServing() {
            return closeObservedNotServing;
        }
    }

    private static final class FakeReadinessLifecycle implements ServerReadinessLifecycle {
        private final boolean requiredChecksAvailable;
        private final AtomicInteger readyAttempts = new AtomicInteger();
        private final AtomicInteger closeCount = new AtomicInteger();
        private volatile boolean ready;

        private FakeReadinessLifecycle(boolean requiredChecksAvailable) {
            this.requiredChecksAvailable = requiredChecksAvailable;
        }

        @Override
        public boolean markReady() {
            readyAttempts.incrementAndGet();
            ready = requiredChecksAvailable;
            return ready;
        }

        @Override
        public void setNotServing() {
            ready = false;
        }

        @Override
        public boolean isServing() {
            return ready;
        }

        @Override
        public void close() {
            closeCount.incrementAndGet();
        }

        @Override
        public ServerServiceDefinition bindService() {
            return ServerServiceDefinition.builder(
                            ServiceDescriptor.newBuilder("test.ReadinessService").build())
                    .build();
        }

        private int readyAttempts() {
            return readyAttempts.get();
        }

        private int closeCount() {
            return closeCount.get();
        }
    }
}
