package com.ghatana.audio.video.integration;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Image-backed checks for the currently fail-closed STT and TTS compositions. */
@DisplayName("Audio-Video Image Startup Integration Tests")
class AudioVideoIntegrationTest extends AudioVideoContainerBase {

    @Test
    @DisplayName("STT image exits with its typed provider-admission refusal")
    void sttServiceFailsClosedWithoutAdmittedProvider() {
        StartupResult result = startupRefusal(STT_SERVICE);

        assertThat(result.exitCode()).isEqualTo(1);
        assertThat(result.timedOut()).isFalse();
        assertThat(result.cleanupSuccessful()).isTrue();
        assertThat(result.output()).contains(STT_PROVIDER_REFUSAL).doesNotContain("NoClassDefFoundError");
    }

    @Test
    @DisplayName("TTS image exits with its typed provider-admission refusal")
    void ttsServiceFailsClosedWithoutAdmittedProvider() {
        StartupResult result = startupRefusal(TTS_SERVICE);

        assertThat(result.exitCode()).isEqualTo(1);
        assertThat(result.timedOut()).isFalse();
        assertThat(result.cleanupSuccessful()).isTrue();
        assertThat(result.output()).contains(TTS_PROVIDER_REFUSAL).doesNotContain("NoClassDefFoundError");
    }

    @Test
    @DisplayName("both candidate images run Java 27")
    void candidateImagesUseJava27Runtime() {
        for (String service : new String[] {STT_SERVICE, TTS_SERVICE}) {
            CommandResult version = javaVersion(service);
            assertThat(version.exitCode()).as(service).isZero();
            assertThat(version.timedOut()).as(service).isFalse();
            assertThat(version.output()).as(service).contains("version \"27");
        }
    }

    @Test
    @DisplayName("startup refusal finishes before any service port is published")
    void rejectedProviderStartupDoesNotPublishServicePorts() {
        for (String service : new String[] {STT_SERVICE, TTS_SERVICE}) {
            StartupResult result = startupRefusal(service);
            assertThat(result.servicePortsRequested()).as(service).isFalse();
            assertThat(result.elapsed()).as(service).isLessThan(STARTUP_BUDGET);
        }
    }

    private static final java.time.Duration STARTUP_BUDGET = java.time.Duration.ofSeconds(30);
}
