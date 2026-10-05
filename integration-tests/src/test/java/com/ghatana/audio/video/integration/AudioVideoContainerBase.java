/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.integration;

import org.junit.jupiter.api.Tag;
import org.testcontainers.containers.DockerComposeContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.io.File;
import java.time.Duration;

/**
 * Shared Testcontainers base for audio-video integration tests.
 *
 * <p>Orchestrates the STT and TTS services via Docker Compose
 * ({@code docker-compose.integration.yml}). Wait strategies are defined
 * <em>on the container object itself</em> — not in {@code @BeforeEach} —
 * so Testcontainers can honour them during startup.
 *
 * <p>Exposes helper methods to retrieve mapped host/port values so individual
 * test classes can build their gRPC channels without repeating boilerplate.
 *
 * <p>All subclasses must be annotated with {@code @Tag("integration")} and
 * {@code @Testcontainers} (inherited annotations are supported from JUnit 5.8+,
 * but explicit declaration keeps intent clear).
 *
 * @doc.type class
 * @doc.purpose Shared Docker Compose container base for audio-video integration tests
 * @doc.layer integration
 * @doc.pattern TestBase
 */
@Tag("integration")
@Testcontainers
public abstract class AudioVideoContainerBase {

    /** Service name as declared in {@code docker-compose.integration.yml}. */
    protected static final String STT_SERVICE = "stt-service";
    /** Service name as declared in {@code docker-compose.integration.yml}. */
    protected static final String TTS_SERVICE = "tts-service";

    /** gRPC port for the STT service. */
    protected static final int STT_GRPC_PORT = 50051;
    /** gRPC port for the TTS service. */
    protected static final int TTS_GRPC_PORT = 50052;
    /** HTTP health port shared by both services. */
    protected static final int SERVICE_HTTP_PORT = 8080;

    /**
     * Single shared Docker Compose environment for the entire test suite.
     *
     * <p>Wait strategies are registered per-service so startup blocks until
     * both health endpoints respond {@code 200 OK}, guaranteeing that the gRPC
     * listeners are ready before any test method executes.
     */
    @Container
    @SuppressWarnings("resource") // managed by @Testcontainers lifecycle
    protected static final DockerComposeContainer<?> COMPOSE =
            new DockerComposeContainer<>(
                    new File("docker-compose.integration.yml"))
                    // STT service: wait on HTTP health before proceeding
                    .withExposedService(STT_SERVICE, STT_GRPC_PORT,
                            Wait.forListeningPort()
                                    .withStartupTimeout(Duration.ofSeconds(120)))
                    .withExposedService(STT_SERVICE, SERVICE_HTTP_PORT,
                            Wait.forHttp("/health/live")
                                    .forStatusCode(200)
                                    .withStartupTimeout(Duration.ofSeconds(120)))
                    // TTS service: wait on HTTP health before proceeding
                    .withExposedService(TTS_SERVICE, TTS_GRPC_PORT,
                            Wait.forListeningPort()
                                    .withStartupTimeout(Duration.ofSeconds(120)))
                    .withExposedService(TTS_SERVICE, SERVICE_HTTP_PORT,
                            Wait.forHttp("/health/live")
                                    .forStatusCode(200)
                                    .withStartupTimeout(Duration.ofSeconds(120)))
                    .withLocalCompose(true);

    // ---- Helper accessors --------------------------------------------------

    /**
     * Returns the externally-accessible host for the STT service.
     *
     * @return host string (usually {@code localhost})
     */
    protected static String sttHost() {
        return COMPOSE.getServiceHost(STT_SERVICE, STT_GRPC_PORT);
    }

    /**
     * Returns the externally-mapped gRPC port for the STT service.
     *
     * @return ephemeral port mapped from container's {@code 50051}
     */
    protected static int sttGrpcPort() {
        return COMPOSE.getServicePort(STT_SERVICE, STT_GRPC_PORT);
    }

    /**
     * Returns the externally-accessible host for the TTS service.
     *
     * @return host string (usually {@code localhost})
     */
    protected static String ttsHost() {
        return COMPOSE.getServiceHost(TTS_SERVICE, TTS_GRPC_PORT);
    }

    /**
     * Returns the externally-mapped gRPC port for the TTS service.
     *
     * @return ephemeral port mapped from container's {@code 50052}
     */
    protected static int ttsGrpcPort() {
        return COMPOSE.getServicePort(TTS_SERVICE, TTS_GRPC_PORT);
    }

    /**
     * Returns the externally-mapped HTTP port for the given service.
     *
     * @param serviceName one of {@link #STT_SERVICE} or {@link #TTS_SERVICE}
     * @return ephemeral port mapped from container's {@code 8080}
     */
    protected static int serviceHttpPort(String serviceName) {
        return COMPOSE.getServicePort(serviceName, SERVICE_HTTP_PORT);
    }
}
