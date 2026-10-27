package com.ghatana.audio.video.integration;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Verifies that an end-to-end speech workflow cannot start with unadmitted providers. */
@DisplayName("Fail-Closed Full Workflow Image Tests")
class FullWorkflowIntegrationTest extends AudioVideoContainerBase {

    @Test
    @DisplayName("STT does not report a completed transcript when startup is refused")
    void sttStartupDoesNotClaimCompletedTranscription() {
        StartupResult result = startupRefusal(STT_SERVICE);

        assertThat(result.exitCode()).isNotZero();
        assertThat(result.output()).contains(STT_PROVIDER_REFUSAL)
                .doesNotContain("TRANSCRIPTION_COMPLETED", "transcription completed");
    }

    @Test
    @DisplayName("TTS does not report synthesized audio when startup is refused")
    void ttsStartupDoesNotClaimCompletedSynthesis() {
        StartupResult result = startupRefusal(TTS_SERVICE);

        assertThat(result.exitCode()).isNotZero();
        assertThat(result.output()).contains(TTS_PROVIDER_REFUSAL)
                .doesNotContain("SYNTHESIS_COMPLETED", "synthesis completed");
    }

    @Test
    @DisplayName("workflow requires both speech providers to pass admission")
    void workflowCannotStartWhenEitherProviderIsNotAdmitted() {
        assertThat(startupRefusal(STT_SERVICE).exitCode()).isNotZero();
        assertThat(startupRefusal(TTS_SERVICE).exitCode()).isNotZero();
    }

    @Test
    @DisplayName("provider-refusal diagnostics stay bounded and contain no request payload")
    void startupDiagnosticsAreBoundedAndPayloadFree() {
        for (StartupResult result : new StartupResult[] {
                startupRefusal(STT_SERVICE), startupRefusal(TTS_SERVICE)}) {
            assertThat(result.timedOut()).isFalse();
            assertThat(result.elapsed()).isLessThan(STARTUP_BUDGET);
            assertThat(result.cleanupSuccessful()).isTrue();
            assertThat(result.output()).hasSizeLessThanOrEqualTo(MAX_DIAGNOSTIC_CHARS)
                    .doesNotContain("fixture-audio", "fixture-text", "Authorization:");
        }
    }

    @Test
    @DisplayName("Compose startup probes do not publish gRPC or HTTP ports")
    void unavailableProvidersDoNotExposeListeners() {
        for (String service : new String[] {STT_SERVICE, TTS_SERVICE}) {
            StartupResult result = startupRefusal(service);
            assertThat(result.servicePortsRequested()).as(service).isFalse();
            assertThat(result.exitCode()).as(service).isNotZero();
        }
    }

    private static final java.time.Duration STARTUP_BUDGET = java.time.Duration.ofSeconds(30);
    private static final int MAX_DIAGNOSTIC_CHARS = 64 * 1024;
}
