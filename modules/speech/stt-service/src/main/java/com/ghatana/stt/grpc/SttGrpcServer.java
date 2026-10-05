package com.ghatana.stt.grpc;

import com.ghatana.audio.video.common.AudioVideoGrpcServerBase;
import com.ghatana.audio.video.common.GrpcTransportSecurityPolicy;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.Map;

/**
 * Standalone gRPC server for Speech-to-Text.
 *
 * <p>The production service composition initializes its model before the server binds. Missing or
 * invalid models therefore fail startup unless synthetic fallback was explicitly enabled for a
 * local/test profile. Production-like transport security is resolved by the shared Media policy.
 *
 * @doc.type class
 * @doc.purpose Fail-closed STT gRPC server bootstrap, transport security, and lifecycle
 * @doc.layer product
 * @doc.pattern Service
 */
public final class SttGrpcServer extends AudioVideoGrpcServerBase {

    private static final Logger LOG = LoggerFactory.getLogger(SttGrpcServer.class);
    private static final int DEFAULT_PORT = 50051;

    public SttGrpcServer(int port) {
        this(port, TransportSecurity.plaintext());
    }

    SttGrpcServer(int port, TransportSecurity transportSecurity) {
        super(
                "stt-service",
                port,
                new ProductionSttGrpcService(new SimpleMeterRegistry()),
                com.ghatana.audio.video.common.GrpcInterceptorChain.build(),
                transportSecurity);
    }

    public static void main(String[] args) {
        if (Boolean.getBoolean("av.smokeTest")) {
            LOG.info("[smoke-test] SttGrpcServer classpath check passed — exiting cleanly.");
            return;
        }

        try {
            Map<String, String> environment = System.getenv();
            int port = parsePort(environment.get("STT_GRPC_PORT"));
            TransportSecurity transportSecurity = transportSecurity(environment);
            new SttGrpcServer(port, transportSecurity).startAndAwaitShutdown();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            LOG.info("STT server interrupted");
        } catch (IOException transportFailure) {
            LOG.error("STT server transport failed", transportFailure);
            System.exit(1);
        } catch (RuntimeException configurationFailure) {
            LOG.error("STT server configuration or provider startup failed", configurationFailure);
            System.exit(1);
        }
    }

    static TransportSecurity transportSecurity(Map<String, String> environment) {
        return GrpcTransportSecurityPolicy.resolve(environment, "STT");
    }

    static int parsePort(String configured) {
        int port;
        try {
            port = configured == null || configured.isBlank()
                    ? DEFAULT_PORT
                    : Integer.parseInt(configured.trim());
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException("STT_GRPC_PORT must be an integer", failure);
        }
        if (port < 1 || port > 65_535) {
            throw new IllegalArgumentException("STT_GRPC_PORT must be between 1 and 65535");
        }
        return port;
    }
}
