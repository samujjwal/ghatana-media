package com.ghatana.media.production.audio;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import java.time.Duration;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Objects;

/** Immutable A/B snapshot for source PCM and a repaired PCM revision. */
public final class AudioRepairComparison {
    private static final int MAX_PCM_BYTES = 16 * 1024 * 1024;

    private final AudioData source;
    private final AudioData repaired;
    private final String sourceSha256;
    private final String repairedSha256;
    private final Metrics metrics;

    private AudioRepairComparison(AudioData source, AudioData repaired, AudioData reference) {
        this.source = copy(source);
        this.repaired = copy(repaired);
        this.sourceSha256 = sha256(this.source.data());
        this.repairedSha256 = sha256(this.repaired.data());
        this.metrics = measure(this.source, this.repaired, reference);
    }

    public static AudioRepairComparison compare(AudioData source, AudioData repaired) {
        return compare(source, repaired, null);
    }

    /**
     * Compare exact-shape signed PCM revisions. SNR is computed only against
     * an independently supplied reference and never inferred from the source.
     */
    public static AudioRepairComparison compare(AudioData source, AudioData repaired, AudioData reference) {
        requireCompatible(source, repaired, "source and repaired revisions");
        if (reference != null) {
            if (reference == source || reference == repaired) {
                throw new IllegalArgumentException("independent reference must be a separate audio value");
            }
            requireCompatible(repaired, reference, "reference and repaired revision");
        }
        return new AudioRepairComparison(source, repaired, reference);
    }

    public AudioData source() { return copy(source); }
    public AudioData repaired() { return copy(repaired); }
    public String sourceSha256() { return sourceSha256; }
    public String repairedSha256() { return repairedSha256; }
    public Metrics metrics() { return metrics; }

    /** Restore the exact immutable input branch as a fresh value; no repair is applied. */
    public AudioData undo() { return copy(source); }

    private static AudioData copy(AudioData value) {
        return new AudioData(value.data(), value.sampleRate(), value.channels(), value.bitsPerSample(),
                value.duration(), value.format());
    }

    private static void requireCompatible(AudioData left, AudioData right, String label) {
        Objects.requireNonNull(left, "left audio");
        Objects.requireNonNull(right, "right audio");
        int leftLength = left.dataLength();
        int rightLength = right.dataLength();
        if (left.format() != AudioFormat.PCM || right.format() != AudioFormat.PCM
                || left.sampleRate() != right.sampleRate()
                || left.channels() != right.channels()
                || left.bitsPerSample() != right.bitsPerSample()
                || !left.duration().equals(right.duration())
                || leftLength == 0
                || leftLength != rightLength
                || leftLength > MAX_PCM_BYTES) {
            throw new IllegalArgumentException(label + " must be non-empty bounded PCM with identical format and length");
        }
        if (!supportedBits(left.bitsPerSample())) {
            throw new IllegalArgumentException("PCM comparison supports signed 16-, 24-, or 32-bit samples");
        }
        int bytesPerSample = left.bitsPerSample() / 8;
        long frameBytes = (long) bytesPerSample * left.channels();
        if (leftLength % frameBytes != 0) {
            throw new IllegalArgumentException("PCM payload must contain complete interleaved frames");
        }
        long frames = leftLength / frameBytes;
        long expectedNanos = (frames * 1_000_000_000L + left.sampleRate() / 2L) / left.sampleRate();
        if (!left.duration().equals(Duration.ofNanos(expectedNanos))) {
            throw new IllegalArgumentException("PCM duration does not match its frame count and sample rate");
        }
    }

    private static boolean supportedBits(int bits) { return bits == 16 || bits == 24 || bits == 32; }

