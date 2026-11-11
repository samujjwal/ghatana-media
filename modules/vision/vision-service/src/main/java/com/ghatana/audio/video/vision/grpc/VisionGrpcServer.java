package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.AudioVideoGrpcServerBase;
import com.ghatana.audio.video.common.GrpcTransportSecurityPolicy;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audiovideo.observability.AudioVideoHealthService;
import com.ghatana.observability.MetricsCollectorFactory;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimePortFactory;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
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

    /** Constructs the server with the canonical Media runtime port; model/rights gates remain independent. */
    public VisionGrpcServer(int port, TransportSecurity transportSecurity,
                            MediaProcessingRuntimePort mediaRuntimePort) {
        this(port, transportSecurity, createProductionRuntime(mediaRuntimePort));
    }

    private VisionGrpcServer(int port, TransportSecurity transportSecurity, ServerRuntime runtime) {
        this(port, transportSecurity, runtime.service(), runtime.readiness());
    }

    VisionGrpcServer(
            int port,
            TransportSecurity transportSecurity,
            ProductionVisionGrpcService service,
            AudioVideoHealthService readiness) {
        super(
                "vision-service",
                port,
                service,
                com.ghatana.audio.video.common.GrpcInterceptorChain.build(),
                transportSecurity,
                readiness);
    }

    private static ServerRuntime createProductionRuntime() {
        return createProductionRuntime(null);
    }

    private static ServerRuntime createProductionRuntime(MediaProcessingRuntimePort mediaRuntimePort) {
        return createProductionRuntime(mediaRuntimePort, false);
    }

    private static ServerRuntime createProductionRuntime(
            MediaProcessingRuntimePort mediaRuntimePort, boolean ownRuntimePort) {
        return createProductionRuntime(System.getenv(), mediaRuntimePort, ownRuntimePort);
    }

    private static ServerRuntime createProductionRuntime(
            Map<String, String> environment, MediaProcessingRuntimePort mediaRuntimePort, boolean ownRuntimePort) {
        ProductionVisionGrpcService service = null;
        try {
            MeterRegistry providerMetrics = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
            service = new ProductionVisionGrpcService(
                    ProductionVisionGrpcService.compose(environment, mediaRuntimePort),
                    MediaProcessingMetrics.create(), providerMetrics, mediaRuntimePort);
            if (ownRuntimePort) service.ownRuntimePort(mediaRuntimePort);
            AudioVideoHealthService readiness = createReadinessLifecycle(
                    providerMetrics, service::isProviderReady);
            service.setReadinessProbe(readiness::isServing);
            return new ServerRuntime(service, readiness);
        } catch (RuntimeException | Error failure) {
            if (service != null) service.close();
            else if (ownRuntimePort) closeRuntimePort(mediaRuntimePort);
            throw failure;
        }
    }

    private static void closeRuntimePort(MediaProcessingRuntimePort mediaRuntimePort) {
        if (mediaRuntimePort instanceof AutoCloseable closeable) {
            try { closeable.close(); }
            catch (Exception closeFailure) { LOG.error("Media runtime port shutdown failed", closeFailure); }
        }
    }

    /** Discover and compose the canonical runtime for the standalone process. */
    static MediaProcessingRuntimePort composeRuntimePort(Map<String, String> environment) {
        return composeRuntimePort(environment, ServiceLoader.load(MediaRuntimePortFactory.class));
    }

    static MediaProcessingRuntimePort composeRuntimePort(Map<String, String> environment, ClassLoader classLoader) {
        return composeRuntimePort(environment, ServiceLoader.load(MediaRuntimePortFactory.class, classLoader));
    }

    /** OCR_ONLY requires one owner-selected Media runtime port for per-request source authorization. */
    static MediaProcessingRuntimePort composeRuntimePortForProfile(
            Map<String, String> environment, Iterable<MediaRuntimePortFactory> discoveredFactories) {
        boolean required = isOcrOnly(environment);
        List<MediaRuntimePortFactory> factories = new ArrayList<>();
        discoveredFactories.forEach(factories::add);
        if (factories.isEmpty() && !required) return null;
        return composeRuntimePort(environment, factories);
    }

    private static boolean isOcrOnly(Map<String, String> environment) {
        return com.ghatana.audio.video.vision.model.VisionCapabilityProfile.fromEnvironment(environment)
                == com.ghatana.audio.video.vision.model.VisionCapabilityProfile.OCR_ONLY;
    }

    static MediaProcessingRuntimePort composeRuntimePortForProfile(
            Map<String, String> environment, ClassLoader classLoader) {
        return composeRuntimePortForProfile(environment,
                ServiceLoader.load(MediaRuntimePortFactory.class, classLoader));
    }

    static MediaProcessingRuntimePort composeRuntimePort(
            Map<String, String> environment, Iterable<MediaRuntimePortFactory> discoveredFactories) {
        List<MediaRuntimePortFactory> factories = new ArrayList<>();
        discoveredFactories.forEach(factories::add);
        if (factories.isEmpty()) {
            throw new IllegalStateException(
                    "Standalone Vision requires exactly one MediaRuntimePortFactory; none is installed");
        }
        if (factories.size() > 1) {
            throw new IllegalStateException("Multiple MediaRuntimePortFactory implementations are installed: "
                    + factories.stream().map(MediaRuntimePortFactory::factoryId).sorted().toList());
        }
        MediaRuntimePortFactory factory = factories.getFirst();
        MediaProcessingRuntimePort port = factory.compose(Map.copyOf(environment));
        if (port == null) {
            throw new IllegalStateException("MediaRuntimePortFactory " + factory.factoryId()
                    + " returned a null runtime port");
        }
        LOG.info("Composed Media runtime port via factory {}", factory.factoryId());
        return port;
    }

    static AudioVideoHealthService createReadinessLifecycle(
            MeterRegistry metrics, BooleanSupplier providerReadiness) {
        AudioVideoHealthService readiness = new AudioVideoHealthService(
                "vision-service", MetricsCollectorFactory.create(metrics), Set.of("provider"));
        readiness.registerCheck("provider", providerReadiness::getAsBoolean);
        return readiness;
    }

    private record ServerRuntime(ProductionVisionGrpcService service, AudioVideoHealthService readiness) { }

    /** Builds the same factory-backed server used by the standalone process entrypoint. */
    static VisionGrpcServer createStandaloneServer(Map<String, String> environment, ClassLoader classLoader) {
        int port = parsePort(environment.get("VISION_GRPC_PORT"));
        TransportSecurity security = transportSecurity(environment);
        MediaProcessingRuntimePort runtimePort = composeRuntimePortForProfile(environment, classLoader);
        ServerRuntime runtime = null;
        try {
            runtime = createProductionRuntime(environment, runtimePort, true);
            return new VisionGrpcServer(port, security, runtime);
        } catch (RuntimeException | Error failure) {
            if (runtime != null) runtime.service().close();
            throw failure;
        }
    }

    public static void main(String[] args) {
        if (Boolean.getBoolean("av.smokeTest")) {
            LOG.info("[smoke-test] VisionGrpcServer classpath check passed — exiting cleanly.");
            return;
        }

        VisionGrpcServer server = null;
        int exitCode = 0;
        try {
            Map<String, String> environment = System.getenv();
            server = createStandaloneServer(environment, VisionGrpcServer.class.getClassLoader());
            startAndAwaitShutdown(server);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            LOG.info("Vision server interrupted");
        } catch (IOException transportFailure) {
            LOG.error("Vision server transport failed", transportFailure);
            exitCode = 1;
        } catch (RuntimeException configurationFailure) {
            LOG.error("Vision server configuration or provider startup failed", configurationFailure);
            exitCode = 1;
        } finally {
            if (server != null) server.close();
        }
        if (exitCode != 0) System.exit(exitCode);
    }

    static void startAndAwaitShutdown(VisionGrpcServer server) throws IOException, InterruptedException {
        try {
            server.startAndAwaitShutdown();
        } finally {
            server.close();
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
