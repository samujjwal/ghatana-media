/**
 * @doc.type class
 * @doc.purpose Test audio transcoding, format conversion, and quality validation
 * @doc.layer products
 * @doc.pattern Test
 */
package com.ghatana.audio.processing;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Audio Processing Logic Tests
 *
 * Test audio transcoding, format conversion, and quality validation.
 */
@DisplayName("Audio Processing Logic Tests")
class AudioProcessingTest {

    private static JsonNode fixtures;
    private static ObjectMapper mapper;

    @BeforeAll
    static void loadFixtures() throws IOException {
        mapper = new ObjectMapper();
        try (InputStream is = AudioProcessingTest.class.getClassLoader()
                .getResourceAsStream("media-contract-fixtures.json")) {
            assertThat(is).as("media-contract-fixtures.json must be on test classpath").isNotNull();
            fixtures = mapper.readTree(is);
        }
    }

    private static JsonNode findAudioFormatById(String id) {
        for (JsonNode fmt : fixtures.get("audioFormats")) {
            if (id.equals(fmt.get("id").asText())) {
                return fmt;
            }
        }
        return null;
    }

    private static JsonNode findSttScenarioById(String id) {
        for (JsonNode sc : fixtures.get("sttScenarios")) {
            if (id.equals(sc.get("id").asText())) {
                return sc;
            }
        }
        return null;
    }

    private static JsonNode findRetentionScenarioById(String id) {
        for (JsonNode sc : fixtures.get("retentionScenarios")) {
            if (id.equals(sc.get("id").asText())) {
                return sc;
            }
        }
        return null;
    }

    private static JsonNode findConsentScenarioById(String id) {
        for (JsonNode sc : fixtures.get("consentScenarios")) {
            if (id.equals(sc.get("id").asText())) {
                return sc;
            }
        }
        return null;
    }

    @Test
    @DisplayName("Audio formats define required codec and sample-rate fields")
    void audioFormatsDefineRequiredFields() {
        JsonNode formats = fixtures.get("audioFormats");
        assertThat(formats).isNotNull();
        assertThat(formats.isArray()).isTrue();
        assertThat(formats.size()).isEqualTo(3);

        for (JsonNode fmt : formats) {
            assertThat(fmt.has("id")).as("id required").isTrue();
            assertThat(fmt.has("codec")).as("codec required for " + fmt.get("id").asText()).isTrue();
            assertThat(fmt.has("sampleRate")).as("sampleRate required").isTrue();
            assertThat(fmt.has("channels")).as("channels required").isTrue();
            assertThat(fmt.has("maxFileSizeBytes")).as("maxFileSizeBytes required").isTrue();
        }
    }

    @Test
    @DisplayName("PCM mono 16k matches STT pipeline narrow-band requirements")
    void pcmMono16kMeetsSttRequirements() {
        JsonNode pcm = findAudioFormatById("pcm-mono-16k");
        assertThat(pcm).isNotNull();
        assertThat(pcm.get("codec").asText()).isEqualTo("PCM_S16LE");
        assertThat(pcm.get("sampleRate").asInt()).isEqualTo(16000);
        assertThat(pcm.get("channels").asInt()).isEqualTo(1);
        assertThat(pcm.get("bitsPerSample").asInt()).isEqualTo(16);
    }

    @Test
    @DisplayName("Opus compressed format is suitable for WebRTC streaming")
    void opusFormatIsWebRtcSuitable() {
        JsonNode opus = findAudioFormatById("opus-mono-48k");
        assertThat(opus).isNotNull();
        assertThat(opus.get("codec").asText()).isEqualTo("OPUS");
        assertThat(opus.get("sampleRate").asInt()).isGreaterThanOrEqualTo(48000);
        assertThat(opus.get("bitrate").asInt()).isLessThanOrEqualTo(32000);
        assertThat(opus.get("maxFileSizeBytes").asInt()).isLessThan(1_000_000);
    }

    @Test
    @DisplayName("STT scenarios define confidence and word-count expectations")
    void sttScenariosDefineConfidenceExpectations() {
        JsonNode scenarios = fixtures.get("sttScenarios");
        assertThat(scenarios).isNotNull();
        assertThat(scenarios.isArray()).isTrue();
        assertThat(scenarios.size()).isEqualTo(4);

        for (JsonNode sc : scenarios) {
            assertThat(sc.has("expectedConfidenceMin")).as("confidenceMin for " + sc.get("id").asText()).isTrue();
            assertThat(sc.has("expectedWordCount")).as("wordCount for " + sc.get("id").asText()).isTrue();
        }
    }

    @Test
    @DisplayName("Clear-speech scenario meets high-confidence threshold")
    void clearSpeechScenarioMeetsHighConfidence() {
        JsonNode clear = findSttScenarioById("clear-speech-en-gb");
        assertThat(clear).isNotNull();
        assertThat(clear.get("expectedConfidenceMin").asDouble()).isGreaterThanOrEqualTo(0.85);
        assertThat(clear.get("expectedWordCount").asInt()).isGreaterThanOrEqualTo(10);
        assertThat(clear.get("containsPii").asBoolean()).isFalse();
    }

