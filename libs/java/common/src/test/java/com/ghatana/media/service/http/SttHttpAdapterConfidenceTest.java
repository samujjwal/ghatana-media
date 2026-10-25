package com.ghatana.media.service.http;

import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.media.stt.api.WordTiming;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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

        SttHttpAdapter.TranscribeResponse response = SttHttpAdapter.toResponse(result, Duration.ofSeconds(2));
        String json = new ObjectMapper().writeValueAsString(response);

        assertThat(response.confidence()).isNull();
        assertThat(json).contains("\"confidence\":null");
    }

    @Test
    void validResultPreservesConfidenceAndMillisecondTimings() {
        TranscriptionResult result = result(0.75, List.of(new WordTiming("hello", 0.125, 0.875, 0.8)));

        SttHttpAdapter.TranscribeResponse response = SttHttpAdapter.toResponse(result, Duration.ofSeconds(1));

        assertThat(response.confidence()).isEqualTo(0.75);
        assertThat(response.words()).containsExactly(new SttHttpAdapter.WordTimingJson("hello", 125, 875, 0.8));
    }

    @Test
    void rejectsInvalidTranscriptConfidence() {
        for (double confidence : new double[] {Double.NaN, Double.POSITIVE_INFINITY, -0.01, 1.01}) {
            assertInvalid(result(confidence, List.of()), Duration.ofSeconds(1), "transcript confidence");
        }
    }

    @Test
    void rejectsMalformedWordConfidenceAndIntervals() {
        List<WordTiming> invalidTimings = List.of(
                new WordTiming("nan", Double.NaN, 0.5, 0.5),
                new WordTiming("infinite", 0.1, Double.POSITIVE_INFINITY, 0.5),
                new WordTiming("negative", -0.1, 0.1, 0.5),
                new WordTiming("reversed", 0.5, 0.4, 0.5),
                new WordTiming("bad score", 0.1, 0.2, Double.NaN),
                new WordTiming("score above range", 0.1, 0.2, 1.01));

        for (WordTiming timing : invalidTimings) {
            assertInvalid(result(0.5, List.of(timing)), Duration.ofSeconds(1), "word timing");
        }
    }

    @Test
    void rejectsOutOfOrderOverlappingAndOverDurationIntervals() {
        assertInvalid(result(0.5, List.of(
                new WordTiming("first", 0.2, 0.4, 0.5),
                new WordTiming("second", 0.1, 0.3, 0.5))), Duration.ofSeconds(1), "ordered");
        assertInvalid(result(0.5, List.of(
                new WordTiming("first", 0.1, 0.5, 0.5),
                new WordTiming("second", 0.4, 0.6, 0.5))), Duration.ofSeconds(1), "ordered");
        assertInvalid(result(0.5, List.of(new WordTiming("late", 0.9, 1.1, 0.5))),
                Duration.ofSeconds(1), "exceeds decoded audio duration");
    }

    @Test
    void rejectsIntervalsThatRoundToEmptyOrOverflowMilliseconds() {
        assertInvalid(result(0.5, List.of(new WordTiming("tiny", 0.0001, 0.0002, 0.5))),
                Duration.ofSeconds(1), "millisecond bounds");
        assertInvalid(result(0.5, List.of(new WordTiming("huge", 1.0e16, 1.0000000000000004e16, 0.5))),
                Duration.ofSeconds(Long.MAX_VALUE), "representable millisecond bounds");
    }

    private static TranscriptionResult result(double confidence, List<WordTiming> words) {
        return new TranscriptionResult("text", confidence, words, List.of(), Duration.ZERO, "en", "model");
    }

    private static void assertInvalid(TranscriptionResult result, Duration audioDuration, String message) {
        assertThatThrownBy(() -> SttHttpAdapter.toResponse(result, audioDuration))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("STT_RESULT_INVALID")
                .hasMessageContaining(message);
    }
}
