package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.AudioVideoGrpcServerBase;
import com.ghatana.audio.video.common.GrpcTransportSecurityPolicy;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.Map;

/**
 * Standalone gRPC server for production object detection.
 *
 * <p>The YOLO detector is initialized before the server binds. Missing models, native runtime
 * failures, malformed configuration, or missing production-like TLS material fail startup rather
 * than exposing a degraded or plaintext service.
 *
 * @doc.type class
 * @doc.purpose Fail-closed Vision gRPC server bootstrap, transport security, and lifecycle
 * @doc.layer product
 * @doc.pattern Service
 */
public final class VisionGrpcServer extends AudioVideoGrpcServerBase {

    private static final Logger LOG = LoggerFactory.getLogger(VisionGrpcServer.class);
    private static final int DEFAULT_PORT = 50054;

    public VisionGrpcServer(int port) {
        this(port, TransportSecurity.plaintext());
    }

    VisionGrpcServer(int port, TransportSecurity transportSecurity) {
        super(
                "vision-service",
                port,
                new ProductionVisionGrpcService(MediaProcessingMetrics.create()),
                com.ghatana.audio.video.common.GrpcInterceptorChain.build(),
                transportSecurity);
    }

    public static void main(String[] args) {
        if (Boolean.getBoolean("av.smokeTest")) {
            LOG.info("[smoke-test] VisionGrpcServer classpath check passed — exiting cleanly.");
            return;
        }

        try {
            Map<String, String> environment = System.getenv();
            int port = parsePort(environment.get("VISION_GRPC_PORT"));
            TransportSecurity transportSecurity = transportSecurity(environment);
            new VisionGrpcServer(port, transportSecurity).startAndAwaitShutdown();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            LOG.info("Vision server interrupted");
        } catch (IOException transportFailure) {
            LOG.error("Vision server transport failed", transportFailure);
            System.exit(1);
        } catch (RuntimeException configurationFailure) {
            LOG.error("Vision server configuration or provider startup failed", configurationFailure);
            System.exit(1);
        }
    }

    static TransportSecurity transportSecurity(Map<String, String> environment) {
        return GrpcTransportSecurityPolicy.resolve(environment, "VISION");
    }

    static int parsePort(String configured) {
        int port;
        try {
            port = configured == null || configured.isBlank()
                    ? DEFAULT_PORT
                    : Integer.parseInt(configured.trim());
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException("VISION_GRPC_PORT must be an integer", failure);
        }
        if (port < 1 || port > 65_535) {
            throw new IllegalArgumentException("VISION_GRPC_PORT must be between 1 and 65535");
        }
        return port;
    }
}