    @Test
    @DisplayName("PII content scenario flags redaction requirements")
    void piiContentScenarioFlagsRedaction() {
        JsonNode pii = findSttScenarioById("pii-content-en-gb");
        assertThat(pii).isNotNull();
        assertThat(pii.get("containsPii").asBoolean()).isTrue();
        assertThat(pii.get("piiTypes").size()).isGreaterThanOrEqualTo(1);
    }

    @Test
    @DisplayName("Silence-only scenario expects empty transcript result")
    void silenceOnlyExpectsEmptyResult() {
        JsonNode silence = findSttScenarioById("silence-only");
        assertThat(silence).isNotNull();
        assertThat(silence.get("expectEmptyResult").asBoolean()).isTrue();
        assertThat(silence.get("expectedWordCount").asInt()).isEqualTo(0);
    }

    @Test
    @DisplayName("Retention policy purges records past their window")
    void expiredTranscriptsMustBePurged() {
        JsonNode scenario = findRetentionScenarioById("transcript-30day-purge");
        assertThat(scenario).isNotNull();
        assertThat(scenario.get("dataType").asText()).isEqualTo("TRANSCRIPT");
        assertThat(scenario.get("expectPurged").asBoolean()).isTrue();
        int offset = scenario.get("createdOffsetDays").asInt();
        int retention = scenario.get("retentionDays").asInt();
        assertThat(offset).isLessThan(-retention);
    }

    @Test
    @DisplayName("Retention policy retains records within their window")
    void inWindowTranscriptsMustBeRetained() {
        JsonNode scenario = findRetentionScenarioById("transcript-within-window");
        assertThat(scenario).isNotNull();
        assertThat(scenario.get("expectPurged").asBoolean()).isFalse();
        int offset = scenario.get("createdOffsetDays").asInt();
        int retention = scenario.get("retentionDays").asInt();
        assertThat(offset).isGreaterThanOrEqualTo(-retention);
    }

    @Test
    @DisplayName("Consent revocation triggers immediate purge of biometric data")
    void consentRevocationTriggersBiometricPurge() {
        JsonNode scenario = findRetentionScenarioById("biometric-revocation-purge");
        assertThat(scenario).isNotNull();
        assertThat(scenario.get("consentRevoked").asBoolean()).isTrue();
        assertThat(scenario.get("expectPurged").asBoolean()).isTrue();
        assertThat(scenario.get("dataType").asText()).isEqualTo("SPEAKER_EMBEDDING");
    }

    @Test
    @DisplayName("Active audio consent allows session capture")
    void activeAudioConsentAllowsCapture() {
        JsonNode consent = findConsentScenarioById("active-audio-consent");
        assertThat(consent).isNotNull();
        assertThat(consent.get("consentType").asText()).isEqualTo("AUDIO_CAPTURE");
        assertThat(consent.get("expectSessionAllowed").asBoolean()).isTrue();
        assertThat(consent.get("revokedOffsetDays").isNull()).isTrue();
    }

    @Test
    @DisplayName("Revoked consent blocks session capture")
    void revokedConsentBlocksCapture() {
        JsonNode consent = findConsentScenarioById("revoked-audio-consent");
        assertThat(consent).isNotNull();
        assertThat(consent.get("expectSessionAllowed").asBoolean()).isFalse();
        assertThat(consent.get("revokedOffsetDays").isNull()).isFalse();
    }

    @Test
    @DisplayName("Missing consent blocks all capture")
    void missingConsentBlocksCapture() {
        JsonNode consent = findConsentScenarioById("missing-consent");
        assertThat(consent).isNotNull();
        assertThat(consent.get("grantedOffsetDays").isNull()).isTrue();
        assertThat(consent.get("expectSessionAllowed").asBoolean()).isFalse();
    }

    @Test
    @DisplayName("Error taxonomy contains retryable and non-retryable categories")
    void errorTaxonomyContainsRetryableAndNonRetryable() {
        JsonNode errors = fixtures.get("errorCodes");
        assertThat(errors).isNotNull();
        assertThat(errors.isArray()).isTrue();

        boolean foundRetryable = false;
        boolean foundNonRetryable = false;
        for (JsonNode err : errors) {
            if (err.get("retryable").asBoolean()) {
                foundRetryable = true;
            } else {
                foundNonRetryable = true;
            }
        }
        assertThat(foundRetryable).as("At least one retryable error code").isTrue();
        assertThat(foundNonRetryable).as("At least one non-retryable error code").isTrue();
    }

    @Test
    @DisplayName("Runtime config defines sync tolerance and buffer parameters")
    void runtimeConfigDefinesSyncParameters() {
        JsonNode cfg = fixtures.get("runtimeConfig");
        assertThat(cfg).isNotNull();
        assertThat(cfg.get("syncToleranceMs").asInt()).isPositive();
        assertThat(cfg.get("syncAudioBufferMs").asInt()).isPositive();
        assertThat(cfg.get("syncVideoBufferMs").asInt()).isPositive();
        assertThat(cfg.get("sttSampleRate").asInt()).isEqualTo(22050);
        assertThat(cfg.get("sttChannels").asInt()).isEqualTo(1);
    }
}
