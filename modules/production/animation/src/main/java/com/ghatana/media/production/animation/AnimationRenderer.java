package com.ghatana.media.production.animation;

import com.ghatana.media.production.AnimationSpecCompiler;

import javax.imageio.ImageIO;
import java.awt.AlphaComposite;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.geom.AffineTransform;
import java.awt.geom.Ellipse2D;
import java.awt.geom.Line2D;
import java.awt.geom.Rectangle2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;

/** Deterministic, bounded raster renderer for a resolved 2D animation scene. */
public final class AnimationRenderer {
    public static final int MAX_WIDTH = 2_048;
    public static final int MAX_HEIGHT = 2_048;
    public static final long MAX_FRAME_PIXELS = 4_194_304L;
    public static final long MAX_ANIMATION_PIXELS = 33_554_432L;
    public static final int MAX_FRAMES = 240;
    public static final int MAX_SHAPES = 4_096;
    public static final int MAX_PARTICLE_FIELDS = 64;
    public static final int MAX_PARTICLES_PER_FIELD = 10_000;
    public static final long MAX_PARTICLE_DRAWS = 1_000_000L;
    public static final int MAX_KEYFRAMES_PER_SHAPE = 240;
    public static final int MAX_ENCODED_ANIMATION_BYTES = 64 * 1024 * 1024;
    public static final int MAX_ENCODED_FRAME_BYTES = 16 * 1024 * 1024;
    private static final double MAX_COORDINATE = 8_192.0;
    private static final double MAX_SCALE = 64.0;
    private static final double MAX_ROTATION_DEGREES = 36_000.0;

    public enum Primitive { RECTANGLE, ELLIPSE, LINE }
    public enum Easing { LINEAR, EASE_IN, EASE_OUT, EASE_IN_OUT }

    /** Coordinates and stroke widths are pixels; colors use unpremultiplied ARGB. */
    public record Shape(String id, Primitive primitive, double x, double y,
            double width, double height, double strokeWidth, int argb,
            List<Keyframe> keyframes) {
        public Shape {
            requireId(id, "shape.id");
            Objects.requireNonNull(primitive, "primitive");
            requireCoordinate(x, "shape.x");
            requireCoordinate(y, "shape.y");
            requireDimension(width, "shape.width");
            requireDimension(height, "shape.height");
            requireDimension(strokeWidth, "shape.strokeWidth");
            if (primitive == Primitive.LINE && strokeWidth <= 0.0) {
                throw new IllegalArgumentException("line strokeWidth must be positive");
            }
            Objects.requireNonNull(keyframes, "shape.keyframes");
            if (keyframes.size() > MAX_KEYFRAMES_PER_SHAPE) {
                throw new IllegalArgumentException("shape.keyframes exceed the renderer ceiling");
            }
            keyframes = List.copyOf(keyframes);
        }
    }

    /** A frame-index key with pixel translation, scale, rotation and opacity. */
    public record Keyframe(int frame, double x, double y, double scaleX, double scaleY,
            double rotationDegrees, double opacity, Easing easingToNext) {
        public Keyframe {
            if (frame < 0 || frame >= MAX_FRAMES) {
                throw new IllegalArgumentException("keyframe.frame is outside the renderer ceiling");
            }
            requireCoordinate(x, "keyframe.x");
            requireCoordinate(y, "keyframe.y");
            if (!Double.isFinite(scaleX) || scaleX < 0.0 || scaleX > MAX_SCALE
                    || !Double.isFinite(scaleY) || scaleY < 0.0 || scaleY > MAX_SCALE) {
                throw new IllegalArgumentException("keyframe scale must be finite and within [0, 64]");
            }
            if (!Double.isFinite(rotationDegrees) || Math.abs(rotationDegrees) > MAX_ROTATION_DEGREES) {
                throw new IllegalArgumentException("keyframe.rotationDegrees is outside the bounded range");
            }
            if (!Double.isFinite(opacity) || opacity < 0.0 || opacity > 1.0) {
                throw new IllegalArgumentException("keyframe.opacity must be within [0, 1]");
            }
            Objects.requireNonNull(easingToNext, "keyframe.easingToNext");
        }
    }

