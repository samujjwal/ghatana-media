package com.ghatana.media.launcher;

import com.ghatana.media.production.AnimationSpecCompiler;
import com.ghatana.media.production.animation.AnimationRenderer;
import com.ghatana.media.production.animation.AnimationRenderer.Primitive;
import com.ghatana.media.production.animation.AnimationRenderer.RasterAsset;
import com.ghatana.media.production.animation.AnimationRenderer.Shape;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.CRC32;

/**
 * Deterministic pixel work of the authored-template reference scenes (J-10): integer area-average resampling, the
 * integer recolour, the seeded layout, composition by the verified {@link AnimationRenderer}, and the continuity
 * metrics computed on the DECODED output PNG (never on the renderer's inputs). All arithmetic is integer or exactly
 * reproducible double arithmetic over integers, so identical inputs give identical bytes and identical metrics.
 */
final class MediaDevReferenceSceneImaging {
    static final String PNG_TAG_KEYWORD = "media.reference-scene";
    private static final int FLOOR_PERCENT = 88;
    private static final int SPARKLE_STRIP_PERCENT = 14;

    static {
        System.setProperty("java.awt.headless", "true");
    }

    private MediaDevReferenceSceneImaging() { }

    record Raster(int width, int height, int[] argb) {
        Raster {
            if (width < 1 || height < 1 || argb.length != (long) width * height) {
                throw new IllegalArgumentException("raster pixel count must match its dimensions");
            }
        }
    }

    record Rect(int x, int y, int width, int height) {
        Map<String, Object> view() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("x", x);
            out.put("y", y);
            out.put("width", width);
            out.put("height", height);
            return out;
        }

