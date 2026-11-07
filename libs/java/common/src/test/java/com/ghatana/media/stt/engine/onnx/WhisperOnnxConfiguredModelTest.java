package com.ghatana.media.stt.engine.onnx;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WhisperOnnxConfiguredModelTest {
    @Test
    void acceptsOnlyTheConfiguredModel() {
        assertThatCode(() -> ConfiguredModelId.require("whisper-base", "whisper-base"))
                .doesNotThrowAnyException();
        assertThatThrownBy(() -> ConfiguredModelId.require("whisper-large", "whisper-base"))
                .isInstanceOf(UnsupportedOperationException.class);
        assertThatThrownBy(() -> ConfiguredModelId.require(" ", "whisper-base"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ConfiguredModelId.require(null, "whisper-base"))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
