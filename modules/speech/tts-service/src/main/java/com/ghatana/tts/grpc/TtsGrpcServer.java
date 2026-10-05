package com.ghatana.tts.grpc;

import com.ghatana.audio.video.common.AudioVideoGrpcServerBase;
import com.ghatana.audio.video.common.GrpcTransportSecurityPolicy;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.Map;

/**
 * Standalone gRPC server for Text-to-Speech.
 *
 * <p>The production service composition initializes its model before the server binds. Missing or
 * invalid models fail startup. Production-like transport security is resolved by the shared Media
 * policy and cannot silently fall back to plaintext.
 *
 * @doc.type class
 * @doc.purpose Fail-closed TTS gRPC server bootstrap, transport security, and lifecycle
 * @doc.layer product
 * @doc.pattern Service
 */
public final class TtsGrpcServer extends AudioVideoGrpcServerBase {

    private static final Logger LOG = LoggerFactory.getLogger(TtsGrpcServer.class);
    private static final int DEFAULT_PORT = 50052;

    public TtsGrpcServer(int port) {
        this(port, TransportSecurity.plaintext());
    }

    TtsGrpcServer(int port, TransportSecurity transportSecurity) {
        super(
                "tts-service",
                port,
                new ProductionTtsGrpcService(new SimpleMeterRegistry()),
                com.ghatana.audio.video.common.GrpcInterceptorChain.build(),
                transportSecurity);
    }

    public static void main(String[] args) {
        if (Boolean.getBoolean("av.smokeTest")) {
            LOG.info("[smoke-test] TtsGrpcServer classpath check passed — exiting cleanly.");
            return;
        }

        try {
            Map<String, String> environment = System.getenv();
            int port = parsePort(environment.get("TTS_GRPC_PORT"));
            TransportSecurity transportSecurity = transportSecurity(environment);
            new TtsGrpcServer(port, transportSecurity).startAndAwaitShutdown();
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            LOG.info("TTS server interrupted");
        } catch (IOException exception) {
            LOG.error("TTS server transport startup failed", exception);
            System.exit(1);
        } catch (RuntimeException exception) {
            LOG.error("TTS server configuration or dependency startup failed", exception);
            System.exit(1);
        }
    }

    static TransportSecurity transportSecurity(Map<String, String> environment) {
        return GrpcTransportSecurityPolicy.resolve(environment, "TTS");
    }

    static int parsePort(String configured) {
        int port;
        try {
            port = configured == null || configured.isBlank()
                    ? DEFAULT_PORT
                    : Integer.parseInt(configured.trim());
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException("TTS_GRPC_PORT must be an integer", exception);
        }
        if (port < 1 || port > 65_535) {
            throw new IllegalArgumentException("TTS_GRPC_PORT must be between 1 and 65535");
        }
        return port;
    }
}
