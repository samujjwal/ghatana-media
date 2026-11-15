package com.ghatana.audio.video.vision.tracking;

import com.ghatana.audio.video.vision.tracking.GreedyIouTracker.Detection;
import com.ghatana.audio.video.vision.tracking.RegionOfInterest.RoiRefusedException;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Pure logic of the vision tracking lane: probe parsing, deterministic sampling, tracker and ROI refusals. */
class TrackingCoreTest {

    private static String probe(String sideData, long... pts) {
        StringBuilder frames = new StringBuilder();
        for (long p : pts) {
            if (frames.length() > 0) frames.append(',');
            frames.append("{\"pts\":").append(p).append(",\"best_effort_timestamp\":").append(p).append('}');
        }
        return "{\"frames\":[" + frames + "],\"streams\":[{\"width\":640,\"height\":360,\"time_base\":\"1/10240\""
                + sideData + "}]}";
    }

    @Test
    void timelineIsPtsOrderedExactAndDetectsVariableFrameRate() {
        VideoTimeline cfr = VideoTimeline.parse(probe("", 0, 1024, 2048, 3072));
        assertThat(cfr.variableFrameRate()).isFalse();
        assertThat(cfr.timeBaseNum()).isEqualTo(1);
        assertThat(cfr.timeBaseDen()).isEqualTo(10240);
        VideoTimeline vfr = VideoTimeline.parse(probe("", 3072, 0, 1024, 7168));
        assertThat(vfr.variableFrameRate()).isTrue();
        assertThat(vfr.frames()).extracting(VideoTimeline.FrameTime::pts).containsExactly(0L, 1024L, 3072L, 7168L);
        assertThat(vfr.frames()).extracting(VideoTimeline.FrameTime::frameIndex).containsExactly(0, 1, 2, 3);
        assertThat(vfr.ptsMicros(7168)).isEqualTo(700_000L);
        assertThat(vfr.ptsMicros(1024)).isEqualTo(100_000L);
    }

    @Test
    void timelineRefusesAmbiguousOrUntrustworthyProbeOutput() {
        assertThatThrownBy(() -> VideoTimeline.parse(probe("", 0, 1024, 1024)))
                .isInstanceOf(VideoTimeline.TimelineException.class).hasMessageContaining("share one");
        assertThatThrownBy(() -> VideoTimeline.parse("{\"frames\":[{\"pts_time\":\"x\"}],\"streams\":[{\"width\":1,"
                + "\"height\":1,\"time_base\":\"1/25\"}]}")).isInstanceOf(VideoTimeline.TimelineException.class);
        assertThatThrownBy(() -> VideoTimeline.parse("{\"frames\":[{\"pts\":0}],\"streams\":[{\"width\":1,"
                + "\"height\":1,\"time_base\":\"N/A\"}]}")).isInstanceOf(VideoTimeline.TimelineException.class);
        assertThatThrownBy(() -> VideoTimeline.parse("{\"frames\":[],\"streams\":[{\"width\":1,\"height\":1,"
                + "\"time_base\":\"1/25\"}]}")).isInstanceOf(VideoTimeline.TimelineException.class);
        assertThatThrownBy(() -> VideoTimeline.parse("not json")).isInstanceOf(VideoTimeline.TimelineException.class);
    }

    @Test
    void rotationSwapsDisplayedGeometry() {
        VideoTimeline rotated = VideoTimeline.parse(probe(",\"side_data_list\":[{\"rotation\":-90}]", 0, 1024));
        assertThat(rotated.width()).isEqualTo(360);
        assertThat(rotated.height()).isEqualTo(640);
    }

    @Test
    void samplingIsDeterministicBoundedAndStrictlyIncreasing() {
        long[] pts = new long[100];
        for (int i = 0; i < pts.length; i++) pts[i] = i * 100L;
        VideoTimeline timeline = VideoTimeline.parse(probe("", pts));
        List<Integer> sampled = timeline.sample(16, 0);
        assertThat(sampled).hasSize(15).startsWith(0, 7, 14).isSorted();
        assertThat(timeline.sample(16, 0)).isEqualTo(sampled);
        assertThat(timeline.sample(5, 3)).containsExactly(0, 3, 6, 9, 12);
        assertThat(timeline.sample(1000, 0)).hasSize(100);
    }

