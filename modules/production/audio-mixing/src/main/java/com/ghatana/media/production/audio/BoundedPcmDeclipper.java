package com.ghatana.media.production.audio;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import java.time.Duration;
import java.util.Objects;

/**
 * Local PCM declip candidate using linear interpolation over short interior
 * clipped runs. Interpolation is an explicit conservative assumption because
 * the product capability does not select a reconstruction algorithm/parameters.
 * It estimates missing samples; it does not recover source truth or imply quality.
 */
public final class BoundedPcmDeclipper {
    public static final int MAX_PCM_BYTES = 16 * 1024 * 1024;
    public static final int MAX_RUN_FRAMES = 4096;

    private BoundedPcmDeclipper() {}

    /** Return a new candidate; the input value and bytes are never modified. */
    public static AudioData repair(AudioData source, double threshold, int maxRunFrames) {
        Objects.requireNonNull(source, "source");
        if (source.format() != AudioFormat.PCM || !supportedBits(source.bitsPerSample())) {
            throw new RepairException(ErrorCode.UNSUPPORTED_FORMAT, "expected signed 16-, 24-, or 32-bit PCM");
        }
        if (source.dataLength() == 0) {
            throw new RepairException(ErrorCode.INVALID_INPUT, "PCM input must not be empty");
        }
        if (source.dataLength() > MAX_PCM_BYTES) {
            throw new RepairException(ErrorCode.RESOURCE_LIMIT, "PCM input exceeds 16 MiB");
        }
        if (!Double.isFinite(threshold) || threshold < 0.5 || threshold > 1.0
                || maxRunFrames < 1 || maxRunFrames > MAX_RUN_FRAMES) {
            throw new RepairException(ErrorCode.INVALID_INPUT, "threshold or clipped-run bound is invalid");
        }
        byte[] input = source.data();
        int sampleBytes = source.bitsPerSample() / 8;
        long frameBytes = (long) sampleBytes * source.channels();
        if (frameBytes > input.length || input.length % frameBytes != 0) {
            throw new RepairException(ErrorCode.INVALID_INPUT, "PCM must contain complete interleaved frames");
        }
        int frames = (int) (input.length / frameBytes);
        long wholeSeconds = frames / (long) source.sampleRate();
        long remainingFrames = frames % (long) source.sampleRate();
        long fractionalNanos = (remainingFrames * 1_000_000_000L + source.sampleRate() / 2L)
                / source.sampleRate();
        if (!source.duration().equals(Duration.ofSeconds(wholeSeconds, fractionalNanos))) {
            throw new RepairException(ErrorCode.INVALID_INPUT, "PCM duration must match its frame count and sample rate");
        }
        byte[] output = input.clone();
        long peak = (1L << (source.bitsPerSample() - 1)) - 1L;
        long clipLevel = (long) Math.ceil(peak * threshold);
        for (int channel = 0; channel < source.channels(); channel++) {
            int frame = 0;
            while (frame < frames) {
                int offset = frame * (int) frameBytes + channel * sampleBytes;
                if (Math.abs(readSigned(input, offset, sampleBytes)) < clipLevel) {
                    frame++;
                    continue;
                }
                int start = frame;
                while (frame < frames) {
                    offset = frame * (int) frameBytes + channel * sampleBytes;
                    if (Math.abs(readSigned(input, offset, sampleBytes)) < clipLevel) break;
                    frame++;
                }
                int run = frame - start;
                if (start == 0 || frame == frames || run > maxRunFrames) {
                    throw new RepairException(ErrorCode.UNREPAIRABLE_RUN,
                            "clipped run lacks bounded unclipped neighbors");
                }
                int leftOffset = (start - 1) * (int) frameBytes + channel * sampleBytes;
                int rightOffset = frame * (int) frameBytes + channel * sampleBytes;
                long left = readSigned(input, leftOffset, sampleBytes);
                long right = readSigned(input, rightOffset, sampleBytes);
                for (int index = 0; index < run; index++) {
                    double fraction = (index + 1.0) / (run + 1.0);
                    long interpolated = Math.round(left + (right - (double) left) * fraction);
                    int repairedOffset = (start + index) * (int) frameBytes + channel * sampleBytes;
                    writeSigned(output, repairedOffset, sampleBytes, interpolated);
                }
            }
        }
        return new AudioData(output, source.sampleRate(), source.channels(), source.bitsPerSample(),
                source.duration(), source.format());
    }

    private static boolean supportedBits(int bits) { return bits == 16 || bits == 24 || bits == 32; }

    private static long readSigned(byte[] bytes, int offset, int count) {
        long value = 0;
        for (int index = count - 1; index >= 0; index--) value = (value << 8) | (bytes[offset + index] & 0xffL);
        int bits = count * 8;
        return (value ^ (1L << (bits - 1))) - (1L << (bits - 1));
    }

    private static void writeSigned(byte[] bytes, int offset, int count, long value) {
        for (int index = 0; index < count; index++) bytes[offset + index] = (byte) (value >>> (index * 8));
    }

    public enum ErrorCode { INVALID_INPUT, UNSUPPORTED_FORMAT, RESOURCE_LIMIT, UNREPAIRABLE_RUN }

    public static final class RepairException extends IllegalArgumentException {
        private final ErrorCode code;
        private RepairException(ErrorCode code, String message) { super(message); this.code = code; }
        public ErrorCode code() { return code; }
    }
}
