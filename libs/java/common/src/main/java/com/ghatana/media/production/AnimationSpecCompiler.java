package com.ghatana.media.production;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeSet;

/**
 * H-05: compile a declarative keyframe/scene/animation spec into a typed,
 * deterministic instruction plan.
 *
 * <p>The spec is a value: scenes each declare typed keyframes with easing,
 * duration and asset refs; the compiler orders them by scene id and
 * emits a stable instruction list. Unsupported rigs, physics or 3D-model
 * bindings are typed {@link UnavailableException} — never a placeholder
 * render claim. Compiled output binds the spec revision, so identical
 * input yields identical instructions.
 *
 * @doc.type class
 * @doc.purpose Declarative animation-spec → instruction-plan compiler
 * @doc.layer product
 * @doc.pattern Compiler
 */
public final class AnimationSpecCompiler {

    /** Bounded plan inputs. */
    public static final int MAX_SCENES = 256;
    public static final int MAX_KEYFRAMES_PER_SCENE = 4_096;

    /** Typed easing functions with real semantics — anything else is unavailable. */
    public enum Easing { LINEAR, EASE_IN, EASE_OUT, EASE_IN_OUT, STEP }

    /** Animated property kinds the compiler can bind to instructions. */
    public enum Property { OPACITY, POSITION_X, POSITION_Y, SCALE, ROTATION }

    /** One typed keyframe — story time in exact milliseconds. */
    public record Keyframe(
            long atMillis,
            Property property,
            double value,
            Easing easing) {
        public Keyframe {
            Objects.requireNonNull(property, "property");
            Objects.requireNonNull(easing, "easing");
            if (atMillis < 0) {
                throw new IllegalArgumentException("keyframe time must be >= 0");
            }
            if (!Double.isFinite(value)) {
                throw new IllegalArgumentException("keyframe value must be finite");
            }
        }
    }

    /** One scene — a named ordered set of keyframes plus asset refs. */
    public record Scene(
            String sceneId,
            long durationMillis,
            List<Keyframe> keyframes,
            List<String> assetRefs) {
        public Scene {
            Objects.requireNonNull(sceneId, "sceneId");
            if (sceneId.isBlank() || sceneId.length() > 128 || !sceneId.equals(sceneId.trim())) {
                throw new IllegalArgumentException("sceneId must be canonical and bounded");
            }
            if (durationMillis < 1 || durationMillis > 3_600_000L) {
                throw new IllegalArgumentException("scene duration must be 1ms..1h");
            }
            keyframes = List.copyOf(Objects.requireNonNull(keyframes, "keyframes"));
            assetRefs = List.copyOf(Objects.requireNonNull(assetRefs, "assetRefs"));
            if (keyframes.size() > MAX_KEYFRAMES_PER_SCENE) {
                throw new IllegalArgumentException("scene keyframes exceed the bound");
            }
            if (keyframes.stream().anyMatch(k -> k.atMillis() > durationMillis)) {
                throw new IllegalArgumentException("keyframe outside scene duration");
            }
        }
    }

    /**
     * The declarative animation spec. {@code rigRefs}/{@code physicsRefs}/
     * {@code model3dRefs} name features the compiler cannot bind — declaring
     * any of them compiles to a typed unavailable result, not a render claim.
     */
    public record AnimationSpec(
            String specRevision,
            List<Scene> scenes,
            List<String> rigRefs,
            List<String> physicsRefs,
            List<String> model3dRefs) {
        public AnimationSpec {
            Objects.requireNonNull(specRevision, "specRevision");
            if (specRevision.isBlank() || specRevision.length() > 384) {
                throw new IllegalArgumentException("specRevision is required and bounded");
            }
            scenes = List.copyOf(Objects.requireNonNull(scenes, "scenes"));
            rigRefs = List.copyOf(rigRefs);
            physicsRefs = List.copyOf(physicsRefs);
            model3dRefs = List.copyOf(model3dRefs);
            if (scenes.isEmpty() || scenes.size() > MAX_SCENES) {
                throw new IllegalArgumentException("scenes must contain 1.." + MAX_SCENES);
            }
            var ids = new TreeSet<String>();
            for (Scene scene : scenes) {
                if (!ids.add(scene.sceneId())) {
                    throw new IllegalArgumentException("duplicate sceneId: " + scene.sceneId());
                }
            }
        }
    }

    /** One compiled instruction — scene-ordered, deterministic. */
    public record Instruction(
            String sceneId,
            long atMillis,
            Property property,
            double value,
            Easing easing,
            List<String> assetRefs) {
    }

    /** The compile result — a plan or a typed unavailable outcome. */
    public sealed interface CompileResult permits CompiledPlan, Unavailable {
    }

    public record CompiledPlan(String specRevision, List<Instruction> instructions)
            implements CompileResult {
        public CompiledPlan {
            instructions = List.copyOf(instructions);
        }
    }

    public record Unavailable(String reason, List<String> offendingRefs) implements CompileResult {
        public Unavailable {
            offendingRefs = List.copyOf(offendingRefs);
        }
    }

    /** Thrown by {@link #compileOrThrow} when the spec cannot bind. */
    public static final class UnavailableException extends RuntimeException {
        private final List<String> offendingRefs;

        UnavailableException(String reason, List<String> offendingRefs) {
            super("animation spec unavailable: " + reason);
            this.offendingRefs = List.copyOf(offendingRefs);
        }

        public List<String> offendingRefs() {
            return offendingRefs;
        }
    }

    /**
     * Compiles the spec. Scenes emit instructions in scene-declaration order;
     * within a scene, keyframes sort by (time, property) for a total,
     * deterministic order. Unsupported bindings return {@link Unavailable}.
     */
    public CompileResult compile(AnimationSpec spec) {
        Objects.requireNonNull(spec, "spec");
        List<String> unsupported = new ArrayList<>();
        if (!spec.rigRefs().isEmpty()) {
            unsupported.addAll(spec.rigRefs());
        }
        if (!spec.physicsRefs().isEmpty()) {
            unsupported.addAll(spec.physicsRefs());
        }
        if (!spec.model3dRefs().isEmpty()) {
            unsupported.addAll(spec.model3dRefs());
        }
        if (!unsupported.isEmpty()) {
            return new Unavailable(
                    "rig, physics or 3D-model bindings have no qualified compiler support",
                    unsupported);
        }
        List<Instruction> instructions = new ArrayList<>();
        for (Scene scene : spec.scenes()) {
            List<Keyframe> ordered = new ArrayList<>(scene.keyframes());
            ordered.sort(Comparator
                    .comparingLong(Keyframe::atMillis)
                    .thenComparing(k -> k.property().name()));
            for (Keyframe keyframe : ordered) {
                instructions.add(new Instruction(
                        scene.sceneId(), keyframe.atMillis(), keyframe.property(),
                        keyframe.value(), keyframe.easing(), scene.assetRefs()));
            }
        }
        return new CompiledPlan(spec.specRevision(), instructions);
    }

    /** Compile or fail with a typed unavailable exception. */
    public CompiledPlan compileOrThrow(AnimationSpec spec) {
        CompileResult result = compile(spec);
        if (result instanceof Unavailable unavailable) {
            throw new UnavailableException(unavailable.reason(), unavailable.offendingRefs());
        }
        return (CompiledPlan) result;
    }
}
