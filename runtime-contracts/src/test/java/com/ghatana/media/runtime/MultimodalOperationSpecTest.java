package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.AbstractList;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

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
    void childListsAreBoundedByIterationEvenWhenReportedSizeLies() {
        List<MultimodalOperationSpec.ChildOperationSpec> children = new ArrayList<>();
        for (int i = 0; i < MultimodalOperationSpec.MAX_CHILDREN + 1; i++) {
            children.add(child("stt-" + i));
        }
        List<MultimodalOperationSpec.ChildOperationSpec> underreported = underreported(children);
        assertThat(underreported.size()).isEqualTo(1);
        assertThatThrownBy(() -> new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION, "cap", "op", 1, "src",
                "sha256:" + SHA_A, SHA_A, underreported, null, Map.of()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("exceeds its bound");

        Map<String, Object> encoded = new java.util.LinkedHashMap<>(spec().toParametersValue());
        List<Object> encodedChildren = new ArrayList<>();
        for (var child : children) encodedChildren.add(child.toString());
        encoded.put("children", underreported(encodedChildren));
        assertThatThrownBy(() -> MultimodalOperationSpec.fromParameterValue(encoded))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("exceeds its bound");
    }

    @Test
    void fusedResultRejectsExcessChildJobsWithoutReadingTheNinth() {
        List<com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob> values = new ArrayList<>();
        for (int i = 0; i < MultimodalOperationSpec.MAX_CHILDREN + 1; i++) {
            values.add(completedChild("job-" + i, JobType.SPEECH_TO_TEXT, Map.of()));
        }
        AtomicInteger consumed = new AtomicInteger();
        List<com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob> underreported =
                trackedUnderreported(values, consumed);

        assertThatThrownBy(() -> MultimodalOperationSpec.fusedResult(spec(), underreported))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("exceeds its bound");
        assertThat(consumed).hasValue(MultimodalOperationSpec.MAX_CHILDREN);
    }

    @Test
    void timedObservationProjectionCapsPerChildEntriesWithoutReadingTheExcessItem() {
        List<Map<String, Object>> values = new ArrayList<>();
        for (int i = 0; i < 17; i++) {
            values.add(Map.of("startTick", (long) i, "endTick", (long) i + 1,
                    "sourceClockId", "src-clock", "ticksPerSecond", 48_000L));
        }
        AtomicInteger consumed = new AtomicInteger();
        List<Map<String, Object>> underreported = trackedUnderreported(values, consumed);
        var bounded = MultimodalOperationSpec.boundedChildResult(
                Map.of("timedObservations", underreported), 24);

        assertThat(bounded.timedObservationsTruncated()).isTrue();
        assertThat((List<?>) bounded.values().get("timedObservations")).hasSize(16);
        assertThat(consumed).hasValue(16);
    }

    @Test
    void timedObservationProjectionRespectsGlobalBudgetWithoutReadingExcessItems() {
        List<Map<String, Object>> values = new ArrayList<>();
        for (int i = 0; i < 16; i++) {
            values.add(Map.of("startTick", (long) i, "endTick", (long) i + 1,
                    "sourceClockId", "src-clock", "ticksPerSecond", 48_000L));
        }
        AtomicInteger consumed = new AtomicInteger();
        var bounded = MultimodalOperationSpec.boundedChildResult(
                Map.of("timedObservations", trackedUnderreported(values, consumed)), 8);

        assertThat(bounded.timedObservationsTruncated()).isTrue();
        assertThat((List<?>) bounded.values().get("timedObservations")).hasSize(8);
        assertThat(consumed).hasValue(8);
    }

    @Test
    void fusedResultHashesFullChildInputAndReportsCharacterBudgetTruncation() {
        String oversizedLabel = "l".repeat(9_000);
        Map<String, Object> timed = Map.of("timedObservations", List.of(Map.of(
                "label", oversizedLabel,
                "startTick", 0L,
                "endTick", 1L,
                "sourceClockId", "src-clock",
                "ticksPerSecond", 48_000L)));
        var child = completedChild("job-timed-large", JobType.SPEECH_TO_TEXT, timed);
        var fused = MultimodalOperationSpec.fusedResult(
                clockedSpec(new MultimodalOperationSpec.SourceClockBinding(
                        "ev", 48_000, 0, "src-clock", 100)), List.of(child));
        Map<?, ?> observation = (Map<?, ?>) ((List<?>) fused.get("observations")).getFirst();
        Map<?, ?> timing = (Map<?, ?>) observation.get("timing");

        assertThat(timing.get("status")).isEqualTo("SYNC_UNDETERMINED");
        assertThat(timing.get("reason")).isEqualTo("TIMED_OBSERVATION_BUDGET_EXCEEDED");
        assertThat(timing.get("groundedTimedObservations")).isEqualTo(0);
        assertThat(((Map<?, ?>) observation.get("observations")).get("timedObservations"))
                .isEqualTo(List.of());
        assertThat(observation.get("childResultDigest")).isEqualTo(
                MediaJobRequestFingerprint.boundedCanonicalJsonDigest(
                        timed, MediaModalityContracts.ExecutionBounds.defaults().maximumOutputBytes()));
    }

    @Test
    void timingBudgetDispositionRemainsExplicitWhenTheEmptyTimingFieldCannotFit() {
        Map<String, Object> childResult = new java.util.LinkedHashMap<>();
        childResult.put("text", "x".repeat(8_160));
        childResult.put("timedObservations", List.of(Map.of(
                "startTick", 0L, "endTick", 1L,
                "sourceClockId", "src-clock", "ticksPerSecond", 48_000L)));
        var child = completedChild("job-timing-no-space", JobType.SPEECH_TO_TEXT, childResult);

        var fused = MultimodalOperationSpec.fusedResult(
                clockedSpec(new MultimodalOperationSpec.SourceClockBinding(
                        "ev", 48_000, 0, "src-clock", 100)), List.of(child));
        Map<?, ?> observation = (Map<?, ?>) ((List<?>) fused.get("observations")).getFirst();
        Map<?, ?> timing = (Map<?, ?>) observation.get("timing");
        Map<?, ?> projected = (Map<?, ?>) observation.get("observations");

        assertThat(MediaJobRequestFingerprint.boundedCanonicalJsonLength(projected, 8_192))
                .isLessThanOrEqualTo(8_192);
        assertThat(projected.containsKey("timedObservations")).isFalse();
        assertThat(timing.get("status")).isEqualTo("SYNC_UNDETERMINED");
        assertThat(timing.get("reason")).isEqualTo("TIMED_OBSERVATION_BUDGET_EXCEEDED");
    }

    @Test
    void fusedResultRejectsOversizedNonTimingFieldsInsteadOfReturningPartialSuccess() {
        var child = completedChild("job-large", JobType.SPEECH_TO_TEXT,
                Map.of("text", "x".repeat(8_192)));

        assertThatThrownBy(() -> MultimodalOperationSpec.fusedResult(List.of(child)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("complete bounded projection");
    }

    @Test
    void fusedResultSortsProjectedFieldsAndKeepsDigestIndependentOfInsertionOrder() {
        Map<String, Object> forward = new java.util.LinkedHashMap<>();
        forward.put("zeta", "last");
        forward.put("alpha", "first");
        Map<String, Object> reverse = new java.util.LinkedHashMap<>();
        reverse.put("alpha", "first");
        reverse.put("zeta", "last");

        var left = MultimodalOperationSpec.boundedChildResult(forward, 24).values();
        var right = MultimodalOperationSpec.boundedChildResult(reverse, 24).values();

        assertThat(left).isEqualTo(right);
        assertThat(new ArrayList<>(left.keySet())).containsExactly("alpha", "zeta");
        assertThat(MediaJobRequestFingerprint.boundedCanonicalJsonDigest(forward, 4 * 1024 * 1024))
                .isEqualTo(MediaJobRequestFingerprint.boundedCanonicalJsonDigest(reverse, 4 * 1024 * 1024));
    }

    @Test
    void malformedTimedObservationsAreNotTreatedAsAbsent() {
        var child = completedChild("job-timed-malformed", JobType.SPEECH_TO_TEXT,
                Map.of("timedObservations", "not-a-list"));
        var fused = MultimodalOperationSpec.fusedResult(List.of(child));
        Map<?, ?> observation = (Map<?, ?>) ((List<?>) fused.get("observations")).getFirst();
        Map<?, ?> timing = (Map<?, ?>) observation.get("timing");

        assertThat(timing.get("status")).isEqualTo("SYNC_UNDETERMINED");
        assertThat(timing.get("reason")).isEqualTo("TIMED_OBSERVATIONS_MALFORMED");
        assertThat(timing.containsKey("declaredTimedObservations")).isFalse();
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
        assertThat(binding.clockId()).isEqualTo("clock-1");
        // Bindings without identity/duration stay verifiable-undetermined, not invented.
        var unscoped = new MultimodalOperationSpec.SourceClockBinding("ev", 1_000, 0);
        assertThat(unscoped.clockId()).isEmpty();
        assertThat(unscoped.durationTicks()).isZero();
        assertThatThrownBy(() -> new MultimodalOperationSpec.SourceClockBinding(
                "ev", 0, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MultimodalOperationSpec.SourceClockBinding(
                "ev", 1_000, 0, "clk\u0007x", 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MultimodalOperationSpec.SourceClockBinding(
                " ev", 1_000, 0, "clock-1", 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MultimodalOperationSpec.SourceClockBinding(
                "ev", 1_000, 0, "clock-1 ", 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MultimodalOperationSpec.SourceClockBinding(
                "\u2003ev", 1_000, 0, "clock-1", 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MultimodalOperationSpec.SourceClockBinding(
                "ev", 1_000, 0, "\u00a0clock-1", 0)).isInstanceOf(IllegalArgumentException.class);
        var paddedEvidence = Map.<String, Object>of(
                "evidenceRef", " ev", "ticksPerSecond", 1_000,
                "epochOffsetTicks", 0, "clockId", "clock-1");
        assertThatThrownBy(() -> MultimodalOperationSpec.SourceClockBinding.fromParameterValue(paddedEvidence))
                .isInstanceOf(IllegalArgumentException.class);
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
                                        "sourceClockId", "src-clock", "ticksPerSecond", 48_000L,
                                        "label", "seg-1"))));
        var vision = completedChild("job-vis", JobType.VISION,
                Map.of("caption", "a cat",
                        "timedObservations", List.of(
                                Map.of("startTick", 24_000L, "endTick", 28_800L,
                                        "sourceClockId", "src-clock", "ticksPerSecond", 48_000L))));
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
                        Map.of("startTick", 0L, "endTick", 1_000L, "sourceClockId", "other-clock",
                                "ticksPerSecond", 48_000L))));
        var outOfDuration = completedChild("job-b", JobType.VISION,
                Map.of("timedObservations", List.of(
                        Map.of("startTick", 0L, "endTick", 96_000L, "sourceClockId", "src-clock",
                                "ticksPerSecond", 48_000L))));
        var missingTimebase = completedChild("job-d", JobType.SPEECH_TO_TEXT,
                Map.of("timedObservations", List.of(
                        Map.of("startTick", 0L, "endTick", 1_000L, "sourceClockId", "src-clock"))));
        var mismatchedTimebase = completedChild("job-e", JobType.VISION,
                Map.of("timedObservations", List.of(
                        Map.of("startTick", 0L, "endTick", 1_000L, "sourceClockId", "src-clock",
                                "ticksPerSecond", 90_000L))));
        var malformed = completedChild("job-c", JobType.SPEECH_TO_TEXT,
                Map.of("timedObservations", List.of(Map.of("startTick", "oops"))));
        var nullObservation = completedChild("job-f", JobType.VISION,
                Map.of("timedObservations", java.util.Collections.singletonList(null)));
        Map<String, Object> fused = MultimodalOperationSpec.fusedResult(
                spec, List.of(wrongClock, outOfDuration, malformed, missingTimebase,
                        mismatchedTimebase, nullObservation));
        List<?> observations = (List<?>) fused.get("observations");
        assertThat(undetermined(observations, 0)).isEqualTo("SOURCE_CLOCK_MISMATCH");
        assertThat(undetermined(observations, 1)).isEqualTo("SOURCE_TICKS_OUT_OF_DURATION");
        assertThat(undetermined(observations, 2)).isEqualTo("TIMED_OBSERVATION_MALFORMED");
        assertThat(undetermined(observations, 3)).isEqualTo("SOURCE_CLOCK_MISMATCH");
        assertThat(undetermined(observations, 4)).isEqualTo("SOURCE_CLOCK_MISMATCH");
        assertThat(undetermined(observations, 5)).isEqualTo("TIMED_OBSERVATION_MALFORMED");
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
        assertThat(MultimodalOperationSpec.declaredSourceClock(Map.of(
                "sourceClockId", " src-clock",
                "sourceClockMappingEvidenceRef", "mapping-evidence",
                "sourceClockTicksPerSecond", 48_000,
                "sourceDurationTicks", 96_000))).isEmpty(); // clock identity edge whitespace
        assertThat(MultimodalOperationSpec.declaredSourceClock(Map.of(
                "sourceClockId", "src-clock",
                "sourceClockMappingEvidenceRef", "mapping-evidence\u2003",
                "sourceClockTicksPerSecond", 48_000,
                "sourceDurationTicks", 96_000))).isEmpty(); // mapping ref edge whitespace
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
                "x", 0, 10, " src-clock", 48_000)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MultimodalOperationSpec.timedObservation(
                "x", 0, 10, "src-clock\u00a0", 48_000)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MultimodalOperationSpec.timedObservation(
                "x", 0, 10, "src-clock", 0)).isInstanceOf(IllegalArgumentException.class);
    }

    private static String undetermined(List<?> observations, int index) {
        Map<?, ?> entry = (Map<?, ?>) ((List<?>) ((Map<?, ?>) ((Map<?, ?>) observations.get(index))
                .get("timing")).get("entries")).get(0);
        assertThat(entry.get("status")).isEqualTo("SYNC_UNDETERMINED");
        return String.valueOf(entry.get("reason"));
    }

    private static <T> List<T> underreported(List<T> values) {
        return new AbstractList<>() {
            @Override public T get(int index) { return values.get(index); }
            @Override public int size() { return 1; }
            @Override public Iterator<T> iterator() { return values.iterator(); }
        };
    }

    private static <T> List<T> trackedUnderreported(List<T> values, AtomicInteger consumed) {
        return new AbstractList<>() {
            @Override public T get(int index) { return values.get(index); }
            @Override public int size() { return 1; }
            @Override public Iterator<T> iterator() {
                Iterator<T> delegate = values.iterator();
                return new Iterator<>() {
                    @Override public boolean hasNext() { return delegate.hasNext(); }
                    @Override public T next() {
                        consumed.incrementAndGet();
                        return delegate.next();
                    }
                };
            }
        };
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
