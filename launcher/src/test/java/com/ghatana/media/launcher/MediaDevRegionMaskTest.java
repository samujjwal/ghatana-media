package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevRegionMask.FrameMask;
import com.ghatana.media.launcher.MediaDevRegionMask.Observation;
import com.ghatana.media.launcher.MediaDevRegionMask.Rect;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** J-11 mask geometry on a variable-frame-rate timeline: interpolation is in PTS, not in frame index. */
class MediaDevRegionMaskTest {
    // time base 1/10240; frames at ticks 0, 1024, 2048, then a gap (frames 3 and 4 dropped), 5120, 6144.
    private static final long[] PTS = {0, 1024, 2048, 5120, 6144};

    @Test
    void interpolatesLinearlyInPresentationTimeNotInFrameIndex() {
        // x moves 0 -> 600 across ticks 0 .. 6144 only if sampled at frames 0 and 4; frame 3 sits at 5120/6144 of the way.
        List<Observation> observations = List.of(new Observation(0, 0, 0, 100, 40, 40),
                new Observation(4, 6144, 600, 100, 40, 40));
        List<FrameMask> masks = MediaDevRegionMask.derive(PTS, 1280, 720, observations, 0, false);
        assertThat(masks).extracting(FrameMask::source).containsExactly(
                MediaDevRegionMask.OBSERVED, MediaDevRegionMask.INTERPOLATED, MediaDevRegionMask.INTERPOLATED,
                MediaDevRegionMask.INTERPOLATED, MediaDevRegionMask.OBSERVED);
        // x at ticks 1024 / 2048 / 5120: 100, 200, 500 (frame-index interpolation would give 150, 300, 450).
        assertThat(masks.get(1).rect().x()).isEqualTo(100);
        assertThat(masks.get(2).rect().x()).isEqualTo(200);
        assertThat(masks.get(3).rect().x()).isEqualTo(500);
        assertThat(masks.get(4).rect().x()).isEqualTo(600);
    }

    @Test
    void masksAreEvenAlignedPaddedSnappedOutwardAndClampedToTheFrame() {
        List<Observation> observations = List.of(new Observation(0, 0, 3.3, 5.1, 10.2, 9.8));
        Rect rect = MediaDevRegionMask.derive(new long[] {0}, 64, 48, observations, 2, false).getFirst().rect();
        // x: floorEven(3.3-2)=0, right ceilEven(3.3+10.2+2)=16; y: floorEven(3.1)=2, bottom ceilEven(5.1+9.8+2)=18.
        assertThat(rect).isEqualTo(new Rect(0, 2, 16, 16));
        assertThat(rect.x() % 2 + rect.y() % 2 + rect.width() % 2 + rect.height() % 2).isZero();
        Rect clamped = MediaDevRegionMask.derive(new long[] {0}, 64, 48,
                List.of(new Observation(0, 0, 50, 40, 14, 8)), 8, false).getFirst().rect();
        assertThat(clamped.right()).isEqualTo(64);
        assertThat(clamped.bottom()).isEqualTo(48);
    }

    @Test
    void framesOutsideTheObservedSpanHaveNoMaskUnlessTheEndsAreHeld() {
        List<Observation> observations = List.of(new Observation(1, 1024, 100, 100, 40, 40),
                new Observation(3, 5120, 200, 100, 40, 40));
        List<FrameMask> open = MediaDevRegionMask.derive(PTS, 1280, 720, observations, 0, false);
        assertThat(open.get(0).rect()).isNull();
        assertThat(open.get(0).source()).isEqualTo(MediaDevRegionMask.NONE);
        assertThat(open.get(4).rect()).isNull();
        List<FrameMask> held = MediaDevRegionMask.derive(PTS, 1280, 720, observations, 0, true);
        assertThat(held.get(0).rect().x()).isEqualTo(100);
        assertThat(held.get(0).source()).isEqualTo(MediaDevRegionMask.HELD);
        assertThat(held.get(4).rect().x()).isEqualTo(200);
    }

    @Test
    void observationsMustBeStrictlyOrderedAndOnTheTimelineOrNothingIsDerived() {
        assertThatThrownBy(() -> MediaDevRegionMask.derive(PTS, 1280, 720, List.of(), 0, false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MediaDevRegionMask.derive(PTS, 1280, 720,
                List.of(new Observation(2, 2048, 1, 1, 5, 5), new Observation(1, 1024, 1, 1, 5, 5)), 0, false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MediaDevRegionMask.derive(PTS, 1280, 720,
                List.of(new Observation(1, 1025, 1, 1, 5, 5)), 0, false)).hasMessageContaining("PTS");
        assertThatThrownBy(() -> MediaDevRegionMask.derive(PTS, 1280, 720,
                List.of(new Observation(9, 0, 1, 1, 5, 5)), 0, false)).hasMessageContaining("outside");
        assertThatThrownBy(() -> new Observation(0, 0, Double.NaN, 1, 5, 5)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void driftIsZeroForUniformMotionAndGrowsWhenTheTrackJumps() {
        List<Observation> straight = List.of(new Observation(0, 0, 0, 0, 20, 20), new Observation(1, 1024, 10, 0, 20, 20),
                new Observation(2, 2048, 20, 0, 20, 20));
        MediaDevRegionMask.Drift steady = MediaDevRegionMask.drift(straight);
        assertThat(steady.maxCenterErrorPx()).isZero();
        assertThat(steady.minIou()).isEqualTo(1.0);
        assertThat(steady.maxGapFrames()).isEqualTo(1);
        List<Observation> jump = List.of(new Observation(0, 0, 0, 0, 20, 20), new Observation(1, 1024, 40, 0, 20, 20),
                new Observation(2, 2048, 20, 0, 20, 20));
        MediaDevRegionMask.Drift jumpy = MediaDevRegionMask.drift(jump);
        assertThat(jumpy.maxCenterErrorPx()).isEqualTo(30.0);
        assertThat(jumpy.heldOutObservations()).isEqualTo(1);
        assertThat(MediaDevRegionMask.drift(List.of(new Observation(0, 0, 0, 0, 5, 5))).heldOutObservations()).isZero();
    }
}
