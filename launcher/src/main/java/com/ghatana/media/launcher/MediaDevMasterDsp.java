package com.ghatana.media.launcher;

import java.util.ArrayDeque;
import java.util.List;
import java.util.Map;
import java.util.function.IntToDoubleFunction;

/**
 * Pure DSP for the DEV_ONLY stem/foley/mix/master journey (J-17): deterministic procedural synthesis, sample-exact
 * mixing, an ITU-R BS.1770 integrated-loudness meter, a windowed-sinc oversampled true-peak meter and a look-ahead
 * true-peak limiter that lands a mix on a loudness target under a peak ceiling.
 *
 * <p>Determinism: synthesis uses only {@link StrictMath}, integer-seeded SplitMix64 noise and fixed-order double
 * arithmetic, so the same spec yields identical bytes on every run, JVM and launcher restart. Nothing here uses a model,
 * a sample library or any third-party audio: every stem is original procedural synthesis.</p>
 */
final class MediaDevMasterDsp {
    static final String SYNTH_ALGORITHM = "ghatana-media.procedural-stem-synth";
    static final String SYNTH_VERSION = "1";
    static final String MASTER_ENGINE = "ghatana-media.master-dsp";
    static final String MASTER_ENGINE_VERSION = "1";
    static final int RATE = MediaDevMasterSpec.RATE;
    /** Sub-block of the BS.1770 gating: 100 ms. */
    private static final int HOP = RATE / 10;
    /** The widest pre-limiter gain the master will apply; a quieter mix is refused instead of boosted without bound. */
    static final double MAX_PRE_GAIN_DB = 48.0;
    private static final int LIMITER_HALF_WINDOW = 48;
    private static final double LOUDNESS_TOLERANCE = 0.05;
    private static final double LOUDNESS_ACCEPT = 0.25;

    private MediaDevMasterDsp() { }

    // ------------------------------------------------------------------ synthesis

    /** SplitMix64: a fixed, specified generator so noise is identical everywhere. */
    private static final class Noise {
        private long state;
        Noise(long seed) { state = seed; }
        double next() {
            long z = (state += 0x9E3779B97F4A7C15L);
            z = (z ^ (z >>> 30)) * 0xBF58476D1CE4E5B9L;
            z = (z ^ (z >>> 27)) * 0x94D049BB133111EBL;
            z ^= z >>> 31;
            return (z >>> 11) * (1.0 / (1L << 53)) * 2.0 - 1.0;
        }
    }

    /** Interleaved signed 16-bit samples at 48 kHz; scale 32767 so -32768 is never produced. */
    static short[] synthesize(MediaDevMasterSpec.Stem stem) {
        int frames = stem.frames();
        int channels = stem.channels();
        double amplitude = StrictMath.pow(10.0, stem.amplitudeDb() / 20.0);
        short[] out = new short[frames * channels];
        double[] first = null;
        for (int channel = 0; channel < channels; channel++) {
            double[] x;
            boolean tonal = stem.kind() == MediaDevMasterSpec.Kind.TONE || stem.kind() == MediaDevMasterSpec.Kind.CHORD;
            if (channel == 1 && tonal) {
                x = first;
            } else {
                long seed = stem.seed() + channel * 0x632BE59BD9B4E019L;
                x = switch (stem.kind()) {
                    case TONE -> tone(stem, frames);
                    case CHORD -> chord(stem, frames);
                    case DRUM -> drum(stem, frames, seed);
                    case FOLEY -> foley(stem, frames, seed);
                };
                if (!tonal) normalize(x);
            }
            if (channel == 0) first = x;
            for (int n = 0; n < frames; n++) out[n * channels + channel] = quantize(x[n] * amplitude);
        }
        return out;
    }

    private static short quantize(double unit) {
        long q = (long) StrictMath.floor(unit * 32767.0 + 0.5);
        return (short) Math.max(-32767, Math.min(32767, q));
    }

    private static double[] tone(MediaDevMasterSpec.Stem stem, int frames) {
        double[] x = new double[frames];
        double f = stem.frequencyHz();
        for (int n = 0; n < frames; n++) {
            x[n] = StrictMath.sin(2.0 * StrictMath.PI * f * n / RATE) * envelope(n, frames, stem.attackMs(), stem.releaseMs());
        }
        return x;
    }

