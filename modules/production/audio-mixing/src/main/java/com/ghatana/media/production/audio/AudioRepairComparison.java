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
        if (reference != null) requireCompatible(repaired, reference, "reference and repaired revision");
        return new AudioRepairComparison(source, repaired, reference);
    }

    public AudioData source() { return copy(source); }
    public AudioData repaired() { return copy(repaired); }
    public String sourceSha256() { return sourceSha256; }
    public String repairedSha256() { return repairedSha256; }
    public Metrics metrics() { return metrics; }

    private static AudioData copy(AudioData value) {
        return new AudioData(value.data(), value.sampleRate(), value.channels(), value.bitsPerSample(),
                value.duration(), value.format());
    }

    private static void requireCompatible(AudioData left, AudioData right, String label) {
        Objects.requireNonNull(left, "left audio");
        Objects.requireNonNull(right, "right audio");
        byte[] leftBytes = left.data();
        byte[] rightBytes = right.data();
        if (left.format() != AudioFormat.PCM || right.format() != AudioFormat.PCM
                || left.sampleRate() != right.sampleRate()
                || left.channels() != right.channels()
                || left.bitsPerSample() != right.bitsPerSample()
                || !left.duration().equals(right.duration())
                || leftBytes.length == 0
                || leftBytes.length != rightBytes.length
                || leftBytes.length > MAX_PCM_BYTES) {
            throw new IllegalArgumentException(label + " must be non-empty bounded PCM with identical format and length");
        }
        if (!supportedBits(left.bitsPerSample())) {
            throw new IllegalArgumentException("PCM comparison supports signed 16-, 24-, or 32-bit samples");
        }
        int bytesPerSample = left.bitsPerSample() / 8;
        if (leftBytes.length % (bytesPerSample * left.channels()) != 0) {
            throw new IllegalArgumentException("PCM payload must contain complete interleaved frames");
        }
        long frames = leftBytes.length / ((long) bytesPerSample * left.channels());
        long expectedNanos = (frames * 1_000_000_000L + left.sampleRate() / 2L) / left.sampleRate();
        if (!left.duration().equals(Duration.ofNanos(expectedNanos))) {
            throw new IllegalArgumentException("PCM duration does not match its frame count and sample rate");
        }
    }

    private static boolean supportedBits(int bits) { return bits == 16 || bits == 24 || bits == 32; }

    private static Metrics measure(AudioData source, AudioData repaired, AudioData reference) {
        byte[] original = source.data();
        byte[] output = repaired.data();
        long changed = 0;
        double inputEnergy = 0;
        double outputEnergy = 0;
        double referenceEnergy = 0;
        double errorEnergy = 0;
        int bytes = source.bitsPerSample() / 8;
        long peak = 0;
        for (int offset = 0; offset < output.length; offset += bytes) {
            long left = readSigned(original, offset, bytes);
            long right = readSigned(output, offset, bytes);
            if (left != right) changed++;
            inputEnergy += (double) left * left;
            outputEnergy += (double) right * right;
            peak = Math.max(peak, Math.abs(right));
            if (reference != null) {
                long expected = readSigned(reference.data(), offset, bytes);
                double error = (double) expected - right;
                referenceEnergy += (double) expected * expected;
                errorEnergy += error * error;
            }
        }
        double count = output.length / (double) bytes;
        double snr = reference == null ? Double.NaN :
                errorEnergy == 0 ? Double.POSITIVE_INFINITY :
                referenceEnergy == 0 ? Double.NEGATIVE_INFINITY : 10.0 * Math.log10(referenceEnergy / errorEnergy);
        return new Metrics(Math.sqrt(inputEnergy / count), Math.sqrt(outputEnergy / count), peak,
                changed, snr, reference != null);
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

    public record Metrics(double sourceRms, double repairedRms, long repairedPeak,
                          long changedSampleCount, double snrDbVsReference,
                          boolean hasIndependentReference) { }
}
