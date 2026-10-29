package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MultimodalOperationSpecTest {

    private static final String SHA_A = "a".repeat(64);
    private static final String SHA_B = "b".repeat(64);

    @Test
    void specRoundTripsThroughParametersAndDigestIsStable() {
        MultimodalOperationSpec spec = spec();
        Map<String, Object> encoded = spec.toParametersValue();
        MultimodalOperationSpec decoded = MultimodalOperationSpec.fromParameterValue(encoded);
        assertThat(decoded).isEqualTo(spec);
        assertThat(decoded.specDigest()).isEqualTo(spec.specDigest());
    }

    @Test
    void specIsRequiredForMultimodalJobs() {
        ProcessingJobRequest request = request(Map.of());
        assertThatThrownBy(() -> MultimodalOperationSpec.from(request))
                .isInstanceOf(IllegalArgumentException.class);
        ProcessingJobRequest bound = request(
                Map.of(MultimodalOperationSpec.PARAMETERS_KEY, spec().toParametersValue()));
        assertThat(MultimodalOperationSpec.from(bound)).isEqualTo(spec());
    }

    @Test
    void malformedSpecsFailClosed() {
        assertThatThrownBy(() -> new MultimodalOperationSpec(
                "v9", "cap", "op", 1, "src", "sha256:" + SHA_A, SHA_A,
                List.of(child("stt")), null, Map.of()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION, "cap", "op", 1, "src",
                "sha256:" + SHA_A, SHA_B, List.of(child("stt")), null, Map.of()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION, "cap", "op", 1, "src",
                "sha256:" + SHA_A, SHA_A,
                List.of(child("stt"), child("vision")), null, Map.of()))
                .isInstanceOf(IllegalArgumentException.class); // duplicate job types
        assertThatThrownBy(() -> new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION, "cap", "op", 1, "src",
                "sha256:" + SHA_A, SHA_A, List.of(), null, Map.of()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void nestedMultimodalChildrenAreRejected() {
        assertThatThrownBy(() -> new MultimodalOperationSpec.ChildOperationSpec(
                "nested", JobType.MULTIMODAL, "art", "sha256:" + SHA_B, SHA_B, "", Map.of()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void childRequestIdsAreDeterministicAndBounded() {
        assertThat(MultimodalOperationSpec.childRequestId("req-1", "stt"))
                .isEqualTo("req-1:stt");
        String tooLong = "r".repeat(600);
        assertThatThrownBy(() -> MultimodalOperationSpec.childRequestId(tooLong, "stt"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void specBindingRequiresExactRequestAndArtifact() {
        MultimodalOperationSpec spec = spec();
        MediaArtifact artifact = artifact("src", SHA_A);
        ProcessingJobRequest matching = request(
                Map.of(MultimodalOperationSpec.PARAMETERS_KEY, spec.toParametersValue()));
        assertThat(spec.matchesRequest(matching, artifact)).isTrue();
        MediaArtifact wrongDigest = artifact("src", SHA_B);
        assertThat(spec.matchesRequest(matching, wrongDigest)).isFalse();
        assertThat(spec.matchesRequest(matching, artifact("other", SHA_A))).isFalse();
    }

    @Test
    void sourceClockBindingRoundTripsWithOptionalFields() {
        var binding = new MultimodalOperationSpec.SourceClockBinding(
                "evidence-1", 48_000, 0, "clock-1", 96_000);
        var spec = new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION, "cap", "op", 1,
                "src", "sha256:" + SHA_A, SHA_A, List.of(child("stt")), binding, Map.of());
        var decoded = MultimodalOperationSpec.fromParameterValue(spec.toParametersValue());
        assertThat(decoded.sourceClock()).isEqualTo(binding);
        // Bindings without identity/duration stay verifiable-undetermined, not invented.
        var unscoped = new MultimodalOperationSpec.SourceClockBinding("ev", 1_000, 0);
        assertThat(unscoped.clockId()).isEmpty();
        assertThat(unscoped.durationTicks()).isZero();
        assertThatThrownBy(() -> new MultimodalOperationSpec.SourceClockBinding(
                "ev", 0, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MultimodalOperationSpec.SourceClockBinding(
                "ev", 1_000, 0, "clk\u0007x", 0)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void fusedResultGroundsTimedObservationsOnTheBoundSourceClock() {
        var binding = new MultimodalOperationSpec.SourceClockBinding(
                "ev-1", 48_000, 9_600, "src-clock", 96_000);
        var spec = clockedSpec(binding);
        var stt = completedChild("job-stt", JobType.SPEECH_TO_TEXT,
                Map.of("text", "hello",
                        "timedObservations", List.of(
                                Map.of("startTick", 9_600L, "endTick", 14_400L,
                                        "sourceClockId", "src-clock", "label", "seg-1"))));
        var vision = completedChild("job-vis", JobType.VISION,
                Map.of("caption", "a cat",
                        "timedObservations", List.of(
                                Map.of("startTick", 24_000L, "endTick", 28_800L,
                                        "sourceClockId", "src-clock"))));
        Map<String, Object> fused = MultimodalOperationSpec.fusedResult(
                spec, List.of(stt, vision));
        assertThat(fused.get("clockComparability")).isEqualTo("SOURCE_CLOCK_SHARED");
        assertThat(((Map<?, ?>) fused.get("sourceClock")).get("clockId")).isEqualTo("src-clock");
        List<?> observations = (List<?>) fused.get("observations");
        Map<?, ?> sttTiming = (Map<?, ?>) ((Map<?, ?>) observations.get(0)).get("timing");
        assertThat(sttTiming.get("status")).isEqualTo("TIMESTAMP_ALIGNED");
        Map<?, ?> entry = (Map<?, ?>) ((List<?>) sttTiming.get("entries")).get(0);
        assertThat(entry.get("startTick")).isEqualTo(9_600L);
        assertThat(entry.get("mediaStartTick")).isEqualTo(0L);
        assertThat(entry.get("mediaStartMs")).isEqualTo(0L);
        assertThat(entry.get("mediaEndMs")).isEqualTo(100L);
        Map<?, ?> visTiming = (Map<?, ?>) ((Map<?, ?>) observations.get(1)).get("timing");
        Map<?, ?> visEntry = (Map<?, ?>) ((List<?>) visTiming.get("entries")).get(0);
        assertThat(visEntry.get("mediaStartTick")).isEqualTo(14_400L);
        assertThat(visEntry.get("mediaStartMs")).isEqualTo(300L);
        // Restart parity: the same durable inputs fuse to byte-identical output.
        assertThat(MultimodalOperationSpec.fusedResult(spec, List.of(stt, vision)))
                .isEqualTo(fused);
    }

    @Test
    void fusedResultReportsUndeterminedForNoncomparableOrMissingClocks() {
        var binding = new MultimodalOperationSpec.SourceClockBinding(
                "ev-1", 48_000, 0, "src-clock", 48_000);
        var spec = clockedSpec(binding);
        var wrongClock = completedChild("job-a", JobType.SPEECH_TO_TEXT,
                Map.of("timedObservations", List.of(
                        Map.of("startTick", 0L, "endTick", 1_000L, "sourceClockId", "other-clock"))));
        var outOfDuration = completedChild("job-b", JobType.VISION,
                Map.of("timedObservations", List.of(
                        Map.of("startTick", 0L, "endTick", 96_000L, "sourceClockId", "src-clock"))));
        var malformed = completedChild("job-c", JobType.SPEECH_TO_TEXT,
                Map.of("timedObservations", List.of(Map.of("startTick", "oops"))));
        Map<String, Object> fused = MultimodalOperationSpec.fusedResult(
                spec, List.of(wrongClock, outOfDuration, malformed));
        List<?> observations = (List<?>) fused.get("observations");
        assertThat(undetermined(observations, 0)).isEqualTo("SOURCE_CLOCK_MISMATCH");
        assertThat(undetermined(observations, 1)).isEqualTo("SOURCE_TICKS_OUT_OF_DURATION");
        assertThat(undetermined(observations, 2)).isEqualTo("TIMED_OBSERVATION_MALFORMED");
        assertThat(fused.get("clockComparability")).isEqualTo("SYNC_UNDETERMINED");
        // No binding at all: nothing is claimed comparable.
        var unbound = clockedSpec(null);
        var noBinding = MultimodalOperationSpec.fusedResult(unbound, List.of(wrongClock));
        assertThat(undetermined((List<?>) noBinding.get("observations"), 0))
                .isEqualTo("SOURCE_CLOCK_NOT_DECLARED");
        assertThat(noBinding).doesNotContainKey("sourceClock");
    }

    @Test
    void declaredSourceClockRequiresTheExactMetadataQuadruple() {
        Map<String, Object> complete = Map.of(
                "sourceClockId", "src-clock",
                "sourceClockMappingEvidenceRef", "mapping-evidence",
                "sourceClockTicksPerSecond", 48_000,
                "sourceDurationTicks", 96_000);
        var declared = MultimodalOperationSpec.declaredSourceClock(complete);
        assertThat(declared).isPresent();
        assertThat(declared.orElseThrow().clockId()).isEqualTo("src-clock");
        assertThat(declared.orElseThrow().ticksPerSecond()).isEqualTo(48_000L);
        assertThat(declared.orElseThrow().durationTicks()).isEqualTo(96_000L);
        assertThat(declared.orElseThrow().mappingEvidenceRef()).isEqualTo("mapping-evidence");
        // A partial or malformed declaration is not a verifiable clock.
        assertThat(MultimodalOperationSpec.declaredSourceClock(Map.of())).isEmpty();
        assertThat(MultimodalOperationSpec.declaredSourceClock(null)).isEmpty();
        assertThat(MultimodalOperationSpec.declaredSourceClock(Map.of(
                "sourceClockId", "src-clock",
                "sourceClockMappingEvidenceRef", "mapping-evidence",
                "sourceClockTicksPerSecond", 48_000))).isEmpty(); // duration missing
        assertThat(MultimodalOperationSpec.declaredSourceClock(Map.of(
                "sourceClockId", "src-clock",
                "sourceClockMappingEvidenceRef", " ",
                "sourceClockTicksPerSecond", 48_000,
                "sourceDurationTicks", 96_000))).isEmpty(); // blank evidence
        assertThat(MultimodalOperationSpec.declaredSourceClock(Map.of(
                "sourceClockId", "src-clock",
                "sourceClockMappingEvidenceRef", "mapping-evidence",
                "sourceClockTicksPerSecond", 0,
                "sourceDurationTicks", 96_000))).isEmpty(); // non-positive rate
        assertThat(MultimodalOperationSpec.declaredSourceClock(Map.of(
                "sourceClockId", "src-clock",
                "sourceClockMappingEvidenceRef", "mapping-evidence",
                "sourceClockTicksPerSecond", 48_000.5,
                "sourceDurationTicks", 96_000))).isEmpty(); // non-integral rate
    }

    @Test
    void extentMappingIsExactRationalOrAbsent() {
        assertThat(MultimodalOperationSpec.mapExtentToSourceTicks(16_000, 16_000, 48_000))
                .isEqualTo(48_000L);
        assertThat(MultimodalOperationSpec.mapExtentToSourceTicks(0, 16_000, 48_000))
                .isEqualTo(0L);
        // Non-integral positions are not rounded into source positions.
        assertThat(MultimodalOperationSpec.mapExtentToSourceTicks(7, 16_000, 44_100)).isNull();
        // Vision PTS convention: a 90kHz decoder timebase onto a 48kHz source clock.
        assertThat(MultimodalOperationSpec.mapExtentToSourceTicks(90_000, 90_000, 48_000))
                .isEqualTo(48_000L);
        assertThat(MultimodalOperationSpec.mapExtentToSourceTicks(-1, 16_000, 48_000)).isNull();
        assertThat(MultimodalOperationSpec.mapExtentToSourceTicks(1, 0, 48_000)).isNull();
        assertThat(MultimodalOperationSpec.mapExtentToSourceTicks(1, 16_000, 0)).isNull();
    }

    @Test
    void timedObservationEntriesAreBoundedAndGroundable() {
        var entry = MultimodalOperationSpec.timedObservation(
                "transcript-span", 0, 48_000, "src-clock", 48_000);
        assertThat(entry).containsEntry("label", "transcript-span")
                .containsEntry("startTick", 0L).containsEntry("endTick", 48_000L)
                .containsEntry("sourceClockId", "src-clock").containsEntry("ticksPerSecond", 48_000L);
        // The emitted shape grounds TIMESTAMP_ALIGNED on the matching binding.
        var binding = new MultimodalOperationSpec.SourceClockBinding(
                "ev-1", 48_000, 0, "src-clock", 96_000);
        var child = completedChild("job-e", JobType.SPEECH_TO_TEXT,
                Map.of("timedObservations", List.of(entry)));
        Map<String, Object> fused = MultimodalOperationSpec.fusedResult(
                clockedSpec(binding), List.of(child));
        List<?> observations = (List<?>) fused.get("observations");
        Map<?, ?> timing = (Map<?, ?>) ((Map<?, ?>) observations.get(0)).get("timing");
        assertThat(timing.get("status")).isEqualTo("TIMESTAMP_ALIGNED");
        // Degenerate or unidentifiable declarations are rejected at emission.
        assertThatThrownBy(() -> MultimodalOperationSpec.timedObservation(
                "x", 10, 10, "src-clock", 48_000)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MultimodalOperationSpec.timedObservation(
                "x", -1, 10, "src-clock", 48_000)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MultimodalOperationSpec.timedObservation(
                "x", 0, 10, " ", 48_000)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MultimodalOperationSpec.timedObservation(
                "x", 0, 10, "src-clock", 0)).isInstanceOf(IllegalArgumentException.class);
    }

    private static String undetermined(List<?> observations, int index) {
        Map<?, ?> entry = (Map<?, ?>) ((List<?>) ((Map<?, ?>) ((Map<?, ?>) observations.get(index))
                .get("timing")).get("entries")).get(0);
        assertThat(entry.get("status")).isEqualTo("SYNC_UNDETERMINED");
        return String.valueOf(entry.get("reason"));
    }

    private static MultimodalOperationSpec clockedSpec(
            MultimodalOperationSpec.SourceClockBinding binding) {
        return new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION, "cap", "op", 1,
                "src", "sha256:" + SHA_A, SHA_A, List.of(child("stt")), binding, Map.of());
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob completedChild(
            String jobId, JobType type, Map<String, Object> result) {
        return new com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob(
                jobId, "req:" + jobId, "tenant-a", "principal-a", "art-" + jobId, type,
                "provider", com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus.COMPLETED,
                Instant.now(), Instant.now(), Instant.now(), result, "", 1,
                "sha256:" + SHA_B, "sha256:" + SHA_B);
    }

    private static MultimodalOperationSpec spec() {
        return new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION,
                "media.multimodal.observe.source-grounded",
                "media.operation.capability.media-multimodal-observe-source-grounded",
                1, "src", "sha256:" + SHA_A, SHA_A,
                List.of(child("stt"), visionChild()), null, Map.of());
    }

    private static MultimodalOperationSpec.ChildOperationSpec child(String key) {
        return new MultimodalOperationSpec.ChildOperationSpec(
                key, JobType.SPEECH_TO_TEXT, "art-" + key,
                "sha256:" + SHA_B, SHA_B, "", Map.of());
    }

    private static MultimodalOperationSpec.ChildOperationSpec visionChild() {
        return new MultimodalOperationSpec.ChildOperationSpec(
                "vision", JobType.VISION, "art-vision",
                "sha256:" + SHA_B, SHA_B, "", Map.of());
    }

    private static ProcessingJobRequest request(Map<String, Object> parameters) {
        return new ProcessingJobRequest("req-1", "tenant-a", "principal-a", "correlation-a",
                "src", "sha256:" + SHA_A, JobType.MULTIMODAL, "", parameters);
    }

    private static MediaArtifact artifact(String artifactId, String sha256) {
        return new MediaArtifact("tenant-a", "principal-a", artifactId, "source.bin",
                "application/octet-stream", 4, sha256, "object-ref", "CONFIDENTIAL",
                Instant.now(), Instant.now().plusSeconds(3600), Map.of());
    }
}
