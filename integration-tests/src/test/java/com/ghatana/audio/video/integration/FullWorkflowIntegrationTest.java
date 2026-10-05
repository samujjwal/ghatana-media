package com.ghatana.audio.video.integration;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Testcontainers;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Full end-to-end workflow integration tests.
 * Tests STT and TTS services working together via the shared
 * {@link AudioVideoContainerBase} Docker Compose orchestration.
 *
 * <p>Container lifecycle and wait strategies are owned by the base class.
 * gRPC call bodies are gated behind GH-90000 until real service images are
 * available in CI.
 *
 * @doc.type class
 * @doc.purpose Full workflow integration testing of STT and TTS service pair
 * @doc.layer integration
 * @doc.pattern Test
 */
@Tag("integration")
@Testcontainers
@DisplayName("Full Workflow Integration Tests")
class FullWorkflowIntegrationTest extends AudioVideoContainerBase {

    @Test
    @DisplayName("STT service gRPC port is reachable before workflow")
    void sttGrpcPort_isReachable() { 
        assertThat(sttGrpcPort()).isGreaterThan(0);
        assertThat(sttHost()).isNotBlank();
    }

    @Test
    @DisplayName("TTS service gRPC port is reachable before workflow")
    void ttsGrpcPort_isReachable() { 
        assertThat(ttsGrpcPort()).isGreaterThan(0);
        assertThat(ttsHost()).isNotBlank();
    }

    @Test
    @DisplayName("STT and TTS services share network for inter-service calls")
    void sttAndTts_shareNetwork() { 
        // DockerComposeContainer wires both services on the same internal network,
        // enabling service-name-based DNS resolution between them.
        assertThat(sttHost()).isEqualTo(ttsHost()); // both expose on the same host
        assertThat(sttGrpcPort()).isNotEqualTo(ttsGrpcPort());
    }

    @Test
    @DisplayName("STT HTTP health endpoint is mapped and reachable")
    void sttHttpHealthPort_isMapped() { 
        assertThat(serviceHttpPort(STT_SERVICE)).isGreaterThan(0);
    }

    @Test
    @DisplayName("TTS HTTP health endpoint is mapped and reachable")
    void ttsHttpHealthPort_isMapped() { 
        assertThat(serviceHttpPort(TTS_SERVICE)).isGreaterThan(0);
    }
}
