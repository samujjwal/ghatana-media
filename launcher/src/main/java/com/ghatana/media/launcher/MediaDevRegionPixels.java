package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevRegionMask.Rect;

import java.util.Locale;

/**
 * Pixel operations on raw planar {@code yuv420p} frames (Y plane, then U, then V; width and height even). Every
 * operation touches only the samples inside an even-aligned rectangle, so the rest of the frame is the decoder's own
 * bytes, untouched, and a lossless encode of the result keeps it bit-exact.
 *
 * <p>Effects: {@code FILL} (a solid colour, BT.709 limited range), {@code PIXELATE} (the mean of each block aligned to
 * the rectangle's origin, rounded half up) and {@code BLUR} (a separable box blur, two passes, edges replicated inside
 * the rectangle so nothing outside it is ever read). Chroma uses the half-size rectangle and half the block size or
 * radius.</p>
 */
final class MediaDevRegionPixels {
    enum Type { FILL, PIXELATE, BLUR }

    /** A validated effect; unused parameters are zero or null. */
    record Effect(Type type, int blockSize, int radius, int fillY, int fillU, int fillV, String fillColor) {
        static final int MAX_BLOCK = 64;
        static final int MAX_RADIUS = 32;

        static Effect fill(String color) {
            if (color == null || !color.matches("#[0-9A-Fa-f]{6}")) {
                throw new IllegalArgumentException("fill color must be #RRGGBB");
            }
            int r = Integer.parseInt(color.substring(1, 3), 16);
            int g = Integer.parseInt(color.substring(3, 5), 16);
            int b = Integer.parseInt(color.substring(5, 7), 16);
            // BT.709 limited range from full-range sRGB bytes.
            double y = 16 + 219.0 * (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
            double u = 128 + 224.0 * ((b - (0.2126 * r + 0.7152 * g + 0.0722 * b)) / 1.8556) / 255.0;
            double v = 128 + 224.0 * ((r - (0.2126 * r + 0.7152 * g + 0.0722 * b)) / 1.5748) / 255.0;
            return new Effect(Type.FILL, 0, 0, clamp(y), clamp(u), clamp(v), color.toUpperCase(Locale.ROOT));
        }

        static Effect pixelate(int blockSize) {
            if (blockSize < 2 || blockSize > MAX_BLOCK || blockSize % 2 != 0) {
                throw new IllegalArgumentException("blockSize must be an even integer within [2, " + MAX_BLOCK + "]");
            }
            return new Effect(Type.PIXELATE, blockSize, 0, 0, 0, 0, null);
        }

        static Effect blur(int radius) {
            if (radius < 1 || radius > MAX_RADIUS) {
                throw new IllegalArgumentException("radius must be within [1, " + MAX_RADIUS + "]");
            }
            return new Effect(Type.BLUR, 0, radius, 0, 0, 0, null);
        }

        private static int clamp(double value) { return (int) Math.max(1, Math.min(254, Math.round(value))); }
    }

    private MediaDevRegionPixels() { }

    static int frameBytes(int width, int height) { return width * height + 2 * (width / 2) * (height / 2); }

    /** Applies the effect inside {@code rect}, in place. */
    static void apply(byte[] frame, int width, int height, Rect rect, Effect effect) {
        int lumaSize = width * height;
        int chromaWidth = width / 2;
        int chromaHeight = height / 2;
        int chromaSize = chromaWidth * chromaHeight;
        plane(frame, 0, width, rect.x(), rect.y(), rect.width(), rect.height(), effect, effect.fillY(), 1);
        plane(frame, lumaSize, chromaWidth, rect.x() / 2, rect.y() / 2, rect.width() / 2, rect.height() / 2, effect,
                effect.fillU(), 2);
        plane(frame, lumaSize + chromaSize, chromaWidth, rect.x() / 2, rect.y() / 2, rect.width() / 2, rect.height() / 2,
                effect, effect.fillV(), 2);
    }

    private static void plane(byte[] data, int offset, int stride, int x, int y, int w, int h, Effect effect, int fill,
                              int scale) {
        switch (effect.type()) {
            case FILL -> {
                for (int row = 0; row < h; row++) {
                    int base = offset + (y + row) * stride + x;
                    java.util.Arrays.fill(data, base, base + w, (byte) fill);
                }
            }
            case PIXELATE -> pixelate(data, offset, stride, x, y, w, h, Math.max(1, effect.blockSize() / scale));
            case BLUR -> blur(data, offset, stride, x, y, w, h, Math.max(1, effect.radius() / scale));
        }
    }