    private static Detection det(String label, double x, double y, double w, double h) {
        return new Detection(label, new SourceBox(x, y, w, h));
    }

    @Test
    void trackerFollowsTwoObjectsKeepsLabelsApartAndIsDeterministic() {
        for (int run = 0; run < 2; run++) {
            GreedyIouTracker tracker = new GreedyIouTracker(0.3, 1);
            for (int f = 0; f < 6; f++) {
                // Frame order of detections is reversed on odd frames: identity must not depend on list order.
                List<Detection> detections = new java.util.ArrayList<>(List.of(
                        det("car", 20 + 30 * f, 200, 160, 70), det("person", 450, 40 + 15 * f, 70, 150)));
                if (f % 2 == 1) java.util.Collections.reverse(detections);
                tracker.update(f, f * 1000L, detections);
            }
            var tracks = tracker.tracks();
            assertThat(tracks).hasSize(2);
            assertThat(tracks).extracting(GreedyIouTracker.Track::label).containsExactlyInAnyOrder("car", "person");
            assertThat(tracks).allSatisfy(t -> assertThat(t.observations()).hasSize(6));
            assertThat(tracks.get(0).trackId()).isEqualTo("T0001");
        }
    }

    @Test
    void trackerBridgesOneMissedFrameButStartsANewTrackAfterALongGap() {
        GreedyIouTracker tracker = new GreedyIouTracker(0.3, 1);
        tracker.update(0, 0, List.of(det("car", 10, 10, 100, 50)));
        tracker.update(1, 10, List.of(det("car", 20, 10, 100, 50)));
        tracker.update(2, 20, List.of());
        tracker.update(3, 30, List.of(det("car", 40, 10, 100, 50)));
        assertThat(tracker.tracks()).hasSize(1);
        tracker.update(4, 40, List.of());
        tracker.update(5, 50, List.of());
        tracker.update(6, 60, List.of(det("car", 70, 10, 100, 50)));
        assertThat(tracker.tracks()).hasSize(2);
        assertThat(tracker.tracks().get(0).observations()).hasSize(3);
    }

    @Test
    void trackerUsesConstantVelocityToKeepAFastSmallObject() {
        GreedyIouTracker tracker = new GreedyIouTracker(0.3, 0);
        // 37px wide object that accelerates to 27px per step: plain IoU with the last box is only ~0.15, so only the
        // constant-velocity prediction keeps it on one track.
        double[] xs = {100, 110, 137, 164, 191};
        for (int f = 0; f < xs.length; f++) tracker.update(f, f * 1000L, List.of(det("wheel", xs[f], 50, 37, 33)));
        assertThat(tracker.tracks()).hasSize(1);
        assertThat(tracker.tracks().get(0).observations()).hasSize(5);
    }

