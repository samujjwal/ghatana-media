package com.ghatana.media.runtime;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.Test;

class MediaProjectTimelineContractsTest {
    @Test
    void rationalTimesNormalizeAndCompareExactlyAtLongDurations() {
        RationalTime ntsc = new RationalTime(30_000L * 60L * 60L * 24L, 30_000, 1_001, Clock.STORY);
        RationalTime sameInstant = new RationalTime(24L * 60L * 60L * 24L, 24, 1, Clock.STORY);

        assertThat(ntsc.rateNumerator()).isEqualTo(30_000);
        assertThat(ntsc.rateDenominator()).isEqualTo(1_001);
        assertThat(ntsc.compareTo(sameInstant)).isPositive();
        RationalTime frame = new RationalTime(1_001, 30_000, 1, Clock.STORY);
        RationalTime accumulated = new RationalTime(0, 1, 1, Clock.STORY);
        for (int i = 0; i < 100_000; i++) accumulated = accumulated.plus(frame);
        assertThat(accumulated.compareTo(new RationalTime(100_100_000L, 30_000, 1, Clock.STORY))).isZero();
        assertThatThrownBy(() -> ntsc.compareTo(new RationalTime(0, 1, 1, Clock.SOURCE_PRESENTATION)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ntsc.plus(new RationalTime(1, 1, 1, Clock.SOURCE_PRESENTATION)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void graphRejectsDetachedOrCrossSceneNodesAndSourceStoryClockMixing() {
        Scene scene = new Scene("scene-1", 0);
        Track track = new Track("track-1", scene.sceneId(), TrackKind.VIDEO, 0);
        Clip clip = clip("clip-1", scene.sceneId(), track.trackId());

        assertThatThrownBy(() -> new Graph("timeline", List.of(scene), List.of(track),
                List.of(new Clip(clip.clipId(), "other-scene", track.trackId(), clip.source(), clip.sourceIn(),
                        clip.sourceOut(), clip.storyStart(), clip.storyDuration()))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("same graph scene");
        assertThatThrownBy(() -> new Clip("bad", "scene-1", "track-1", clip.source(),
                new RationalTime(0, 24, 1, Clock.STORY), clip.sourceOut(), clip.storyStart(), clip.storyDuration()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("clock domains");
    }

    static Clip clip(String id, String sceneId, String trackId) {
        return new Clip(id, sceneId, trackId, new SourceVersion("artifact-1", "version-7"),
                new RationalTime(0, 30_000, 1_001, Clock.SOURCE_PRESENTATION),
                new RationalTime(30_000, 30_000, 1_001, Clock.SOURCE_PRESENTATION),
                new RationalTime(86_400L * 24, 24, 1, Clock.STORY),
                new RationalTime(24, 24, 1, Clock.STORY));
    }
}
