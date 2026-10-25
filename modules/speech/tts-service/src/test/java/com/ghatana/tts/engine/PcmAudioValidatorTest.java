package com.ghatana.tts.engine;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PcmAudioValidatorTest {
    @Test
    void derivesFramesDurationAndUncalibratedLoudnessFromFixturePcm() {
        byte[] fixture = {0, 0, 0, 64, 0, (byte) 128, 0, (byte) 192};
        var facts = PcmAudioValidator.validate(new AudioData(
                fixture, 8_000, 1, 16, Duration.ofMillis(1), AudioFormat.PCM));
        assertThat(facts.frames()).isEqualTo(4);
        assertThat(facts.duration()).isEqualTo(Duration.ofMillis(1));
        assertThat(facts.rms()).isBetween(0.61, 0.62);
        assertThat(facts.peak()).isEqualTo(1.0);
    }

    @Test
    void rejectsMislabeledEncodedAudio() {
        assertThatThrownBy(() -> PcmAudioValidator.validate(new AudioData(
                new byte[32], 16_000, 1, 16, Duration.ofMillis(1), AudioFormat.WAV)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("raw PCM");
    }

    @Test
    void rejectsDurationAndFrameMetadataMismatch() {
        assertThatThrownBy(() -> PcmAudioValidator.validate(new AudioData(
                new byte[32], 16_000, 1, 16, Duration.ofSeconds(5), AudioFormat.PCM)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("duration metadata");
    }

    @Test
    void rejectsNonemptyPcmWhoseDurationRoundsToZeroMilliseconds() {
        assertThatThrownBy(() -> PcmAudioValidator.validate(new AudioData(
                new byte[2], 96_000, 1, 16, Duration.ofMillis(1), AudioFormat.PCM)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("rounds to zero");
    }

    @Test
    void rejectsPartialFramesUnsupportedChannelsAndOversizedPayloads() {
        assertThatThrownBy(() -> PcmAudioValidator.validate(new AudioData(
                new byte[3], 16_000, 1, 16, Duration.ofMillis(1), AudioFormat.PCM)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("partial sample frame");
        assertThatThrownBy(() -> PcmAudioValidator.validate(new AudioData(
                new byte[4], 16_000, 3, 16, Duration.ofMillis(1), AudioFormat.PCM)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("channel count");
        assertThatThrownBy(() -> PcmAudioValidator.validate(new AudioData(
                new byte[PcmAudioValidator.MAX_AUDIO_BYTES + 1], 16_000, 1, 16,
                Duration.ofSeconds(1), AudioFormat.PCM)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("byte limit");
    }
}
