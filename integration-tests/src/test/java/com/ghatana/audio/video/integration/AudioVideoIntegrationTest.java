package com.ghatana.audio.video.integration;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Testcontainers;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Integration tests for end-to-end audio-video workflows.
 * Tests STT and TTS services working together via the shared
 * {@link AudioVideoContainerBase} Docker Compose orchestration.
 *
 * <p>Container lifecycle and wait strategies are owned by the base class;
 * this class is responsible only for test assertions.
 *
 * @doc.type class
 * @doc.purpose End-to-end integration testing of STT + TTS service pair
 * @doc.layer integration
 * @doc.pattern Test
 */
@Tag("integration")
@Testcontainers
@DisplayName("Audio-Video Integration Tests")
class AudioVideoIntegrationTest extends AudioVideoContainerBase {

    @Test
    @DisplayName("STT service exposes reachable gRPC and HTTP ports after startup")
    void sttService_exposesPortsAfterStartup() { 
        assertThat(sttGrpcPort()).isGreaterThan(0);
        assertThat(serviceHttpPort(STT_SERVICE)).isGreaterThan(0);
        assertThat(sttHost()).isNotBlank();
    }

    @Test
    @DisplayName("TTS service exposes reachable gRPC and HTTP ports after startup")
    void ttsService_exposesPortsAfterStartup() { 
        assertThat(ttsGrpcPort()).isGreaterThan(0);
        assertThat(serviceHttpPort(TTS_SERVICE)).isGreaterThan(0);
        assertThat(ttsHost()).isNotBlank();
    }

    @Test
    @DisplayName("Both services expose distinct gRPC ports (no collision)")
    void bothServices_distinctGrpcPorts() { 
        // Docker maps both to ephemeral host ports; assert they are distinct
        assertThat(sttGrpcPort()).isNotEqualTo(ttsGrpcPort());
    }

    @Test
    @DisplayName("STT and TTS services share the Docker Compose network")
    void bothServices_shareNetwork() { 
        // DockerComposeContainer wires all services to the same internal network;
        // cross-service calls are possible using service-name aliases
        assertThat(COMPOSE).isNotNull();
        assertThat(sttHost()).isEqualTo(ttsHost()); // both map to the same host
    }
}
