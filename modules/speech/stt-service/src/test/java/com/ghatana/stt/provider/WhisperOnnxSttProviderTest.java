package com.ghatana.stt.provider;

import org.junit.jupiter.api.Test;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.runtime.MediaModalityContracts;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;

import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.Optional;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Source-tick emission coverage for the Whisper provider result path. The pinned
 * profile supplies no qualified word timings; the provider declares the measured
 * decoded span on the artifact's exact source clock or honestly declares nothing.
 */
class WhisperOnnxSttProviderTest {

    private static WhisperOnnxSttProvider.ProfileBinding binding(boolean productionEligible) {
        return new WhisperOnnxSttProvider.ProfileBinding(
                "whisper-provider", "whisper-v1", "whisper-profile", "v1",
                "sha256:" + "a".repeat(64), Set.of("en-US"), "", "local", productionEligible);
    }

    @Test
    void observedModelProfileReflectsRealEngineStateWithoutClaimingWordTimingOrQualification() {
        Instant checkedAt = Instant.now().minusSeconds(5);
        var ready = WhisperOnnxSttProvider.observedCapabilityProfile(
                binding(false), "WHISPER-TINY", EngineStatus.State.READY, checkedAt);
        assertThat(ready.modelVersions()).containsExactly("whisper-tiny");
        assertThat(ready.codecs()).containsExactly("pcm_s16le");
        assertThat(ready.containers()).containsExactly("wav");
        assertThat(ready.sampleRatesHz()).containsExactly(16_000);
        assertThat(ready.timingAvailable()).isFalse();
        assertThat(ready.confidenceAvailable()).isFalse();
        assertThat(ready.biometricDerivativesAvailable()).isFalse();
        assertThat(ready.health().status())
                .isEqualTo(MediaModalityContracts.ProviderHealthStatus.HEALTHY);
        assertThat(ready.degradationPolicy())
                .isEqualTo(MediaModalityContracts.DegradationPolicy.LOCAL_DIAGNOSTIC_ONLY);

        var stopped = WhisperOnnxSttProvider.observedCapabilityProfile(
                binding(true), "WHISPER-TINY", EngineStatus.State.ERROR, checkedAt);
        assertThat(stopped.health().status())
                .isEqualTo(MediaModalityContracts.ProviderHealthStatus.UNAVAILABLE);
        assertThat(stopped.degradationPolicy())
                .isEqualTo(MediaModalityContracts.DegradationPolicy.FAIL_CLOSED);
        assertThatThrownBy(() -> WhisperOnnxSttProvider.observedCapabilityProfile(
                binding(false), "invalid/engine-path", EngineStatus.State.READY, checkedAt))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void measuredQualityIsReadOnlyAndMustMatchTheExactSourceOwnedProviderAndModel() {
        var at = Instant.now().minusSeconds(12);
        var measured = new MediaModalityContracts.ProviderQualityObservation(
                "whisper-provider", "whisper-v1", JobType.SPEECH_TO_TEXT, "whisper-tiny",
                MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                1.0938, at, "a".repeat(64));
        assertThat(WhisperOnnxSttProvider.matchingQualityObservation(
                binding(false), "whisper-tiny", Optional.of(measured)))
                .contains(measured);
        assertThat(WhisperOnnxSttProvider.matchingQualityObservation(
                binding(false), "another-model", Optional.of(measured))).isEmpty();
        assertThat(WhisperOnnxSttProvider.matchingQualityObservation(
                binding(false), "whisper-tiny", Optional.empty())).isEmpty();
        assertThat(WhisperOnnxSttProvider.matchingQualityObservation(
                binding(false), "whisper-tiny", null)).isEmpty();
        var foreign = new MediaModalityContracts.ProviderQualityObservation(
                "other-provider", "whisper-v1", JobType.SPEECH_TO_TEXT, "whisper-tiny",
                MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                0.10, at, "b".repeat(64));
        assertThat(WhisperOnnxSttProvider.matchingQualityObservation(
                binding(false), "whisper-tiny", Optional.of(foreign))).isEmpty();
    }

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
