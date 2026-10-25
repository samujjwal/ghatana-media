package com.ghatana.media.service.http;

import com.ghatana.media.stt.api.TranscriptionResult;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class SttHttpAdapterConfidenceTest {
    @Test
    void legacyResponseConstructorRetainsNumericConfidence() {
        SttHttpAdapter.TranscribeResponse response =
                new SttHttpAdapter.TranscribeResponse("text", 0.5, List.of(), 1L);

        assertThat(response.confidence()).isEqualTo(0.5);
    }

    @Test
    void unavailableConfidenceIsNullInResponseAndJson() throws Exception {
        TranscriptionResult result = TranscriptionResult.withoutConfidence(
                "text", List.of(), List.of(), Duration.ZERO, "en", "onnx-model");

        SttHttpAdapter.TranscribeResponse response = SttHttpAdapter.toResponse(result);
        String json = new ObjectMapper().writeValueAsString(response);

        assertThat(response.confidence()).isNull();
        assertThat(json).contains("\"confidence\":null");
    }
}
