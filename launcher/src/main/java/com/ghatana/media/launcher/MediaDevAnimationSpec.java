package com.ghatana.media.launcher;

import com.ghatana.media.production.animation.AnimationRenderer;
import com.ghatana.media.production.animation.AnimationRenderer.Easing;
import com.ghatana.media.production.animation.AnimationRenderer.Keyframe;
import com.ghatana.media.production.animation.AnimationRenderer.ParticleField;
import com.ghatana.media.production.animation.AnimationRenderer.Primitive;
import com.ghatana.media.production.animation.AnimationRenderer.Shape;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Strict parser and budget gate of the DEV_ONLY animation spec ({@code media.dev.animation-spec.v1}). Every refusal
 * carries the JSON path of the offending value ({@code $.shapes[2].keyframes[1].frame}); a structural or value error
 * is {@code ANIMATION_SPEC_INVALID} and a ceiling is {@code ANIMATION_BUDGET_EXCEEDED}. Nothing here reads a source,
 * calls the rights authority or starts a process: both refusals happen before any effect.
 *
 * <p>The spec is a typed, resolved 2D scene: shapes (rectangle, ellipse, line, raster asset) with keyframes whose
 * easing is one of the renderer's four curves, optional seeded particle fields, and optional image assets that are
 * named by exact artifact versions (resolved and rights-checked by the runtime). There is deliberately no text
 * primitive: glyph rasterization depends on host fonts and would break the determinism guarantee.</p>
 */
final class MediaDevAnimationSpec {
    static final String SCHEMA = "media.dev.animation-spec.v1";
    static final int MIN_SIDE = 16;
    static final int MAX_WIDTH = 1_280;
    static final int MAX_HEIGHT = 720;
    static final int MAX_FRAMES = AnimationRenderer.MAX_FRAMES;
    static final int MAX_FPS = 60;
    static final int MAX_SHAPES = 256;
    static final int MAX_ASSETS = 8;
    static final int MAX_PARTICLE_FIELDS = 8;
    static final int MAX_KEYFRAMES_PER_SHAPE = 64;
    static final long MAX_ANIMATION_PIXELS = AnimationRenderer.MAX_ANIMATION_PIXELS;
    static final long MAX_PARTICLE_DRAWS = AnimationRenderer.MAX_PARTICLE_DRAWS;

    /** A named image asset: the exact artifact version that holds its pixels. */
    record AssetRef(String id, String artifactId, String artifactVersionId, String path) { }

    /** Raster-asset shape (needs its decoded asset) or procedural shape, in render order. */
    record Parsed(int width, int height, int backgroundArgb, int fpsNumerator, int fpsDenominator, int frameCount,
                  List<Shape> shapes, List<ParticleField> particleFields, List<AssetRef> assets,
                  Map<String, Object> canonical) { }

    private MediaDevAnimationSpec() { }

    static MediaDevAnimationRuntime.AnimationRefusedException invalid(String path, String message) {
        return new MediaDevAnimationRuntime.AnimationRefusedException(422, "ANIMATION_SPEC_INVALID",
                message, Map.of("path", path));
    }

    /** Renderer constructors name the field ("keyframe.opacity must ..."): append it to the object's path. */
    private static MediaDevAnimationRuntime.AnimationRefusedException refused(String path, IllegalArgumentException cause) {
        String message = cause.getMessage() == null ? "is invalid" : cause.getMessage();
        java.util.regex.Matcher field = java.util.regex.Pattern.compile("^[A-Za-z]+\\.([A-Za-z]+) ").matcher(message);
        return invalid(field.find() ? path + "." + field.group(1) : path, message);
    }