    /** Typed render inputs separate resolved graph payload from opaque PDP references. */
    public record ParticleField(String id, long seed, int count, double x, double y,
            double width, double height, double radius, int argb) {
        public ParticleField {
            requireId(id, "particleField.id");
            if (count < 1 || count > MAX_PARTICLES_PER_FIELD) {
                throw new IllegalArgumentException("particleField.count must be within [1, 10000]");
            }
            requireCoordinate(x, "particleField.x");
            requireCoordinate(y, "particleField.y");
            requireDimension(width, "particleField.width");
            requireDimension(height, "particleField.height");
            if (!Double.isFinite(radius) || radius <= 0.0 || radius > 128.0) {
                throw new IllegalArgumentException("particleField.radius must be finite and within (0, 128]");
            }
        }
    }

    public record Scene(int width, int height, int backgroundArgb, List<Shape> shapes,
            List<ParticleField> particleFields) {
        public Scene(int width, int height, int backgroundArgb, List<Shape> shapes) {
            this(width, height, backgroundArgb, shapes, List.of());
        }

        public Scene {
            if (width < 1 || width > MAX_WIDTH || height < 1 || height > MAX_HEIGHT) {
                throw new IllegalArgumentException("scene dimensions must be within [1, 2048]");
            }
            long pixels = (long) width * height;
            if (pixels > MAX_FRAME_PIXELS) {
                throw new IllegalArgumentException("scene frame pixel count exceeds the renderer ceiling");
            }
            Objects.requireNonNull(shapes, "scene.shapes");
            if (shapes.size() > MAX_SHAPES) {
                throw new IllegalArgumentException("scene.shapes exceed the renderer ceiling");
            }
            shapes = List.copyOf(shapes);
            Objects.requireNonNull(particleFields, "scene.particleFields");
            if (particleFields.size() > MAX_PARTICLE_FIELDS) {
                throw new IllegalArgumentException("scene.particleFields exceed the renderer ceiling");
            }
            particleFields = List.copyOf(particleFields);
            HashSet<String> ids = new HashSet<>();
            for (Shape shape : shapes) {
                Objects.requireNonNull(shape, "scene.shapes[]");
                if (!ids.add(shape.id())) {
                    throw new IllegalArgumentException("scene shape ids must be unique");
                }
                int previousFrame = -1;
                for (Keyframe keyframe : shape.keyframes()) {
                    if (keyframe.frame() <= previousFrame) {
                        throw new IllegalArgumentException("shape keyframes must have strictly increasing frame indexes");
                    }
                    previousFrame = keyframe.frame();
                }
            }
            for (ParticleField field : particleFields) {
                Objects.requireNonNull(field, "scene.particleFields[]");
                if (!ids.add(field.id())) {
                    throw new IllegalArgumentException("scene object ids must be unique");
                }
            }
        }
    }

    /** Frame rate is frames per second; frame timestamps are kept as exact rationals. */
    public record Profile(int framesPerSecondNumerator, int framesPerSecondDenominator, int frameCount) {
        public Profile {
            if (framesPerSecondNumerator < 1 || framesPerSecondNumerator > 240_000
                    || framesPerSecondDenominator < 1 || framesPerSecondDenominator > 10_000) {
                throw new IllegalArgumentException("frame rate must be a positive bounded rational");
            }
            if (frameCount < 1 || frameCount > MAX_FRAMES) {
                throw new IllegalArgumentException("frameCount must be within [1, 240]");
            }
        }
    }

    /** Exact output frame PTS in seconds and story time in the input story-clock ticks. */
    public record Frame(int index, String ptsNumerator, String ptsDenominator,
            String storyTicksNumerator, String storyTicksDenominator, byte[] png) {
        public Frame {
            Objects.requireNonNull(ptsNumerator, "ptsNumerator");
            Objects.requireNonNull(ptsDenominator, "ptsDenominator");
            Objects.requireNonNull(storyTicksNumerator, "storyTicksNumerator");
            Objects.requireNonNull(storyTicksDenominator, "storyTicksDenominator");
            png = Objects.requireNonNull(png, "png").clone();
        }

        @Override
        public byte[] png() {
            return png.clone();
        }
    }

