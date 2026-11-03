package com.ghatana.media.production;

import com.ghatana.media.production.AnimationSpecCompiler.AnimationSpec;
import com.ghatana.media.production.AnimationSpecCompiler.PositiveRational;
import com.ghatana.media.production.AnimationSpecCompiler.StoryTime;
import com.ghatana.media.production.AnimationSpecCompiler.Unavailable;
import com.ghatana.media.production.AnimationSpecCompiler.UnavailableReason;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** H-05: PDP-1 envelope validation and truthful non-admission without rendering. */
class AnimationSpecCompilerTest {

    private static AnimationSpec validSpec() {
        return new AnimationSpec(
                "media.declarative.value.animation-spec.v1",
                "scene/main@v3",
                "animation/main@v4",
                "operators/vector@v1",
                "assets/project@v2",
                List.of("curve/opacity@v1", "curve/position@v2"),
                new StoryTime("story", "clock-main", "stream-main", "origin/edit@v1",
                        "-9223372036854775808", new PositiveRational("1", "24000")),
                "render-profile/vector@v2");
    }

    @Test
    void acceptsSourceDefinedEnvelopeButReturnsTypedNotAdmittedWithoutPlanOrFrames() {
        var compiler = new AnimationSpecCompiler();
        Unavailable result = compiler.compile(validSpec());

        assertThat(result.reason()).isEqualTo(UnavailableReason.ANIMATION_RUNTIME_NOT_ADMITTED);
        assertThat(result.getClass().getRecordComponents()).extracting(component -> component.getName())
                .containsExactly("reason");
        assertThat(compiler.compile(validSpec())).isEqualTo(result);
    }

    @Test
    void acceptsEmptyCurveListAndExactPositiveTimeBaseBoundary() {
        var spec = new AnimationSpec(
                "media.declarative.value.animation-spec.v1",
                "scene/main@v3", "animation/main@v4", "operators/vector@v1",
                "assets/project@v2", List.of(),
                new StoryTime("story", "clock", "stream", "origin@v1", "0",
                        new PositiveRational("9223372036854775807", "1")),
                "render-profile/vector@v2");

        assertThat(new AnimationSpecCompiler().compile(spec).reason())
                .isEqualTo(UnavailableReason.ANIMATION_RUNTIME_NOT_ADMITTED);
    }

    @Test
    void rejectsWrongSchemaVersionAndDuplicateCurveReferences() {
        var valid = validSpec();
        assertThatThrownBy(() -> new AnimationSpec(
                "media.declarative.value.animation-spec.v2", valid.sceneGraphRef(),
                valid.animationGraphRef(), valid.operatorTreeRef(), valid.assetsRef(),
                valid.propertyCurveRefs(), valid.tStory(), valid.renderingRef()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("schemaVersion");

        assertThatThrownBy(() -> new AnimationSpec(
                valid.schemaVersion(), valid.sceneGraphRef(), valid.animationGraphRef(),
                valid.operatorTreeRef(), valid.assetsRef(), List.of("curve/a@v1", "curve/a@v1"),
                valid.tStory(), valid.renderingRef()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unique");
    }

    @Test
    void capsCurveReferenceCollectionBeforeCopyOrUniquenessIndexing() {
        var valid = validSpec();
        assertThatThrownBy(() -> new AnimationSpec(
                valid.schemaVersion(), valid.sceneGraphRef(), valid.animationGraphRef(),
                valid.operatorTreeRef(), valid.assetsRef(),
                java.util.Collections.nCopies(AnimationSpecCompiler.MAX_PROPERTY_CURVE_REFS + 1, "curve/repeated@v1"),
                valid.tStory(), valid.renderingRef()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("local parser safety ceiling");
    }

    @Test
    void rejectsUnsupportedClockAndNoncanonicalOrOutOfRangeTimeValues() {
        assertThatThrownBy(() -> new StoryTime("media", "clock", "stream", "origin@v1",
                "0", new PositiveRational("1", "1")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("clockKind");
        assertThatThrownBy(() -> new StoryTime("story", "clock", "stream", "origin@v1",
                "01", new PositiveRational("1", "1")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("canonical signed-int64");
        assertThatThrownBy(() -> new StoryTime("story", "clock", "stream", "origin@v1",
                "9223372036854775808", new PositiveRational("1", "1")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("outside signed-int64");
        assertThatThrownBy(() -> new PositiveRational("1", "0"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("positive-int64");
    }

    @Test
    void rejectsInvalidReferencesAndNullCurveEntries() {
        var valid = validSpec();
        assertThatThrownBy(() -> new AnimationSpec(
                valid.schemaVersion(), "   ", valid.animationGraphRef(), valid.operatorTreeRef(),
                valid.assetsRef(), valid.propertyCurveRefs(), valid.tStory(), valid.renderingRef()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sceneGraphRef");
        assertThatThrownBy(() -> new AnimationSpec(
                valid.schemaVersion(), valid.sceneGraphRef(), valid.animationGraphRef(),
                valid.operatorTreeRef(), valid.assetsRef(), valid.propertyCurveRefs(), valid.tStory(),
                "render profile/v1"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("renderingRef");
        assertThatThrownBy(() -> new StoryTime("story", "clock", "stream", " origin@v1",
                "0", new PositiveRational("1", "1")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("originRef");
        assertThatThrownBy(() -> new AnimationSpec(
                valid.schemaVersion(), valid.sceneGraphRef(), valid.animationGraphRef(),
                valid.operatorTreeRef(), valid.assetsRef(), java.util.Arrays.asList("curve/a@v1", null),
                valid.tStory(), valid.renderingRef()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("must not contain null");
        assertThatThrownBy(() -> new StoryTime("story", "bad id", "stream", "origin@v1",
                "0", new PositiveRational("1", "1")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("opaqueId");
    }
}
