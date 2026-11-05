package com.ghatana.audio.video.common;

import com.ghatana.audio.video.common.health.HealthMetricsServer;
import com.ghatana.audio.video.common.health.ServerReadinessLifecycle;
import io.grpc.BindableService;
import io.grpc.Server;
import io.grpc.ServerBuilder;
import io.grpc.netty.shaded.io.grpc.netty.GrpcSslContexts;
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder;
import io.grpc.netty.shaded.io.netty.handler.ssl.ClientAuth;
import io.grpc.netty.shaded.io.netty.handler.ssl.SslContext;
import io.grpc.netty.shaded.io.netty.util.ReferenceCountUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.interfaces.EdECKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;
import java.util.List;
import java.util.OptionalInt;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Reusable lifecycle owner for audio/video gRPC servers.
 *
 * <p>The base owns the gRPC server, TLS/mTLS transport configuration, health sidecar, and—when the
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
    private final BindableService serviceImpl;
    private final List<io.grpc.ServerInterceptor> interceptors;
    private final OptionalInt maxInboundMessageSize;
    private volatile Server server;
    private final HealthMetricsServer healthServer;
    private final ServerReadinessLifecycle readinessLifecycle;
    private final Runnable readinessMetricRegistration;
    private final AutoCloseable serviceResource;
    private volatile TransportSecurity transportSecurity;
    private final AtomicBoolean shutdownHookRegistered = new AtomicBoolean();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final AtomicBoolean started = new AtomicBoolean();
    private final AtomicBoolean serviceResourceClosed = new AtomicBoolean();
    private final AtomicBoolean readinessResourceClosed = new AtomicBoolean();

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
        this(serviceName, port, serviceImpl, interceptors, transportSecurity, null);
    }

    /** Construct a Media gRPC server with an explicit provider and modality readiness service. */
    protected AudioVideoGrpcServerBase(
            String serviceName,
            int port,
            BindableService serviceImpl,
            List<io.grpc.ServerInterceptor> interceptors,
            TransportSecurity transportSecurity,
            ServerReadinessLifecycle readinessLifecycle) {
        this(serviceName, port, serviceImpl, interceptors, transportSecurity, readinessLifecycle,
                OptionalInt.empty());
    }

    /** Construct a Media gRPC server with an explicit maximum serialized inbound message size. */
    protected AudioVideoGrpcServerBase(
            String serviceName,
            int port,
            BindableService serviceImpl,
            List<io.grpc.ServerInterceptor> interceptors,
            TransportSecurity transportSecurity,
            ServerReadinessLifecycle readinessLifecycle,
            int maxInboundMessageSize) {
        this(serviceName, port, serviceImpl, interceptors, transportSecurity, readinessLifecycle,
                OptionalInt.of(requirePositiveInboundLimit(maxInboundMessageSize)));
    }

    private AudioVideoGrpcServerBase(
            String serviceName,
            int port,
            BindableService serviceImpl,
            List<io.grpc.ServerInterceptor> interceptors,
            TransportSecurity transportSecurity,
            ServerReadinessLifecycle readinessLifecycle,
            OptionalInt maxInboundMessageSize) {
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
        this.serviceImpl = serviceImpl;
        this.interceptors = List.copyOf(interceptors);
        this.maxInboundMessageSize = maxInboundMessageSize;
        this.serviceResource = serviceImpl instanceof AutoCloseable closeable ? closeable : null;
        this.readinessLifecycle = readinessLifecycle;

        this.server = buildServer(port, transportSecurity);
        this.healthServer = new HealthMetricsServer(this.serviceName, this::isReady);
        this.readinessMetricRegistration =
                com.ghatana.audio.video.common.observability.MetricsServerInterceptor.getInstance()
                        .registerServiceReadiness(this.serviceName, this::isReady);
    }

    public final synchronized void start() throws IOException {
        if (closed.get()) {
            throw new IllegalStateException(serviceName + " server is closed");
        }
        try {
            server.start();
            healthServer.start();
            if (readinessLifecycle != null) {
                readinessLifecycle.markReady();
            }
            started.set(true);
        } catch (IOException | RuntimeException exception) {
            started.set(false);
            setNotServing();
            closed.set(true);
            server.shutdownNow();
            try {
                healthServer.close();
            } finally {
                try {
                    closeReadinessResource();
                } finally {
                    try {
                        closeServiceResource();
                    } finally {
                        closeReadinessMetricRegistration();
                    }
                }
            }
            throw exception;
        }
        LOG.info("{} started on port {} transportSecurity={}",
                serviceName, port, transportSecurity.tlsEnabled() ? "TLS" : "PLAINTEXT");

        if (shutdownHookRegistered.compareAndSet(false, true)) {
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                LOG.info("Shutdown hook triggered for {}", serviceName);
                close();
            }, serviceName + "-shutdown-hook"));
        }
    }

    /**
     * Replaces the TLS identity by stopping and rebuilding this listener on its configured port.
     * The candidate pair is validated before traffic is interrupted. A failed rebind leaves this
     * server closed and NOT_SERVING; it never falls back to plaintext or the old identity.
     */
    public final synchronized void rotateTls(TransportSecurity replacement) throws IOException {
        java.util.Objects.requireNonNull(replacement, "replacement must not be null");
        if (!replacement.tlsEnabled()) {
            throw new IllegalArgumentException("TLS rotation requires TLS transport security");
        }
        replacement.verify();
        if (closed.get()) throw new IllegalStateException(serviceName + " server is closed");
        Server previous = server;
        if (!started.get()) {
            throw new IllegalStateException(serviceName + " server is not started");
        }
        int boundPort = previous.getPort();
        // Build first so malformed/incomplete certificate material is rejected before traffic is
        // interrupted. ServerBuilder.build() does not bind the configured port.
        Server next = buildServer(boundPort, replacement);
        setNotServing();
        previous.shutdown();
        try {
            try {
                if (!previous.awaitTermination(SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    previous.shutdownNow();
                    previous.awaitTermination(SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("Interrupted while stopping " + serviceName + " for TLS rotation",
                        interrupted);
            }
            try {
                next.start();
            } catch (IOException | RuntimeException failure) {
                next.shutdownNow();
                throw failure;
            }
            server = next;
            transportSecurity = replacement;
            if (readinessLifecycle != null) readinessLifecycle.markReady();
            started.set(true);
            LOG.info("{} TLS identity rotated on port {}", serviceName, boundPort);
        } catch (IOException | RuntimeException failure) {
            next.shutdownNow();
            closed.set(true);
            started.set(false);
            server = previous;
            previous.shutdownNow();
            setNotServing();
            try {
                healthServer.close();
            } finally {
                try {
                    closeReadinessResource();
                } finally {
                    try {
                        closeServiceResource();
                    } finally {
                        closeReadinessMetricRegistration();
                    }
                }
            }
            throw failure;
        }
    }

    private Server buildServer(int bindPort, TransportSecurity security) {
        // A plaintext listener is intended only for local development and tests. The generic
        // forPort() builder binds wildcard interfaces, which would expose those profiles to the
        // network even though the profile policy permits plaintext only for local use.
        ServerBuilder<?> builder = security.tlsEnabled()
                ? NettyServerBuilder.forPort(bindPort)
                : NettyServerBuilder.forAddress(
                        new InetSocketAddress(loopbackAddress(), bindPort));
        maxInboundMessageSize.ifPresent(builder::maxInboundMessageSize);
        interceptors.forEach(builder::intercept);
        if (security.tlsEnabled()) {
            if (security.clientTrustCertificate() == null) {
                builder.useTransportSecurity(security.certificateChain().toFile(), security.privateKey().toFile());
            } else {
                SslContext sslContext;
                try {
                    sslContext = GrpcSslContexts.forServer(
                                    security.certificateChain().toFile(), security.privateKey().toFile())
                            .trustManager(security.clientTrustCertificate().toFile())
                            .clientAuth(ClientAuth.REQUIRE)
                            .build();
                } catch (Exception failure) {
                    throw new IllegalArgumentException("gRPC client trust certificate is invalid", failure);
                }
                ((NettyServerBuilder) builder).sslContext(sslContext);
            }
        }
        builder.addService(serviceImpl);
        if (readinessLifecycle != null && readinessLifecycle != serviceImpl) builder.addService(readinessLifecycle);
        return builder.build();
    }

    private static InetAddress loopbackAddress() {
        try {
            // The service tests and local clients use IPv4 loopback. Binding that explicit
            // address avoids depending on whether the host has IPv6 loopback enabled.
            return InetAddress.getByAddress(new byte[] {127, 0, 0, 1});
        } catch (java.net.UnknownHostException impossible) {
            throw new IllegalStateException("IPv4 loopback address is unavailable", impossible);
        }
    }

    public final void startAndAwaitShutdown() throws IOException, InterruptedException {
        start();
        blockUntilShutdown();
    }

    public final void blockUntilShutdown() throws InterruptedException {
        while (true) {
            Server current = server;
            current.awaitTermination();
            synchronized (this) {
                // Rotation terminates the old generation before publishing the replacement. Since
                // rotation and close hold this monitor, this check cannot mistake that gap for a
                // final server shutdown.
                if (closed.get() || server == current) return;
            }
        }
    }

    @Override
    public final synchronized void close() {
        if (!closed.compareAndSet(false, true)) {
            closeServiceResource();
            closeReadinessMetricRegistration();
            return;
        }

        started.set(false);

        setNotServing();

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
            try {
                closeReadinessResource();
            } finally {
                try {
                    closeServiceResource();
                } finally {
                    closeReadinessMetricRegistration();
                }
            }
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

    private void setNotServing() {
        if (readinessLifecycle != null) {
            try {
                readinessLifecycle.setNotServing();
            } catch (RuntimeException exception) {
                LOG.error("Unable to mark {} NOT_SERVING before shutdown", serviceName, exception);
            }
        }
    }

    private void closeReadinessResource() {
        if (readinessLifecycle == null || readinessLifecycle == serviceResource
                || !readinessResourceClosed.compareAndSet(false, true)) {
            return;
        }
        try {
            readinessLifecycle.close();
        } catch (Exception exception) {
            LOG.error("Error closing {} readiness resources", serviceName, exception);
        }
    }

    private void closeReadinessMetricRegistration() {
        readinessMetricRegistration.run();
    }

    public final int getPort() {
        return started.get() ? server.getPort() : port;
    }

    public final boolean isShutdown() {
        return server.isShutdown();
    }

    /** Current readiness; servers without an explicit readiness lifecycle are never ready. */
    public final boolean isReady() {
        return readinessLifecycle != null && !server.isShutdown() && readinessLifecycle.isServing();
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
            Path privateKey,
            Path clientTrustCertificate) {

        /** Source-compatible server-auth TLS constructor for local/test transports. */
        public TransportSecurity(boolean tlsEnabled, Path certificateChain, Path privateKey) {
            this(tlsEnabled, certificateChain, privateKey, null);
        }

        public TransportSecurity {
            if (tlsEnabled) {
                certificateChain = normalizedPath(certificateChain, "certificateChain");
                privateKey = normalizedPath(privateKey, "privateKey");
                if (clientTrustCertificate != null) {
                    clientTrustCertificate = normalizedPath(clientTrustCertificate, "clientTrustCertificate");
                }
            } else if (certificateChain != null || privateKey != null || clientTrustCertificate != null) {
                throw new IllegalArgumentException("TLS material must be absent when TLS is disabled");
            }
        }

        public static TransportSecurity plaintext() {
            return new TransportSecurity(false, null, null, null);
        }

        public static TransportSecurity tls(Path certificateChain, Path privateKey) {
            return new TransportSecurity(true, certificateChain, privateKey, null);
        }

        /** TLS with mandatory client-certificate authentication against the supplied CA bundle. */
        public static TransportSecurity mtls(Path certificateChain, Path privateKey, Path clientTrustCertificate) {
            return new TransportSecurity(true, certificateChain, privateKey, clientTrustCertificate);
        }

        private void verify() {
            if (!tlsEnabled) return;
            verifyFile(certificateChain, "gRPC TLS certificate chain");
            verifyFile(privateKey, "gRPC TLS private key");
            if (clientTrustCertificate != null) {
                verifyFile(clientTrustCertificate, "gRPC mTLS client trust certificate");
            }
            SslContext preflightContext = null;
            try {
                preflightContext = GrpcSslContexts.forServer(
                        certificateChain.toFile(), privateKey.toFile()).build();
                verifyCertificateAndKeyMatch(certificateChain, privateKey);
            } catch (Exception failure) {
                throw new IllegalArgumentException("gRPC TLS certificate chain and private key are invalid or mismatched",
                        failure);
            } finally {
                // OpenSSL SslContext instances own native state; safeRelease is a no-op for JDK
                // contexts that do not implement Netty's ReferenceCounted contract.
                if (preflightContext != null) ReferenceCountUtil.safeRelease(preflightContext);
            }
        }

        private static void verifyCertificateAndKeyMatch(Path certificateChain, Path privateKey)
                throws Exception {
            java.util.Collection<? extends java.security.cert.Certificate> certificates;
            try (var input = Files.newInputStream(certificateChain)) {
                certificates = CertificateFactory.getInstance("X.509").generateCertificates(input);
            }
            if (certificates.isEmpty() || !(certificates.iterator().next() instanceof X509Certificate leaf)) {
                throw new IllegalArgumentException("certificate chain has no X.509 leaf certificate");
            }
            leaf.checkValidity();

            String pem = Files.readString(privateKey, StandardCharsets.US_ASCII);
            String begin = "-----BEGIN PRIVATE KEY-----";
            String end = "-----END PRIVATE KEY-----";
            if (pem.contains("-----BEGIN RSA PRIVATE KEY-----")) {
                begin = "-----BEGIN RSA PRIVATE KEY-----";
                end = "-----END RSA PRIVATE KEY-----";
            }
            int start = pem.indexOf(begin);
            int finish = pem.indexOf(end);
            if (start < 0 || finish <= start) {
                throw new IllegalArgumentException("private key must be an unencrypted PKCS#8 or RSA PKCS#1 PEM key");
            }
            byte[] keyBytes = Base64.getMimeDecoder().decode(
                    pem.substring(start + begin.length(), finish));
            if (begin.contains("RSA PRIVATE KEY")) keyBytes = wrapRsaPkcs1(keyBytes);
            String keyAlgorithm = leaf.getPublicKey().getAlgorithm();
            PrivateKey key = KeyFactory.getInstance(keyAlgorithm).generatePrivate(new PKCS8EncodedKeySpec(keyBytes));
            String signatureAlgorithm = leaf.getPublicKey() instanceof EdECKey edKey
                    ? edKey.getParams().getName()
                    : switch (keyAlgorithm) {
                case "RSA" -> "SHA256withRSA";
                case "EC" -> "SHA256withECDSA";
                case "DSA" -> "SHA256withDSA";
                case "Ed25519", "Ed448" -> keyAlgorithm;
                default -> throw new IllegalArgumentException("unsupported TLS private-key algorithm: " + keyAlgorithm);
            };
            byte[] challenge = "media-grpc-tls-pair-check".getBytes(StandardCharsets.US_ASCII);
            Signature signer = Signature.getInstance(signatureAlgorithm);
            signer.initSign(key);
            signer.update(challenge);
            byte[] signed = signer.sign();
            signer.initVerify(leaf.getPublicKey());
            signer.update(challenge);
            if (!signer.verify(signed)) {
                throw new IllegalArgumentException("private key does not match certificate leaf");
            }
        }

        private static byte[] wrapRsaPkcs1(byte[] pkcs1) {
            byte[] rsaEncryptionOid = new byte[] {0x06, 0x09, 0x2a, (byte) 0x86, 0x48,
                    (byte) 0x86, (byte) 0xf7, 0x0d, 0x01, 0x01, 0x01};
            byte[] nullValue = new byte[] {0x05, 0x00};
            byte[] algorithm = der(0x30, concat(rsaEncryptionOid, nullValue));
            byte[] version = new byte[] {0x02, 0x01, 0x00};
            byte[] key = der(0x04, pkcs1);
            return der(0x30, concat(version, algorithm, key));
        }

        private static byte[] der(int tag, byte[] value) {
            byte[] length;
            if (value.length < 128) {
                length = new byte[] {(byte) value.length};
            } else {
                int count = 0;
                for (int remaining = value.length; remaining > 0; remaining >>>= 8) count++;
                length = new byte[count + 1];
                length[0] = (byte) (0x80 | count);
                for (int index = count; index > 0; index--) {
                    length[index] = (byte) (value.length >>> (8 * (count - index)));
                }
            }
            return concat(new byte[] {(byte) tag}, length, value);
        }

        private static byte[] concat(byte[]... values) {
            int length = 0;
            for (byte[] value : values) length += value.length;
            byte[] result = new byte[length];
            int offset = 0;
            for (byte[] value : values) {
                System.arraycopy(value, 0, result, offset, value.length);
                offset += value.length;
            }
            return result;
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

    private static int requirePositiveInboundLimit(int value) {
        if (value <= 0) {
            throw new IllegalArgumentException("maxInboundMessageSize must be positive");
        }
        return value;
    }
}
