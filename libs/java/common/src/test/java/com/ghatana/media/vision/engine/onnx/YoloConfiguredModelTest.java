package com.ghatana.media.vision.engine.onnx;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class YoloConfiguredModelTest {
    @Test
    void acceptsOnlyTheConfiguredModel() {
        assertThatCode(() -> ConfiguredModelId.require("yolov8n", "yolov8n"))
                .doesNotThrowAnyException();
        assertThatThrownBy(() -> ConfiguredModelId.require("yolov8x", "yolov8n"))
                .isInstanceOf(UnsupportedOperationException.class);
        assertThatThrownBy(() -> ConfiguredModelId.require(" ", "yolov8n"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ConfiguredModelId.require(null, "yolov8n"))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
