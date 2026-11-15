package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Pure checks of the J-08 metrics against analytic values and of the typed filter-graph bounds. */
class MediaDevVideoMetricsAndGraphTest {
    private static final int W = 64;
    private static final int H = 48;

    private static byte[] flat(int value) {
        byte[] frame = new byte[W * H];
        java.util.Arrays.fill(frame, (byte) value);
        return frame;
    }

    private static byte[] gaussian(int mean, double sigma, long seed) {
        Random random = new Random(seed);
        byte[] frame = new byte[W * H];
        for (int i = 0; i < frame.length; i++) {
            frame[i] = (byte) Math.max(0, Math.min(255, (int) Math.round(mean + random.nextGaussian() * sigma)));
        }
        return frame;
    }

    @Test
    void psnrMatchesTheAnalyticFormulaAndIdenticalFramesAreCappedNotInfinite() {
        byte[] a = flat(100);
        byte[] b = flat(110);
        double mse = MediaDevVideoQualityMetrics.mse(a, b, a.length);
        assertThat(mse).isEqualTo(100.0);
        assertThat(MediaDevVideoQualityMetrics.psnrFromMse(mse)).isCloseTo(10 * Math.log10(255.0 * 255.0 / 100.0),
                org.assertj.core.data.Offset.offset(1e-9));
        assertThat(MediaDevVideoQualityMetrics.psnrFromMse(0)).isEqualTo(MediaDevVideoQualityMetrics.IDENTICAL_PSNR_DB);
        assertThat(Double.isFinite(MediaDevVideoQualityMetrics.psnrFromMse(0))).isTrue();
    }

    @Test
    void ssimIsOneForIdenticalFramesAndFallsWithDistortion() {
        byte[] clean = gaussian(128, 40, 1);
        assertThat(MediaDevVideoQualityMetrics.ssim(clean, clean, W, H)).isEqualTo(1.0);
        double mild = MediaDevVideoQualityMetrics.ssim(clean, noisy(clean, 4, 2), W, H);
        double heavy = MediaDevVideoQualityMetrics.ssim(clean, noisy(clean, 30, 3), W, H);
        assertThat(mild).isLessThan(1.0).isGreaterThan(heavy);
        assertThat(heavy).isGreaterThan(-1.0).isLessThan(0.9);
    }