    public record RenderedAnimation(AnimationSpecCompiler.ReferencePlan plan, List<Frame> frames) {
        public RenderedAnimation {
            Objects.requireNonNull(plan, "plan");
            frames = List.copyOf(frames);
        }
    }

    /** Validate the envelope, resolve a caller-provided typed 2D graph, and render real PNG frames. */
    public RenderedAnimation render(AnimationSpecCompiler.AnimationSpec spec, Scene scene, Profile profile) {
        Objects.requireNonNull(scene, "scene");
        Objects.requireNonNull(profile, "profile");
        AnimationSpecCompiler.ReferencePlan plan = new AnimationSpecCompiler().compile(spec).plan();
        long pixels = (long) scene.width() * scene.height() * profile.frameCount();
        if (pixels > MAX_ANIMATION_PIXELS) {
            throw new IllegalArgumentException("animation raster pixel budget exceeded");
        }
        long particlesPerFrame = scene.particleFields().stream().mapToLong(ParticleField::count).sum();
        if (particlesPerFrame * profile.frameCount() > MAX_PARTICLE_DRAWS) {
            throw new IllegalArgumentException("animation procedural draw budget exceeded");
        }
        validateKeyframeRange(scene, profile.frameCount());

        ArrayList<Frame> frames = new ArrayList<>(profile.frameCount());
        long encodedBytes = 0;
        for (int index = 0; index < profile.frameCount(); index++) {
            byte[] png = renderPng(scene, index);
            if (png.length > MAX_ENCODED_FRAME_BYTES) {
                throw new RenderException("encoded animation frame exceeds byte ceiling");
            }
            encodedBytes += png.length;
            if (encodedBytes > MAX_ENCODED_ANIMATION_BYTES) {
                throw new RenderException("encoded animation exceeds byte ceiling");
            }
            frames.add(frame(index, profile, spec.tStoryRef(), png));
        }
        return new RenderedAnimation(plan, frames);
    }

    /** Public curve sampler used for deterministic golden-curve checks. */
    public static Transform sample(List<Keyframe> keys, int frameIndex) {
        Objects.requireNonNull(keys, "keys");
        if (frameIndex < 0 || frameIndex >= MAX_FRAMES) {
            throw new IllegalArgumentException("frameIndex is outside the renderer ceiling");
        }
        if (keys.size() > MAX_KEYFRAMES_PER_SHAPE) {
            throw new IllegalArgumentException("keys exceed the renderer ceiling");
        }
        int previousFrame = -1;
        for (Keyframe key : keys) {
            Objects.requireNonNull(key, "keys[]");
            if (key.frame() <= previousFrame) {
                throw new IllegalArgumentException("keys must have strictly increasing frame indexes");
            }
            previousFrame = key.frame();
        }
        if (keys.isEmpty()) {
            return Transform.IDENTITY;
        }
        Keyframe left = keys.get(0);
        if (frameIndex <= left.frame()) {
            return transform(left);
        }
        for (int i = 1; i < keys.size(); i++) {
            Keyframe right = keys.get(i);
            if (frameIndex <= right.frame()) {
                double t = (double) (frameIndex - left.frame()) / (right.frame() - left.frame());
                t = ease(left.easingToNext(), t);
                return interpolate(left, right, t);
            }
            left = right;
        }
        return transform(left);
    }

    public record Transform(double x, double y, double scaleX, double scaleY,
            double rotationDegrees, double opacity) {
        private static final Transform IDENTITY = new Transform(0, 0, 1, 1, 0, 1);
    }

