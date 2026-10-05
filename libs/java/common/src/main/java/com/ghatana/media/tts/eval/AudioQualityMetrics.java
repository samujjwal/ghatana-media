package com.ghatana.media.tts.eval;

import java.util.Arrays;

/**
 * Audio quality metrics for TTS evaluation.
 *
 * <p>Provides objective measures of synthesised-speech quality against a reference
 * signal. Two metrics are implemented:
 * <ul>
 *   <li><b>SNR</b> (Signal-to-Noise Ratio) – broad energy-based quality proxy.</li>
 *   <li><b>STOI</b> (Short-Time Objective Intelligibility) – frame-level correlation
 *       method aligned with Taal et al. 2010, normalised to [0, 1].</li>
 * </ul>
 *
 * <p>All methods operate on 32-bit PCM float samples normalised to [-1, 1].
 *
 * @doc.type class
 * @doc.purpose Objective audio quality metrics (SNR, STOI) for TTS evaluation
 * @doc.layer platform
 * @doc.pattern Utility
 */
public final class AudioQualityMetrics {

    // STOI constants (Taal 2010 – Table I)
    private static final int STOI_FRAME_LEN   = 256;   // 32 ms @ 8 kHz
    private static final int STOI_FRAME_SHIFT = 128;   // 16 ms hop (50 % overlap)
    private static final int STOI_N_FRAMES    = 30;    // ~480 ms context window

    private AudioQualityMetrics() {}

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Compute Signal-to-Noise Ratio in dB.
     *
     * @param reference clean reference signal
     * @param degraded  reconstructed / synthesised signal (same length)
     * @return SNR in decibels ({@code Double.POSITIVE_INFINITY} for a perfect copy)
     */
    public static double computeSnr(float[] reference, float[] degraded) {
        if (reference.length != degraded.length) {
            throw new IllegalArgumentException(
                    "Arrays must be the same length (ref=%d, deg=%d)"
                            .formatted(reference.length, degraded.length));
        }
        double signalEnergy = 0.0;
        double noiseEnergy  = 0.0;
        for (int i = 0; i < reference.length; i++) {
            signalEnergy += (double) reference[i] * reference[i];
            double err = reference[i] - degraded[i];
            noiseEnergy += err * err;
        }
        if (noiseEnergy == 0.0) return Double.POSITIVE_INFINITY;
        if (signalEnergy == 0.0) return Double.NEGATIVE_INFINITY;
        return 10.0 * Math.log10(signalEnergy / noiseEnergy);
    }

    /**
     * Estimate Short-Time Objective Intelligibility (STOI).
     *
     * <p>The implementation follows the core of the Taal et al. algorithm:
     * <ol>
     *   <li>High-pass pre-emphasis at 50 Hz.</li>
     *   <li>Framing with 50 % Hann overlap.</li>
     *   <li>Normalised cross-correlation within a ±N_FRAMES context window.</li>
     * </ol>
     * The result is a value in [0, 1] where 1 indicates perfect intelligibility.
     *
     * @param reference  clean reference signal
     * @param degraded   synthesised / processed signal (may differ in length)
     * @param sampleRate sample rate in Hz (used only to scale context window)
     * @return STOI score in [0, 1]
     */
    public static double computeStoi(float[] reference, float[] degraded, int sampleRate) {
        // Scale frame constants to actual sample rate (defaults tuned for 8 kHz)
        int scale   = Math.max(1, sampleRate / 8000);
        int framLen = STOI_FRAME_LEN * scale;
        int framShi = STOI_FRAME_SHIFT * scale;

        float[] ref   = preEmphasis(reference);
        float[] deg   = preEmphasis(padOrTruncate(degraded, reference.length));
        float[] hann  = hann(framLen);

        int nFrames = (ref.length - framLen) / framShi + 1;
        if (nFrames <= 0) return 0.0;

        double[] corrValues = new double[nFrames];
        for (int f = 0; f < nFrames; f++) {
            int start = f * framShi;
            double[] refFrame = applyWindow(ref, start, framLen, hann);
            double[] degFrame = applyWindow(deg, start, framLen, hann);
            corrValues[f] = normCorr(refFrame, degFrame);
        }

        // Average over a sliding context of N_FRAMES (or the whole sequence)
        int ctx  = Math.min(STOI_N_FRAMES, nFrames);
        double sum = 0.0;
        int count  = 0;
        for (int f = ctx - 1; f < nFrames; f++) {
            double windowMean = 0.0;
            for (int k = f - ctx + 1; k <= f; k++) windowMean += corrValues[k];
            sum += windowMean / ctx;
            count++;
        }
        double raw = count > 0 ? sum / count : 0.0;
        return Math.max(0.0, Math.min(1.0, (raw + 1.0) / 2.0)); // [-1,1] → [0,1]
    }

