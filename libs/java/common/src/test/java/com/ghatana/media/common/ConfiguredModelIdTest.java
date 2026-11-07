package com.ghatana.media.common;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class ConfiguredModelIdTest {
    @Test
    void acceptsOnlyTheAlreadyConfiguredModelSelector() {
        assertThatCode(() -> ConfiguredModelId.require("whisper-base", "whisper-base"))
                .doesNotThrowAnyException();
        assertThatThrownBy(() -> ConfiguredModelId.require("whisper-large", "whisper-base"))
                .isInstanceOf(UnsupportedOperationException.class)
                .hasMessage("Model switching is not supported by this configured engine");
        assertThatThrownBy(() -> ConfiguredModelId.require(" ", "whisper-base"))
                .isInstanceOf(IllegalArgumentException.class).hasMessage("modelId must not be blank");
        assertThatThrownBy(() -> ConfiguredModelId.require(null, "whisper-base"))
                .isInstanceOf(IllegalArgumentException.class).hasMessage("modelId must not be blank");
    }
}
