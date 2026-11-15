package com.ghatana.media.launcher;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Measurements for the DEV_ONLY audio restoration comparison. Every number is computed from decoded PCM16 samples;
 * nothing is estimated from a model or inferred from filter parameters.
 *
 * <ul>
 *   <li>{@link #snrDb}: {@code 10 log10(sum(ref^2) / sum((x - ref)^2))} over all interleaved samples;</li>
 *   <li>{@link #segmentalSnrDb}: mean over 20 ms frames of the per-frame SNR against the reference, each clamped to
 *       [-10, 35] dB (the usual segmental-SNR convention), frames whose reference energy is zero skipped;</li>
 *   <li>{@link #clippedSamples}: samples inside a run of at least 3 consecutive identical values of at least 25% of the
 *       channel peak and at least 1024 (a flat-top plateau, the signature of hard clipping);</li>
 *   <li>{@link #noiseFloor}: the quietest 10% of 1024-sample Hann frames of the mono mix; their RMS in dBFS and the
 *       spectral flatness (Wiener entropy) of their averaged power spectrum, 1.0 for white noise, near 0 for a
 *       tonal floor such as hum.</li>
 * </ul>
 */
final class MediaDevAudioMetrics {
    static final double SEGMENT_SECONDS = 0.02;
    static final double SEGMENT_MIN_DB = -10.0;
    static final double SEGMENT_MAX_DB = 35.0;
    static final int FLOOR_FRAME = 1024;
    static final int MIN_FLOOR_FRAMES = 8;
    private static final int MIN_PLATEAU_RUN = 3;
    private static final int MIN_PLATEAU_MAGNITUDE = 1024;

    private MediaDevAudioMetrics() { }

    /** Null when the reference carries no energy or the signals differ in shape. */
    static Double snrDb(MediaDevAudioWav.Pcm signal, MediaDevAudioWav.Pcm reference) {
        requireSameShape(signal, reference);
        short[] x = signal.raw();
        short[] r = reference.raw();
        double signalEnergy = 0;
        double errorEnergy = 0;
        for (int i = 0; i < r.length; i++) {
            double ref = r[i];
            double error = x[i] - ref;
            signalEnergy += ref * ref;
            errorEnergy += error * error;
        }
        if (signalEnergy <= 0) return null;
        if (errorEnergy <= 0) return Double.POSITIVE_INFINITY;
        return 10 * Math.log10(signalEnergy / errorEnergy);
    }

    static Double segmentalSnrDb(MediaDevAudioWav.Pcm signal, MediaDevAudioWav.Pcm reference) {
        requireSameShape(signal, reference);
        short[] x = signal.raw();
        short[] r = reference.raw();
        int frame = Math.max(1, (int) Math.round(SEGMENT_SECONDS * signal.sampleRate())) * signal.channels();
        double sum = 0;
        int counted = 0;
        for (int start = 0; start + frame <= r.length; start += frame) {
            double signalEnergy = 0;
            double errorEnergy = 0;
            for (int i = start; i < start + frame; i++) {
                double ref = r[i];
                double error = x[i] - ref;
                signalEnergy += ref * ref;
                errorEnergy += error * error;
            }
            if (signalEnergy <= 0) continue;
            double db = errorEnergy <= 0 ? SEGMENT_MAX_DB : 10 * Math.log10(signalEnergy / errorEnergy);
            sum += Math.max(SEGMENT_MIN_DB, Math.min(SEGMENT_MAX_DB, db));
            counted++;
        }
        return counted == 0 ? null : sum / counted;
    }

    static long clippedSamples(MediaDevAudioWav.Pcm pcm) {
        short[] samples = pcm.raw();
        int channels = pcm.channels();
        long total = 0;
        for (int channel = 0; channel < channels; channel++) {
            int peak = 0;
            for (int i = channel; i < samples.length; i += channels) peak = Math.max(peak, Math.abs((int) samples[i]));
            int floor = Math.max(MIN_PLATEAU_MAGNITUDE, peak / 4);
            int i = channel;
            while (i < samples.length) {
                int j = i;
                while (j + channels < samples.length && samples[j + channels] == samples[i]) j += channels;
                int run = (j - i) / channels + 1;
                if (run >= MIN_PLATEAU_RUN && Math.abs((int) samples[i]) >= floor) total += run;
                i = j + channels;
            }
        }
        return total;
    }

    static double peak(MediaDevAudioWav.Pcm pcm) {
        int peak = 0;
        for (short sample : pcm.raw()) peak = Math.max(peak, Math.abs((int) sample));
        return peak;
    }

    static double rmsDbfs(MediaDevAudioWav.Pcm pcm) {
        double energy = 0;
        for (short sample : pcm.raw()) energy += (double) sample * sample;
        double rms = Math.sqrt(energy / Math.max(1, pcm.raw().length)) / 32768.0;
        return toDb(rms);
    }

    record NoiseFloor(double rmsDbfs, double spectralFlatness, int frames) { }

    /** Null when the clip is too short to hold the minimum number of analysis frames. */
    static NoiseFloor noiseFloor(MediaDevAudioWav.Pcm pcm) {
        double[] mono = mono(pcm);
        int hop = FLOOR_FRAME / 2;
        if (mono.length < FLOOR_FRAME + hop * (MIN_FLOOR_FRAMES - 1)) return null;
        double[] window = new double[FLOOR_FRAME];
        for (int i = 0; i < FLOOR_FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FLOOR_FRAME);
        List<double[]> frames = new ArrayList<>();
        List<Double> energies = new ArrayList<>();
        for (int start = 0; start + FLOOR_FRAME <= mono.length; start += hop) {
            double energy = 0;
            for (int i = 0; i < FLOOR_FRAME; i++) energy += mono[start + i] * mono[start + i];
            energies.add(energy);
            frames.add(new double[] { start });
        }
        Integer[] order = new Integer[frames.size()];
        for (int i = 0; i < order.length; i++) order[i] = i;
        Arrays.sort(order, (a, b) -> Double.compare(energies.get(a), energies.get(b)));
        int quiet = Math.max(MIN_FLOOR_FRAMES, order.length / 10);
        double[] power = new double[FLOOR_FRAME / 2 + 1];
        double rmsEnergy = 0;
        double[] re = new double[FLOOR_FRAME];
        double[] im = new double[FLOOR_FRAME];
        for (int k = 0; k < quiet; k++) {
            int start = (int) frames.get(order[k])[0];
            for (int i = 0; i < FLOOR_FRAME; i++) {
                re[i] = mono[start + i] * window[i];
                im[i] = 0;
            }
            fft(re, im);
            for (int bin = 0; bin < power.length; bin++) power[bin] += re[bin] * re[bin] + im[bin] * im[bin];
            rmsEnergy += energies.get(order[k]) / FLOOR_FRAME;
        }
        double logSum = 0;
        double sum = 0;
        int bins = 0;
        for (int bin = 1; bin < power.length - 1; bin++) {
            double p = power[bin] / quiet + 1e-9;
            logSum += Math.log(p);
            sum += p;
            bins++;
        }
        double flatness = Math.exp(logSum / bins) / (sum / bins);
        return new NoiseFloor(toDb(Math.sqrt(rmsEnergy / quiet)), flatness, quiet);
    }

    private static double[] mono(MediaDevAudioWav.Pcm pcm) {
        short[] samples = pcm.raw();
        int channels = pcm.channels();
        double[] mono = new double[samples.length / channels];
        for (int frame = 0; frame < mono.length; frame++) {
            double sum = 0;
            for (int c = 0; c < channels; c++) sum += samples[frame * channels + c];
            mono[frame] = sum / channels / 32768.0;
        }
        return mono;
    }

    private static double toDb(double linear) {
        return 20 * Math.log10(Math.max(linear, 1e-9));
    }

    /** In-place iterative radix-2 FFT; the length must be a power of two. */
    static void fft(double[] re, double[] im) {
        int n = re.length;
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                double t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double angle = -2 * Math.PI / len;
            double wr = Math.cos(angle);
            double wi = Math.sin(angle);
            for (int i = 0; i < n; i += len) {
                double cr = 1;
                double ci = 0;
                for (int k = 0; k < len / 2; k++) {
                    int a = i + k;
                    int b = a + len / 2;
                    double xr = re[b] * cr - im[b] * ci;
                    double xi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - xr;
                    im[b] = im[a] - xi;
                    re[a] += xr;
                    im[a] += xi;
                    double next = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = next;
                }
            }
        }
    }

    private static void requireSameShape(MediaDevAudioWav.Pcm a, MediaDevAudioWav.Pcm b) {
        if (a.sampleRate() != b.sampleRate() || a.channels() != b.channels() || a.raw().length != b.raw().length) {
            throw new IllegalArgumentException("signals must have identical sample rate, channels and length");
        }
    }

    // ---- transcript comparison ----

    private static final Pattern WORD = Pattern.compile("[a-z0-9']+");

    static List<String> words(String text) {
        List<String> words = new ArrayList<>();
        Matcher matcher = WORD.matcher(text == null ? "" : text.toLowerCase(Locale.ROOT).replace('’', '\''));
        while (matcher.find()) words.add(matcher.group());
        return words;
    }

    /** Word error rate of {@code hypothesis} against {@code reference}; null when the reference has no words. */
    static Double wordErrorRate(String reference, String hypothesis) {
        List<String> ref = words(reference);
        List<String> hyp = words(hypothesis);
        if (ref.isEmpty()) return null;
        int[] previous = new int[hyp.size() + 1];
        int[] current = new int[hyp.size() + 1];
        for (int j = 0; j <= hyp.size(); j++) previous[j] = j;
        for (int i = 1; i <= ref.size(); i++) {
            current[0] = i;
            for (int j = 1; j <= hyp.size(); j++) {
                int substitution = previous[j - 1] + (ref.get(i - 1).equals(hyp.get(j - 1)) ? 0 : 1);
                current[j] = Math.min(substitution, Math.min(previous[j] + 1, current[j - 1] + 1));
            }
            int[] swap = previous; previous = current; current = swap;
        }
        return previous[hyp.size()] / (double) ref.size();
    }
}