    private static Metrics measure(AudioData source, AudioData repaired, AudioData reference) {
        byte[] original = source.data();
        byte[] output = repaired.data();
        // AudioData.data() returns a defensive copy. Read the reference once so
        // per-sample metrics stay linear in payload size and allocation.
        byte[] expectedBytes = reference == null ? null : reference.data();
        long changed = 0;
        double inputEnergy = 0;
        double outputEnergy = 0;
        double referenceEnergy = 0;
        double errorEnergy = 0;
        int bytes = source.bitsPerSample() / 8;
        long sourcePeak = 0;
        long repairedPeak = 0;
        long sourceNearClip = 0;
        long repairedNearClip = 0;
        long nearClipThreshold = (long) Math.ceil(((1L << (source.bitsPerSample() - 1)) - 1L) * 0.999);
        for (int offset = 0; offset < output.length; offset += bytes) {
            long left = readSigned(original, offset, bytes);
            long right = readSigned(output, offset, bytes);
            if (left != right) changed++;
            inputEnergy += (double) left * left;
            outputEnergy += (double) right * right;
            sourcePeak = Math.max(sourcePeak, Math.abs(left));
            repairedPeak = Math.max(repairedPeak, Math.abs(right));
            if (Math.abs(left) >= nearClipThreshold) sourceNearClip++;
            if (Math.abs(right) >= nearClipThreshold) repairedNearClip++;
            if (reference != null) {
                long expected = readSigned(expectedBytes, offset, bytes);
                double error = (double) expected - right;
                referenceEnergy += (double) expected * expected;
                errorEnergy += error * error;
            }
        }
        double count = output.length / (double) bytes;
        double snr = reference == null ? Double.NaN :
                errorEnergy == 0 ? Double.POSITIVE_INFINITY :
                referenceEnergy == 0 ? Double.NEGATIVE_INFINITY : 10.0 * Math.log10(referenceEnergy / errorEnergy);
        double sourceRms = Math.sqrt(inputEnergy / count);
        double repairedRms = Math.sqrt(outputEnergy / count);
        double rmsChangeDb = sourceRms == 0.0
                ? (repairedRms == 0.0 ? 0.0 : Double.POSITIVE_INFINITY)
                : 20.0 * Math.log10(repairedRms / sourceRms);
        Double sourceStereoCorrelation = stereoCorrelation(original, source);
        Double repairedStereoCorrelation = stereoCorrelation(output, repaired);
        Double stereoCorrelationDelta = sourceStereoCorrelation == null || repairedStereoCorrelation == null ? null
                : Math.abs(sourceStereoCorrelation - repairedStereoCorrelation);
        return new Metrics(sourceRms, repairedRms, sourcePeak, repairedPeak,
                sourceNearClip, repairedNearClip, changed, rmsChangeDb, snr,
                reference != null, sourceStereoCorrelation, repairedStereoCorrelation,
                stereoCorrelationDelta);
    }

    /** Zero-lag channel correlation is an explicit stereo phase/polarity proxy, not a perceptual score. */
    private static Double stereoCorrelation(byte[] bytes, AudioData format) {
        // This proxy compares exactly the left and right channels. For a
        // multichannel layout, treating channel 0/1 as stereo would mislabel
        // a partial-layout statistic as stereo correlation.
        if (format.channels() != 2) return null;
        int sampleBytes = format.bitsPerSample() / 8;
        int frameBytes = sampleBytes * format.channels();
        double leftRight = 0.0;
        double leftEnergy = 0.0;
        double rightEnergy = 0.0;
        for (int offset = 0; offset < bytes.length; offset += frameBytes) {
            long left = readSigned(bytes, offset, sampleBytes);
            long right = readSigned(bytes, offset + sampleBytes, sampleBytes);
            leftRight += (double) left * right;
            leftEnergy += (double) left * left;
            rightEnergy += (double) right * right;
        }
        if (leftEnergy == 0.0 || rightEnergy == 0.0) return null;
        return Math.max(-1.0, Math.min(1.0, leftRight / Math.sqrt(leftEnergy * rightEnergy)));
    }

    private static long readSigned(byte[] data, int offset, int bytes) {
        long value = 0;
        for (int index = bytes - 1; index >= 0; index--) value = (value << 8) | (data[offset + index] & 0xffL);
        int bits = bytes * 8;
        long sign = 1L << (bits - 1);
        return (value ^ sign) - sign;
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("JDK SHA-256 is unavailable", impossible);
        }
    }

    public record Metrics(double sourceRms, double repairedRms, long sourcePeak, long repairedPeak,
                          long sourceNearClipSampleCount, long repairedNearClipSampleCount,
                          long changedSampleCount, double rmsChangeDb, double snrDbVsReference,
                          boolean hasIndependentReference, Double sourceStereoCorrelation,
                          Double repairedStereoCorrelation, Double stereoCorrelationDelta) { }
}