    private static double[] chord(MediaDevMasterSpec.Stem stem, int frames) {
        double[] x = new double[frames];
        List<Double> notes = stem.frequenciesHz();
        for (int n = 0; n < frames; n++) {
            double sum = 0;
            for (double f : notes) sum += StrictMath.sin(2.0 * StrictMath.PI * f * n / RATE);
            x[n] = sum / notes.size() * envelope(n, frames, stem.attackMs(), stem.releaseMs());
        }
        return x;
    }

    /** Linear attack from 0 over attackMs and linear release to 0 over the last releaseMs; 1 in between. */
    static double envelope(int n, int frames, int attackMs, int releaseMs) {
        int attack = attackMs * (RATE / 1000);
        int release = releaseMs * (RATE / 1000);
        double a = attack > 0 ? Math.min(1.0, (double) n / attack) : 1.0;
        double r = release > 0 ? Math.min(1.0, (double) (frames - 1 - n) / release) : 1.0;
        return Math.min(a, r);
    }

    private static double ramp(int n) {
        return Math.min(1.0, n / 48.0);
    }

    private static double[] drum(MediaDevMasterSpec.Stem stem, int frames, long seed) {
        double[] x = new double[frames];
        Noise noise = new Noise(seed);
        switch (stem.drum()) {
            case KICK -> {
                double phase = 0;
                for (int n = 0; n < frames; n++) {
                    double t = (double) n / RATE;
                    double f = 50.0 + 100.0 * StrictMath.exp(-t / 0.03);
                    phase += 2.0 * StrictMath.PI * f / RATE;
                    x[n] = StrictMath.sin(phase) * StrictMath.exp(-t / 0.12) * ramp(n);
                }
            }
            case SNARE -> {
                for (int n = 0; n < frames; n++) {
                    double t = (double) n / RATE;
                    double body = StrictMath.sin(2.0 * StrictMath.PI * 190.0 * t) * StrictMath.exp(-t / 0.05) * 0.5;
                    x[n] = (noise.next() * StrictMath.exp(-t / 0.08) * 0.6 + body) * ramp(n);
                }
            }
            case HAT -> {
                double previous = 0;
                for (int n = 0; n < frames; n++) {
                    double t = (double) n / RATE;
                    double current = noise.next();
                    x[n] = (current - previous) * StrictMath.exp(-t / 0.03) * ramp(n);
                    previous = current;
                }
            }
        }
        return x;
    }

    private static double[] foley(MediaDevMasterSpec.Stem stem, int frames, long seed) {
        double[] x = new double[frames];
        Noise noise = new Noise(seed);
        switch (stem.foley()) {
            case FOOTSTEP -> {
                double low = 0;
                for (int n = 0; n < frames; n++) {
                    double t = (double) n / RATE;
                    low += 0.12 * (noise.next() - low);
                    double heel = StrictMath.exp(-t / 0.04);
                    double toe = t >= 0.09 ? 0.5 * StrictMath.exp(-(t - 0.09) / 0.04) : 0.0;
                    double thump = StrictMath.sin(2.0 * StrictMath.PI * 80.0 * t) * StrictMath.exp(-t / 0.05) * 0.4;
                    x[n] = (low * (heel + toe) * 2.0 + thump) * ramp(n);
                }
            }
            case WHOOSH -> {
                double length = (double) frames / RATE;
                double lowState = 0;
                double bandState = 0;
                for (int n = 0; n < frames; n++) {
                    double t = (double) n / RATE;
                    double sweep = StrictMath.sin(StrictMath.PI * t / length);
                    double fc = 300.0 + 2700.0 * sweep * sweep;
                    double f = 2.0 * StrictMath.sin(StrictMath.PI * fc / RATE);
                    double input = noise.next();
                    lowState += f * bandState;
                    double high = input - lowState - 0.5 * bandState;
                    bandState += f * high;
                    x[n] = bandState * sweep;
                }
            }
            case IMPACT -> {
                double low = 0;
                for (int n = 0; n < frames; n++) {
                    double t = (double) n / RATE;
                    low += 0.3 * (noise.next() - low);
                    double thud = StrictMath.sin(2.0 * StrictMath.PI * 55.0 * t) * StrictMath.exp(-t / 0.25);
                    x[n] = (low * StrictMath.exp(-t / 0.15) + thud) * Math.min(1.0, n / 24.0);
                }
            }
        }
        return x;
    }

