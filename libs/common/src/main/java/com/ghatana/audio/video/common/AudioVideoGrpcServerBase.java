package com.ghatana.audio.video.common;

import com.ghatana.audio.video.common.health.HealthMetricsServer;
import io.grpc.BindableService;
import io.grpc.Server;
import io.grpc.ServerBuilder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Reusable lifecycle owner for audio/video gRPC servers.
 *
 * <p>The base owns the gRPC server, transport-security configuration, health sidecar, and—when the
 * supplied service implements {@link AutoCloseable}—the service resource graph. Shutdown and
 * failed-start cleanup are idempotent: the service graph is closed at most once even when health
 * startup fails and a caller later invokes {@link #close()}.
 *
 * @doc.type class
 * @doc.purpose Shared gRPC server lifecycle, transport security, health, interceptors, and service-resource ownership
 * @doc.layer product
 * @doc.pattern TemplateMethod
 */
public abstract class AudioVideoGrpcServerBase implements AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(AudioVideoGrpcServerBase.class);
    private static final int SHUTDOWN_TIMEOUT_SECONDS = 30;

    private final String serviceName;
    private final int port;
    private final Server server;
    private final HealthMetricsServer healthServer;
    private final AutoCloseable serviceResource;
    private final TransportSecurity transportSecurity;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final AtomicBoolean serviceResourceClosed = new AtomicBoolean();

    protected AudioVideoGrpcServerBase(
            String serviceName,
            int port,
            BindableService serviceImpl) {
        this(serviceName, port, serviceImpl, GrpcInterceptorChain.build(), TransportSecurity.plaintext());
    }

    protected AudioVideoGrpcServerBase(
            String serviceName,
            int port,
            BindableService serviceImpl,
            List<io.grpc.ServerInterceptor> interceptors) {
        this(serviceName, port, serviceImpl, interceptors, TransportSecurity.plaintext());
    }

    protected AudioVideoGrpcServerBase(
            String serviceName,
            int port,
            BindableService serviceImpl,
            List<io.grpc.ServerInterceptor> interceptors,
            TransportSecurity transportSecurity) {
        this.serviceName = requireText(serviceName, "serviceName");
        if (port < 0 || port > 65_535) {
            throw new IllegalArgumentException("port must be between 0 and 65535");
        }
        this.port = port;
        if (serviceImpl == null) {
            throw new NullPointerException("serviceImpl must not be null");
        }
        if (interceptors == null) {
            throw new NullPointerException("interceptors must not be null");
        }
        this.transportSecurity = java.util.Objects.requireNonNull(
                transportSecurity, "transportSecurity must not be null");
        this.transportSecurity.verify();
        this.serviceResource = serviceImpl instanceof AutoCloseable closeable ? closeable : null;

        ServerBuilder<?> builder = ServerBuilder.forPort(port);
        interceptors.forEach(builder::intercept);
        if (transportSecurity.tlsEnabled()) {
            builder.useTransportSecurity(
                    transportSecurity.certificateChain().toFile(),
                    transportSecurity.privateKey().toFile());
        }
        this.server = builder.addService(serviceImpl).build();
        this.healthServer = new HealthMetricsServer(this.serviceName, () -> !server.isShutdown());
    }

    public final void start() throws IOException {
        if (closed.get()) {
            throw new IllegalStateException(serviceName + " server is closed");
        }
        server.start();
        try {
            healthServer.start();
        } catch (IOException | RuntimeException exception) {
            closed.set(true);
            server.shutdownNow();
            try {
                healthServer.close();
            } finally {
                closeServiceResource();
            }
            throw exception;
        }
        LOG.info("{} started on port {} transportSecurity={}",
                serviceName, port, transportSecurity.tlsEnabled() ? "TLS" : "PLAINTEXT");

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            LOG.info("Shutdown hook triggered for {}", serviceName);
            close();
        }, serviceName + "-shutdown-hook"));
    }

    public final void startAndAwaitShutdown() throws IOException, InterruptedException {
        start();
        blockUntilShutdown();
    }

    public final void blockUntilShutdown() throws InterruptedException {
        server.awaitTermination();
    }

    @Override
    public final void close() {
        if (!closed.compareAndSet(false, true)) {
            closeServiceResource();
            return;
        }

        if (!server.isShutdown()) {
            server.shutdown();
            try {
                if (!server.awaitTermination(SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    LOG.warn(
                            "{} did not shut down cleanly within {}s; forcing",
                            serviceName,
                            SHUTDOWN_TIMEOUT_SECONDS);
                    server.shutdownNow();
                }
            } catch (InterruptedException exception) {
                server.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }

        try {
            healthServer.close();
        } finally {
            closeServiceResource();
        }
        LOG.info("{} stopped", serviceName);
    }

    private void closeServiceResource() {
        if (serviceResource == null || !serviceResourceClosed.compareAndSet(false, true)) {
            return;
        }
        try {
            serviceResource.close();
        } catch (Exception exception) {
            LOG.error("Error closing {} service resources", serviceName, exception);
        }
    }

    public final int getPort() {
        return port;
    }

    public final boolean isShutdown() {
        return server.isShutdown();
    }

    public final String getServiceName() {
        return serviceName;
    }

    public final boolean isTlsEnabled() {
        return transportSecurity.tlsEnabled();
    }

    /** Explicit transport-security configuration. Plaintext is permitted only when the caller opts in. */
    public record TransportSecurity(
            boolean tlsEnabled,
            Path certificateChain,
            Path privateKey) {

        public TransportSecurity {
            if (tlsEnabled) {
                certificateChain = normalizedPath(certificateChain, "certificateChain");
                privateKey = normalizedPath(privateKey, "privateKey");
            } else if (certificateChain != null || privateKey != null) {
                throw new IllegalArgumentException(
                        "certificateChain/privateKey must be absent when TLS is disabled");
            }
        }

        public static TransportSecurity plaintext() {
            return new TransportSecurity(false, null, null);
        }

        public static TransportSecurity tls(Path certificateChain, Path privateKey) {
            return new TransportSecurity(true, certificateChain, privateKey);
        }

        private void verify() {
            if (!tlsEnabled) return;
            verifyFile(certificateChain, "gRPC TLS certificate chain");
            verifyFile(privateKey, "gRPC TLS private key");
        }

        private static Path normalizedPath(Path value, String field) {
            if (value == null) throw new NullPointerException(field + " must not be null");
            return value.toAbsolutePath().normalize();
        }

        private static void verifyFile(Path value, String field) {
            if (!Files.isRegularFile(value) || Files.isSymbolicLink(value) || !Files.isReadable(value)) {
                throw new IllegalArgumentException(
                        field + " must be a readable regular non-symlink file");
            }
        }
    }

    private static String requireText(String value, String field) {
        if (value == null) {
            throw new NullPointerException(field + " must not be null");
        }
        String normalized = value.trim();
        if (normalized.isEmpty()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        return normalized;
    }
}
