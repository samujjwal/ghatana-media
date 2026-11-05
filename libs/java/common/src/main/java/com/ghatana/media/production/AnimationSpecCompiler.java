package com.ghatana.media.production;

import java.math.BigInteger;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;

/**
 * Effect-free validation boundary for the PDP-1 versioned AnimationSpec.
 *
 * <p>The PDP-1 contract contains versioned references to scene, animation,
 * operator, asset, curve, and rendering values, plus an exact story-time value.
 * It does not define the referenced easing, transform/dimension, or asset
 * payloads. This class therefore compiles only a deterministic, immutable
 * reference plan. Rendering is performed by a renderer that receives a
 * separately resolved, typed scene graph; a reference plan alone never claims
 * to produce media.</p>
 *
 * @doc.type class
 * @doc.purpose Validate source-defined animation spec shape without execution
 * @doc.layer product
 * @doc.pattern Compiler
 */
public final class AnimationSpecCompiler {

    /** Parser safety ceiling; the PDP-1 contract itself defines no list maximum. */
    public static final int MAX_PROPERTY_CURVE_REFS = 100_000;

    private static final String SCHEMA_VERSION = "media.declarative.value.animation-spec.v1";
    private static final BigInteger MAX_INT64 = BigInteger.valueOf(Long.MAX_VALUE);
    private static final BigInteger MIN_INT64 = BigInteger.valueOf(Long.MIN_VALUE);
    private static final String OPAQUE_ID = "^[A-Za-z0-9][A-Za-z0-9._:-]*$";
    private static final String SIGNED_INT64 = "^(0|-[1-9][0-9]*|[1-9][0-9]*)$";
    private static final String POSITIVE_INT64 = "^[1-9][0-9]*$";

    /** Source-defined rational time base; decimal strings preserve exact values. */
    public record PositiveRational(String numerator, String denominator) {
        public PositiveRational {
            requirePositiveInt64(numerator, "timeBase.numerator");
            requirePositiveInt64(denominator, "timeBase.denominator");
        }
    }

    /** Exact PDP-1 story-time shape; this is not converted to wall-clock time. */
    public record StoryTime(
            String clockKind,
            String clockId,
            String streamId,
            String originRef,
            String ticks,
            PositiveRational timeBase) {
        public StoryTime {
            if (!"story".equals(clockKind)) {
                throw new IllegalArgumentException("tStory.clockKind must be story");
            }
            requireOpaqueId(clockId, "tStory.clockId");
            requireOpaqueId(streamId, "tStory.streamId");
            requireVersionRef(originRef, "tStory.originRef");
            requireSignedInt64(ticks, "tStory.ticks");
            Objects.requireNonNull(timeBase, "tStory.timeBase");
        }
    }

    /** Closed PDP-1 animation-spec value represented by its declared fields. */
    public record AnimationSpec(
            String schemaVersion,
            String sceneGraphRef,
            String animationGraphRef,
            String operatorTreeRef,
            String assetsRef,
            List<String> propertyCurveRefs,
            StoryTime tStoryRef,
            String renderingRef) {
        public AnimationSpec {
            if (!SCHEMA_VERSION.equals(schemaVersion)) {
                throw new IllegalArgumentException("unsupported animation schemaVersion");
            }
            requireVersionRef(sceneGraphRef, "sceneGraphRef");
            requireVersionRef(animationGraphRef, "animationGraphRef");
            requireVersionRef(operatorTreeRef, "operatorTreeRef");
            requireVersionRef(assetsRef, "assetsRef");
            Objects.requireNonNull(propertyCurveRefs, "propertyCurveRefs");
            if (propertyCurveRefs.size() > MAX_PROPERTY_CURVE_REFS) {
                throw new IllegalArgumentException("propertyCurveRefs exceed the local parser safety ceiling");
            }
            if (propertyCurveRefs.stream().anyMatch(ref -> ref == null)) {
                throw new IllegalArgumentException("propertyCurveRefs must not contain null");
            }
            propertyCurveRefs.forEach(ref -> requireVersionRef(ref, "propertyCurveRefs[]"));
            if (new HashSet<>(propertyCurveRefs).size() != propertyCurveRefs.size()) {
                throw new IllegalArgumentException("propertyCurveRefs must be unique");
            }
            propertyCurveRefs = List.copyOf(propertyCurveRefs);
            Objects.requireNonNull(tStoryRef, "tStoryRef");
            requireVersionRef(renderingRef, "renderingRef");
        }
    }