    private static void normalize(double[] x) {
        double peak = 0;
        for (double v : x) peak = Math.max(peak, Math.abs(v));
        if (peak > 0) for (int i = 0; i < x.length; i++) x[i] /= peak;
    }

    // ------------------------------------------------------------------ mix

    /** One input stem placed on the master timeline; {@code pcm} is interleaved with {@code channels} 1 or 2. */
    record Placed(short[] pcm, int channels, double gainDb, double pan, int startFrame, int fadeIn, int fadeOut) {
        int frames() { return pcm.length / channels; }
    }

    /** Sums the placed stems into two double buses (full scale 1.0). Pan law: left=1-max(pan,0), right=1+min(pan,0). */
    static double[][] mix(List<Placed> stems, int frames) {
        double[] left = new double[frames];
        double[] right = new double[frames];
        for (Placed stem : stems) {
            double gain = StrictMath.pow(10.0, stem.gainDb() / 20.0);
            double gl = gain * (stem.pan() > 0 ? 1.0 - stem.pan() : 1.0);
            double gr = gain * (stem.pan() < 0 ? 1.0 + stem.pan() : 1.0);
            int length = stem.frames();
            for (int i = 0; i < length; i++) {
                int at = stem.startFrame() + i;
                double fade = 1.0;
                if (stem.fadeIn() > 0 && i < stem.fadeIn()) fade = (double) i / stem.fadeIn();
                if (stem.fadeOut() > 0 && length - 1 - i < stem.fadeOut()) {
                    fade = Math.min(fade, (double) (length - 1 - i) / stem.fadeOut());
                }
                double a = stem.pcm()[i * stem.channels()] / 32768.0;
                double b = stem.channels() == 2 ? stem.pcm()[i * 2 + 1] / 32768.0 : a;
                left[at] += a * gl * fade;
                right[at] += b * gr * fade;
            }
        }
        return new double[][] { left, right };
    }

    // ------------------------------------------------------------------ loudness (ITU-R BS.1770 / EBU R128)

    // K-weighting at 48 kHz: high-shelf pre-filter then the RLB high-pass (the standard's published coefficients).
    private static final double[] SHELF_B = { 1.53512485958697, -2.69169618940638, 1.19839281085285 };
    private static final double[] SHELF_A = { 1.0, -1.69065929318241, 0.73248077421585 };
    private static final double[] RLB_B = { 1.0, -2.0, 1.0 };
    private static final double[] RLB_A = { 1.0, -1.99004745483398, 0.99007225036621 };

    /** Integrated loudness in LUFS (400 ms blocks, 75% overlap, -70 LUFS absolute and -10 LU relative gates); NaN if undefined. */
    static double integratedLufs(IntToDoubleFunction left, IntToDoubleFunction right, int frames) {
        int subBlocks = frames / HOP;
        double[] sub = new double[subBlocks];
        double[] state = new double[8]; // per channel: shelf z1,z2, rlb z1,z2
        double energy = 0;
        int count = 0;
        int index = 0;
        for (int n = 0; n < subBlocks * HOP; n++) {
            double kl = kWeight(left.applyAsDouble(n), state, 0);
            double kr = kWeight(right.applyAsDouble(n), state, 4);
            energy += kl * kl + kr * kr;
            if (++count == HOP) {
                sub[index++] = energy;
                energy = 0;
                count = 0;
            }
        }
        int blocks = subBlocks - 3;
        if (blocks <= 0) return Double.NaN;
        double[] block = new double[blocks];
        double absoluteSum = 0;
        int absoluteCount = 0;
        for (int b = 0; b < blocks; b++) {
            block[b] = (sub[b] + sub[b + 1] + sub[b + 2] + sub[b + 3]) / (4.0 * HOP);
            if (lufs(block[b]) > -70.0) {
                absoluteSum += block[b];
                absoluteCount++;
            }
        }
        if (absoluteCount == 0) return Double.NaN;
        double relative = lufs(absoluteSum / absoluteCount) - 10.0;
        double sum = 0;
        int kept = 0;
        for (double e : block) {
            double l = lufs(e);
            if (l > -70.0 && l > relative) {
                sum += e;
                kept++;
            }
        }
        return kept == 0 ? Double.NaN : lufs(sum / kept);
    }

