package com.ghatana.media.stt.engine.onnx;

import com.ghatana.media.stt.api.TranscriptionResult;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class WhisperOnnxConfidenceTest {
    @Test
    void batchResultReportsConfidenceUnavailable() {
        TranscriptionResult result = WhisperOnnxEngine.resultWithoutConfidence(
                "text", List.of(), List.of(), Duration.ZERO, "en", "onnx-model");

        assertThat(result.hasConfidence()).isFalse();
        assertThat(result.confidenceAvailability())
                .isEqualTo(TranscriptionResult.ConfidenceAvailability.UNAVAILABLE);
        assertThat(result.confidence()).isZero();
    }
}
