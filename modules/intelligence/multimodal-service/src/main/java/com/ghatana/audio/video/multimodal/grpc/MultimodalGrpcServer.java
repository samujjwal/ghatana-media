package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.common.AudioVideoGrpcServerBase;
import com.ghatana.audio.video.common.GrpcTransportSecurityPolicy;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audiovideo.observability.AudioVideoHealthService;
import com.ghatana.observability.MetricsCollectorFactory;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;

/**
 * Standalone gRPC server for the Multimodal analysis service.
 *
 * <p>Production-like transport security is resolved through the shared Media policy; missing TLS
 * material fails startup rather than binding a plaintext multimodal endpoint.
 *
 * @doc.type class
 * @doc.purpose Fail-closed Multimodal gRPC server bootstrap, transport security, and lifecycle
 * @doc.layer product
 * @doc.pattern Service
 */
public final class MultimodalGrpcServer extends AudioVideoGrpcServerBase {

    private static final Logger LOG = LoggerFactory.getLogger(MultimodalGrpcServer.class);
    private static final int DEFAULT_PORT = 50055;

    public MultimodalGrpcServer(int port) {
        this(port, TransportSecurity.plaintext());
    }

    MultimodalGrpcServer(int port, TransportSecurity transportSecurity) {
        this(port, transportSecurity, createRuntime());
    }

    private MultimodalGrpcServer(int port, TransportSecurity transportSecurity, ServerRuntime runtime) {
        this(port, transportSecurity, runtime.service(), runtime.readiness());
    }

    MultimodalGrpcServer(
            int port,
            TransportSecurity transportSecurity,
            MultimodalGrpcService service,
            AudioVideoHealthService readiness) {
        super(
                "multimodal-service",
                port,
                service,
                com.ghatana.audio.video.common.GrpcInterceptorChain.build(),
                transportSecurity,
                readiness);
    }

    private static ServerRuntime createRuntime() {
        MultimodalGrpcService service = new MultimodalGrpcService(MediaProcessingMetrics.create());
        return new ServerRuntime(service, readinessService(service));
    }

    static AudioVideoHealthService readinessService(MultimodalGrpcService service) {
        return readinessService(service, service::isSttProviderReady, service::isVisionProviderReady);
    }

    static AudioVideoHealthService readinessService(
            MultimodalGrpcService service,
            BooleanSupplier sttProviderReady,
            BooleanSupplier visionProviderReady) {
        AudioVideoHealthService readiness = new AudioVideoHealthService(
                "multimodal-service",
                MetricsCollectorFactory.create(new SimpleMeterRegistry()),
                Set.of("stt-provider", "vision-provider"));
        readiness.registerCheck("stt-provider", sttProviderReady::getAsBoolean);
        readiness.registerCheck("vision-provider", visionProviderReady::getAsBoolean);
        service.setReadinessProbe(readiness::isServing);
        return readiness;
    }

    private record ServerRuntime(
            MultimodalGrpcService service,
            AudioVideoHealthService readiness) {}

    public static void main(String[] args) {
        if (Boolean.getBoolean("av.smokeTest")) {
            LOG.info("[smoke-test] MultimodalGrpcServer classpath check passed — exiting cleanly.");
            return;
        }

        try {
            Map<String, String> environment = System.getenv();
            int port = parsePort(environment.get("MULTIMODAL_GRPC_PORT"));
            TransportSecurity transportSecurity = transportSecurity(environment);
            new MultimodalGrpcServer(port, transportSecurity).startAndAwaitShutdown();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            LOG.info("Multimodal server interrupted");
        } catch (IOException transportFailure) {
            LOG.error("Multimodal server transport failed", transportFailure);
            System.exit(1);
        } catch (RuntimeException configurationFailure) {
            LOG.error("Multimodal server configuration or provider startup failed", configurationFailure);
            System.exit(1);
        }
    }

    static TransportSecurity transportSecurity(Map<String, String> environment) {
        return GrpcTransportSecurityPolicy.resolve(environment, "MULTIMODAL");
    }

    static int parsePort(String configured) {
        int port;
        try {
            port = configured == null || configured.isBlank()
                    ? DEFAULT_PORT
                    : Integer.parseInt(configured.trim());
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException("MULTIMODAL_GRPC_PORT must be an integer", failure);
        }
        if (port < 1 || port > 65_535) {
            throw new IllegalArgumentException("MULTIMODAL_GRPC_PORT must be between 1 and 65535");
        }
        return port;
    }
}