    static double integratedLufs(double[] left, double[] right) {
        return integratedLufs(i -> left[i], i -> right[i], left.length);
    }

    /** Integrated loudness of an interleaved stereo PCM16 buffer. */
    static double integratedLufs(short[] stereo) {
        return integratedLufs(i -> stereo[2 * i] / 32768.0, i -> stereo[2 * i + 1] / 32768.0, stereo.length / 2);
    }

    private static double lufs(double meanSquare) {
        return meanSquare <= 0 ? Double.NEGATIVE_INFINITY : -0.691 + 10.0 * Math.log10(meanSquare);
    }

    private static double kWeight(double x, double[] s, int o) {
        double y1 = SHELF_B[0] * x + s[o];
        s[o] = SHELF_B[1] * x - SHELF_A[1] * y1 + s[o + 1];
        s[o + 1] = SHELF_B[2] * x - SHELF_A[2] * y1;
        double y2 = RLB_B[0] * y1 + s[o + 2];
        s[o + 2] = RLB_B[1] * y1 - RLB_A[1] * y2 + s[o + 3];
        s[o + 3] = RLB_B[2] * y1 - RLB_A[2] * y2;
        return y2;
    }

    // ------------------------------------------------------------------ true peak

    private static double bessel0(double x) {
        double sum = 1.0;
        double term = 1.0;
        for (int k = 1; k < 40; k++) {
            term *= (x / (2.0 * k)) * (x / (2.0 * k));
            sum += term;
        }
        return sum;
    }

    /** Kaiser-windowed sinc interpolation taps for each of the {@code up - 1} fractional phases, each normalized to unit DC gain. */
    static double[][] phaseTable(int up, int half) {
        double beta = 9.0;
        double norm = bessel0(beta);
        double[][] table = new double[up - 1][2 * half];
        for (int k = 1; k < up; k++) {
            double frac = (double) k / up;
            double sum = 0;
            for (int j = -half + 1; j <= half; j++) {
                double x = j - frac;
                double sinc = StrictMath.sin(StrictMath.PI * x) / (StrictMath.PI * x);
                double w = bessel0(beta * StrictMath.sqrt(Math.max(0.0, 1.0 - (x / half) * (x / half)))) / norm;
                double c = sinc * w;
                table[k - 1][j + half - 1] = c;
                sum += c;
            }
            for (int i = 0; i < 2 * half; i++) table[k - 1][i] /= sum;
        }
        return table;
    }

    /** Largest absolute value of the oversampled signal over both channels; optionally per frame (the interval n..n+1). */
    static double scanPeak(double[] left, double[] right, int up, int half, float[] perFrame) {
        double[][] table = phaseTable(up, half);
        int frames = left.length;
        double peak = 0;
        for (int n = 0; n < frames; n++) {
            double local = Math.max(Math.abs(left[n]), Math.abs(right[n]));
            for (double[] taps : table) {
                double yl = 0;
                double yr = 0;
                int base = n - half + 1;
                int from = Math.max(0, -base);
                int to = Math.min(2 * half, frames - base);
                for (int i = from; i < to; i++) {
                    yl += taps[i] * left[base + i];
                    yr += taps[i] * right[base + i];
                }
                local = Math.max(local, Math.max(Math.abs(yl), Math.abs(yr)));
            }
            if (perFrame != null) perFrame[n] = (float) local;
            peak = Math.max(peak, local);
        }
        return peak;
    }

