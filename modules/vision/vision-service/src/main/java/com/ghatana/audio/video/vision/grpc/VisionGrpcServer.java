package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.AudioVideoGrpcServerBase;
import com.ghatana.audio.video.common.GrpcTransportSecurityPolicy;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audiovideo.observability.AudioVideoHealthService;
import com.ghatana.observability.MetricsCollectorFactory;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;

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
        this(port, transportSecurity, createProductionRuntime());
    }

    private VisionGrpcServer(int port, TransportSecurity transportSecurity, ServerRuntime runtime) {
        super(
                "vision-service",
                port,
                runtime.service(),
                com.ghatana.audio.video.common.GrpcInterceptorChain.build(),
                transportSecurity,
                runtime.readiness());
    }

    private static ServerRuntime createProductionRuntime() {
        ProductionVisionGrpcService service = new ProductionVisionGrpcService(MediaProcessingMetrics.create());
        try {
            AudioVideoHealthService readiness = createReadinessLifecycle(
                    new SimpleMeterRegistry(), service::isProviderReady);
            service.setReadinessProbe(readiness::isServing);
            return new ServerRuntime(service, readiness);
        } catch (RuntimeException failure) {
            service.close();
            throw failure;
        }
    }

    static AudioVideoHealthService createReadinessLifecycle(
            MeterRegistry metrics, BooleanSupplier providerReadiness) {
        AudioVideoHealthService readiness = new AudioVideoHealthService(
                "vision-service", MetricsCollectorFactory.create(metrics), Set.of("provider"));
        readiness.registerCheck("provider", providerReadiness::getAsBoolean);
        return readiness;
    }

    private record ServerRuntime(ProductionVisionGrpcService service, AudioVideoHealthService readiness) { }

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
