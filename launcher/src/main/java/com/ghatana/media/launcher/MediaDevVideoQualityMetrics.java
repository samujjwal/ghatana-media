package com.ghatana.media.launcher;

/**
 * Pure per-frame luma quality measurements over 8-bit grey rasters (the Y plane of a decoded frame). The
 * implementations are independent of FFmpeg's {@code psnr}/{@code ssim} filters so a comparison is not graded by the
 * code that produced the enhancement; the tests cross-check them against those filters.
 *
 * <ul>
 *   <li>PSNR: {@code 10*log10(255^2 / MSE)}; identical frames have no finite PSNR and are reported as
 *       {@link #IDENTICAL_PSNR_DB} with the caller counting them as identical.</li>
 *   <li>SSIM: Wang et al. mean structural similarity over 8x8 uniform windows on a 4-pixel stride with
 *       {@code C1=(0.01*255)^2, C2=(0.03*255)^2} (the same window geometry FFmpeg's ssim filter uses).</li>
 *   <li>Noise sigma: Immerkaer's fast estimate, {@code sqrt(pi/2) * sum|I*N| / (6 (W-2)(H-2))} with the
 *       2D difference-of-Laplacians mask; it responds to edges and texture too, so it is an upper-bound-style
 *       estimate, never a measurement of injected noise on a textured image.</li>
 *   <li>Blur: variance of the 3x3 Laplacian (higher means sharper, but noise also raises it).</li>
 * </ul>
 */
final class MediaDevVideoQualityMetrics {
    /** Stand-in for an infinite PSNR so JSON stays finite. */
    static final double IDENTICAL_PSNR_DB = 100.0;
    private static final double C1 = (0.01 * 255) * (0.01 * 255);
    private static final double C2 = (0.03 * 255) * (0.03 * 255);
    private static final int WINDOW = 8;
    private static final int STRIDE = 4;

    private MediaDevVideoQualityMetrics() { }

    static double mse(byte[] a, byte[] b, int length) {
        long sum = 0;
        for (int i = 0; i < length; i++) {
            int d = (a[i] & 0xFF) - (b[i] & 0xFF);
            sum += (long) d * d;
        }
        return sum / (double) length;
    }

    static double psnrFromMse(double mse) {
        if (mse <= 0) return IDENTICAL_PSNR_DB;
        return Math.min(IDENTICAL_PSNR_DB, 10.0 * Math.log10(255.0 * 255.0 / mse));
    }

    static double ssim(byte[] a, byte[] b, int width, int height) {
        if (width < WINDOW || height < WINDOW) throw new IllegalArgumentException("frame is smaller than the SSIM window");
        double total = 0;
        long windows = 0;
        for (int y = 0; y + WINDOW <= height; y += STRIDE) {
            for (int x = 0; x + WINDOW <= width; x += STRIDE) {
                long sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
                for (int j = 0; j < WINDOW; j++) {
                    int row = (y + j) * width + x;
                    for (int i = 0; i < WINDOW; i++) {
                        int va = a[row + i] & 0xFF;
                        int vb = b[row + i] & 0xFF;
                        sa += va;
                        sb += vb;
                        saa += (long) va * va;
                        sbb += (long) vb * vb;
                        sab += (long) va * vb;
                    }
                }
                double n = WINDOW * WINDOW;
                double ma = sa / n;
                double mb = sb / n;
                double va = saa / n - ma * ma;
                double vb = sbb / n - mb * mb;
                double cov = sab / n - ma * mb;
                total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
                windows++;
            }
        }
        return total / windows;
    }

    static double noiseSigma(byte[] y, int width, int height) {
        if (width < 3 || height < 3) throw new IllegalArgumentException("frame is too small for a noise estimate");
        double sum = 0;
        for (int row = 1; row < height - 1; row++) {
            for (int col = 1; col < width - 1; col++) {
                int i = row * width + col;
                int value = 4 * (y[i] & 0xFF)
                        - 2 * ((y[i - 1] & 0xFF) + (y[i + 1] & 0xFF) + (y[i - width] & 0xFF) + (y[i + width] & 0xFF))
                        + (y[i - width - 1] & 0xFF) + (y[i - width + 1] & 0xFF)
                        + (y[i + width - 1] & 0xFF) + (y[i + width + 1] & 0xFF);
                sum += Math.abs(value);
            }
        }
        return sum * Math.sqrt(Math.PI / 2.0) / (6.0 * (width - 2) * (height - 2));
    }

    static double laplacianVariance(byte[] y, int width, int height) {
        if (width < 3 || height < 3) throw new IllegalArgumentException("frame is too small for a Laplacian");
        double sum = 0;
        double sumSquares = 0;
        long count = 0;
        for (int row = 1; row < height - 1; row++) {
            for (int col = 1; col < width - 1; col++) {
                int i = row * width + col;
                int value = (y[i - 1] & 0xFF) + (y[i + 1] & 0xFF) + (y[i - width] & 0xFF) + (y[i + width] & 0xFF)
                        - 4 * (y[i] & 0xFF);
                sum += value;
                sumSquares += (double) value * value;
                count++;
            }
        }
        double mean = sum / count;
        return sumSquares / count - mean * mean;
    }
}
