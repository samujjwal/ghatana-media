package com.ghatana.media.production;

import com.ghatana.media.production.AnimationSpecCompiler.AnimationSpec;
import com.ghatana.media.production.AnimationSpecCompiler.PositiveRational;
import com.ghatana.media.production.AnimationSpecCompiler.StoryTime;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** J-13 boundary: reference compilation cannot admit coordinates or a renderer profile. */
class AnimationSpecCompilerJ13BoundaryTest {

    @Test
    void preservesUnqualifiedThreeDimensionalReferencesWithoutRequestingRender() {
        // These opaque refs deliberately describe an unsupported coordinate convention and
        // renderer profile. The compiler does not resolve either referenced value.
        var spec = new AnimationSpec(
                "media.declarative.value.animation-spec.v1",
                "scene/character@v7",
                "animation/rig-path@v3",
                "operators/retarget@v2",
                "assets/character@v5",
                List.of("curve/root-motion@v1"),
                new StoryTime("story", "clock-main", "stream-main", "edit/origin@v1",
                        "120", new PositiveRational("1", "24")),
                "render-profile/unsupported-coordinate-and-rig@v1");

        var result = new AnimationSpecCompiler().compile(spec);

        assertThat(result.plan().sceneGraphRef()).isEqualTo("scene/character@v7");
        assertThat(result.plan().animationGraphRef()).isEqualTo("animation/rig-path@v3");
        assertThat(result.plan().renderingRef())
                .isEqualTo("render-profile/unsupported-coordinate-and-rig@v1");
        assertThat(result.rendering()).isEqualTo(new AnimationSpecCompiler.RenderNotRequested(false));
    }
}