    @Test
    void trackerRefusesNonMonotonicPtsAndBadParameters() {
        GreedyIouTracker tracker = new GreedyIouTracker(0.3, 1);
        tracker.update(0, 100, List.of());
        assertThatThrownBy(() -> tracker.update(1, 100, List.of())).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new GreedyIouTracker(0, 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new GreedyIouTracker(0.3, 99)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void invalidDetectionFrameIsRejectedBeforeConsumingPtsOrChangingTracks() {
        GreedyIouTracker tracker = new GreedyIouTracker(0.3, 0);
        tracker.update(0, 100, List.of(det("car", 10, 10, 20, 20)));

        assertThatThrownBy(() -> tracker.update(1, 200, null))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("detections are required");
        assertThatThrownBy(() -> tracker.update(1, 200, java.util.Arrays.asList((Detection) null)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("entries must be non-null");
        assertThatThrownBy(() -> new Detection("  ", new SourceBox(10, 10, 20, 20)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("label must be non-blank");
        assertThatThrownBy(() -> new Detection("car", null))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("box is required");

        tracker.update(1, 200, List.of(det("car", 10, 10, 20, 20)));
        assertThat(tracker.tracks()).hasSize(1);
        assertThat(tracker.tracks().getFirst().observations())
                .extracting(GreedyIouTracker.Observation::pts).containsExactly(100L, 200L);
    }

    @Test
    void boxBoundsAndIouAreExact() {
        SourceBox a = new SourceBox(0, 0, 10, 10);
        assertThat(a.iou(new SourceBox(5, 0, 10, 10))).isEqualTo(50.0 / 150.0);
        assertThat(a.iou(new SourceBox(20, 20, 5, 5))).isZero();
        assertThat(a.withinFrame(10, 10)).isTrue();
        assertThat(a.withinFrame(9, 10)).isFalse();
        SourceBox clamped = new SourceBox(-0.6, 0, 10, 10).clampedToFrame(100, 100);
        assertThat(clamped.x()).isZero();
        assertThat(clamped.width()).isCloseTo(9.4, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(new SourceBox(-3, 0, 10, 10).clampedToFrame(100, 100)).isNull();
        assertThat(new SourceBox(90, 0, 10.5, 10).clampedToFrame(100, 100)).isNotNull();
        assertThat(new SourceBox(90, 0, 12, 10).clampedToFrame(100, 100)).isNull();
        assertThatThrownBy(() -> new SourceBox(Double.NaN, 0, 1, 1)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void roiRefusalsAreTypedAndOrderedStructuralFirst() {
        assertThat(RegionOfInterest.of(1, 2, 3, 4)).isEqualTo(new RegionOfInterest(1, 2, 3, 4));
        assertThatThrownBy(() -> RegionOfInterest.of(-1, 0, 5, 5)).isInstanceOfSatisfying(RoiRefusedException.class,
                e -> assertThat(e.code()).isEqualTo("ROI_NEGATIVE"));
        assertThatThrownBy(() -> RegionOfInterest.of(0, 0, 0, 5)).isInstanceOfSatisfying(RoiRefusedException.class,
                e -> assertThat(e.code()).isEqualTo("ROI_ZERO_SIZE"));
        assertThatThrownBy(() -> RegionOfInterest.of(0, 0, 5, -2)).isInstanceOfSatisfying(RoiRefusedException.class,
                e -> assertThat(e.code()).isEqualTo("ROI_ZERO_SIZE"));
        assertThatThrownBy(() -> RegionOfInterest.of(0.5, 0, 5, 5)).isInstanceOfSatisfying(RoiRefusedException.class,
                e -> assertThat(e.code()).isEqualTo("ROI_MALFORMED"));
        assertThatThrownBy(() -> RegionOfInterest.of("1", 0, 5, 5)).isInstanceOfSatisfying(RoiRefusedException.class,
                e -> assertThat(e.code()).isEqualTo("ROI_MALFORMED"));
        assertThatThrownBy(() -> RegionOfInterest.of(null, 0, 5, 5)).isInstanceOfSatisfying(RoiRefusedException.class,
                e -> assertThat(e.code()).isEqualTo("ROI_MALFORMED"));
        assertThatThrownBy(() -> RegionOfInterest.of(Integer.MAX_VALUE, 0, 1, 1))
                .isInstanceOfSatisfying(RoiRefusedException.class, e -> assertThat(e.code()).isEqualTo("ROI_MALFORMED"));
        RegionOfInterest roi = new RegionOfInterest(600, 300, 40, 60);
        roi.requireWithin(640, 360);
        assertThatThrownBy(() -> new RegionOfInterest(600, 300, 41, 60).requireWithin(640, 360))
                .isInstanceOfSatisfying(RoiRefusedException.class, e -> assertThat(e.code()).isEqualTo("ROI_OUT_OF_FRAME"));
        assertThatThrownBy(() -> new RegionOfInterest(600, 300, 40, 61).requireWithin(640, 360))
                .isInstanceOf(RoiRefusedException.class);
    }
}
