package com.ghatana.media.production.audio;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;

/**
 * Bounded deterministic signed-16-bit PCM stereo stem mixer.
 *
 * This is a local mix/render primitive. It does not generate Foley, qualify
 * source rights, normalize loudness, or claim a standards-certified true-peak
 * measurement. Its 4x linear-interpolation inter-sample estimate is used only
 * to apply a conservative global peak ceiling before encoding a playable WAV.
 */
public final class PcmStemMixer {
    public static final int MAX_STEMS = 16;
    public static final int MAX_FRAMES = 1_000_000;
    public static final int MAX_AGGREGATE_INPUT_BYTES = 16 * 1024 * 1024;
    public static final int CHANNELS = 2;
    public static final int BITS_PER_SAMPLE = 16;
    private static final int BYTES_PER_FRAME = CHANNELS * (BITS_PER_SAMPLE / 8);
    /** Largest PCM payload any single stem can contribute to a valid mix. */
    public static final int MAX_STEM_PCM_BYTES = MAX_FRAMES * CHANNELS * (BITS_PER_SAMPLE / 8);
    private static final int TRUE_PEAK_OVERSAMPLE = 4;
    private static final int TRUE_PEAK_KERNEL_RADIUS = 4;
    private static final double TRUE_PEAK_HEADROOM = 1.02;
    private static final float MAX_STEM_GAIN = 4.0f;
    private static final float MAX_ABS_PAN = 1.0f;
    private static final float MAX_CEILING = 0.98f;

    public enum ErrorCode {
        INVALID_INPUT,
        RIGHTS_MISSING,
        RIGHTS_STALE,
        RIGHTS_DENIED,
        FORMAT_MISMATCH,
        RESOURCE_LIMIT,
        ENCODE_FAILED
    }

    public static final class MixException extends RuntimeException {
        private final ErrorCode code;

        public MixException(ErrorCode code, String message) {
            super(message);
            this.code = Objects.requireNonNull(code, "code");
        }

        public MixException(ErrorCode code, String message, Throwable cause) {
            super(message, cause);
            this.code = Objects.requireNonNull(code, "code");
        }

        public ErrorCode code() { return code; }
    }

    public interface Provenance { }

    /** Source-free, deterministic input made by a named local algorithm. */
    public record SyntheticProvenance(String algorithmId, String algorithmVersion,
                                      String parameterDigest) implements Provenance { }

    /** Input backed by a specific immutable artifact revision. */
    public record AssetProvenance(String sourceVersionRef,
                                  RightsEvidence rightsEvidence) implements Provenance { }

    public enum RightsPurpose { PCM_STEM_MIX }
    public enum RightsDisposition { CLEARED, DENIED, PENDING, UNKNOWN }

    /** Typed evidence binds an exact artifact version, decision, purpose and validity interval. */
    public record RightsEvidence(String sourceVersionRef, String decisionRef,
                                 RightsPurpose purpose, RightsDisposition disposition,
                                 Instant validFrom, Instant validUntil) { }

    public static final class Stem {
        private final String versionRef;
        private final int sampleRate;
        private final int channels;
        private final int bitsPerSample;
        private final byte[] pcmS16Le;
        private final float gain;
        private final float pan;
        private final Provenance provenance;

        public Stem(String versionRef, int sampleRate, int channels, int bitsPerSample,
                    byte[] pcmS16Le, float gain, float pan, Provenance provenance) {
            this.versionRef = versionRef;
            this.sampleRate = sampleRate;
            this.channels = channels;
            this.bitsPerSample = bitsPerSample;
            if (pcmS16Le != null && pcmS16Le.length > MAX_STEM_PCM_BYTES) {
                throw error(ErrorCode.RESOURCE_LIMIT, "one PCM stem exceeds the maximum frame budget");
            }
            this.pcmS16Le = pcmS16Le == null ? null : pcmS16Le.clone();
            this.gain = gain;
            this.pan = pan;
            this.provenance = provenance;
        }