        boolean overlaps(Rect other) {
            return x < other.x + other.width && other.x < x + width && y < other.y + other.height && other.y < y + height;
        }
    }

    /** SplitMix64: a fixed, specified generator, so a seed means the same layout on every JDK. */
    static final class Rng {
        private long state;

        Rng(long seed) { this.state = seed; }

        long next() {
            long z = (state += 0x9E3779B97F4A7C15L);
            z = (z ^ (z >>> 30)) * 0xBF58476D1CE4E5B9L;
            z = (z ^ (z >>> 27)) * 0x94D049BB133111EBL;
            return z ^ (z >>> 31);
        }

        int bounded(int bound) { return (int) Long.remainderUnsigned(next(), bound); }
    }

    // ------------------------------------------------------------------ resampling and recolour

    /** Area-average (premultiplied) resampling by integer arithmetic; an upscale degenerates to nearest neighbour. */
    static Raster boxScale(Raster source, int targetWidth, int targetHeight) {
        int[] out = new int[targetWidth * targetHeight];
        int sw = source.width();
        int sh = source.height();
        for (int y = 0; y < targetHeight; y++) {
            int y0 = (int) ((long) y * sh / targetHeight);
            int y1 = Math.max(y0 + 1, (int) (((long) (y + 1) * sh + targetHeight - 1) / targetHeight));
            for (int x = 0; x < targetWidth; x++) {
                int x0 = (int) ((long) x * sw / targetWidth);
                int x1 = Math.max(x0 + 1, (int) (((long) (x + 1) * sw + targetWidth - 1) / targetWidth));
                long sumA = 0;
                long sumR = 0;
                long sumG = 0;
                long sumB = 0;
                int n = 0;
                for (int yy = y0; yy < Math.min(y1, sh); yy++) {
                    for (int xx = x0; xx < Math.min(x1, sw); xx++) {
                        int p = source.argb()[yy * sw + xx];
                        int a = p >>> 24;
                        sumA += a;
                        sumR += (long) ((p >> 16) & 0xff) * a;
                        sumG += (long) ((p >> 8) & 0xff) * a;
                        sumB += (long) (p & 0xff) * a;
                        n++;
                    }
                }
                if (n == 0 || sumA == 0) { out[y * targetWidth + x] = 0; continue; }
                int a = (int) ((sumA + n / 2) / n);
                int r = (int) ((sumR + sumA / 2) / sumA);
                int g = (int) ((sumG + sumA / 2) / sumA);
                int b = (int) ((sumB + sumA / 2) / sumA);
                out[y * targetWidth + x] = (a << 24) | (r << 16) | (g << 8) | b;
            }
        }
        return new Raster(targetWidth, targetHeight, out);
    }

    static int luma(int argb) {
        return (299 * ((argb >> 16) & 0xff) + 587 * ((argb >> 8) & 0xff) + 114 * (argb & 0xff)) / 1000;
    }

    /** Colorize: each pixel moves toward {@code tint * luma / 128} (clamped) by {@code permille / 1000}. */
    static Raster tint(Raster source, int tintRgb, int permille) {
        if (permille <= 0) return source;
        int[] out = new int[source.argb().length];
        int tr = (tintRgb >> 16) & 0xff;
        int tg = (tintRgb >> 8) & 0xff;
        int tb = tintRgb & 0xff;
        for (int i = 0; i < out.length; i++) {
            int p = source.argb()[i];
            int a = p >>> 24;
            if (a == 0) { out[i] = p; continue; }
            int l = luma(p);
            int r = mix((p >> 16) & 0xff, Math.min(255, tr * l / 128), permille);
            int g = mix((p >> 8) & 0xff, Math.min(255, tg * l / 128), permille);
            int b = mix(p & 0xff, Math.min(255, tb * l / 128), permille);
            out[i] = (a << 24) | (r << 16) | (g << 8) | b;
        }
        return new Raster(source.width(), source.height(), out);
    }

    private static int mix(int from, int to, int permille) {
        return (from * (1000 - permille) + to * permille + 500) / 1000;
    }

    // ------------------------------------------------------------------ layout

    /** Per-scene placed rectangles ({@code references} are width/height pairs), from the seed alone; a slot that does not fit the canvas is a typed 422. */
    static List<List<Rect>> layout(MediaDevReferenceSceneSpec.Parsed spec, List<int[]> references) {
        int width = spec.width();
        int height = spec.height();
        int floor = height * FLOOR_PERCENT / 100;
        int top = spec.sparkles() > 0 ? height * SPARKLE_STRIP_PERCENT / 100 : 0;
        List<List<Rect>> scenes = new ArrayList<>();
        for (int scene = 0; scene < spec.sceneCount(); scene++) {
            Rng rng = new Rng(spec.seed() ^ ((long) (scene + 1) * 0x9E3779B97F4A7C15L));
            double t = spec.sceneCount() == 1 ? 0 : (double) scene / (spec.sceneCount() - 1);
            double scale = spec.pushStart() + (spec.pushEnd() - spec.pushStart()) * t;
            List<Rect> rects = new ArrayList<>();
            for (int k = 0; k < spec.slots().size(); k++) {
                MediaDevReferenceSceneSpec.Slot slot = spec.slots().get(k);
                int[] reference = references.get(k);
                int dx = spec.drift() == 0 ? 0 : rng.bounded(2 * spec.drift() + 1) - spec.drift();
                int dy = spec.drift() == 0 ? 0 : rng.bounded(2 * spec.drift() + 1) - spec.drift();
                int h = Math.max(8, (int) Math.round(height * slot.height() * scale));
                int w = Math.max(8, (int) Math.round((double) reference[0] * h / reference[1]));
                int cx = (int) Math.round(width * slot.x()) + dx;
                int left = cx - w / 2;
                int baseline = floor + dy;
                Rect rect = new Rect(left, baseline - h, w, h);
                String path = spec.spotlight() ? "$.parameters.subject.height" : "$.parameters.slots[" + k + "].height";
                if (rect.x() < 0 || rect.x() + w > width || rect.y() < top || rect.y() + h > height) {
                    throw MediaDevReferenceSceneSpec.invalid(path, "the placed reference does not fit the canvas in scene "
                            + scene + " (" + w + "x" + h + " at " + rect.x() + "," + rect.y() + ")");
                }
                for (Rect other : rects) {
                    if (other.overlaps(rect)) {
                        throw MediaDevReferenceSceneSpec.invalid(path, "placed references overlap in scene " + scene);
                    }
                }
                rects.add(rect);
            }
            scenes.add(rects);
        }
        return scenes;
    }

    // ------------------------------------------------------------------ composition

    /** One scene composed by the animation renderer: floor band, optional ring, the placed (recoloured) references, sparkles. */
    static byte[] compose(MediaDevReferenceSceneSpec.Parsed spec, int sceneIndex, List<Rect> rects, List<Raster> prepared,
                          String specSha) {
        int width = spec.width();
        int height = spec.height();
        int floor = height * FLOOR_PERCENT / 100;
        int background = 0xFF000000 | spec.palette().getFirst();
        int floorColour = 0xFF000000 | spec.palette().get(1);
        int sparkleColour = 0xFF000000 | spec.palette().getLast();
        List<Shape> shapes = new ArrayList<>();
        List<RasterAsset> assets = new ArrayList<>();
        shapes.add(new Shape("floor", Primitive.RECTANGLE, 0, floor, width, height - floor, 0, floorColour, List.of()));
        if (spec.spotlight()) {
            Rect subject = rects.getFirst();
            double rw = subject.width() * 1.5;
            double rh = subject.height() * 1.5;
            shapes.add(new Shape("ring", Primitive.ELLIPSE, subject.x() + subject.width() / 2.0 - rw / 2,
                    subject.y() + subject.height() / 2.0 - rh / 2, rw, rh, 0, floorColour, List.of()));
        }
        for (int k = 0; k < rects.size(); k++) {
            Rect rect = rects.get(k);
            Raster image = prepared.get(k);
            assets.add(new RasterAsset("ref" + k, image.width(), image.height(), image.argb()));
            shapes.add(new Shape("slot" + k, Primitive.RASTER_ASSET, rect.x(), rect.y(), rect.width(), rect.height(), 0, 0,
                    List.of(), "ref" + k));
        }
        List<AnimationRenderer.ParticleField> particles = new ArrayList<>();
        if (spec.sparkles() > 0) {
            long sparkleSeed = new Rng(spec.seed() ^ ((long) (sceneIndex + 1) * 0xD1B54A32D192ED03L)).next();
            particles.add(new AnimationRenderer.ParticleField("sparkles", sparkleSeed, spec.sparkles(), 0, 0, width,
                    height * SPARKLE_STRIP_PERCENT / 100, 1.5, sparkleColour));
        }
        AnimationRenderer.Scene scene = new AnimationRenderer.Scene(width, height, background, shapes, particles, assets);
        List<String> curves = new ArrayList<>();
        for (Shape shape : shapes) curves.add("curve:" + shape.id() + ":" + specSha);
        AnimationSpecCompiler.AnimationSpec animation = new AnimationSpecCompiler.AnimationSpec(
                "media.declarative.value.animation-spec.v1", "scene:" + specSha + ":" + sceneIndex,
                "animation:" + specSha, "operators:none", "assets:" + assets.size(), curves,
                new AnimationSpecCompiler.StoryTime("story", "dev-reference-scene", "main", "origin:start", "0",
                        new AnimationSpecCompiler.PositiveRational("1", "1000")),
                "rendering:" + width + "x" + height + "@1/1x1");
        AnimationRenderer.RenderedAnimation rendered = new AnimationRenderer().render(animation, scene,
                new AnimationRenderer.Profile(1, 1, 1));
        return rendered.frames().getFirst().png();
    }

    // ------------------------------------------------------------------ decode and digests

    static Raster decode(byte[] png) {
        try {
            BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
            if (image == null) throw new IOException("not a decodable image");
            try {
                int w = image.getWidth();
                int h = image.getHeight();
                return new Raster(w, h, image.getRGB(0, 0, w, h, null, 0, w));
            } finally {
                image.flush();
            }
        } catch (IOException failure) {
            throw new IllegalStateException("a rendered scene could not be decoded", failure);
        }
    }

    static String pixelDigest(Raster raster) {
        ByteBuffer buffer = ByteBuffer.allocate(raster.argb().length * 4);
        for (int value : raster.argb()) buffer.putInt(value);
        return sha256(buffer.array());
    }

    static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    // ------------------------------------------------------------------ PNG request tag

    /**
     * Inserts one {@code tEXt} chunk after IHDR. The artifact store refuses a second artifact with identical bytes in
     * a tenant, so every registered scene carries its request id and index; {@link #untag} removes exactly that chunk,
     * which must give back the canonical renderer bytes (the regeneration proof).
     */
    static byte[] tag(byte[] png, String text) {
        byte[] data = (PNG_TAG_KEYWORD + "\0" + text).getBytes(StandardCharsets.ISO_8859_1);
        ByteArrayOutputStream out = new ByteArrayOutputStream(png.length + data.length + 12);
        out.write(png, 0, 33); // signature (8) + IHDR chunk (4 + 4 + 13 + 4)
        writeChunk(out, "tEXt", data);
        out.write(png, 33, png.length - 33);
        return out.toByteArray();
    }

    static byte[] untag(byte[] png) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(png.length);
        out.write(png, 0, 8);
        int offset = 8;
        byte[] prefix = (PNG_TAG_KEYWORD + "\0").getBytes(StandardCharsets.ISO_8859_1);
        while (offset + 12 <= png.length) {
            int length = ByteBuffer.wrap(png, offset, 4).getInt();
            if (length < 0 || offset + 12L + length > png.length) throw new IllegalStateException("malformed PNG chunk");
            String type = new String(png, offset + 4, 4, StandardCharsets.ISO_8859_1);
            boolean ours = "tEXt".equals(type) && length >= prefix.length
                    && java.util.Arrays.equals(png, offset + 8, offset + 8 + prefix.length, prefix, 0, prefix.length);
            if (!ours) out.write(png, offset, 12 + length);
            offset += 12 + length;
        }
        return out.toByteArray();
    }

    private static void writeChunk(ByteArrayOutputStream out, String type, byte[] data) {
        byte[] typeBytes = type.getBytes(StandardCharsets.ISO_8859_1);
        out.write(ByteBuffer.allocate(4).putInt(data.length).array(), 0, 4);
        out.write(typeBytes, 0, 4);
        out.write(data, 0, data.length);
        CRC32 crc = new CRC32();
        crc.update(typeBytes);
        crc.update(data);
        out.write(ByteBuffer.allocate(4).putInt((int) crc.getValue()).array(), 0, 4);
    }

    // ------------------------------------------------------------------ metrics

    static Raster crop(Raster image, Rect rect) {
        int[] out = new int[rect.width() * rect.height()];
        for (int y = 0; y < rect.height(); y++) {
            System.arraycopy(image.argb(), (rect.y() + y) * image.width() + rect.x(), out, y * rect.width(), rect.width());
        }
        return new Raster(rect.width(), rect.height(), out);
    }

    /** Pixels that are fully opaque in the (untinted, scaled) reference: the only pixels the reference determines. */
    static boolean[] opaqueMask(Raster scaledReference) {
        boolean[] mask = new boolean[scaledReference.argb().length];
        for (int i = 0; i < mask.length; i++) mask[i] = (scaledReference.argb()[i] >>> 24) == 255;
        return mask;
    }

    /** Total-variation distance between 64-bin (2 bits per channel) colour histograms over the masked pixels, in [0, 1]. */
    static double histogramDistance(Raster a, Raster b, boolean[] mask) {
        long[] ha = new long[64];
        long[] hb = new long[64];
        long count = 0;
        for (int i = 0; i < a.argb().length; i++) {
            if (mask != null && !mask[i]) continue;
            ha[bin(a.argb()[i])]++;
            hb[bin(b.argb()[i])]++;
            count++;
        }
        if (count == 0) return 1.0;
        long diff = 0;
        for (int i = 0; i < 64; i++) diff += Math.abs(ha[i] - hb[i]);
        return round6((double) diff / (2.0 * count));
    }

    private static int bin(int argb) {
        return (((argb >> 22) & 3) << 4) | (((argb >> 14) & 3) << 2) | ((argb >> 6) & 3);
    }

    /** Global (single-window) SSIM of the luma over the masked pixels. */
    static double ssim(Raster a, Raster b, boolean[] mask) {
        double c1 = (0.01 * 255) * (0.01 * 255);
        double c2 = (0.03 * 255) * (0.03 * 255);
        long n = 0;
        double sa = 0;
        double sb = 0;
        for (int i = 0; i < mask.length; i++) {
            if (!mask[i]) continue;
            sa += luma(a.argb()[i]);
            sb += luma(b.argb()[i]);
            n++;
        }
        if (n == 0) return -1.0;
        double ma = sa / n;
        double mb = sb / n;
        double va = 0;
        double vb = 0;
        double cov = 0;
        for (int i = 0; i < mask.length; i++) {
            if (!mask[i]) continue;
            double da = luma(a.argb()[i]) - ma;
            double db = luma(b.argb()[i]) - mb;
            va += da * da;
            vb += db * db;
            cov += da * db;
        }
        va /= n;
        vb /= n;
        cov /= n;
        return round6(((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2)));
    }

    /** 64-bit difference hash (9x8 luma grid, left brighter than right) of an image. */
    static long dHash(Raster image) {
        int[] gray = new int[image.argb().length];
        for (int i = 0; i < gray.length; i++) {
            int l = luma(image.argb()[i]);
            gray[i] = 0xFF000000 | (l << 16) | (l << 8) | l;
        }
        Raster small = boxScale(new Raster(image.width(), image.height(), gray), 9, 8);
        long hash = 0;
        for (int y = 0; y < 8; y++) {
            for (int x = 0; x < 8; x++) {
                hash <<= 1;
                if ((small.argb()[y * 9 + x] & 0xff) > (small.argb()[y * 9 + x + 1] & 0xff)) hash |= 1;
            }
        }
        return hash;
    }

    /** The reference where it determines the pixel (opaque), the output pixel elsewhere: only the reference region differs. */
    static Raster merged(Raster expected, Raster actual, boolean[] mask) {
        int[] out = actual.argb().clone();
        for (int i = 0; i < out.length; i++) if (mask[i]) out[i] = expected.argb()[i];
        return new Raster(actual.width(), actual.height(), out);
    }

    static int maxChannelDifference(Raster a, Raster b, boolean[] mask) {
        int max = 0;
        for (int i = 0; i < mask.length; i++) {
            if (!mask[i]) continue;
            int pa = a.argb()[i];
            int pb = b.argb()[i];
            max = Math.max(max, Math.max(Math.abs(((pa >> 16) & 0xff) - ((pb >> 16) & 0xff)),
                    Math.max(Math.abs(((pa >> 8) & 0xff) - ((pb >> 8) & 0xff)), Math.abs((pa & 0xff) - (pb & 0xff)))));
        }
        return max;
    }

    /** Fraction of the pixels outside every placed reference whose RGB is exactly a palette colour. */
    static double paletteAdherence(Raster image, List<Rect> rects, List<Integer> palette) {
        long inside = 0;
        long total = 0;
        boolean[] covered = new boolean[image.argb().length];
        for (Rect rect : rects) {
            for (int y = rect.y(); y < rect.y() + rect.height(); y++) {
                for (int x = rect.x(); x < rect.x() + rect.width(); x++) covered[y * image.width() + x] = true;
            }
        }
        for (int i = 0; i < covered.length; i++) {
            if (covered[i]) continue;
            total++;
            int rgb = image.argb()[i] & 0xFFFFFF;
            if (palette.contains(rgb)) inside++;
        }
        return total == 0 ? 1.0 : round6((double) inside / total);
    }

    static double round6(double value) {
        return Math.round(value * 1_000_000d) / 1_000_000d;
    }

    static String hex64(long value) {
        return String.format("%016x", value);
    }
}
