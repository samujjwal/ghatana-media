package com.ghatana.media.production;

import java.math.BigInteger;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;

/**
 * Effect-free validation boundary for the PDP-1 versioned AnimationSpec.
 *
 * <p>The source contract contains references to versioned scene, animation,
 * operator, asset, curve, time, and rendering values. It does not define the
 * contents of those referenced values or an admitted renderer. Consequently,
 * this compiler validates only the source-defined envelope and returns a typed
 * NOT_ADMITTED result; it never expands references or claims to render.</p>
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

    /** Why source-valid references cannot yet become an executable plan. */
    public enum UnavailableReason { ANIMATION_RUNTIME_NOT_ADMITTED }

    /** A truthful non-executable result without echoing caller-controlled identifiers. */
    public record Unavailable(UnavailableReason reason) {
        public Unavailable {
            Objects.requireNonNull(reason, "reason");
        }
    }

    /** Validates the source-defined value and reports its current admission boundary. */
    public Unavailable compile(AnimationSpec spec) {
        Objects.requireNonNull(spec, "spec");
        return new Unavailable(UnavailableReason.ANIMATION_RUNTIME_NOT_ADMITTED);
    }

    private static void requireVersionRef(String value, String field) {
        Objects.requireNonNull(value, field);
        if (value.isEmpty() || value.length() > 384
                || value.chars().anyMatch(c -> Character.isWhitespace(c) || Character.isSpaceChar(c))) {
            throw new IllegalArgumentException(field + " must match the bounded whitespace-free versionRef shape");
        }
    }

    private static void requireOpaqueId(String value, String field) {
        Objects.requireNonNull(value, field);
        if (value.length() < 1 || value.length() > 128 || !value.matches(OPAQUE_ID)) {
            throw new IllegalArgumentException(field + " must match the bounded opaqueId shape");
        }
    }

    private static void requireSignedInt64(String value, String field) {
        Objects.requireNonNull(value, field);
        if (!value.matches(SIGNED_INT64)) {
            throw new IllegalArgumentException(field + " must be canonical signed-int64 decimal text");
        }
        BigInteger parsed = new BigInteger(value);
        if (parsed.compareTo(MIN_INT64) < 0 || parsed.compareTo(MAX_INT64) > 0) {
            throw new IllegalArgumentException(field + " is outside signed-int64 range");
        }
    }

    private static void requirePositiveInt64(String value, String field) {
        Objects.requireNonNull(value, field);
        if (!value.matches(POSITIVE_INT64) || new BigInteger(value).compareTo(MAX_INT64) > 0) {
            throw new IllegalArgumentException(field + " must be canonical positive-int64 decimal text");
        }
    }
}