        public String versionRef() { return versionRef; }
        public int sampleRate() { return sampleRate; }
        public int channels() { return channels; }
        public int bitsPerSample() { return bitsPerSample; }
        public byte[] pcmS16Le() { return pcmS16Le == null ? null : pcmS16Le.clone(); }
        public float gain() { return gain; }
        public float pan() { return pan; }
        public Provenance provenance() { return provenance; }
    }

    public record MixSpec(int sampleRate, int frameCount, float truePeakCeiling) { }

    public static final class MixResult {
        private final byte[] pcmS16Le;
        private final byte[] wav;
        private final String pcmSha256;
        private final String wavSha256;
        private final int sampleRate;
        private final int frameCount;
        private final float appliedMasterGain;
        private final double estimatedTruePeakBeforeCeiling;
        private final double estimatedTruePeakAfterCeiling;
        private final double samplePeakAfterCeiling;
        private final double rmsDbfsAfterCeiling;

        private MixResult(byte[] pcmS16Le, byte[] wav, int sampleRate, int frameCount,
                          float appliedMasterGain,
                          double estimatedTruePeakBeforeCeiling,
                          double estimatedTruePeakAfterCeiling,
                          double samplePeakAfterCeiling, double rmsDbfsAfterCeiling) {
            this.pcmS16Le = pcmS16Le.clone();
            this.wav = wav.clone();
            this.pcmSha256 = sha256(this.pcmS16Le);
            this.wavSha256 = sha256(this.wav);
            this.sampleRate = sampleRate;
            this.frameCount = frameCount;
            this.appliedMasterGain = appliedMasterGain;
            this.estimatedTruePeakBeforeCeiling = estimatedTruePeakBeforeCeiling;
            this.estimatedTruePeakAfterCeiling = estimatedTruePeakAfterCeiling;
            this.samplePeakAfterCeiling = samplePeakAfterCeiling;
            this.rmsDbfsAfterCeiling = rmsDbfsAfterCeiling;
        }

        public byte[] pcmS16Le() { return pcmS16Le.clone(); }
        public byte[] wav() { return wav.clone(); }
        public String pcmSha256() { return pcmSha256; }
        public String wavSha256() { return wavSha256; }
        public int sampleRate() { return sampleRate; }
        public int frameCount() { return frameCount; }
        public float appliedMasterGain() { return appliedMasterGain; }
        public double estimatedTruePeakBeforeCeiling() { return estimatedTruePeakBeforeCeiling; }
        public double estimatedTruePeakAfterCeiling() { return estimatedTruePeakAfterCeiling; }
        public double samplePeakAfterCeiling() { return samplePeakAfterCeiling; }
        /** Unweighted stereo sample RMS in dBFS; this is not an ITU-R BS.1770 LUFS measurement. */
        public double rmsDbfsAfterCeiling() { return rmsDbfsAfterCeiling; }
    }

