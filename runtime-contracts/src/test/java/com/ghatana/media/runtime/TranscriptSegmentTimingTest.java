package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaTranscriptContracts.SegmentTimingTag;
import com.ghatana.media.runtime.MediaTranscriptContracts.TimingAvailability;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptSegment;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptSegmentTiming;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * PDP-1 per-segment timing union: exact tagged dispositions are preserved, never
 * flattened, inferred, or promoted — and the aggregate reports the shared qualified
 * clock only when every segment carries the identical tuple.
 */
class TranscriptSegmentTimingTest {

    private static final String SHA = "ab".repeat(32);

    @Test
    void sourceTicksRequireTheExactQualifiedTupleWithinDuration() {
        var timing = TranscriptSegmentTiming.sourceTicks(0, 48_000, "src-clock", 48_000, 96_000);
        assertThat(timing.tag()).isEqualTo(SegmentTimingTag.SOURCE_TICKS);

        assertThatThrownBy(() -> TranscriptSegmentTiming.sourceTicks(0, 0, "src-clock", 48_000, 96_000))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> TranscriptSegmentTiming.sourceTicks(0, 97_000, "src-clock", 48_000, 96_000))
                .as("segment end beyond declared source duration fails closed")
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> TranscriptSegmentTiming.sourceTicks(0, 48_000, " ", 48_000, 96_000))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void providerUnqualifiedTimesArePreservedNeverRelabelled() {
        var timing = TranscriptSegmentTiming.providerTimeUnqualified(120, 340, "provider-ms");
        assertThat(timing.tag()).isEqualTo(SegmentTimingTag.PROVIDER_TIME_UNQUALIFIED);
        assertThat(timing.sourceClockId()).isEmpty();

        assertThatThrownBy(() -> TranscriptSegmentTiming.providerTimeUnqualified(0, 340, " "))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> TranscriptSegmentTiming.providerTimeUnqualified(400, 340, "ms"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TranscriptSegmentTiming(
                SegmentTimingTag.PROVIDER_TIME_UNQUALIFIED, 0, 100, "ms", "clock", 1, 1))
                .as("unqualified timing must not smuggle a source clock")
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void notSuppliedCarriesNoTimingFields() {
        assertThat(TranscriptSegmentTiming.notSupplied().tag())
                .isEqualTo(SegmentTimingTag.NOT_SUPPLIED);
        assertThatThrownBy(() -> new TranscriptSegmentTiming(
                SegmentTimingTag.NOT_SUPPLIED, 0, 10, "", "", 0, -1))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aggregateReportsEachExactDisposition() {
        var supplied = segment("s1", TranscriptSegmentTiming.notSupplied());
        var unqualified = segment("s2", TranscriptSegmentTiming.providerTimeUnqualified(0, 5, "ms"));
        var ticks = segment("s3", TranscriptSegmentTiming.sourceTicks(0, 10, "clock", 10, 100));

        assertThat(MediaTranscriptContracts.aggregateTimingAvailability(List.of()))
                .isEqualTo(TimingAvailability.NOT_SUPPLIED);
        assertThat(MediaTranscriptContracts.aggregateTimingAvailability(List.of(supplied)))
                .isEqualTo(TimingAvailability.NOT_SUPPLIED);
        assertThat(MediaTranscriptContracts.aggregateTimingAvailability(List.of(unqualified)))
                .isEqualTo(TimingAvailability.PROVIDER_TIME_UNQUALIFIED);
        assertThat(MediaTranscriptContracts.aggregateTimingAvailability(List.of(ticks)))
                .isEqualTo(TimingAvailability.SOURCE_CLOCK_BOUND);
    }

    @Test
    void mixedTagsOrInconsistentClockTuplesNeverPromoteTheAggregate() {
        var ticks = segment("s1", TranscriptSegmentTiming.sourceTicks(0, 10, "clock", 10, 100));
        var otherTicks = segment("s2", TranscriptSegmentTiming.sourceTicks(10, 20, "other", 10, 100));
        var otherRate = segment("s3", TranscriptSegmentTiming.sourceTicks(10, 20, "clock", 20, 100));
        var supplied = segment("s4", TranscriptSegmentTiming.notSupplied());

        assertThat(MediaTranscriptContracts.aggregateTimingAvailability(List.of(ticks, otherTicks)))
                .isEqualTo(TimingAvailability.MIXED);
        assertThat(MediaTranscriptContracts.aggregateTimingAvailability(List.of(ticks, otherRate)))
                .isEqualTo(TimingAvailability.MIXED);
        assertThat(MediaTranscriptContracts.aggregateTimingAvailability(List.of(ticks, supplied)))
                .isEqualTo(TimingAvailability.MIXED);
        // Same tuple on every segment still aggregates to SOURCE_CLOCK_BOUND.
        var ticks2 = segment("s5", TranscriptSegmentTiming.sourceTicks(10, 20, "clock", 10, 100));
        assertThat(MediaTranscriptContracts.aggregateTimingAvailability(List.of(ticks, ticks2)))
                .isEqualTo(TimingAvailability.SOURCE_CLOCK_BOUND);
    }

    @Test
    void draftRequiresStableUniqueSegmentIds() {
        var segment = segment("dup", TranscriptSegmentTiming.notSupplied());
        var draft = draft(List.of(segment));
        assertThat(draft.timingAvailability()).isEqualTo(TimingAvailability.NOT_SUPPLIED);
        assertThatThrownBy(() -> draft(List.of(segment, segment)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void segmentParameterValueRoundTripsExactly() {
        var ticks = segment("s1", TranscriptSegmentTiming.sourceTicks(0, 48_000, "c", 48_000, 96_000));
        var unqualified = segment("s2", TranscriptSegmentTiming.providerTimeUnqualified(3, 9, "ms"));
        var supplied = segment("s3", TranscriptSegmentTiming.notSupplied());
        var value = MediaTranscriptContracts.segmentsToParametersValue(List.of(ticks, unqualified, supplied));
        var parsed = MediaTranscriptContracts.segmentsFromParameterValue(value);
        assertThat(parsed).containsExactly(ticks, unqualified, supplied);
    }

    @Test
    void malformedSegmentPayloadsFailClosed() {
        assertThat(MediaTranscriptContracts.segmentsFromParameterValue(null)).isEmpty();
        assertThatThrownBy(() -> MediaTranscriptContracts.segmentsFromParameterValue("nope"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MediaTranscriptContracts.segmentsFromParameterValue(List.of(Map.of())))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MediaTranscriptContracts.segmentsFromParameterValue(List.of(Map.of(
                "segmentId", "s", "text", "t", "origin", "PROVIDER",
                "timing", Map.of("tag", "FICTIONAL")))))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static TranscriptSegment segment(String id, TranscriptSegmentTiming timing) {
        return new TranscriptSegment(id, "text", "PROVIDER", timing);
    }

    private static TranscriptDraft draft(List<TranscriptSegment> segments) {
        return new TranscriptDraft("tenant-a", "principal-a", "transcript:1", "src",
                "sha256:" + SHA, SHA, "job-1", "profile-a", "provider-a", "model-a",
                "en-US", "milliseconds", "text", "consent-1", "rights-1", "policy-v1",
                "urn:test", "test-purpose", segments);
    }
}