    private static byte[] renderPng(Scene scene, int index) {
        BufferedImage image = new BufferedImage(scene.width(), scene.height(), BufferedImage.TYPE_INT_ARGB);
        Graphics2D graphics = image.createGraphics();
        try {
            graphics.setComposite(AlphaComposite.Src);
            graphics.setColor(new Color(scene.backgroundArgb(), true));
            graphics.fillRect(0, 0, scene.width(), scene.height());
            graphics.setComposite(AlphaComposite.SrcOver);
            graphics.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_OFF);
            graphics.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
            graphics.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            for (Shape shape : scene.shapes()) {
                Transform transform = sample(shape.keyframes(), index);
                drawShape(graphics, shape, transform);
            }
            for (ParticleField field : scene.particleFields()) {
                drawParticles(graphics, field);
            }
            ByteArrayOutputStream output = new ByteArrayOutputStream(Math.min(scene.width() * scene.height() / 2, 1_048_576));
            if (!ImageIO.write(image, "png", output)) {
                throw new RenderException("JDK PNG encoder is unavailable");
            }
            return output.toByteArray();
        } catch (IOException exception) {
            throw new RenderException("PNG frame encoding failed", exception);
        } finally {
            graphics.dispose();
            image.flush();
        }
    }

    private static void drawShape(Graphics2D graphics, Shape shape, Transform value) {
        if (value.opacity() == 0.0 || value.scaleX() == 0.0 || value.scaleY() == 0.0) {
            return;
        }
        int sourceAlpha = (shape.argb() >>> 24) & 0xff;
        int alpha = (int) Math.round(sourceAlpha * value.opacity());
        if (alpha == 0) {
            return;
        }
        Color color = new Color((shape.argb() & 0x00ffffff) | (alpha << 24), true);
        double centerX = shape.x() + shape.width() / 2.0;
        double centerY = shape.y() + shape.height() / 2.0;
        AffineTransform old = graphics.getTransform();
        java.awt.Composite oldComposite = graphics.getComposite();
        try {
            graphics.translate(centerX + value.x(), centerY + value.y());
            graphics.rotate(Math.toRadians(value.rotationDegrees()));
            graphics.scale(value.scaleX(), value.scaleY());
            graphics.translate(-centerX, -centerY);
            graphics.setComposite(AlphaComposite.SrcOver);
            graphics.setColor(color);
            java.awt.Shape geometry = switch (shape.primitive()) {
                case RECTANGLE -> new Rectangle2D.Double(shape.x(), shape.y(), shape.width(), shape.height());
                case ELLIPSE -> new Ellipse2D.Double(shape.x(), shape.y(), shape.width(), shape.height());
                case LINE -> new Line2D.Double(shape.x(), shape.y(), shape.x() + shape.width(), shape.y() + shape.height());
            };
            if (shape.primitive() == Primitive.LINE) {
                graphics.setStroke(new java.awt.BasicStroke((float) shape.strokeWidth(), java.awt.BasicStroke.CAP_BUTT,
                        java.awt.BasicStroke.JOIN_MITER));
                graphics.draw(geometry);
            } else {
                graphics.fill(geometry);
            }
        } finally {
            graphics.setTransform(old);
            graphics.setComposite(oldComposite);
        }
    }

    private static void drawParticles(Graphics2D graphics, ParticleField field) {
        graphics.setColor(new Color(field.argb(), true));
        for (int index = 0; index < field.count(); index++) {
            long particleSeed = mix64(field.seed() + 0x9e3779b97f4a7c15L * index);
            double x = field.x() + unitDouble(particleSeed) * field.width();
            double y = field.y() + unitDouble(mix64(particleSeed)) * field.height();
            graphics.fill(new Ellipse2D.Double(x, y, field.radius(), field.radius()));
        }
    }

    private static long mix64(long value) {
        value = (value ^ (value >>> 30)) * 0xbf58476d1ce4e5b9L;
        value = (value ^ (value >>> 27)) * 0x94d049bb133111ebL;
        return value ^ (value >>> 31);
    }

    private static double unitDouble(long value) {
        return (value >>> 11) * 0x1.0p-53;
    }

    private static Frame frame(int index, Profile profile, AnimationSpecCompiler.StoryTime storyTime, byte[] png) {
        BigInteger ptsNumerator = BigInteger.valueOf(index)
                .multiply(BigInteger.valueOf(profile.framesPerSecondDenominator()));
        BigInteger ptsDenominator = BigInteger.valueOf(profile.framesPerSecondNumerator());
        BigInteger ptsGcd = ptsNumerator.gcd(ptsDenominator);
        if (ptsGcd.signum() != 0) {
            ptsNumerator = ptsNumerator.divide(ptsGcd);
            ptsDenominator = ptsDenominator.divide(ptsGcd);
        }

        BigInteger fpsNum = BigInteger.valueOf(profile.framesPerSecondNumerator());
        BigInteger fpsDen = BigInteger.valueOf(profile.framesPerSecondDenominator());
        BigInteger timeBaseNum = new BigInteger(storyTime.timeBase().numerator());
        BigInteger timeBaseDen = new BigInteger(storyTime.timeBase().denominator());
        BigInteger startTicks = new BigInteger(storyTime.ticks());
        BigInteger storyDenominator = fpsNum.multiply(timeBaseNum);
        BigInteger storyNumerator = startTicks.multiply(storyDenominator)
                .add(BigInteger.valueOf(index).multiply(fpsDen).multiply(timeBaseDen));
        BigInteger minStoryNumerator = BigInteger.valueOf(Long.MIN_VALUE).multiply(storyDenominator);
        BigInteger maxStoryNumerator = BigInteger.valueOf(Long.MAX_VALUE).multiply(storyDenominator);
        if (storyNumerator.compareTo(minStoryNumerator) < 0 || storyNumerator.compareTo(maxStoryNumerator) > 0) {
            throw new IllegalArgumentException("rendered story tick is outside signed-int64 range");
        }
        BigInteger storyGcd = storyNumerator.gcd(storyDenominator);
        if (storyGcd.signum() != 0) {
            storyNumerator = storyNumerator.divide(storyGcd);
            storyDenominator = storyDenominator.divide(storyGcd);
        }
        return new Frame(index, ptsNumerator.toString(), ptsDenominator.toString(),
                storyNumerator.toString(), storyDenominator.toString(), png);
    }

    private static void validateKeyframeRange(Scene scene, int frameCount) {
        for (Shape shape : scene.shapes()) {
            for (Keyframe keyframe : shape.keyframes()) {
                if (keyframe.frame() >= frameCount) {
                    throw new IllegalArgumentException("keyframe.frame must be less than profile.frameCount");
                }
            }
        }
    }

    private static Transform interpolate(Keyframe from, Keyframe to, double amount) {
        return new Transform(lerp(from.x(), to.x(), amount), lerp(from.y(), to.y(), amount),
                lerp(from.scaleX(), to.scaleX(), amount), lerp(from.scaleY(), to.scaleY(), amount),
                lerp(from.rotationDegrees(), to.rotationDegrees(), amount),
                lerp(from.opacity(), to.opacity(), amount));
    }

    private static Transform transform(Keyframe keyframe) {
        return new Transform(keyframe.x(), keyframe.y(), keyframe.scaleX(), keyframe.scaleY(),
                keyframe.rotationDegrees(), keyframe.opacity());
    }

    private static double ease(Easing easing, double t) {
        return switch (easing) {
            case LINEAR -> t;
            case EASE_IN -> t * t;
            case EASE_OUT -> 1.0 - (1.0 - t) * (1.0 - t);
            case EASE_IN_OUT -> t < 0.5 ? 2.0 * t * t : 1.0 - Math.pow(-2.0 * t + 2.0, 2.0) / 2.0;
        };
    }

    private static double lerp(double left, double right, double amount) {
        return left + (right - left) * amount;
    }

    private static void requireId(String value, String field) {
        Objects.requireNonNull(value, field);
        if (value.isEmpty() || value.length() > 128 || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]*")) {
            throw new IllegalArgumentException(field + " must be a bounded opaque id");
        }
    }

    private static void requireCoordinate(double value, String field) {
        if (!Double.isFinite(value) || Math.abs(value) > MAX_COORDINATE) {
            throw new IllegalArgumentException(field + " must be finite and within [-8192, 8192] pixels");
        }
    }

    private static void requireDimension(double value, String field) {
        if (!Double.isFinite(value) || value < 0.0 || value > MAX_COORDINATE) {
            throw new IllegalArgumentException(field + " must be finite and within [0, 8192] pixels");
        }
    }

    public static final class RenderException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public RenderException(String message) { super(message); }
        public RenderException(String message, Throwable cause) { super(message, cause); }
    }
}
