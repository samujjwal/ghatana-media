package com.ghatana.video.streaming;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** VS-03 source-backed tests for exact VFR timing and explicit mapping uncertainty. */
class VideoFrameTimebaseTest {

    private static VideoStreamSession.DecodedFrame wireFrame(int sequence, boolean keyframe, long wireMillis) {
        return new VideoStreamSession.DecodedFrame(sequence, keyframe, wireMillis, new byte[]{1});
    }

    private static VideoFrameTimebase.FrameTiming timing(
            int sequence, boolean keyframe, long capturePts, long presentationPts,
            String discontinuity, String codecId, String codecConfiguration) {
        return VideoFrameTimebase.bind(
                "camera-A",
                // The wall-time-like legacy value is intentionally not used as either source PTS.
                wireFrame(sequence, keyframe, 1_700_000_000_000L + sequence),
                keyframe ? sequence : 0,
                VideoFrameTimebase.SourceTimestamp.known(capturePts, 1, 90_000, "capture-clock-A"),
                VideoFrameTimebase.SourceTimestamp.known(presentationPts, 1, 90_000, "source-clock-A"),
                discontinuity,
                codecId,
                codecConfiguration,
                VideoFrameTimebase.PresentationMapping.unknown("NO_QUALIFIED_PRESENTATION_MAP"));
    }

    @Test
    void preservesIrregularPtsTimebasesAndKeyframeDependencyWithoutUsingWireMillis() {
        List<VideoFrameTimebase.FrameTiming> frames = List.of(
                timing(0, true, 0, 0, "segment-0", "h264", "h264-config-1"),
                timing(1, false, 3_000, 3_750, "segment-0", "h264", "h264-config-1"),
                timing(2, false, 6_000, 3_840, "segment-0", "h264", "h264-config-1"),
                timing(3, true, 9_000, 10_000, "segment-0", "h264", "h264-config-1"));

        assertThat(frames).extracting(VideoFrameTimebase.FrameTiming::sequence)
                .containsExactly(0, 1, 2, 3);
        assertThat(frames).extracting(VideoFrameTimebase.FrameTiming::keyFrameSequence)
                .containsExactly(0, 0, 0, 3);
        assertThat(frames).extracting(f -> f.presentationPts().ticks())
                .containsExactly(0L, 3_750L, 3_840L, 10_000L);
        assertThat(frames).allSatisfy(frame -> {
            assertThat(frame.presentationPts().timebaseNumerator()).isEqualTo(1L);
            assertThat(frame.presentationPts().timebaseDenominator()).isEqualTo(90_000L);
            assertThat(frame.presentationMapping().status()).isEqualTo(VideoFrameTimebase.Status.UNKNOWN);
        });
        assertThat(frames.get(1).capturePts().clockId()).isEqualTo("capture-clock-A");
        assertThat(frames.get(1).presentationPts().clockId()).isEqualTo("source-clock-A");
        assertThat(wireFrame(1, false, 1_700_000_000_000L).timestampMillis())
                .isNotEqualTo(frames.get(1).presentationPts().ticks());
    }

    @Test
    void explicitDiscontinuityAndCodecConfigurationChangesCanRetainPtsReset() {
        var before = timing(4, true, 180_000, 180_000, "segment-0", "h264", "h264-config-1");
        var after = timing(5, true, 0, 0, "segment-1", "hevc", "hevc-config-2");

        assertThat(before.presentationPts().ticks()).isGreaterThan(after.presentationPts().ticks());
        assertThat(after.discontinuityId()).isNotEqualTo(before.discontinuityId());
        assertThat(after.codecId()).isNotEqualTo(before.codecId());
        assertThat(after.codecConfigurationId()).isNotEqualTo(before.codecConfigurationId());
        assertThat(after.keyFrameSequence()).isEqualTo(5);
        assertThat(after.presentationMapping().unknownReason()).isEqualTo("NO_QUALIFIED_PRESENTATION_MAP");
    }

