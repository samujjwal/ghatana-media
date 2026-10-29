package com.ghatana.stt.provider;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Source-tick emission coverage for the Whisper provider result path. The pinned
 * profile supplies no qualified word timings; the provider declares the measured
 * decoded span on the artifact's exact source clock or honestly declares nothing.
 */
class WhisperOnnxSttProviderTest {

    private static Map<String, Object> clockMetadata(long ticksPerSecond, long durationTicks) {
        return Map.of(
                "sourceClockId", "src-clock",
                "sourceClockMappingEvidenceRef", "mapping-evidence",
                "sourceClockTicksPerSecond", ticksPerSecond,
                "sourceDurationTicks", durationTicks);
    }

    @Test
    void declaresMeasuredSpanOnTheDeclaredSourceClock() {
        // One second of 16kHz PCM on a declared 48kHz source clock: exact rational map.
        List<Map<String, Object>> observations = WhisperOnnxSttProvider.sourceTickObservations(
                16_000, 16_000, clockMetadata(48_000, 96_000));
        assertThat(observations).hasSize(1);
        Map<String, Object> entry = observations.get(0);
        assertThat(entry).containsEntry("label", "transcript-span")
                .containsEntry("startTick", 0L)
                .containsEntry("endTick", 48_000L)
                .containsEntry("sourceClockId", "src-clock")
                .containsEntry("ticksPerSecond", 48_000L);
    }

    @Test
    void identityClockMapsSamplesOneToOne() {
        List<Map<String, Object>> observations = WhisperOnnxSttProvider.sourceTickObservations(
                8_000, 16_000, clockMetadata(16_000, 16_000));
        assertThat(observations).hasSize(1);
        assertThat(observations.get(0)).containsEntry("endTick", 8_000L);
    }

    @Test
    void omitsObservationsWithoutACompleteDeclaredClock() {
        assertThat(WhisperOnnxSttProvider.sourceTickObservations(16_000, 16_000, Map.of()))
                .isEmpty();
        assertThat(WhisperOnnxSttProvider.sourceTickObservations(16_000, 16_000, Map.of(
                        "sourceClockId", "src-clock",
                        "sourceClockTicksPerSecond", 48_000)))
                .isEmpty();
        assertThat(WhisperOnnxSttProvider.sourceTickObservations(16_000, 16_000,
                        clockMetadata(0, 96_000)))
                .isEmpty();
    }

    @Test
    void omitsObservationsThatCannotMapExactly() {
        // 7 samples at 16kHz on a 44.1kHz clock is not an integral source position.
        assertThat(WhisperOnnxSttProvider.sourceTickObservations(7, 16_000,
                        clockMetadata(44_100, 96_000)))
                .isEmpty();
        assertThat(WhisperOnnxSttProvider.sourceTickObservations(0, 16_000,
                        clockMetadata(48_000, 96_000)))
                .isEmpty();
    }

    @Test
    void declaredSpanBecomesOneSourceTicksTranscriptSegment() {
        Map<String, Object> segment = WhisperOnnxSttProvider.sourceTickSegment(
                "decoded text", 16_000, 16_000, clockMetadata(48_000, 96_000));
        assertThat(segment).isNotNull();
        assertThat(segment).containsEntry("segmentId", "transcript-span")
                .containsEntry("text", "decoded text")
                .containsEntry("origin", "PROVIDER");
        assertThat(segment.get("timing")).isInstanceOf(Map.class);
        @SuppressWarnings("unchecked")
        Map<String, Object> timing = (Map<String, Object>) segment.get("timing");
        assertThat(timing).containsEntry("tag", "SOURCE_TICKS")
                .containsEntry("startTick", 0L)
                .containsEntry("endTick", 48_000L)
                .containsEntry("sourceClockId", "src-clock")
                .containsEntry("sourceTicksPerSecond", 48_000L)
                .containsEntry("sourceDurationTicks", 96_000L);
    }

    @Test
    void noVerifiedSpanMeansNoSegmentIsDeclared() {
        assertThat(WhisperOnnxSttProvider.sourceTickSegment(
                "text", 16_000, 16_000, Map.of())).isNull();
        assertThat(WhisperOnnxSttProvider.sourceTickSegment(
                "text", 7, 16_000, clockMetadata(44_100, 96_000))).isNull();
        assertThat(WhisperOnnxSttProvider.sourceTickSegment(
                "text", 0, 16_000, clockMetadata(48_000, 96_000))).isNull();
    }
}
