package com.ghatana.media.runtime;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.Test;

class MediaProjectTimelineContractsTest {
    @Test
    void exactTimelineIdentitiesRejectSurroundingWhitespace() {
        assertThatThrownBy(() -> new SourceVersion(" artifact", "version"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("artifactId");
        assertThatThrownBy(() -> new SourceVersion("artifact", "version "))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("artifactVersionId");
        assertThatThrownBy(() -> new Scene(" scene", 0))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("sceneId");
        assertThatThrownBy(() -> new Actor("tenant", " principal"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("principalId");
        assertThatThrownBy(() -> new Graph("timeline ", List.of(), List.of(), List.of()))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("timelineId");
    }

    @Test
    void typedIdentitiesEnforcePdpOpaqueIdAndVersionIdScalars() {
        String maxId = "A" + "a".repeat(127);
        assertThat(new Actor(maxId, "principal:1").tenantId()).isEqualTo(maxId);
        assertThat(new SourceVersion("artifact_1", "version+1").artifactVersionId()).isEqualTo("version+1");

        for (String invalid : List.of("", "_first", "has space", "é", "a".repeat(129))) {
            assertThatThrownBy(() -> new Actor(invalid, "principal"))
                    .as("tenant opaque id %s", invalid)
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> new Graph(invalid, List.of(), List.of(), List.of()))
                    .as("timeline opaque id %s", invalid)
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> new SourceVersion("artifact", "_version"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("artifactVersionId");
        assertThatThrownBy(() -> new SourceVersion("artifact", "v".repeat(129)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("artifactVersionId");
        assertThatThrownBy(() -> new SourceVersion("artifact/1", "version"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("artifactId");
    }

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

    @Test
    void clipStoryEndUsesExactRationalAdditionAndRejectsUnrepresentableOverflow() {
        Scene scene = new Scene("scene", 0);
        Track track = new Track("track", scene.sceneId(), TrackKind.VIDEO, 0);
        Clip fractional = new Clip("fractional", scene.sceneId(), track.trackId(),
                new SourceVersion("artifact", "version"),
                new RationalTime(0, 24, 1, Clock.SOURCE_PRESENTATION),
                new RationalTime(24, 24, 1, Clock.SOURCE_PRESENTATION),
                new RationalTime(1, 3, 1, Clock.STORY),
                new RationalTime(1, 6, 1, Clock.STORY));
        assertThat(fractional.storyEnd()).isEqualTo(new RationalTime(1, 2, 1, Clock.STORY));

        assertThatThrownBy(() -> new Clip("overflow", scene.sceneId(), track.trackId(),
                new SourceVersion("artifact", "version"),
                new RationalTime(0, 24, 1, Clock.SOURCE_PRESENTATION),
                new RationalTime(24, 24, 1, Clock.SOURCE_PRESENTATION),
                new RationalTime(Long.MAX_VALUE, 1, 1, Clock.STORY),
                new RationalTime(1, 1, 1, Clock.STORY)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("story interval end is not representable");
    }

    @Test
    void graphSnapshotsAreImmutableAndCanonicalizedByDeclaredOrder() {
        Scene later = new Scene("a-scene", 1);
        Scene earlier = new Scene("z-scene", 0);
        Track laterTrack = new Track("a-track-later", later.sceneId(), TrackKind.VIDEO, 0);
        Track earlierSecondTrack = new Track("a-track-second", earlier.sceneId(), TrackKind.VIDEO, 1);
        Track earlierFirstTrack = new Track("z-track-first", earlier.sceneId(), TrackKind.AUDIO, 0);
        Clip laterClip = clip("a-clip-later", later.sceneId(), laterTrack.trackId());
        Clip earlierSecondClip = clip("a-clip-second", earlier.sceneId(), earlierSecondTrack.trackId());
        Clip earlierFirstClip = clip("z-clip-first", earlier.sceneId(), earlierFirstTrack.trackId());
        Graph graph = new Graph("timeline", List.of(later, earlier),
                List.of(laterTrack, earlierSecondTrack, earlierFirstTrack),
                List.of(laterClip, earlierSecondClip, earlierFirstClip));

        assertThat(graph.scenes()).extracting(Scene::sceneId).containsExactly("z-scene", "a-scene");
        assertThat(graph.tracks()).extracting(Track::trackId)
                .containsExactly("z-track-first", "a-track-second", "a-track-later");
        assertThat(graph.clips()).extracting(Clip::clipId)
                .containsExactly("z-clip-first", "a-clip-second", "a-clip-later");
        assertThatThrownBy(() -> graph.scenes().add(new Scene("scene-third", 2)))
                .isInstanceOf(UnsupportedOperationException.class);
    }

    static Clip clip(String id, String sceneId, String trackId) {
        return new Clip(id, sceneId, trackId, new SourceVersion("artifact-1", "version-7"),
                new RationalTime(0, 30_000, 1_001, Clock.SOURCE_PRESENTATION),
                new RationalTime(30_000, 30_000, 1_001, Clock.SOURCE_PRESENTATION),
                new RationalTime(86_400L * 24, 24, 1, Clock.STORY),
                new RationalTime(24, 24, 1, Clock.STORY));
    }
}