    public MixResult mix(List<Stem> stems, MixSpec spec, Clock clock) {
        Objects.requireNonNull(stems, "stems");
        Objects.requireNonNull(spec, "spec");
        Objects.requireNonNull(clock, "clock");
        validateSpec(spec);
        if (stems.isEmpty() || stems.size() > MAX_STEMS) {
            throw error(ErrorCode.RESOURCE_LIMIT, "stem count must be within 1..=" + MAX_STEMS);
        }

        int expectedBytes = checkedPcmBytes(spec.frameCount());
        long aggregateBytes = 0;
        ArrayList<Stem> acceptedStems = new ArrayList<>(MAX_STEMS);
        ArrayList<byte[]> sources = new ArrayList<>(MAX_STEMS);
        Instant now = clock.instant();
        int stemCount = 0;
        for (Stem stem : stems) {
            if (++stemCount > MAX_STEMS) {
                throw error(ErrorCode.RESOURCE_LIMIT, "stem count exceeds the mixer budget");
            }
            validateStem(stem, spec, now);
            int sourceLength = stem.pcmS16Le.length;
            if (sourceLength != expectedBytes) {
                throw error(ErrorCode.FORMAT_MISMATCH,
                        "all stems must have exactly the requested frame count; no implicit trim or padding is applied");
            }
            aggregateBytes += sourceLength;
            if (aggregateBytes > MAX_AGGREGATE_INPUT_BYTES) {
                throw error(ErrorCode.RESOURCE_LIMIT, "aggregate PCM input exceeds the byte budget");
            }
            acceptedStems.add(stem);
            sources.add(stem.pcmS16Le.clone());
        }
        if (acceptedStems.isEmpty()) {
            throw error(ErrorCode.RESOURCE_LIMIT, "stem count must be within 1..=" + MAX_STEMS);
        }

        double[] sums = new double[expectedBytes / 2];
        for (int stemIndex = 0; stemIndex < acceptedStems.size(); stemIndex++) {
            Stem stem = acceptedStems.get(stemIndex);
            byte[] source = sources.get(stemIndex);
            double gain = stem.gain();
            double leftPan = stem.pan() > 0 ? 1.0 - stem.pan() : 1.0;
            double rightPan = stem.pan() < 0 ? 1.0 + stem.pan() : 1.0;
            for (int frame = 0; frame < spec.frameCount(); frame++) {
                int offset = frame * BYTES_PER_FRAME;
                sums[frame * CHANNELS] += decode(source, offset) * gain * leftPan;
                sums[frame * CHANNELS + 1] += decode(source, offset + 2) * gain * rightPan;
            }
        }

        double peakBefore = estimateTruePeak(spec.frameCount(),
                (frame, channel) -> sums[frame * CHANNELS + channel] / 32768.0);
        double ceiling = spec.truePeakCeiling();
        double guardedPeak = peakBefore * TRUE_PEAK_HEADROOM;
        double limiterGain = guardedPeak <= ceiling || guardedPeak == 0.0 ? 1.0 : ceiling / guardedPeak;
        byte[] pcm = new byte[expectedBytes];
        double samplePeak = 0.0;
        double sumSquares = 0.0;
        for (int index = 0; index < sums.length; index++) {
            double normalized = sums[index] / 32768.0 * limiterGain;
            int quantized = (int) Math.round(normalized * 32768.0);
            if (quantized < Short.MIN_VALUE || quantized > Short.MAX_VALUE) {
                throw error(ErrorCode.ENCODE_FAILED, "peak ceiling failed to prevent PCM clipping");
            }
            samplePeak = Math.max(samplePeak, Math.abs(quantized / 32768.0));
            double normalizedSample = quantized / 32768.0;
            sumSquares += normalizedSample * normalizedSample;
            pcm[index * 2] = (byte) quantized;
            pcm[index * 2 + 1] = (byte) (quantized >>> 8);
        }
        double peakAfter = estimateTruePeak(spec.frameCount(),
                (frame, channel) -> decode(pcm, frame * BYTES_PER_FRAME + channel * 2) / 32768.0);
        double rms = Math.sqrt(sumSquares / sums.length);
        double rmsDbfs = rms == 0.0 ? Double.NEGATIVE_INFINITY : 20.0 * Math.log10(rms);
        return new MixResult(pcm, encodeWav(pcm, spec.sampleRate()), spec.sampleRate(),
                spec.frameCount(), (float) limiterGain, peakBefore, peakAfter, samplePeak, rmsDbfs);
    }

    private static void validateSpec(MixSpec spec) {
        if (spec.frameCount() > MAX_FRAMES) {
            throw error(ErrorCode.RESOURCE_LIMIT, "requested frame count exceeds the mixer budget");
        }
        if (spec.sampleRate() < 8_000 || spec.sampleRate() > 192_000
                || spec.frameCount() <= 0 || !Float.isFinite(spec.truePeakCeiling())
                || spec.truePeakCeiling() <= 0.0f || spec.truePeakCeiling() > MAX_CEILING) {
            throw error(ErrorCode.INVALID_INPUT,
                    "mix requires explicit bounded sample rate, frame count and a (0, 0.98] peak ceiling");
        }
        checkedPcmBytes(spec.frameCount());
    }

