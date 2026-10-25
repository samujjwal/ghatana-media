package com.ghatana.stt.grpc;

import com.ghatana.media.stt.api.Alternative;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.media.stt.api.WordTiming;
import com.ghatana.stt.core.grpc.proto.ConfidenceCalibration;
import com.ghatana.stt.core.grpc.proto.TimestampTimebase;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SttTranscriptionResponseMapperTest {
    @Test
    void mapsProviderWordsWithoutClockProvenanceAsUnknown() {
        TranscriptionResult result = result(0.74,
                List.of(new WordTiming("hello", 0.0, 0.25, 0.70),
                        new WordTiming("world", 0.25, 0.5, 0.80)),
                List.of(new Alternative("hullo", 0.20)));

        var response = SttTranscriptionResponseMapper.toProto(result, Duration.ofMillis(500)).build();

        assertThat(response.getWordTimings(0).getStartMs()).isZero();
        assertThat(response.getWordTimings(0).getEndMs()).isEqualTo(250L);
        assertThat(response.getWordTimings(1).getStartMs()).isEqualTo(250L);
        assertThat(response.getWordTimings(1).getEndMs()).isEqualTo(500L);
        assertThat(response.getAlternativesCount()).isEqualTo(1);
        assertThat(response.getAlternatives(0).getText()).isEqualTo("hullo");
        assertThat(response.getLanguage()).isEqualTo("en-US");
        assertThat(response.getWordTimingTimebase())
                .isEqualTo(TimestampTimebase.TIMESTAMP_TIMEBASE_UNKNOWN);
        assertThat(response.getConfidenceCalibration())
                .isEqualTo(ConfidenceCalibration.CONFIDENCE_CALIBRATION_UNCALIBRATED);
    }

    @Test
    void convertsDecimalSecondsToMillisecondsWithBoundedHalfUpRounding() {
        TranscriptionResult result = result(0.74,
                List.of(new WordTiming("first", 1.2341, 1.2345, 0.7),
                        new WordTiming("second", 1.2355, 1.2370, 0.8)), List.of());

        var response = SttTranscriptionResponseMapper.toProto(result, Duration.ofSeconds(2)).build();

        assertThat(response.getWordTimings(0).getStartMs()).isEqualTo(1234L);
        assertThat(response.getWordTimings(0).getEndMs()).isEqualTo(1235L);
        assertThat(response.getWordTimings(1).getStartMs()).isEqualTo(1236L);
        assertThat(response.getWordTimings(1).getEndMs()).isEqualTo(1237L);
        assertThat(response.getWordTimingTimebase()).isEqualTo(TimestampTimebase.TIMESTAMP_TIMEBASE_UNKNOWN);
    }

    @Test
    void rejectsTimingOutsideNanosecondDurationWithoutFloatingPointTolerance() {
        TranscriptionResult result = result(0.5,
                List.of(new WordTiming("edge", 0.0, 0.000000002, 0.5)), List.of());

        assertInvalid(result, Duration.ofNanos(1), "exceeds decoded audio duration");
    }

    @Test
    void rejectsMillisecondOverflowInsteadOfWrapping() {
        TranscriptionResult result = result(0.5,
                List.of(new WordTiming("far", 0.0, 1.0e16, 0.5)), List.of());

        assertInvalid(result, Duration.ofSeconds(2L * 10_000_000_000_000_000L),
                "exceeds representable millisecond bounds");
    }

    @Test
    void absentWordTimingIsUnknownAndConfidenceStillExplicitlyUncalibrated() {
        var response = SttTranscriptionResponseMapper.toProto(
                result(0.0, List.of(), List.of()), Duration.ofSeconds(1)).build();

        assertThat(response.getWordTimingsList()).isEmpty();
        assertThat(response.getWordTimingTimebase()).isEqualTo(TimestampTimebase.TIMESTAMP_TIMEBASE_UNKNOWN);
        assertThat(response.getConfidenceCalibration())
                .isEqualTo(ConfidenceCalibration.CONFIDENCE_CALIBRATION_UNCALIBRATED);
    }

    @Test
    void unavailableConfidenceMapsToUnknownWithoutSettingNumericScore() {
        TranscriptionResult result = TranscriptionResult.withoutConfidence(
                "transcript", List.of(), List.of(), Duration.ofMillis(2), "en", "onnx-model");

        var response = SttTranscriptionResponseMapper.toProto(result, Duration.ofSeconds(1)).build();

        assertThat(response.getConfidence()).isZero(); // protobuf scalar default; calibration marks it absent
        assertThat(response.getConfidenceCalibration())
                .isEqualTo(ConfidenceCalibration.CONFIDENCE_CALIBRATION_UNKNOWN);
        assertThat(response.toByteArray()).doesNotContain((byte) 0x15); // field 2 float confidence is unset
    }

    @Test
    void availableConfidenceMustBeFinite() {
        assertInvalid(result(Double.POSITIVE_INFINITY, List.of(), List.of()), Duration.ofSeconds(1), "confidence");
        assertInvalid(result(Double.NEGATIVE_INFINITY, List.of(), List.of()), Duration.ofSeconds(1), "confidence");
    }

    @Test
    void nullOptionalProviderMetadataRemainsAbsent() {
        TranscriptionResult result = new TranscriptionResult(
                "text only", 0.0, null, null, null, null, null);

        var response = SttTranscriptionResponseMapper.toProto(result, Duration.ofSeconds(1)).build();

        assertThat(response.getWordTimingsList()).isEmpty();
        assertThat(response.getAlternativesList()).isEmpty();
        assertThat(response.getProcessingTimeMs()).isZero();
        assertThat(response.getLanguage()).isEmpty();
        assertThat(response.getWordTimingTimebase())
                .isEqualTo(TimestampTimebase.TIMESTAMP_TIMEBASE_UNKNOWN);
        assertThat(response.getConfidenceCalibration())
                .isEqualTo(ConfidenceCalibration.CONFIDENCE_CALIBRATION_UNCALIBRATED);
    }

    @Test
    void rejectsNonFiniteOrOutOfRangeConfidenceAndUnboundedAlternatives() {
        assertInvalid(result(Double.NaN, List.of(), List.of()), Duration.ofSeconds(1), "confidence");
        assertInvalid(result(1.01, List.of(), List.of()), Duration.ofSeconds(1), "confidence");
        assertInvalid(result(0.5, List.of(), List.of(new Alternative("alt", Double.POSITIVE_INFINITY))),
                Duration.ofSeconds(1), "alternative confidence");
        assertInvalid(result(0.5, List.of(), alternativesOverLimit()), Duration.ofSeconds(1), "alternative count");
        assertInvalid(result(0.5, wordsOverLimit(), List.of()), Duration.ofSeconds(1), "word timing count");
    }

    @Test
    void rejectsMalformedWordIntervalsWithoutRepairingOrSynthesizingThem() {
        assertInvalid(result(0.5, List.of(new WordTiming("bad", 0.1, 0.1, 0.5)), List.of()),
                Duration.ofSeconds(1), "nonempty");
        assertInvalid(result(0.5, List.of(new WordTiming("bad", 0.2, 0.4, 0.5),
                new WordTiming("overlap", 0.3, 0.5, 0.5)), List.of()),
                Duration.ofSeconds(1), "non-overlapping");
        assertInvalid(result(0.5, List.of(new WordTiming("late", 0.8, 1.1, 0.5)), List.of()),
                Duration.ofSeconds(1), "exceeds decoded audio duration");
        assertInvalid(result(0.5, List.of(new WordTiming("nan", Double.NaN, 0.5, 0.5)), List.of()),
                Duration.ofSeconds(1), "finite");
        assertInvalid(result(0.5, List.of(new WordTiming("tiny", 0.0001, 0.0002, 0.5)), List.of()),
                Duration.ofSeconds(1), "millisecond bounds");
    }

    private static TranscriptionResult result(
            double confidence, List<WordTiming> words, List<Alternative> alternatives) {
        return new TranscriptionResult("transcript", confidence, words, alternatives,
                Duration.ofMillis(17), "en-US", "fixture-model");
    }

    private static List<Alternative> alternativesOverLimit() {
        return java.util.stream.IntStream.range(0, SttTranscriptionResponseMapper.MAX_ALTERNATIVES + 1)
                .mapToObj(index -> new Alternative("alternative-" + index, 0.1))
                .toList();
    }

    private static List<WordTiming> wordsOverLimit() {
        return java.util.stream.IntStream.range(0, SttTranscriptionResponseMapper.MAX_WORD_TIMINGS + 1)
                .mapToObj(index -> new WordTiming("word-" + index, 0.0, 0.1, 0.5))
                .toList();
    }

    private static void assertInvalid(TranscriptionResult result, Duration audioDuration, String reason) {
        assertThatThrownBy(() -> SttTranscriptionResponseMapper.toProto(result, audioDuration))
                .isInstanceOfSatisfying(SttTranscriptionResponseMapper.InvalidResultException.class, failure -> {
                    assertThat(failure).hasMessageContaining("STT_RESULT_INVALID")
                            .hasMessageContaining(reason);
                });
    }
}