    static MediaDevAnimationRuntime.AnimationRefusedException budget(String path, String limit, long ceiling,
                                                                      long requested) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("path", path);
        details.put("limit", limit);
        details.put("ceiling", ceiling);
        details.put("requested", requested);
        return new MediaDevAnimationRuntime.AnimationRefusedException(422, "ANIMATION_BUDGET_EXCEEDED",
                limit + " exceeds its ceiling; nothing was rendered", details);
    }

    static Parsed parse(Object rawSpec) {
        Map<String, Object> spec = object(rawSpec, "$");
        keys(spec, "$", Set.of("width", "height", "background", "fps", "frameCount", "shapes"),
                Set.of("particleFields", "assets"));
        int width = integer(spec.get("width"), "$.width");
        int height = integer(spec.get("height"), "$.height");
        if (width < MIN_SIDE || height < MIN_SIDE) throw invalid(width < MIN_SIDE ? "$.width" : "$.height",
                "frame sides must be at least " + MIN_SIDE + " pixels");
        if (width % 2 != 0) throw invalid("$.width", "width must be even (yuv420p video)");
        if (height % 2 != 0) throw invalid("$.height", "height must be even (yuv420p video)");
        if (width > MAX_WIDTH) throw budget("$.width", "width", MAX_WIDTH, width);
        if (height > MAX_HEIGHT) throw budget("$.height", "height", MAX_HEIGHT, height);
        int background = color(spec.get("background"), "$.background");
        if ((background >>> 24) != 0xff) throw invalid("$.background", "background must be opaque (#RRGGBB)");
        Map<String, Object> fps = object(spec.get("fps"), "$.fps");
        keys(fps, "$.fps", Set.of("numerator", "denominator"), Set.of());
        int fpsNumerator = integer(fps.get("numerator"), "$.fps.numerator");
        int fpsDenominator = integer(fps.get("denominator"), "$.fps.denominator");
        if (fpsDenominator < 1 || fpsDenominator > 10_000) {
            throw invalid("$.fps.denominator", "denominator must be within [1, 10000]");
        }
        if (fpsNumerator < fpsDenominator) throw invalid("$.fps", "the frame rate must be at least 1 frame per second");
        if ((long) fpsNumerator > (long) MAX_FPS * fpsDenominator) {
            throw budget("$.fps", "frames per second", MAX_FPS, Math.round((double) fpsNumerator / fpsDenominator));
        }
        int frameCount = integer(spec.get("frameCount"), "$.frameCount");
        if (frameCount < 1) throw invalid("$.frameCount", "frameCount must be at least 1");
        if (frameCount > MAX_FRAMES) throw budget("$.frameCount", "frameCount", MAX_FRAMES, frameCount);
        long pixels = (long) width * height * frameCount;
        if (pixels > MAX_ANIMATION_PIXELS) {
            throw budget("$", "total animation pixels (width x height x frameCount)", MAX_ANIMATION_PIXELS, pixels);
        }

        Set<String> ids = new HashSet<>();
        List<AssetRef> assets = new ArrayList<>();
        List<Object> rawAssets = list(spec.getOrDefault("assets", List.of()), "$.assets");
        if (rawAssets.size() > MAX_ASSETS) throw budget("$.assets", "assets", MAX_ASSETS, rawAssets.size());
        for (int i = 0; i < rawAssets.size(); i++) {
            String path = "$.assets[" + i + "]";
            Map<String, Object> asset = object(rawAssets.get(i), path);
            keys(asset, path, Set.of("id", "artifactId", "artifactVersionId"), Set.of());
            String id = id(asset.get("id"), path + ".id");
            if (!ids.add(id)) throw invalid(path + ".id", "object ids must be unique across shapes, particle fields and assets");
            assets.add(new AssetRef(id, string(asset.get("artifactId"), path + ".artifactId"),
                    string(asset.get("artifactVersionId"), path + ".artifactVersionId"), path));
        }

        List<Object> rawShapes = list(spec.get("shapes"), "$.shapes");
        if (rawShapes.size() > MAX_SHAPES) throw budget("$.shapes", "shapes", MAX_SHAPES, rawShapes.size());
        List<Shape> shapes = new ArrayList<>();
        for (int i = 0; i < rawShapes.size(); i++) {
            shapes.add(shape(object(rawShapes.get(i), "$.shapes[" + i + "]"), "$.shapes[" + i + "]", frameCount, ids,
                    assets));
        }

        List<ParticleField> fields = new ArrayList<>();
        List<Object> rawFields = list(spec.getOrDefault("particleFields", List.of()), "$.particleFields");
        if (rawFields.size() > MAX_PARTICLE_FIELDS) {
            throw budget("$.particleFields", "particleFields", MAX_PARTICLE_FIELDS, rawFields.size());
        }
        long particlesPerFrame = 0;
        for (int i = 0; i < rawFields.size(); i++) {
            String path = "$.particleFields[" + i + "]";
            Map<String, Object> field = object(rawFields.get(i), path);
            keys(field, path, Set.of("id", "seed", "count", "x", "y", "width", "height", "radius", "color"), Set.of());
            String id = id(field.get("id"), path + ".id");
            if (!ids.add(id)) throw invalid(path + ".id", "object ids must be unique across shapes, particle fields and assets");
            int count = integer(field.get("count"), path + ".count");
            if (count > AnimationRenderer.MAX_PARTICLES_PER_FIELD) {
                throw budget(path + ".count", "particles per field", AnimationRenderer.MAX_PARTICLES_PER_FIELD, count);
            }
            particlesPerFrame += Math.max(count, 0);
            try {
                fields.add(new ParticleField(id, longValue(field.get("seed"), path + ".seed"), count,
                        number(field.get("x"), path + ".x"), number(field.get("y"), path + ".y"),
                        number(field.get("width"), path + ".width"), number(field.get("height"), path + ".height"),
                        number(field.get("radius"), path + ".radius"), color(field.get("color"), path + ".color")));
            } catch (IllegalArgumentException refused) {
                throw refused(path, refused);
            }
        }
        if (particlesPerFrame * frameCount > MAX_PARTICLE_DRAWS) {
            throw budget("$.particleFields", "particle draws (particles x frames)", MAX_PARTICLE_DRAWS,
                    particlesPerFrame * frameCount);
        }
        return new Parsed(width, height, background, fpsNumerator, fpsDenominator, frameCount, List.copyOf(shapes),
                List.copyOf(fields), List.copyOf(assets), canonical(spec));
    }

    private static Shape shape(Map<String, Object> shape, String path, int frameCount, Set<String> ids,
                               List<AssetRef> assets) {
        keys(shape, path, Set.of("id", "primitive", "x", "y", "width", "height"),
                Set.of("strokeWidth", "color", "assetId", "keyframes"));
        String id = id(shape.get("id"), path + ".id");
        if (!ids.add(id)) throw invalid(path + ".id", "object ids must be unique across shapes, particle fields and assets");
        Primitive primitive;
        try {
            primitive = Primitive.valueOf(string(shape.get("primitive"), path + ".primitive"));
        } catch (IllegalArgumentException unknown) {
            throw invalid(path + ".primitive", "primitive must be RECTANGLE, ELLIPSE, LINE or RASTER_ASSET");
        }
        String assetId = null;
        if (primitive == Primitive.RASTER_ASSET) {
            assetId = id(shape.get("assetId"), path + ".assetId");
            String wanted = assetId;
            if (assets.stream().noneMatch(asset -> asset.id().equals(wanted))) {
                throw invalid(path + ".assetId", "assetId does not name a declared asset");
            }
        } else if (shape.containsKey("assetId")) {
            throw invalid(path + ".assetId", "assetId is only valid for RASTER_ASSET");
        }
        List<Object> rawKeys = list(shape.getOrDefault("keyframes", List.of()), path + ".keyframes");
        if (rawKeys.size() > MAX_KEYFRAMES_PER_SHAPE) {
            throw budget(path + ".keyframes", "keyframes per shape", MAX_KEYFRAMES_PER_SHAPE, rawKeys.size());
        }
        List<Keyframe> keyframes = new ArrayList<>();
        int previous = -1;
        for (int i = 0; i < rawKeys.size(); i++) {
            String keyPath = path + ".keyframes[" + i + "]";
            Map<String, Object> key = object(rawKeys.get(i), keyPath);
            keys(key, keyPath, Set.of("frame"), Set.of("x", "y", "scaleX", "scaleY", "rotationDegrees", "opacity", "easing"));
            int frame = integer(key.get("frame"), keyPath + ".frame");
            if (frame < 0 || frame >= frameCount) {
                throw invalid(keyPath + ".frame", "frame must be within [0, frameCount - 1]");
            }
            if (frame <= previous) throw invalid(keyPath + ".frame", "keyframes must have strictly increasing frames");
            previous = frame;
            Easing easing;
            try {
                easing = Easing.valueOf(key.containsKey("easing") ? string(key.get("easing"), keyPath + ".easing") : "LINEAR");
            } catch (IllegalArgumentException unknown) {
                throw invalid(keyPath + ".easing", "easing must be LINEAR, EASE_IN, EASE_OUT or EASE_IN_OUT");
            }
            try {
                keyframes.add(new Keyframe(frame, optional(key, "x", 0, keyPath), optional(key, "y", 0, keyPath),
                        optional(key, "scaleX", 1, keyPath), optional(key, "scaleY", 1, keyPath),
                        optional(key, "rotationDegrees", 0, keyPath), optional(key, "opacity", 1, keyPath), easing));
            } catch (IllegalArgumentException refused) {
                throw refused(keyPath, refused);
            }
        }
        int argb = shape.containsKey("color") ? color(shape.get("color"), path + ".color") : 0xffffffff;
        try {
            return new Shape(id, primitive, number(shape.get("x"), path + ".x"), number(shape.get("y"), path + ".y"),
                    number(shape.get("width"), path + ".width"), number(shape.get("height"), path + ".height"),
                    optional(shape, "strokeWidth", primitive == Primitive.LINE ? 1 : 0, path), argb, keyframes, assetId);
        } catch (IllegalArgumentException refused) {
            throw refused(path, refused);
        }
    }

    // ---- strict JSON value helpers: each names its JSON path in the refusal ----

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value, String path) {
        if (!(value instanceof Map<?, ?> map)) throw invalid(path, "must be an object");
        return (Map<String, Object>) map;
    }

    private static List<Object> list(Object value, String path) {
        if (!(value instanceof List<?> list)) throw invalid(path, "must be an array");
        return new ArrayList<>(list);
    }

    private static void keys(Map<String, Object> value, String path, Set<String> required, Set<String> optional) {
        for (String key : required) {
            if (!value.containsKey(key)) throw invalid(path + "." + key, "is required");
        }
        for (String key : value.keySet()) {
            if (!required.contains(key) && !optional.contains(key)) throw invalid(path + "." + key, "is not a known field");
        }
    }

    private static String string(Object value, String path) {
        if (!(value instanceof String text)) throw invalid(path, "must be a string");
        return text;
    }

    private static String id(Object value, String path) {
        String text = string(value, path);
        if (!text.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) throw invalid(path, "must be a 1-128 character opaque id");
        return text;
    }

    private static int integer(Object value, String path) {
        if (!(value instanceof Integer || value instanceof Long || value instanceof Short)) {
            throw invalid(path, "must be an integer");
        }
        long v = ((Number) value).longValue();
        if (v < Integer.MIN_VALUE || v > Integer.MAX_VALUE) throw invalid(path, "is out of the 32-bit integer range");
        return (int) v;
    }

    private static long longValue(Object value, String path) {
        if (!(value instanceof Integer || value instanceof Long || value instanceof Short)) {
            throw invalid(path, "must be an integer");
        }
        return ((Number) value).longValue();
    }

    private static double number(Object value, String path) {
        if (!(value instanceof Number number) || value instanceof Boolean) throw invalid(path, "must be a number");
        double v = number.doubleValue();
        if (!Double.isFinite(v)) throw invalid(path, "must be finite");
        return v;
    }

    private static double optional(Map<String, Object> map, String key, double fallback, String path) {
        return map.containsKey(key) ? number(map.get(key), path + "." + key) : fallback;
    }

    /** {@code #RRGGBB} (opaque) or {@code #RRGGBBAA}. */
    private static int color(Object value, String path) {
        String text = string(value, path);
        if (!text.matches("#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?")) throw invalid(path, "must be #RRGGBB or #RRGGBBAA");
        int rgb = (int) Long.parseLong(text.substring(1, 7), 16);
        int alpha = text.length() == 9 ? Integer.parseInt(text.substring(7, 9), 16) : 0xff;
        return (alpha << 24) | rgb;
    }

    /** Deep copy with every object's keys sorted: the stable form that is fingerprinted and echoed into the manifest. */
    @SuppressWarnings("unchecked")
    static Map<String, Object> canonical(Map<String, Object> value) {
        return (Map<String, Object>) canonicalValue(value);
    }

    private static Object canonicalValue(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> sorted = new TreeMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) sorted.put(String.valueOf(entry.getKey()), canonicalValue(entry.getValue()));
            return sorted;
        }
        if (value instanceof List<?> list) {
            List<Object> copy = new ArrayList<>(list.size());
            for (Object item : list) copy.add(canonicalValue(item));
            return copy;
        }
        return value;
    }
}