    /** True peak of interleaved stereo PCM16 in dBTP, 8x oversampled (the BS.1770 minimum is 4x); -inf for silence. */
    static double truePeakDbtp(short[] stereo) {
        int frames = stereo.length / 2;
        double[] l = new double[frames];
        double[] r = new double[frames];
        for (int i = 0; i < frames; i++) {
            l[i] = stereo[2 * i] / 32768.0;
            r[i] = stereo[2 * i + 1] / 32768.0;
        }
        return db(scanPeak(l, r, 8, 16, null));
    }

    static double db(double linear) {
        return linear <= 0 ? Double.NEGATIVE_INFINITY : 20.0 * Math.log10(linear);
    }

    // ------------------------------------------------------------------ limiter and master

    /** Per-frame gain that keeps {@code gain * peak} under the ceiling; smoothed so it never exceeds the needed reduction. */
    static float[] gainEnvelope(float[] peak, double gain, double ceiling) {
        int frames = peak.length;
        double[] need = new double[frames];
        for (int n = 0; n < frames; n++) {
            double p = gain * peak[n];
            need[n] = p > ceiling ? ceiling / p : 1.0;
        }
        // Sliding minimum over [n-W, n+W]: the gain at every neighbour is at most what this frame needs.
        double[] min = new double[frames];
        ArrayDeque<Integer> window = new ArrayDeque<>();
        int w = LIMITER_HALF_WINDOW;
        int next = 0;
        for (int n = 0; n < frames; n++) {
            int upper = Math.min(frames - 1, n + w);
            for (; next <= upper; next++) {
                while (!window.isEmpty() && need[window.peekLast()] >= need[next]) window.pollLast();
                window.addLast(next);
            }
            while (window.peekFirst() < n - w) window.pollFirst();
            min[n] = need[window.peekFirst()];
        }
        // A moving average of the minima over the same window never exceeds the frame's own requirement.
        double[] prefix = new double[frames + 1];
        for (int n = 0; n < frames; n++) prefix[n + 1] = prefix[n] + min[n];
        float[] out = new float[frames];
        for (int n = 0; n < frames; n++) {
            int lo = Math.max(0, n - w);
            int hi = Math.min(frames - 1, n + w);
            out[n] = (float) Math.min(need[n], (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1));
        }
        return out;
    }

    /** The mastered stereo PCM16 plus every measurement taken on those exact samples. */
    record Mastered(short[] pcm, double preGainDb, double integratedLufs, double truePeakDbtp, double samplePeakDbfs,
                    long clippedSamples, double maxReductionDb, long limitedFrames, int iterations,
                    double mixIntegratedLufs, double mixSamplePeakDbfs, double mixTruePeakDbtp, double ceilingUsedDbtp) { }

    private static MediaDevMasterRuntime.MasterRefusedException unreachable(String reason, String message,
                                                                          Map<String, Object> details) {
        Map<String, Object> all = new java.util.LinkedHashMap<>(details);
        all.put("outcome", "ABSTAINED");
        all.put("reason", reason);
        return new MediaDevMasterRuntime.MasterRefusedException(422, "MASTER_LOUDNESS_TARGET_UNREACHABLE", message, all);
    }

