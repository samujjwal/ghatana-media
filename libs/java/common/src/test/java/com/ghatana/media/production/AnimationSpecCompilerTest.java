package com.ghatana.media.production;

import com.ghatana.media.production.AnimationSpecCompiler.AnimationSpec;
import com.ghatana.media.production.AnimationSpecCompiler.CompiledPlan;
import com.ghatana.media.production.AnimationSpecCompiler.Easing;
import com.ghatana.media.production.AnimationSpecCompiler.Keyframe;
import com.ghatana.media.production.AnimationSpecCompiler.Property;
import com.ghatana.media.production.AnimationSpecCompiler.Scene;
import com.ghatana.media.production.AnimationSpecCompiler.Unavailable;
import com.ghatana.media.production.AnimationSpecCompiler.UnavailableException;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** H-05: deterministic scene/keyframe compile; unsupported bindings typed unavailable. */
class AnimationSpecCompilerTest {

    private static AnimationSpec simpleSpec() {
        return new AnimationSpec("anim-rev-2", List.of(
                new Scene("intro", 2_000, List.of(
                        new Keyframe(1_000, Property.OPACITY, 1.0, Easing.LINEAR),
                        new Keyframe(0, Property.OPACITY, 0.0, Easing.EASE_IN)),
                        List.of("asset/logo@v1")),
                new Scene("main", 5_000, List.of(
                        new Keyframe(500, Property.POSITION_X, 42.5, Easing.EASE_OUT)),
                        List.of())),
                List.of(), List.of(), List.of());
    }

    @Test
    void compilesDeterministicOrderedInstructions() {
        AnimationSpecCompiler compiler = new AnimationSpecCompiler();
        CompiledPlan plan = compiler.compileOrThrow(simpleSpec());
        assertThat(plan.specRevision()).isEqualTo("anim-rev-2");
        // Keyframes within a scene order by (time, property); scene order preserved.
        assertThat(plan.instructions()).extracting(i -> i.sceneId() + "@" + i.atMillis())
                .containsExactly("intro@0", "intro@1000", "main@500");
        assertThat(compiler.compileOrThrow(simpleSpec()).instructions())
                .isEqualTo(plan.instructions());
    }

    @Test
    void rigPhysicsOrModel3dBindingsAreTypedUnavailable() {
        AnimationSpecCompiler compiler = new AnimationSpecCompiler();
        var unsupported = new AnimationSpec("rev", List.of(
                new Scene("s", 100, List.of(), List.of())),
                List.of("rig/skeleton@v1"), List.of("physics/cloth@v2"), List.of());
        assertThat(compiler.compile(unsupported))
                .isInstanceOf(Unavailable.class)
                .satisfies(result -> assertThat(((Unavailable) result).offendingRefs())
                        .containsExactly("rig/skeleton@v1", "physics/cloth@v2"));
        assertThatThrownBy(() -> compiler.compileOrThrow(unsupported))
                .isInstanceOf(UnavailableException.class);
    }

    @Test
    void boundedCanonicalSpecsOnly() {
        assertThatThrownBy(() -> new Scene("s", 100,
                List.of(new Keyframe(200, Property.SCALE, 1.0, Easing.STEP)), List.of()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Keyframe(0, Property.ROTATION, Double.NaN, Easing.LINEAR))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AnimationSpec("rev", List.of(
                new Scene("dup", 100, List.of(), List.of()),
                new Scene("dup", 100, List.of(), List.of())),
                List.of(), List.of(), List.of()))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