    private static void pixelate(byte[] data, int offset, int stride, int x, int y, int w, int h, int block) {
        for (int by = 0; by < h; by += block) {
            int bh = Math.min(block, h - by);
            for (int bx = 0; bx < w; bx += block) {
                int bw = Math.min(block, w - bx);
                long sum = 0;
                for (int row = 0; row < bh; row++) {
                    int base = offset + (y + by + row) * stride + x + bx;
                    for (int col = 0; col < bw; col++) sum += data[base + col] & 0xFF;
                }
                int count = bw * bh;
                byte mean = (byte) ((sum + count / 2) / count);
                for (int row = 0; row < bh; row++) {
                    int base = offset + (y + by + row) * stride + x + bx;
                    java.util.Arrays.fill(data, base, base + bw, mean);
                }
            }
        }
    }

    private static void blur(byte[] data, int offset, int stride, int x, int y, int w, int h, int radius) {
        int[] source = new int[w * h];
        for (int row = 0; row < h; row++) {
            int base = offset + (y + row) * stride + x;
            for (int col = 0; col < w; col++) source[row * w + col] = data[base + col] & 0xFF;
        }
        int[] scratch = new int[w * h];
        for (int pass = 0; pass < 2; pass++) {
            horizontal(source, scratch, w, h, radius);
            vertical(scratch, source, w, h, radius);
        }
        for (int row = 0; row < h; row++) {
            int base = offset + (y + row) * stride + x;
            for (int col = 0; col < w; col++) data[base + col] = (byte) source[row * w + col];
        }
    }

    /** Box mean over [i-r, i+r] with the edge sample replicated: a sliding window, O(width) per row. */
    private static void horizontal(int[] in, int[] out, int w, int h, int r) {
        int window = 2 * r + 1;
        for (int row = 0; row < h; row++) {
            int base = row * w;
            long sum = 0;
            for (int k = -r; k <= r; k++) sum += in[base + clampIndex(k, w)];
            for (int col = 0; col < w; col++) {
                out[base + col] = (int) ((sum + window / 2) / window);
                sum += in[base + clampIndex(col + r + 1, w)] - in[base + clampIndex(col - r, w)];
            }
        }
    }

    private static void vertical(int[] in, int[] out, int w, int h, int r) {
        int window = 2 * r + 1;
        for (int col = 0; col < w; col++) {
            long sum = 0;
            for (int k = -r; k <= r; k++) sum += in[clampIndex(k, h) * w + col];
            for (int row = 0; row < h; row++) {
                out[row * w + col] = (int) ((sum + window / 2) / window);
                sum += in[clampIndex(row + r + 1, h) * w + col] - in[clampIndex(row - r, h) * w + col];
            }
        }
    }

    private static int clampIndex(int index, int length) { return Math.max(0, Math.min(length - 1, index)); }

    /**
     * Compares the edited frame with its source frame: outside the mask every sample must match (the report is the
     * maximum absolute difference and the squared-error sum for PSNR); inside it the report is the changed-sample count
     * and the mean absolute luma difference.
     */
    static final class Comparison {
        long outsideSamples;
        long outsideSquaredError;
        int outsideMaxAbsDiff;
        long insideSamples;
        long insideChangedSamples;
        long insideAbsDiffSum;

        /** Mean absolute difference of the inside samples of the last frame compared via {@link #compareFrame}. */
        double compareFrame(byte[] source, byte[] edited, int width, int height, Rect rect) {
            long frameInsideAbs = 0;
            long frameInside = 0;
            int lumaSize = width * height;
            int chromaWidth = width / 2;
            int chromaSize = chromaWidth * (height / 2);
            for (int plane = 0; plane < 3; plane++) {
                int offset = plane == 0 ? 0 : lumaSize + (plane - 1) * chromaSize;
                int pw = plane == 0 ? width : chromaWidth;
                int ph = plane == 0 ? height : height / 2;
                int scale = plane == 0 ? 1 : 2;
                for (int row = 0; row < ph; row++) {
                    for (int col = 0; col < pw; col++) {
                        int i = offset + row * pw + col;
                        int diff = Math.abs((source[i] & 0xFF) - (edited[i] & 0xFF));
                        boolean inside = rect != null && col * scale >= rect.x() && col * scale < rect.right()
                                && row * scale >= rect.y() && row * scale < rect.bottom();
                        if (inside) {
                            insideSamples++;
                            insideAbsDiffSum += diff;
                            if (diff != 0) insideChangedSamples++;
                            if (plane == 0) {
                                frameInside++;
                                frameInsideAbs += diff;
                            }
                        } else {
                            outsideSamples++;
                            outsideSquaredError += (long) diff * diff;
                            if (diff > outsideMaxAbsDiff) outsideMaxAbsDiff = diff;
                        }
                    }
                }
            }
            return frameInside == 0 ? 0 : (double) frameInsideAbs / frameInside;
        }

        /** PSNR in dB over all samples outside the masks; {@code null} when the outside is bit-exact (infinite). */
        Double outsidePsnrDb() {
            if (outsideSquaredError == 0) return null;
            double mse = (double) outsideSquaredError / outsideSamples;
            return Math.round(10 * Math.log10(255.0 * 255.0 / mse) * 100.0) / 100.0;
        }
    }
}