    private static int checkedPcmBytes(int frames) {
        try {
            return Math.multiplyExact(frames, BYTES_PER_FRAME);
        } catch (ArithmeticException overflow) {
            throw error(ErrorCode.RESOURCE_LIMIT, "PCM output byte count overflow");
        }
    }

    private static void validateStem(Stem stem, MixSpec spec, Instant now) {
        if (stem == null || blank(stem.versionRef()) || stem.pcmS16Le == null) {
            throw error(ErrorCode.INVALID_INPUT, "stem requires immutable version identity and PCM bytes");
        }
        if (stem.sampleRate() != spec.sampleRate() || stem.channels() != CHANNELS
                || stem.bitsPerSample() != BITS_PER_SAMPLE) {
            throw error(ErrorCode.FORMAT_MISMATCH, "stem must be signed 16-bit stereo PCM at the requested rate");
        }
        if (!Float.isFinite(stem.gain()) || stem.gain() < 0 || stem.gain() > MAX_STEM_GAIN
                || !Float.isFinite(stem.pan()) || Math.abs(stem.pan()) > MAX_ABS_PAN) {
            throw error(ErrorCode.INVALID_INPUT, "stem gain or pan is outside the bounded range");
        }
        if (stem.provenance() instanceof SyntheticProvenance synthetic) {
            if (blank(synthetic.algorithmId()) || blank(synthetic.algorithmVersion())
                    || blank(synthetic.parameterDigest())) {
                throw error(ErrorCode.INVALID_INPUT, "synthetic stem requires algorithm provenance");
            }
            return;
        }
        if (!(stem.provenance() instanceof AssetProvenance asset)) {
            throw error(ErrorCode.RIGHTS_MISSING,
                    "stem must carry algorithm provenance or exact source and rights evidence");
        }
        if (blank(asset.sourceVersionRef()) || asset.rightsEvidence() == null) {
            throw error(ErrorCode.RIGHTS_MISSING, "asset stem is missing version-bound rights evidence");
        }
        if (!stem.versionRef().equals(asset.sourceVersionRef())) {
            throw error(ErrorCode.RIGHTS_MISSING,
                    "asset stem version must match the exact source version bound by its rights evidence");
        }
        RightsEvidence evidence = asset.rightsEvidence();
        if (blank(evidence.sourceVersionRef()) || blank(evidence.decisionRef())
                || evidence.purpose() == null || evidence.disposition() == null
                || evidence.validFrom() == null || evidence.validUntil() == null
                || !evidence.sourceVersionRef().equals(asset.sourceVersionRef())) {
            throw error(ErrorCode.RIGHTS_MISSING, "rights evidence must bind an exact source version and purpose");
        }
        if (evidence.disposition() != RightsDisposition.CLEARED) {
            throw error(ErrorCode.RIGHTS_DENIED, "asset rights disposition is not cleared");
        }
        if (evidence.purpose() != RightsPurpose.PCM_STEM_MIX) {
            throw error(ErrorCode.RIGHTS_DENIED, "asset rights decision does not cover PCM stem mixing");
        }
        if (now.isBefore(evidence.validFrom()) || !now.isBefore(evidence.validUntil())) {
            throw error(ErrorCode.RIGHTS_STALE, "asset rights decision is outside its validity interval");
        }
    }

    private static double decode(byte[] pcm, int offset) {
        short sample = (short) ((pcm[offset] & 0xff) | (pcm[offset + 1] << 8));
        return sample;
    }

    @FunctionalInterface
    private interface SampleReader {
        double sample(int frame, int channel);
    }

