package com.ghatana.audio.video.integration;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.common.validation.MediaFormatValidator;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.stt.api.SttEngineFactory;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.tts.api.TtsEngineFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * @doc.type class
 * @doc.purpose Integration smoke tests for core Media pipeline contracts
 * @doc.layer test
 * @doc.pattern IntegrationTest
 */
class MediaPipelineIntegrationTest {

    @TempDir
    Path tempDirectory;

    @Test
    void detectsWavHeader() {
        byte[] wavHeader = new byte[] {
            'R', 'I', 'F', 'F', 0, 0, 0, 0,
            'W', 'A', 'V', 'E', 'f', 'm', 't', ' '
        };

        assertThat(MediaFormatValidator.detectAudioFormat(wavHeader)).isEqualTo("WAV");
    }

    @Test
    void createsSttEngineThroughItsConfiguredFactoryContract() {
        SttConfig config = SttConfig.builder()
                .modelId("whisper-tiny")
                .allowSyntheticFallback(true)
                .build();
        AudioVideoLibrary.LibraryState state = new AudioVideoLibrary.LibraryState();
        assertThat(SttEngineFactory.create(config, state)).isNotNull();
        assertThat(state.isHealthy()).isFalse();
    }

    @Test
    void createsSyntheticTtsOnlyWhenExplicitlyEnabledAndReportsDegradedHealth() {
        TtsConfig config = TtsConfig.builder()
                .voiceModelPath(tempDirectory.resolve("missing.onnx"))
                .defaultVoiceId("integration-test")
                .availableVoices(List.of("integration-test"))
                .allowSyntheticFallback(true)
                .build();
        AudioVideoLibrary.LibraryState state = new AudioVideoLibrary.LibraryState();

        TtsEngine engine = TtsEngineFactory.create(config, state);
        try {
            assertThat(engine.getStatus().state()).isEqualTo(EngineStatus.State.DEGRADED);
            assertThat(state.isHealthy()).isFalse();
            assertThat(engine.synthesize("pipeline check").data()).isNotEmpty();
        } finally {
            engine.close();
        }
    }
}