    private static byte[] noisy(byte[] source, double sigma, long seed) {
        Random random = new Random(seed);
        byte[] out = source.clone();
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Math.max(0, Math.min(255, (out[i] & 0xFF) + (int) Math.round(random.nextGaussian() * sigma)));
        }
        return out;
    }

    @Test
    void noiseSigmaRecoversTheInjectedSigmaOnAFlatFieldAndIsZeroWithoutNoise() {
        assertThat(MediaDevVideoQualityMetrics.noiseSigma(flat(90), W, H)).isZero();
        for (double sigma : new double[] {3.0, 6.0, 10.0}) {
            double estimate = MediaDevVideoQualityMetrics.noiseSigma(gaussian(128, sigma, 7), W, H);
            assertThat(estimate).as("sigma " + sigma).isBetween(sigma * 0.9, sigma * 1.1);
        }
    }

    @Test
    void laplacianVarianceIsZeroOnAFlatFieldAndGrowsWithNoise() {
        assertThat(MediaDevVideoQualityMetrics.laplacianVariance(flat(10), W, H)).isZero();
        assertThat(MediaDevVideoQualityMetrics.laplacianVariance(gaussian(128, 8, 9), W, H))
                .isGreaterThan(MediaDevVideoQualityMetrics.laplacianVariance(gaussian(128, 2, 9), W, H));
    }

    @Test
    void graphUsesAFixedOrderAndFormattedNumbersOnly() {
        List<MediaDevVideoRuntime.Operation> shuffled = List.of(
                new MediaDevVideoRuntime.ColourCorrection(0.05, 1.1, 1.0, 1.0),
                new MediaDevVideoRuntime.Sharpen(0.3),
                new MediaDevVideoRuntime.Deblock(0.1),
                new MediaDevVideoRuntime.Denoise(MediaDevVideoRuntime.DenoiseMethod.HQDN3D, 4),
                new MediaDevVideoRuntime.Deinterlace());
        MediaDevVideoRuntime.EnhanceRequest request = new MediaDevVideoRuntime.EnhanceRequest("req-1", "a",
                "sha256:" + "0".repeat(64), shuffled, 18);
        assertThat(MediaDevVideoRuntime.filterGraph(request.operations())).isEqualTo(
                "yadif=mode=0:parity=-1:deint=0,hqdn3d=4:3:6:4.5,"
                        + "deblock=filter=strong:block=8:alpha=0.1:beta=0.05:gamma=0.05:delta=0.05,"
                        + "unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=0.3:chroma_msize_x=3:chroma_msize_y=3:chroma_amount=0,"
                        + "eq=brightness=0.05:contrast=1.1:saturation=1:gamma=1");
        assertThat(MediaDevVideoRuntime.filterGraph(request.operations())).doesNotContain(" ", ";", "'", "\"", "\\");
    }

    @Test
    void everyBoundIsEnforcedAtConstruction() {
        assertThatThrownBy(() -> new MediaDevVideoRuntime.Sharpen(1.6)).isInstanceOf(MediaDevVideoRuntime.VideoParameterException.class);
        assertThatThrownBy(() -> new MediaDevVideoRuntime.Sharpen(0.05)).isInstanceOf(MediaDevVideoRuntime.VideoParameterException.class);
        assertThatThrownBy(() -> new MediaDevVideoRuntime.Sharpen(Double.NaN)).isInstanceOf(MediaDevVideoRuntime.VideoParameterException.class);
        assertThatThrownBy(() -> new MediaDevVideoRuntime.Deblock(Double.POSITIVE_INFINITY)).isInstanceOf(MediaDevVideoRuntime.VideoParameterException.class);
        assertThatThrownBy(() -> new MediaDevVideoRuntime.Denoise(MediaDevVideoRuntime.DenoiseMethod.HQDN3D, 12.1))
                .isInstanceOf(MediaDevVideoRuntime.VideoParameterException.class);
        assertThatThrownBy(() -> new MediaDevVideoRuntime.Denoise(MediaDevVideoRuntime.DenoiseMethod.NLMEANS, 10.1))
                .isInstanceOf(MediaDevVideoRuntime.VideoParameterException.class);
        assertThatThrownBy(() -> new MediaDevVideoRuntime.ColourCorrection(0.31, 1, 1, 1)).isInstanceOf(MediaDevVideoRuntime.VideoParameterException.class);
        assertThatThrownBy(() -> new MediaDevVideoRuntime.ColourCorrection(0, 2.1, 1, 1)).isInstanceOf(MediaDevVideoRuntime.VideoParameterException.class);
        assertThatThrownBy(() -> new MediaDevVideoRuntime.ColourCorrection(0, 1, 2.6, 1)).isInstanceOf(MediaDevVideoRuntime.VideoParameterException.class);
        assertThatThrownBy(() -> new MediaDevVideoRuntime.ColourCorrection(0, 1, 1, 0.4)).isInstanceOf(MediaDevVideoRuntime.VideoParameterException.class);
        // Edges are inclusive.
        new MediaDevVideoRuntime.Sharpen(1.5);
        new MediaDevVideoRuntime.Sharpen(0.1);
        new MediaDevVideoRuntime.ColourCorrection(-0.3, 0.5, 0.0, 2.0);
        assertThatThrownBy(() -> new MediaDevVideoRuntime.EnhanceRequest("r", "a", "v", List.of(), 18))
                .isInstanceOf(MediaDevVideoRuntime.VideoParameterException.class);
        assertThatThrownBy(() -> new MediaDevVideoRuntime.EnhanceRequest("r", "a", "v",
                List.of(new MediaDevVideoRuntime.Sharpen(0.5)), 9)).isInstanceOf(MediaDevVideoRuntime.VideoParameterException.class);
        assertThatThrownBy(() -> new MediaDevVideoRuntime.EnhanceRequest("bad id!", "a", "v",
                List.of(new MediaDevVideoRuntime.Sharpen(0.5)), 18)).isInstanceOf(IllegalArgumentException.class);
    }
}
