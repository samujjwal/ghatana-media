package com.ghatana.tts.engine;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;

import java.time.Duration;

/** Strict validation and measurements for the PCM S16LE format currently exposed by TTS. */
public final class PcmAudioValidator {
    public static final int MAX_AUDIO_BYTES = 50 * 1024 * 1024;

    private PcmAudioValidator() { }

    /** Validated facts derived from PCM bytes; RMS/peak are measurements, not calibrated loudness claims. */
    public record PcmFacts(long frames, Duration duration, double rms, double peak) { }

    public static PcmFacts validate(AudioData audio) {
        return validate(audio, -1);
    }

    public static PcmFacts validate(AudioData audio, int expectedSampleRate) {
        return validate(audio, expectedSampleRate, -1);
    }

    public static PcmFacts validate(AudioData audio, int expectedSampleRate, int expectedChannels) {
        if (audio == null) throw new IllegalStateException("TTS provider returned no audio metadata");
        if (audio.format() != AudioFormat.PCM || audio.bitsPerSample() != 16) {
            throw new IllegalStateException("TTS output must be raw PCM S16LE; encoded/container output is not admitted");
        }
        if (audio.sampleRate() < 8_000 || audio.sampleRate() > 96_000) {
            throw new IllegalStateException("TTS PCM sample rate is outside the supported validation range");
        }
        if (expectedSampleRate > 0 && audio.sampleRate() != expectedSampleRate) {
            throw new IllegalStateException("TTS PCM sample rate does not match the requested sample rate");
        }
        if (audio.channels() < 1 || audio.channels() > 2) {
            throw new IllegalStateException("TTS PCM channel count must be one or two");
        }
        if (expectedChannels > 0 && audio.channels() != expectedChannels) {
            throw new IllegalStateException("TTS PCM channels do not match the response contract");
        }
        byte[] bytes = audio.data();
        if (bytes.length == 0 || bytes.length > MAX_AUDIO_BYTES) {
            throw new IllegalStateException("TTS PCM payload is empty or exceeds the output byte limit");
        }
        int bytesPerFrame = Math.multiplyExact(audio.channels(), 2);
        if (bytes.length % bytesPerFrame != 0) {
            throw new IllegalStateException("TTS PCM payload contains a partial sample frame");
        }
        long frames = bytes.length / bytesPerFrame;
        long durationNumerator = Math.multiplyExact(frames, 1_000L);
        long durationMillis = durationNumerator / audio.sampleRate();
        long durationRemainder = durationNumerator % audio.sampleRate();
        // Round the exact rational frame clock to the nearest millisecond, with
        // ties rounded up. The validated payload limit keeps numerator bounded.
        if (durationRemainder * 2L >= audio.sampleRate()) durationMillis++;
        if (durationMillis <= 0) {
            throw new IllegalStateException("TTS PCM duration rounds to zero milliseconds");
        }
        Duration measuredDuration = Duration.ofMillis(durationMillis);
        Duration claimed = audio.duration();
        if (claimed == null || claimed.isNegative() || claimed.isZero() || !claimed.equals(measuredDuration)) {
            throw new IllegalStateException("TTS PCM duration metadata does not match frame count and sample rate");
        }
        double sumSquares = 0.0d;
        double peak = 0.0d;
        short firstSample = 0;
        boolean hasDifferentSample = false;
        for (int i = 0; i < bytes.length; i += 2) {
            short sample = (short) ((bytes[i] & 0xff) | (bytes[i + 1] << 8));
            if (i == 0) firstSample = sample;
            else if (sample != firstSample) hasDifferentSample = true;
            double normalized = sample / 32768.0d;
            sumSquares += normalized * normalized;
            peak = Math.max(peak, Math.abs(normalized));
        }
        // A non-empty, correctly labeled PCM buffer can still be the old fixed-byte
        // placeholder (or digital silence). Reject a flatline before it can be reported
        // as synthesized speech. This is only a basic signal-integrity guard; it does
        // not establish intelligibility or provider quality.
        if (!hasDifferentSample) {
            throw new IllegalStateException("TTS PCM payload contains no sample variation");
        }
        double rms = Math.sqrt(sumSquares / (bytes.length / 2.0d));
        if (!Double.isFinite(rms) || !Double.isFinite(peak) || rms > 1.0d || peak > 1.0d) {
            throw new IllegalStateException("TTS PCM loudness measurement is invalid");
        }
        return new PcmFacts(frames, measuredDuration, rms, peak);
    }
}
