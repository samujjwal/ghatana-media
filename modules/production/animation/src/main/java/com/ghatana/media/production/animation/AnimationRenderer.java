package com.ghatana.media.production.animation;

import com.ghatana.media.production.AnimationSpecCompiler;

import javax.imageio.ImageIO;
import javax.imageio.IIOImage;
import javax.imageio.ImageTypeSpecifier;
import javax.imageio.ImageWriter;
import javax.imageio.metadata.IIOMetadata;
import javax.imageio.metadata.IIOMetadataNode;
import javax.imageio.stream.ImageOutputStreamImpl;
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
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import org.w3c.dom.Node;

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

    public enum AnimatedFormat { GIF, WEBP, MP4 }
    public enum ExportStatus { ENCODED, UNSUPPORTED_CODEC, UNSUPPORTED_FRAME_RATE, CODEC_UNAVAILABLE, ENCODING_FAILED }
    public enum ExportFailure { CODEC_NOT_SUPPORTED, FRAME_RATE_NOT_EXACTLY_REPRESENTABLE,
        CODEC_PROVIDER_UNAVAILABLE, ENCODING_FAILED }

    /** Exact rational source cadence; encoded GIF is offered only when centisecond delays preserve it exactly. */
    public record FrameTime(int index, String ptsNumerator, String ptsDenominator,
            String storyTicksNumerator, String storyTicksDenominator) {
        public FrameTime {
            if (index < 0) throw new IllegalArgumentException("frame time index must be non-negative");
            Objects.requireNonNull(ptsNumerator, "ptsNumerator");
            Objects.requireNonNull(ptsDenominator, "ptsDenominator");
            Objects.requireNonNull(storyTicksNumerator, "storyTicksNumerator");
            Objects.requireNonNull(storyTicksDenominator, "storyTicksDenominator");
        }
    }

    public record EncodedAnimation(AnimationSpecCompiler.ReferencePlan plan, String format,
            int framesPerSecondNumerator, int framesPerSecondDenominator, int frameDelayCentiseconds,
            int frameCount, List<FrameTime> frameTimes, String sha256, byte[] bytes) {
        public EncodedAnimation {
            Objects.requireNonNull(plan, "plan");
            if (!"gif".equals(format) || framesPerSecondNumerator < 1 || framesPerSecondDenominator < 1
                    || frameDelayCentiseconds < 1 || frameDelayCentiseconds > 65_535 || frameCount < 1) {
                throw new IllegalArgumentException("encoded animation metadata is invalid");
            }
            frameTimes = List.copyOf(Objects.requireNonNull(frameTimes, "frameTimes"));
            if (frameTimes.size() != frameCount) throw new IllegalArgumentException("frame time count must match frame count");
            for (int index = 0; index < frameTimes.size(); index++) {
                if (frameTimes.get(index).index() != index) throw new IllegalArgumentException("frame times must be ordered");
            }
            Objects.requireNonNull(bytes, "bytes");
            bytes = bytes.clone();
            sha256 = Objects.requireNonNull(sha256, "sha256").toLowerCase(java.util.Locale.ROOT);
            if (!sha256.matches("^[a-f0-9]{64}$") || !AnimationRenderer.sha256(bytes).equals(sha256)) {
                throw new IllegalArgumentException("encoded animation SHA-256 does not match its bytes");
            }
        }
        @Override public byte[] bytes() { return bytes.clone(); }
    }

    /** Unsupported codec/rate outcomes have no bytes and never masquerade as completed exports. */
    public record AnimationExport(ExportStatus status, Optional<ExportFailure> failure,
            Optional<EncodedAnimation> encoded) {
        public AnimationExport {
            Objects.requireNonNull(status, "status");
            Objects.requireNonNull(failure, "failure");
            Objects.requireNonNull(encoded, "encoded");
            if (status == ExportStatus.ENCODED && (failure.isPresent() || encoded.isEmpty())) {
                throw new IllegalArgumentException("encoded outcome must contain bytes and no failure");
            }
            if (status != ExportStatus.ENCODED && (failure.isEmpty() || encoded.isPresent())) {
                throw new IllegalArgumentException("failed outcome must name a failure and contain no bytes");
            }
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

    /**
     * Encodes an animated GIF only when its centisecond clock exactly represents the requested FPS.
     * Other formats return a typed unsupported outcome; no fallback codec or silent frame-rate change occurs.
     */
    public AnimationExport renderAnimated(AnimationSpecCompiler.AnimationSpec spec, Scene scene,
            Profile profile, AnimatedFormat format) {
        Objects.requireNonNull(spec, "spec");
        Objects.requireNonNull(scene, "scene");
        Objects.requireNonNull(profile, "profile");
        Objects.requireNonNull(format, "format");
        if (format != AnimatedFormat.GIF) {
            return exportFailure(ExportStatus.UNSUPPORTED_CODEC, ExportFailure.CODEC_NOT_SUPPORTED);
        }
        long centisecondNumerator = 100L * profile.framesPerSecondDenominator();
        if (centisecondNumerator % profile.framesPerSecondNumerator() != 0) {
            return exportFailure(ExportStatus.UNSUPPORTED_FRAME_RATE, ExportFailure.FRAME_RATE_NOT_EXACTLY_REPRESENTABLE);
        }
        long delay = centisecondNumerator / profile.framesPerSecondNumerator();
        if (delay < 1 || delay > 65_535) {
            return exportFailure(ExportStatus.UNSUPPORTED_FRAME_RATE, ExportFailure.FRAME_RATE_NOT_EXACTLY_REPRESENTABLE);
        }
        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("gif");
        if (!writers.hasNext()) {
            return exportFailure(ExportStatus.CODEC_UNAVAILABLE, ExportFailure.CODEC_PROVIDER_UNAVAILABLE);
        }
        RenderedAnimation rendered = render(spec, scene, profile);
        ImageWriter writer = writers.next();
        BoundedImageOutput output = new BoundedImageOutput(MAX_ENCODED_ANIMATION_BYTES);
        try {
            writer.setOutput(output);
            writer.prepareWriteSequence(null);
            for (Frame frame : rendered.frames()) {
                BufferedImage image = ImageIO.read(new java.io.ByteArrayInputStream(frame.png()));
                if (image == null) throw new RenderException("PNG decoder could not read a rendered frame");
                try {
                    ImageTypeSpecifier type = ImageTypeSpecifier.createFromRenderedImage(image);
                    IIOMetadata metadata = writer.getDefaultImageMetadata(type, writer.getDefaultWriteParam());
                    setGifFrameDelay(metadata, Math.toIntExact(delay));
                    writer.writeToSequence(new IIOImage(image, null, metadata), writer.getDefaultWriteParam());
                } finally {
                    image.flush();
                }
            }
            writer.endWriteSequence();
            output.flush();
            byte[] bytes = output.toByteArray();
            String digest = sha256(bytes);
            List<FrameTime> frameTimes = rendered.frames().stream().map(frame -> new FrameTime(frame.index(),
                    frame.ptsNumerator(), frame.ptsDenominator(), frame.storyTicksNumerator(),
                    frame.storyTicksDenominator())).toList();
            EncodedAnimation encoded = new EncodedAnimation(rendered.plan(), "gif", profile.framesPerSecondNumerator(),
                    profile.framesPerSecondDenominator(), Math.toIntExact(delay), profile.frameCount(), frameTimes,
                    digest, bytes);
            return new AnimationExport(ExportStatus.ENCODED, Optional.empty(), Optional.of(encoded));
        } catch (IOException | RuntimeException failure) {
            return exportFailure(ExportStatus.ENCODING_FAILED, ExportFailure.ENCODING_FAILED);
        } finally {
            writer.dispose();
            try { output.close(); } catch (IOException ignored) { /* byte-array stream close has no external effect */ }
        }
    }

    private static AnimationExport exportFailure(ExportStatus status, ExportFailure failure) {
        return new AnimationExport(status, Optional.of(failure), Optional.empty());
    }

    private static void setGifFrameDelay(IIOMetadata metadata, int delayCentiseconds) throws IOException {
        String format = metadata.getNativeMetadataFormatName();
        if (format == null) throw new IOException("GIF writer does not expose native frame metadata");
        Node root = metadata.getAsTree(format);
        IIOMetadataNode control = findNode(root, "GraphicControlExtension");
        if (control == null) throw new IOException("GIF writer lacks frame delay metadata");
        control.setAttribute("disposalMethod", "none");
        control.setAttribute("userInputFlag", "FALSE");
        control.setAttribute("transparentColorFlag", "FALSE");
        control.setAttribute("delayTime", Integer.toString(delayCentiseconds));
        control.setAttribute("transparentColorIndex", "0");
        metadata.setFromTree(format, root);
    }

    private static IIOMetadataNode findNode(Node root, String name) {
        if (name.equals(root.getNodeName()) && root instanceof IIOMetadataNode metadataNode) return metadataNode;
        for (Node child = root.getFirstChild(); child != null; child = child.getNextSibling()) {
            IIOMetadataNode match = findNode(child, name);
            if (match != null) return match;
        }
        return null;
    }

    private static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    /** Seekable bounded ImageOutputStream for ImageIO writers; allocation never exceeds the output ceiling. */
    private static final class BoundedImageOutput extends ImageOutputStreamImpl {
        private final int maximumBytes;
        private byte[] buffer = new byte[8_192];
        private int length;

        private BoundedImageOutput(int maximumBytes) { this.maximumBytes = maximumBytes; }

        @Override public int read() {
            if (streamPos >= length) return -1;
            return buffer[Math.toIntExact(streamPos++)] & 0xff;
        }

        @Override public int read(byte[] bytes, int offset, int count) {
            Objects.checkFromIndexSize(offset, count, bytes.length);
            if (streamPos >= length) return -1;
            int available = Math.min(count, length - Math.toIntExact(streamPos));
            System.arraycopy(buffer, Math.toIntExact(streamPos), bytes, offset, available);
            streamPos += available;
            return available;
        }

        @Override public void write(int value) throws IOException {
            flushBits();
            ensureCapacity(Math.toIntExact(streamPos + 1));
            buffer[Math.toIntExact(streamPos++)] = (byte) value;
            length = Math.max(length, Math.toIntExact(streamPos));
        }

        @Override public void write(byte[] bytes, int offset, int count) throws IOException {
            Objects.checkFromIndexSize(offset, count, bytes.length);
            flushBits();
            long end = streamPos + count;
            if (end > maximumBytes) throw new IOException("encoded animation exceeds byte ceiling");
            ensureCapacity(Math.toIntExact(end));
            System.arraycopy(bytes, offset, buffer, Math.toIntExact(streamPos), count);
            streamPos = end;
            length = Math.max(length, Math.toIntExact(streamPos));
        }

        @Override public void close() throws IOException { super.close(); }

        private void ensureCapacity(int required) throws IOException {
            if (required > maximumBytes) throw new IOException("encoded animation exceeds byte ceiling");
            if (required <= buffer.length) return;
            int capacity = buffer.length;
            while (capacity < required) capacity = (int) Math.min(maximumBytes, Math.max((long) capacity * 2, required));
            buffer = java.util.Arrays.copyOf(buffer, capacity);
        }

        private byte[] toByteArray() { return java.util.Arrays.copyOf(buffer, length); }
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