    /**
     * Lands the mix on {@code targetLufs} integrated loudness under {@code ceilingDbtp}. The pre-limiter gain is searched
     * (secant steps) against loudness measured on the actual quantized output; the limiter is re-solved at every step and
     * the final 16-bit samples are re-measured at 8x oversampling, tightening the internal ceiling until the claim holds.
     * Silence, an unreachable target or a gain beyond the cap is an explicit abstention, never unbounded gain.
     */
    static Mastered master(double[] left, double[] right, double targetLufs, double ceilingDbtp) {
        int frames = left.length;
        double mixLufs = integratedLufs(left, right);
        double mixSamplePeak = 0;
        for (int n = 0; n < frames; n++) mixSamplePeak = Math.max(mixSamplePeak, Math.max(Math.abs(left[n]), Math.abs(right[n])));
        if (Double.isNaN(mixLufs)) {
            throw unreachable("SILENT_INPUT", "the mix is silent (no 400 ms block above the -70 LUFS gate); a loudness "
                    + "target cannot be reached without unbounded gain", Map.of("targetLufs", targetLufs,
                    "mixHasSamples", mixSamplePeak > 0));
        }
        float[] peak = new float[frames];
        double mixTruePeak = scanPeak(left, right, 4, 12, peak);
        double margin = 0.10;
        for (int outer = 0; outer < 6; outer++) {
            double ceilingLinear = StrictMath.pow(10.0, (ceilingDbtp - margin) / 20.0);
            double gainDb = targetLufs - mixLufs;
            double previousGain = Double.NaN;
            double previousOut = Double.NaN;
            short[] pcm = null;
            double out = Double.NaN;
            float[] envelope = null;
            int iterations = 0;
            for (; iterations < 24; iterations++) {
                if (gainDb > MAX_PRE_GAIN_DB) {
                    throw unreachable("GAIN_CAP", "reaching the target would need more than +" + MAX_PRE_GAIN_DB
                            + " dB of gain; refused instead of boosting without bound", Map.of("targetLufs", targetLufs,
                            "mixIntegratedLufs", mixLufs, "requiredGainDb", gainDb));
                }
                double linear = StrictMath.pow(10.0, gainDb / 20.0);
                envelope = gainEnvelope(peak, linear, ceilingLinear);
                pcm = quantize(left, right, linear, envelope);
                out = integratedLufs(pcm);
                if (Double.isNaN(out)) {
                    throw unreachable("SILENT_INPUT", "the limited output is below the loudness gate",
                            Map.of("targetLufs", targetLufs, "mixIntegratedLufs", mixLufs));
                }
                double error = targetLufs - out;
                if (Math.abs(error) <= LOUDNESS_TOLERANCE) break;
                double slope = 1.0;
                if (!Double.isNaN(previousGain) && Math.abs(gainDb - previousGain) > 1e-9) {
                    slope = Math.max(0.1, Math.min(1.2, (out - previousOut) / (gainDb - previousGain)));
                }
                previousGain = gainDb;
                previousOut = out;
                gainDb += error / slope;
            }
            if (Math.abs(targetLufs - out) > LOUDNESS_ACCEPT) {
                throw unreachable("LIMITER_BOUND", "the true-peak ceiling and limiter keep this mix from reaching the "
                        + "loudness target", Map.of("targetLufs", targetLufs, "achievedLufs", out,
                        "mixIntegratedLufs", mixLufs, "ceilingDbtp", ceilingDbtp));
            }
            double truePeak = truePeakDbtp(pcm);
            if (truePeak <= ceilingDbtp) {
                long clipped = 0;
                int samplePeak = 0;
                for (short s : pcm) {
                    int a = Math.abs((int) s);
                    samplePeak = Math.max(samplePeak, a);
                    if (a >= 32767) clipped++;
                }
                double minGain = 1.0;
                long limited = 0;
                for (float g : envelope) {
                    minGain = Math.min(minGain, g);
                    if (g < 0.999f) limited++;
                }
                return new Mastered(pcm, gainDb, out, truePeak, db(samplePeak / 32768.0), clipped,
                        minGain >= 1.0 ? 0.0 : -db(minGain), limited, iterations + 1, mixLufs, db(mixSamplePeak),
                        db(mixTruePeak), ceilingDbtp - margin);
            }
            margin += (truePeak - ceilingDbtp) + 0.03;
        }
        throw unreachable("PEAK_CEILING", "the true-peak ceiling could not be honoured on the quantized output",
                Map.of("targetLufs", targetLufs, "ceilingDbtp", ceilingDbtp));
    }

    private static short[] quantize(double[] left, double[] right, double gain, float[] envelope) {
        int frames = left.length;
        short[] out = new short[frames * 2];
        for (int n = 0; n < frames; n++) {
            double g = gain * envelope[n] * 32768.0;
            out[2 * n] = clamp(Math.rint(left[n] * g));
            out[2 * n + 1] = clamp(Math.rint(right[n] * g));
        }
        return out;
    }

    private static short clamp(double value) {
        return (short) Math.max(-32767.0, Math.min(32767.0, value));
    }
}
