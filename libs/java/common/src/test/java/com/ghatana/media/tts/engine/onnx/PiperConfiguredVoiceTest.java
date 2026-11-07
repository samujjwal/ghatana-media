package com.ghatana.media.tts.engine.onnx;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PiperConfiguredVoiceTest {
    @Test
    void acceptsOnlyTheConfiguredVoice() {
        assertThatCode(() -> ConfiguredVoiceId.require("en_US-lessac-medium", "en_US-lessac-medium"))
                .doesNotThrowAnyException();
        assertThatThrownBy(() -> ConfiguredVoiceId.require("other-voice", "en_US-lessac-medium"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ConfiguredVoiceId.require(" ", "en_US-lessac-medium"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ConfiguredVoiceId.require(null, "en_US-lessac-medium"))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
