package com.ghatana.audio.video.integration;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.common.validation.MediaFormatValidator;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.audio.streaming.BoundedAudioFrameDecoder;
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
            EngineStatus status = engine.getStatus();
            assertThat(status.state()).isEqualTo(EngineStatus.State.DEGRADED);
            assertThat(status.modelId()).isEqualTo("synthetic:integration-test");
            assertThat(status.version()).isEqualTo("synthetic-local-v1");
            assertThat(status.errorMessage()).isEqualTo("Synthetic fallback active");
            assertThat(state.isHealthy()).isFalse();
            var fixture = engine.synthesize("pipeline check");
            assertThat(fixture.data()).isNotEmpty().containsOnly((byte) 0);
        } finally {
            engine.close();
        }
    }

    @Test
    void boundedStreamDecoderPreservesExactSourceTimebaseAndReportsUnsupportedCodec() {
        byte[] syntheticPcmFixture = new byte[] {0x01, 0x02, 0x03, 0x04};
        BoundedAudioFrameDecoder pcmDecoder = BoundedAudioFrameDecoder.declare(
                "PCM_S16LE", 1, 48_000, new BoundedAudioFrameDecoder.SessionBudget(1, 4));

        var decoded = pcmDecoder.decode(syntheticPcmFixture, 24_000, true);

        assertThat(decoded.verdict()).isEqualTo(BoundedAudioFrameDecoder.DecodeVerdict.DECODED);
        assertThat(decoded.frame().codec()).isEqualTo(BoundedAudioFrameDecoder.Codec.PCM_S16LE);
        assertThat(decoded.frame().position())
                .isEqualTo(new BoundedAudioFrameDecoder.SamplePosition(24_000, 48_000));
        assertThat(decoded.frame().partialRevision()).isTrue();
        syntheticPcmFixture[0] = 0x7f;
        assertThat(decoded.frame().payload()).containsExactly((byte) 0x01, (byte) 0x02, (byte) 0x03, (byte) 0x04);

        var malformed = pcmDecoder.decode(new byte[] {0x01}, 24_001, false);
        assertThat(malformed.verdict()).isEqualTo(BoundedAudioFrameDecoder.DecodeVerdict.MALFORMED);
        assertThat(malformed.frame()).isNull();

        BoundedAudioFrameDecoder opusDecoder = BoundedAudioFrameDecoder.declare(
                "OPUS", 1, 48_000, new BoundedAudioFrameDecoder.SessionBudget(1, 4));
        var unavailable = opusDecoder.decode(new byte[] {0x01, 0x02}, 24_000, false);
        assertThat(unavailable.verdict()).isEqualTo(BoundedAudioFrameDecoder.DecodeVerdict.UNAVAILABLE);
        assertThat(unavailable.frame()).isNull();
    }
}