    /**
     * Compute both SNR and STOI in a single call.
     *
     * @param reference  clean reference
     * @param degraded   processed / synthesised signal
     * @param sampleRate sample rate in Hz
     * @return {@link AudioQualityResult} containing both metrics
     */
    public static AudioQualityResult computeAll(float[] reference, float[] degraded, int sampleRate) {
        return new AudioQualityResult(
                computeSnr(reference, degraded),
                computeStoi(reference, degraded, sampleRate));
    }

    // -------------------------------------------------------------------------
    // Result record
    // -------------------------------------------------------------------------

    /**
     * Holds SNR and STOI scores for a synthesised-speech segment.
     *
     * @param snrDb SNR in decibels
     * @param stoi  Short-Time Objective Intelligibility in [0, 1]
     */
    public record AudioQualityResult(double snrDb, double stoi) {
        /** Returns {@code true} if the STOI score meets the minimum intelligible threshold (0.65). */
        public boolean isIntelligible() { return stoi >= 0.65; }
        /** Returns {@code true} if the SNR exceeds a comfortable listening threshold (20 dB). */
        public boolean isClean() { return snrDb >= 20.0; }
    }

    // -------------------------------------------------------------------------
    // Private DSP helpers
    // -------------------------------------------------------------------------

    /** First-order high-pass pre-emphasis filter (α = 0.97). */
    private static float[] preEmphasis(float[] in) {
        float[] out = new float[in.length];
        out[0] = in[0];
        for (int i = 1; i < in.length; i++) {
            out[i] = in[i] - 0.97f * in[i - 1];
        }
        return out;
    }

    /** Pad with zeros or truncate {@code src} to exactly {@code len} samples. */
    private static float[] padOrTruncate(float[] src, int len) {
        if (src.length == len) return src;
        return Arrays.copyOf(src, len); // copyOf zero-pads if len > src.length
    }

    /** Build a normalised Hann window of length {@code n}. */
    private static float[] hann(int n) {
        float[] w = new float[n];
        for (int i = 0; i < n; i++) {
            w[i] = (float) (0.5 * (1.0 - Math.cos(2.0 * Math.PI * i / (n - 1))));
        }
        return w;
    }

    /** Extract a windowed frame from {@code signal} as a double[]. */
    private static double[] applyWindow(float[] signal, int start, int len, float[] window) {
        double[] frame = new double[len];
        for (int i = 0; i < len; i++) {
            frame[i] = signal[start + i] * window[i];
        }
        return frame;
    }

    /** Normalised cross-correlation of two (zero-mean) vectors. */
    private static double normCorr(double[] a, double[] b) {
        double sumA = 0, sumB = 0;
        for (int i = 0; i < a.length; i++) { sumA += a[i]; sumB += b[i]; }
        double meanA = sumA / a.length, meanB = sumB / b.length;

        double dot = 0, normA = 0, normB = 0;
        for (int i = 0; i < a.length; i++) {
            double da = a[i] - meanA, db = b[i] - meanB;
            dot   += da * db;
            normA += da * da;
            normB += db * db;
        }
        double denom = Math.sqrt(normA * normB);
        return denom < 1e-10 ? 0.0 : dot / denom;
    }
}
