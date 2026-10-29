package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.common.AudioVideoGrpcServerBase;
import com.ghatana.audio.video.common.GrpcTransportSecurityPolicy;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audiovideo.observability.AudioVideoHealthService;
import com.ghatana.observability.MetricsCollectorFactory;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.ServiceLoader;
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

    /** Constructs the server with the canonical Media runtime port; source authority remains required. */
    public MultimodalGrpcServer(int port, TransportSecurity transportSecurity,
                                MediaProcessingRuntimePort mediaRuntimePort) {
        this(port, transportSecurity, createRuntime(mediaRuntimePort));
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
        return createRuntime(null);
    }

    private static ServerRuntime createRuntime(MediaProcessingRuntimePort mediaRuntimePort) {
        // A composed runtime port supplies the real source-rights seam; without one the
        // service remains fail-closed on the unavailable default.
        SourceAuthorization sourceAuthorization = mediaRuntimePort == null
                ? SourceAuthorization.unavailable()
                : new MediaRuntimeSourceAuthorization(mediaRuntimePort);
        MultimodalGrpcService service = new MultimodalGrpcService(
                MediaProcessingMetrics.create(), sourceAuthorization, mediaRuntimePort);
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

        MediaProcessingRuntimePort runtimePort = null;
        try {
            Map<String, String> environment = System.getenv();
            int port = parsePort(environment.get("MULTIMODAL_GRPC_PORT"));
            TransportSecurity transportSecurity = transportSecurity(environment);
            runtimePort = composeRuntimePort(environment);
            new MultimodalGrpcServer(port, transportSecurity, runtimePort).startAndAwaitShutdown();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            LOG.info("Multimodal server interrupted");
        } catch (IOException transportFailure) {
            LOG.error("Multimodal server transport failed", transportFailure);
            System.exit(1);
        } catch (RuntimeException configurationFailure) {
            LOG.error("Multimodal server configuration or provider startup failed", configurationFailure);
            System.exit(1);
        } finally {
            closeRuntimePort(runtimePort);
        }
    }

    /**
     * Discovers the canonical Media runtime through the installed
     * {@link com.ghatana.media.runtime.MediaRuntimePortFactory} SPI and composes it
     * against the real environment. Composition failures propagate so the server
     * cannot start on a half-initialized runtime; an absent factory leaves the
     * service fail-closed with every operation not-admitted and readiness down.
     */
    static MediaProcessingRuntimePort composeRuntimePort(Map<String, String> environment) {
        List<com.ghatana.media.runtime.MediaRuntimePortFactory> factories = new ArrayList<>();
        for (com.ghatana.media.runtime.MediaRuntimePortFactory factory
                : ServiceLoader.load(com.ghatana.media.runtime.MediaRuntimePortFactory.class)) {
            factories.add(factory);
        }
        if (factories.isEmpty()) {
            LOG.warn("No MediaRuntimePortFactory installed; multimodal operations stay NOT_ADMITTED");
            return null;
        }
        if (factories.size() > 1) {
            throw new IllegalStateException(
                    "Multiple MediaRuntimePortFactory implementations are installed: "
                            + factories.stream().map(
                                    com.ghatana.media.runtime.MediaRuntimePortFactory::factoryId)
                                    .sorted().toList());
        }
        MediaProcessingRuntimePort port = factories.getFirst().compose(environment);
        LOG.info("Composed Media runtime port via factory {}", factories.getFirst().factoryId());
        return port;
    }

    private static void closeRuntimePort(MediaProcessingRuntimePort runtimePort) {
        if (runtimePort instanceof AutoCloseable closeable) {
            try {
                closeable.close();
            } catch (Exception closeFailure) {
                LOG.error("Media runtime port shutdown failed", closeFailure);
            }
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
