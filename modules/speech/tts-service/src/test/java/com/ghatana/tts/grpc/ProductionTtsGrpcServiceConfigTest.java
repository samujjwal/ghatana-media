package com.ghatana.tts.grpc;

import com.ghatana.media.config.TtsConfig;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * @doc.type class
 * @doc.purpose Verifies fail-closed production TTS environment configuration
 * @doc.layer product
 * @doc.pattern UnitTest
 */
class ProductionTtsGrpcServiceConfigTest {

    @Test
    void defaultsToRealModelOnlyAndSyntheticFallbackDisabled() {
        TtsConfig config = ProductionTtsGrpcService.createConfig(Map.of());

        assertThat(config.voiceModelPath().toString()).isEqualTo("/models/piper-en.onnx");
        assertThat(config.defaultVoiceId()).isEqualTo("piper-en");
        assertThat(config.maxConcurrentRequests()).isEqualTo(10);
        assertThat(config.sampleRate()).isEqualTo(22_050);
        assertThat(config.allowSyntheticFallback()).isFalse();
    }

    @Test
    void allowsSyntheticFallbackOnlyThroughExplicitBooleanFlag() {
        TtsConfig config = ProductionTtsGrpcService.createConfig(Map.of(
                "MEDIA_TTS_ALLOW_SYNTHETIC_FALLBACK", "true",
                "TTS_DEFAULT_VOICE", "local-test",
                "TTS_MAX_CONCURRENT", "4",
                "TTS_SAMPLE_RATE", "16000",
                "TTS_MAX_TEXT_LENGTH", "2000"));

        assertThat(config.allowSyntheticFallback()).isTrue();
        assertThat(config.defaultVoiceId()).isEqualTo("local-test");
        assertThat(config.maxConcurrentRequests()).isEqualTo(4);
        assertThat(config.sampleRate()).isEqualTo(16_000);
        assertThat(config.maxTextLength()).isEqualTo(2_000);
    }

    @Test
    void rejectsMalformedAndOutOfRangeConfiguration() {
        assertThatThrownBy(() -> ProductionTtsGrpcService.createConfig(Map.of(
                "MEDIA_TTS_ALLOW_SYNTHETIC_FALLBACK", "yes")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("true or false");
        assertThatThrownBy(() -> ProductionTtsGrpcService.createConfig(Map.of(
                "TTS_MAX_CONCURRENT", "0")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("between 1 and 1000");
        assertThatThrownBy(() -> ProductionTtsGrpcService.createConfig(Map.of(
                "TTS_SAMPLE_RATE", "abc")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("must be an integer");
        assertThatThrownBy(() -> ProductionTtsGrpcService.createConfig(Map.of(
                "TTS_DEFAULT_VOICE", " ")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("must not be blank");
    }

    @Test
    void validatesServerPort() {
        assertThat(TtsGrpcServer.parsePort(null)).isEqualTo(50052);
        assertThat(TtsGrpcServer.parsePort(" 51000 ")).isEqualTo(51000);
        assertThatThrownBy(() -> TtsGrpcServer.parsePort("0"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> TtsGrpcServer.parsePort("not-a-port"))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
