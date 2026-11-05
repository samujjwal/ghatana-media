package com.ghatana.media.production.animation;

import com.ghatana.media.production.AnimationSpecCompiler.AnimationSpec;
import com.ghatana.media.production.AnimationSpecCompiler.PositiveRational;
import com.ghatana.media.production.AnimationSpecCompiler.StoryTime;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.io.ByteArrayInputStream;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * J-12 local preview slice: keyframe authoring/render output only. The source
 * journey's authenticated commit, candidate comparison, codec export and
 * playback operations remain NOT_ADMITTED and are intentionally not simulated.
 */
class AnimationJ12LocalPreviewSliceTest {
    private static AnimationSpec exactSpec() {
        return new AnimationSpec("media.declarative.value.animation-spec.v1",
                "scene/j12@v3", "animation/j12@v2", "operators/vector@v1", "assets/none@v1",
                List.of("curve/position@v4"),
                new StoryTime("story", "editorial-clock", "preview-stream", "origin@v1", "100",
                        new PositiveRational("1", "24")), "render/png@v1");
    }

    private static AnimationRenderer.Scene authoredScene() {
        return new AnimationRenderer.Scene(40, 24, 0xff101820, List.of(
                new AnimationRenderer.Shape("title-card", AnimationRenderer.Primitive.RECTANGLE,
                        2, 5, 8, 8, 0, 0xfff0c040, List.of(
                                new AnimationRenderer.Keyframe(0, 0, 0, 1, 1, 0, 1,
                                        AnimationRenderer.Easing.EASE_IN_OUT),
                                new AnimationRenderer.Keyframe(2, 20, 0, 1, 1, 0, 1,
                                        AnimationRenderer.Easing.LINEAR)))));
    }

    @Test
    void rendersExactVersionedLocalPreviewRepeatablyWithoutClaimingExportOrCommit() throws Exception {
        var renderer = new AnimationRenderer();
        var profile = new AnimationRenderer.Profile(24, 1, 3);
        var spec = exactSpec();
        var first = renderer.render(spec, authoredScene(), profile);
        var repeated = renderer.render(spec, authoredScene(), profile);

        // The plan retains the exact immutable references. It is not a graph
        // lookup, asset resolution, rights check, export receipt, or commit.
        assertThat(first.plan().sceneGraphRef()).isEqualTo("scene/j12@v3");
        assertThat(first.plan().animationGraphRef()).isEqualTo("animation/j12@v2");
        assertThat(first.plan().propertyCurveRefs()).containsExactly("curve/position@v4");
        assertThat(first.plan().renderingRef()).isEqualTo("render/png@v1");
        assertThat(first.frames()).hasSize(3);
        for (int i = 0; i < first.frames().size(); i++) {
            var frame = first.frames().get(i);
            assertThat(frame.png()).containsExactly(repeated.frames().get(i).png());
            var decoded = ImageIO.read(new ByteArrayInputStream(frame.png()));
            assertThat(decoded).isNotNull();
            assertThat(decoded.getWidth()).isEqualTo(40);
            assertThat(decoded.getHeight()).isEqualTo(24);
            assertThat(decoded.getRGB(0, 0)).isEqualTo(0xff101820);
        }

        // Ease-in-out midpoint remains centered at half progress, and each
        // rendered PNG has exact rational PTS and story-clock provenance.
        assertThat(AnimationRenderer.sample(authoredScene().shapes().getFirst().keyframes(), 1).x())
                .isEqualTo(10.0);
        assertThat(first.frames().get(1).ptsNumerator()).isEqualTo("1");
        assertThat(first.frames().get(1).ptsDenominator()).isEqualTo("24");
        assertThat(first.frames().get(1).storyTicksNumerator()).isEqualTo("101");
        assertThat(first.frames().get(1).storyTicksDenominator()).isEqualTo("1");
    }

    @Test
    void refusesOutOfProfileKeysAndOversizedPreviewBeforeReturningAnOutput() {
        var renderer = new AnimationRenderer();
        var beyondProfile = new AnimationRenderer.Scene(40, 24, 0xff101820, List.of(
                new AnimationRenderer.Shape("late", AnimationRenderer.Primitive.RECTANGLE,
                        0, 0, 1, 1, 0, 0xffffffff, List.of(
                                new AnimationRenderer.Keyframe(3, 0, 0, 1, 1, 0, 1,
                                        AnimationRenderer.Easing.LINEAR)))));
        assertThatThrownBy(() -> renderer.render(exactSpec(), beyondProfile,
                new AnimationRenderer.Profile(24, 1, 3)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("less than profile.frameCount");

        assertThatThrownBy(() -> renderer.render(exactSpec(),
                new AnimationRenderer.Scene(2_048, 2_048, 0xff000000, List.of()),
                new AnimationRenderer.Profile(24, 1, 9)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("pixel budget");
    }
}