    /** Deterministic role binding of the source-defined refs; not an executable DAG. */
    public record ReferencePlan(
            String schemaVersion,
            String sceneGraphRef,
            String animationGraphRef,
            String operatorTreeRef,
            String assetsRef,
            List<String> propertyCurveRefs,
            StoryTime tStoryRef,
            String renderingRef) {
        public ReferencePlan {
            Objects.requireNonNull(schemaVersion, "schemaVersion");
            Objects.requireNonNull(sceneGraphRef, "sceneGraphRef");
            Objects.requireNonNull(animationGraphRef, "animationGraphRef");
            Objects.requireNonNull(operatorTreeRef, "operatorTreeRef");
            Objects.requireNonNull(assetsRef, "assetsRef");
            propertyCurveRefs = List.copyOf(propertyCurveRefs);
            Objects.requireNonNull(tStoryRef, "tStoryRef");
            Objects.requireNonNull(renderingRef, "renderingRef");
        }
    }

    /** The compile-only API makes no rendering request and has no side effect. */
    public record RenderNotRequested(boolean effectOccurred) {
        public RenderNotRequested {
            if (effectOccurred) {
                throw new IllegalArgumentException("compile-only validation cannot claim a render effect");
            }
        }
    }

    /** Validated deterministic reference compilation; rendering was not requested. */
    public record CompilationResult(ReferencePlan plan, RenderNotRequested rendering) {
        public CompilationResult {
            Objects.requireNonNull(plan, "plan");
            Objects.requireNonNull(rendering, "rendering");
        }
    }

    /** Validates and deterministically compiles only the fields defined by PDP-1. */
    public CompilationResult compile(AnimationSpec spec) {
        Objects.requireNonNull(spec, "spec");
        ReferencePlan plan = new ReferencePlan(spec.schemaVersion(), spec.sceneGraphRef(),
                spec.animationGraphRef(), spec.operatorTreeRef(), spec.assetsRef(),
                spec.propertyCurveRefs(), spec.tStoryRef(), spec.renderingRef());
        return new CompilationResult(plan, new RenderNotRequested(false));
    }

    private static void requireVersionRef(String value, String field) {
        Objects.requireNonNull(value, field);
        // JSON Schema string length is measured in Unicode code points, while
        // String.length() counts UTF-16 code units. Keep the source's maxLength
        // behavior for supplementary characters as well as BMP text.
        int codePointLength = value.codePointCount(0, value.length());
        if (!hasWellFormedUnicode(value) || codePointLength == 0 || codePointLength > 384
                || value.codePoints().anyMatch(AnimationSpecCompiler::isEcmaScriptWhitespace)) {
            throw new IllegalArgumentException(field + " must match the bounded whitespace-free versionRef shape");
        }
    }

    /** ECMAScript WhiteSpace and LineTerminator code points used by {@code \\S}. */
    private static boolean isEcmaScriptWhitespace(int codePoint) {
        return switch (codePoint) {
            case 0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020,
                    0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF -> true;
            default -> codePoint >= 0x2000 && codePoint <= 0x200A;
        };
    }

    private static boolean hasWellFormedUnicode(String value) {
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (Character.isHighSurrogate(current)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    return false;
                }
                index++;
            } else if (Character.isLowSurrogate(current)) {
                return false;
            }
        }
        return true;
    }

    private static void requireOpaqueId(String value, String field) {
        Objects.requireNonNull(value, field);
        if (value.length() < 1 || value.length() > 128 || !value.matches(OPAQUE_ID)) {
            throw new IllegalArgumentException(field + " must match the bounded opaqueId shape");
        }
    }

    private static void requireSignedInt64(String value, String field) {
        Objects.requireNonNull(value, field);
        // Bound parser work before constructing BigInteger. Canonical signed
        // int64 text has at most 19 digits, plus an optional minus sign.
        int digitCount = value.startsWith("-") ? value.length() - 1 : value.length();
        if (digitCount > 19 || !value.matches(SIGNED_INT64)) {
            throw new IllegalArgumentException(field + " must be canonical signed-int64 decimal text");
        }
        BigInteger parsed = new BigInteger(value);
        if (parsed.compareTo(MIN_INT64) < 0 || parsed.compareTo(MAX_INT64) > 0) {
            throw new IllegalArgumentException(field + " is outside signed-int64 range");
        }
    }

    private static void requirePositiveInt64(String value, String field) {
        Objects.requireNonNull(value, field);
        // A positive int64 has at most 19 decimal digits. Reject oversized
        // input before regex matching and arbitrary-precision conversion.
        if (value.length() > 19 || !value.matches(POSITIVE_INT64)
                || new BigInteger(value).compareTo(MAX_INT64) > 0) {
            throw new IllegalArgumentException(field + " must be canonical positive-int64 decimal text");
        }
    }
}