    @Test
    void missingSourcePtsRemainsUnknownAndInvalidKeyframeIdentityFailsClosed() {
        var frame = VideoFrameTimebase.bind(
                "camera-A", wireFrame(7, false, 123L), null,
                VideoFrameTimebase.SourceTimestamp.unknown("CAPTURE_PTS_NOT_SUPPLIED"),
                VideoFrameTimebase.SourceTimestamp.unknown("PRESENTATION_PTS_NOT_SUPPLIED"),
                "segment-0", "h264", "h264-config-1",
                VideoFrameTimebase.PresentationMapping.unknown("NO_QUALIFIED_PRESENTATION_MAP"));

        assertThat(frame.capturePts().status()).isEqualTo(VideoFrameTimebase.Status.UNKNOWN);
        assertThat(frame.presentationPts().status()).isEqualTo(VideoFrameTimebase.Status.UNKNOWN);
        assertThat(frame.keyFrameSequence()).isNull();
        assertThatThrownBy(() -> VideoFrameTimebase.bind(
                "camera-A", wireFrame(8, true, 456L), 7,
                VideoFrameTimebase.SourceTimestamp.unknown("CAPTURE_PTS_NOT_SUPPLIED"),
                VideoFrameTimebase.SourceTimestamp.unknown("PRESENTATION_PTS_NOT_SUPPLIED"),
                "segment-0", "h264", "h264-config-1",
                VideoFrameTimebase.PresentationMapping.unknown("NO_QUALIFIED_PRESENTATION_MAP")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("keyframe identity");
    }

    @Test
    void sourceTimebaseRequiresClockIdentityAndMappingRequiresUncertaintyAndPolicy() {
        assertThatThrownBy(() -> VideoFrameTimebase.SourceTimestamp.known(12, 1, 90_000, " "))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("clock identity");
        assertThatThrownBy(() -> new VideoFrameTimebase.PresentationMapping(
                VideoFrameTimebase.Status.KNOWN,
                VideoFrameTimebase.SourceTimestamp.known(1, 1, 90_000, "output-clock"),
                VideoFrameTimebase.TimelineTimestamp.known(1, 24_000, 1,
                        VideoFrameTimebase.ClockDomain.STORY_EXPLANATION, "story-clock"),
                "origin", "", "ROUND_NEAREST_TIES_TO_EVEN", "evidence", null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("uncertainty");
    }

    @Test
    void knownPresentationMappingSurvivesFrameBindingWithoutRescaling() {
        var mapping = new VideoFrameTimebase.PresentationMapping(
                VideoFrameTimebase.Status.KNOWN,
                VideoFrameTimebase.SourceTimestamp.known(90_090, 1, 90_000, "source-clock-A"),
                VideoFrameTimebase.TimelineTimestamp.known(24_024, 24_000, 1,
                        VideoFrameTimebase.ClockDomain.STORY_EXPLANATION, "story-clock-v1"),
                "source-PTS-zero-to-story-frame-zero",
                "SYNTHETIC_FIXTURE_BOUND_1_TICK",
                "ROUND_NEAREST_TIES_TO_EVEN",
                "mapping-evidence:fixture-v1",
                null);

        var frame = VideoFrameTimebase.bind(
                "camera-A", wireFrame(8, false, 1_700_000_000_008L), 0,
                VideoFrameTimebase.SourceTimestamp.known(90_090, 1, 90_000, "capture-clock-A"),
                VideoFrameTimebase.SourceTimestamp.known(90_090, 1, 90_000, "source-clock-A"),
                "segment-0", "h264", "h264-config-1", mapping);

        assertThat(frame.presentationPts().ticks()).isEqualTo(90_090L);
        assertThat(frame.presentationMapping()).isEqualTo(mapping);
        assertThat(frame.presentationMapping().sourcePosition()).isEqualTo(frame.presentationPts());
        assertThat(frame.presentationMapping().presentationPosition().ticks()).isEqualTo(24_024L);
        assertThat(frame.presentationMapping().presentationPosition().timebaseNumerator()).isEqualTo(24_000L);
        assertThat(frame.presentationMapping().presentationPosition().timebaseDenominator()).isEqualTo(1L);
        assertThat(frame.presentationMapping().presentationPosition().domain())
                .isEqualTo(VideoFrameTimebase.ClockDomain.STORY_EXPLANATION);
        assertThat(frame.presentationMapping().origin()).isEqualTo("source-PTS-zero-to-story-frame-zero");
        assertThat(frame.presentationMapping().uncertainty()).isEqualTo("SYNTHETIC_FIXTURE_BOUND_1_TICK");
        assertThat(frame.presentationMapping().roundingPolicy()).isEqualTo("ROUND_NEAREST_TIES_TO_EVEN");
        assertThat(frame.presentationMapping().evidenceRef()).isEqualTo("mapping-evidence:fixture-v1");
    }

    @Test
    void knownPresentationMappingMustReferToThisFramesExactSourcePts() {
        var mismatchedSource = VideoFrameTimebase.SourceTimestamp.known(90_000, 1, 90_000, "source-clock-A");
        var mapping = new VideoFrameTimebase.PresentationMapping(
                VideoFrameTimebase.Status.KNOWN,
                mismatchedSource,
                VideoFrameTimebase.TimelineTimestamp.known(24_000, 24_000, 1,
                        VideoFrameTimebase.ClockDomain.STORY_EXPLANATION, "story-clock-v1"),
                "synthetic-origin",
                "SYNTHETIC_FIXTURE_BOUND_1_TICK",
                "ROUND_NEAREST_TIES_TO_EVEN",
                "mapping-evidence:fixture-v1",
                null);

        assertThatThrownBy(() -> VideoFrameTimebase.bind(
                "camera-A", wireFrame(8, false, 1_700_000_000_008L), 0,
                VideoFrameTimebase.SourceTimestamp.known(90_090, 1, 90_000, "capture-clock-A"),
                VideoFrameTimebase.SourceTimestamp.known(90_090, 1, 90_000, "source-clock-A"),
                "segment-0", "h264", "h264-config-1", mapping))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("source position must match");
    }

    @Test
    void sourceTimebaseRejectsZeroNegativeAndOutOfRangeRates() {
        for (long invalid : new long[]{0, -1, 1_000_000_001L}) {
            assertThatThrownBy(() -> VideoFrameTimebase.SourceTimestamp.known(
                    1, invalid, 90_000, "source-clock-A"))
                    .as("invalid timebase numerator %s", invalid)
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> VideoFrameTimebase.SourceTimestamp.known(
                    1, 1, invalid, "source-clock-A"))
                    .as("invalid timebase denominator %s", invalid)
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void unknownPresentationMappingRequiresANonblankReason() {
        assertThatThrownBy(() -> VideoFrameTimebase.PresentationMapping.unknown(" "))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unknown presentation mappings");
        assertThatThrownBy(() -> new VideoFrameTimebase.PresentationMapping(
                VideoFrameTimebase.Status.UNKNOWN, null, null, null, null, null, null, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unknown presentation mappings");
    }
}