    /** 4x windowed-sinc oversampling estimate, with edge replication. */
    private static double estimateTruePeak(int frames, SampleReader samples) {
        double peak = 0.0;
        for (int channel = 0; channel < CHANNELS; channel++) {
            for (int frame = 0; frame < frames; frame++) {
                double current = samples.sample(frame, channel);
                peak = Math.max(peak, Math.abs(current));
                for (int step = 1; step < TRUE_PEAK_OVERSAMPLE; step++) {
                    double position = frame + step / (double) TRUE_PEAK_OVERSAMPLE;
                    peak = Math.max(peak, Math.abs(interpolateSinc(samples, frames, channel, position)));
                }
            }
        }
        return peak;
    }

    private static double interpolateSinc(SampleReader samples, int frames, int channel, double position) {
        int center = (int) Math.floor(position);
        double weighted = 0;
        double weightTotal = 0;
        for (int index = center - TRUE_PEAK_KERNEL_RADIUS + 1;
             index <= center + TRUE_PEAK_KERNEL_RADIUS; index++) {
            double offset = index - position;
            if (Math.abs(offset) >= TRUE_PEAK_KERNEL_RADIUS) continue;
            double windowPosition = offset / TRUE_PEAK_KERNEL_RADIUS;
            double window = 0.42 + 0.5 * Math.cos(Math.PI * windowPosition)
                    + 0.08 * Math.cos(2.0 * Math.PI * windowPosition);
            double sinc = Math.abs(offset) < 1e-12 ? 1.0
                    : Math.sin(Math.PI * offset) / (Math.PI * offset);
            double weight = window * sinc;
            int sourceFrame = Math.max(0, Math.min(frames - 1, index));
            weighted += samples.sample(sourceFrame, channel) * weight;
            weightTotal += weight;
        }
        return weightTotal == 0.0 ? samples.sample(center, channel) : weighted / weightTotal;
    }

    private static double estimateTruePeak(byte[] pcm, int frames) {
        return estimateTruePeak(frames, (frame, channel) ->
                decode(pcm, frame * BYTES_PER_FRAME + channel * 2) / 32768.0);
    }

    private static double estimateTruePeak(byte[] pcm) {
        int frames = pcm.length / BYTES_PER_FRAME;
        return estimateTruePeak(pcm, frames);
    }

    private static byte[] encodeWav(byte[] pcm, int sampleRate) {
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(44 + pcm.length);
            DataOutputStream out = new DataOutputStream(bytes);
            writeAscii(out, "RIFF");
            writeIntLe(out, 36 + pcm.length);
            writeAscii(out, "WAVEfmt ");
            writeIntLe(out, 16);
            writeShortLe(out, 1);
            writeShortLe(out, CHANNELS);
            writeIntLe(out, sampleRate);
            writeIntLe(out, sampleRate * BYTES_PER_FRAME);
            writeShortLe(out, BYTES_PER_FRAME);
            writeShortLe(out, BITS_PER_SAMPLE);
            writeAscii(out, "data");
            writeIntLe(out, pcm.length);
            out.write(pcm);
            out.flush();
            return bytes.toByteArray();
        } catch (IOException impossibleForMemoryStream) {
            throw new MixException(ErrorCode.ENCODE_FAILED, "WAV encoding failed", impossibleForMemoryStream);
        }
    }

    private static void writeAscii(DataOutputStream out, String value) throws IOException {
        out.write(value.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
    }

    private static void writeShortLe(DataOutputStream out, int value) throws IOException {
        out.writeByte(value & 0xff);
        out.writeByte((value >>> 8) & 0xff);
    }

    private static void writeIntLe(DataOutputStream out, int value) throws IOException {
        out.writeByte(value & 0xff);
        out.writeByte((value >>> 8) & 0xff);
        out.writeByte((value >>> 16) & 0xff);
        out.writeByte((value >>> 24) & 0xff);
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("JDK SHA-256 is unavailable", impossible);
        }
    }

    private static boolean blank(String value) { return value == null || value.isBlank(); }

    private static MixException error(ErrorCode code, String message) {
        return new MixException(code, message);
    }
}
