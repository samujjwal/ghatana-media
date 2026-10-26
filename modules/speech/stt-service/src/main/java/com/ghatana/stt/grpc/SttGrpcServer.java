package com.ghatana.stt.grpc;

import com.ghatana.audio.video.common.AudioVideoGrpcServerBase;
import com.ghatana.audio.video.common.GrpcTransportSecurityPolicy;
import com.ghatana.audiovideo.observability.AudioVideoHealthService;
import com.ghatana.observability.MetricsCollectorFactory;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.stt.service.SttAudioInputDecoder;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.Map;
import java.util.Set;

/**
 * Standalone gRPC server for Speech-to-Text.
 *
 * <p>The production service composition requires an explicit admitted provider profile before the
 * server binds. The current gRPC and local ONNX profiles are NOT_ADMITTED and therefore fail
 * startup. Production-like transport security is resolved by the shared Media policy.
 *
 * @doc.type class
 * @doc.purpose Fail-closed STT gRPC server bootstrap, transport security, and lifecycle
 * @doc.layer product
 * @doc.pattern Service
 */
public final class SttGrpcServer extends AudioVideoGrpcServerBase {

    private static final Logger LOG = LoggerFactory.getLogger(SttGrpcServer.class);
    private static final int DEFAULT_PORT = 50051;
    // Permit bounded protobuf metadata around the separately enforced 4 MiB audio payload.
    // The service decoder remains the content cap; this transport envelope cap does not raise it.
    static final long MAX_REQUEST_ENVELOPE_BYTES = 64L * 1024;
    static final int MAX_INBOUND_MESSAGE_SIZE = Math.toIntExact(
            SttAudioInputDecoder.MAX_INPUT_BYTES + MAX_REQUEST_ENVELOPE_BYTES);

    public SttGrpcServer(int port) {
        this(port, TransportSecurity.plaintext());
    }

    SttGrpcServer(int port, TransportSecurity transportSecurity) {
        this(port, transportSecurity, new ProductionSttGrpcService(new SimpleMeterRegistry()));
    }

    /** Constructs the server with the canonical Media runtime port; rights and source-version gates remain required. */
    public SttGrpcServer(int port, TransportSecurity transportSecurity,
                         MediaProcessingRuntimePort mediaRuntimePort) {
        this(port, transportSecurity,
                new ProductionSttGrpcService(new SimpleMeterRegistry(), mediaRuntimePort));
    }

    SttGrpcServer(int port, TransportSecurity transportSecurity, ProductionSttGrpcService service) {
        super(
                "stt-service",
                port,
                service,
                com.ghatana.audio.video.common.GrpcInterceptorChain.build(),
                transportSecurity,
                readinessService(service),
                MAX_INBOUND_MESSAGE_SIZE);
    }

    static AudioVideoHealthService readinessService(ProductionSttGrpcService service) {
        AudioVideoHealthService readiness = new AudioVideoHealthService(
                "stt-service",
                MetricsCollectorFactory.create(new SimpleMeterRegistry()),
                Set.of("provider"));
        readiness.registerCheck("provider", service::isProviderReady);
        service.setReadinessProbe(readiness::isServing);
        return readiness;
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
