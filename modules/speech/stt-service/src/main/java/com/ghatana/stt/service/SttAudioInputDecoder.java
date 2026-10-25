package com.ghatana.stt.service;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.common.validation.MediaFormatValidator;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.time.Duration;
import java.util.Locale;

/** Validates and decodes only the audio encodings supported by the current STT engine boundary. */
public final class SttAudioInputDecoder {
    public static final long MAX_INPUT_BYTES = 100L * 1024 * 1024;
    public static final long MAX_DECODED_PCM_BYTES = 100L * 1024 * 1024;
    public static final int MIN_SAMPLE_RATE = 8_000;
    public static final int MAX_SAMPLE_RATE = 48_000;

    public enum FailureKind { INVALID_ARGUMENT, RESOURCE_EXHAUSTED, NOT_ADMITTED }

    public static final class InputException extends IllegalArgumentException {
        private final FailureKind kind;

        public InputException(FailureKind kind, String message) {
            super(message);
            this.kind = kind;
        }

        public FailureKind kind() { return kind; }
    }

    private SttAudioInputDecoder() { }

    private record PcmWavInfo(
            int sampleRate, int channels, int bitsPerSample,
            int dataOffset, int dataSize, Duration duration) { }

    /** Inspect a supported WAV clock without allocating or copying its decoded PCM payload. */
    public static Duration inspectWavDuration(byte[] wav, int requestedSampleRate) {
        if (wav == null) throw invalid("Audio data cannot be null");
        requireInputSize(wav.length);
        requireSampleRate(requestedSampleRate);
        return inspectPcmWav(wav, requestedSampleRate).duration();
    }

    /** Checks a declared size before a protobuf or decoded byte array is materialized. */
    public static void requireInputSize(long size) {
        if (size <= 0) {
            throw invalid("Audio data cannot be empty");
        }
        if (size > MAX_INPUT_BYTES) {
            throw new InputException(FailureKind.RESOURCE_EXHAUSTED,
                    "STT_AUDIO_TOO_LARGE: audio data exceeds the 100 MiB input limit");
        }
    }

    /**
     * Decode WAV or explicit raw PCM to the PCM representation consumed by SttEngine.
     * Compressed formats are recognized and rejected until a decoder is admitted.
     */
    public static AudioData decode(byte[] input, AudioFormat declaredFormat, int requestedSampleRate) {
        if (input == null) throw invalid("Audio data cannot be null");
        requireInputSize(input.length);
        requireSampleRate(requestedSampleRate);

        String detected = MediaFormatValidator.detectAudioFormat(input);
        if (declaredFormat == AudioFormat.WAV || (declaredFormat == null && "WAV".equals(detected))) {
            if (!"WAV".equals(detected)) throw invalid("STT_AUDIO_INVALID_HEADER: expected a valid RIFF/WAVE container");
            return decodePcmWav(input, requestedSampleRate);
        }

        if (declaredFormat == AudioFormat.PCM || (declaredFormat == null && "UNKNOWN".equals(detected))) {
            if (startsWithRiff(input) || !"UNKNOWN".equals(detected)) {
                throw invalid("STT_AUDIO_INVALID_HEADER: audio container does not match the declared PCM input");
            }
            if ((input.length & 1) != 0) throw invalid("STT_AUDIO_INCOMPLETE_FRAME: PCM S16LE must contain complete samples");
            requireDecodedSize(input.length);
            long frames = input.length / 2L;
            return new AudioData(input, requestedSampleRate, 1, 16,
                    durationForFrames(frames, requestedSampleRate), AudioFormat.PCM);
        }

        String format = declaredFormat == null ? detected : declaredFormat.name();
        if ("UNKNOWN".equals(format)) {
            throw invalid("STT_AUDIO_INVALID_HEADER: unable to identify audio container");
        }
        throw new InputException(FailureKind.NOT_ADMITTED,
                "STT_AUDIO_FORMAT_NOT_ADMITTED: no qualified decoder is available for "
                        + format.toUpperCase(Locale.ROOT));
    }

    public static void requireSampleRate(int sampleRate) {
        if (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
            throw invalid("STT_AUDIO_SAMPLE_RATE_INVALID: sample rate must be between "
                    + MIN_SAMPLE_RATE + " and " + MAX_SAMPLE_RATE + " Hz");
        }
    }

    private static AudioData decodePcmWav(byte[] wav, int requestedSampleRate) {
        PcmWavInfo info = inspectPcmWav(wav, requestedSampleRate);
        // Allocation happens only after full header, rate, channel, frame and size validation.
        byte[] pcm = new byte[info.dataSize()];
        System.arraycopy(wav, info.dataOffset(), pcm, 0, pcm.length);
        return new AudioData(pcm, info.sampleRate(), info.channels(), info.bitsPerSample(),
                info.duration(), AudioFormat.PCM);
    }

    private static PcmWavInfo inspectPcmWav(byte[] wav, int requestedSampleRate) {
        var validation = MediaFormatValidator.validateAudio(wav, "WAV", 0);
        if (!validation.valid || validation.warning) {
            throw invalid("STT_AUDIO_INVALID_WAV: " + validation.errorMessage);
        }
        if (validation.sampleRate != requestedSampleRate) {
            throw invalid("STT_AUDIO_SAMPLE_RATE_MISMATCH: request sample rate differs from WAV fmt chunk");
        }
        if (validation.bitsPerSample != 16) {
            throw new InputException(FailureKind.NOT_ADMITTED,
                    "STT_AUDIO_FORMAT_NOT_ADMITTED: only PCM S16LE WAV is currently supported");
        }
        // Both current Whisper adapters convert each S16LE pair directly to one
        // mono sample and do not downmix/interleave channels. Do not label stereo
        // input as correctly decoded mono audio.
        if (validation.channels != 1) {
            throw new InputException(FailureKind.NOT_ADMITTED,
                    "STT_AUDIO_CHANNEL_LAYOUT_NOT_ADMITTED: current STT engines support mono PCM only");
        }

        ByteBuffer bytes = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        long riffEnd = 8L + Integer.toUnsignedLong(bytes.getInt(4));
        int offset = 12;
        long dataOffset = -1;
        long dataSize = -1;
        while ((long) offset + 8 <= riffEnd) {
            long chunkSize = Integer.toUnsignedLong(bytes.getInt(offset + 4));
            long chunkEnd = (long) offset + 8 + chunkSize;
            if (chunkEnd > riffEnd || chunkEnd > wav.length) {
                throw invalid("STT_AUDIO_INVALID_WAV: chunk exceeds RIFF bounds");
            }
            if (wav[offset] == 'd' && wav[offset + 1] == 'a'
                    && wav[offset + 2] == 't' && wav[offset + 3] == 'a') {
                dataOffset = offset + 8L;
                dataSize = chunkSize;
                break;
            }
            long paddedEnd = chunkEnd + (chunkSize & 1L);
            if (paddedEnd > Integer.MAX_VALUE) throw invalid("STT_AUDIO_INVALID_WAV: chunk offset overflow");
            offset = (int) paddedEnd;
        }
        if (dataOffset < 0 || dataSize <= 0) throw invalid("STT_AUDIO_INVALID_WAV: missing PCM data chunk");
        requireDecodedSize(dataSize);
        int blockAlign = validation.channels * 2;
        if (dataSize % blockAlign != 0) {
            throw invalid("STT_AUDIO_INCOMPLETE_FRAME: WAV data chunk ends with a partial audio frame");
        }
        if (dataOffset + dataSize > wav.length || dataSize > Integer.MAX_VALUE) {
            throw invalid("STT_AUDIO_INVALID_WAV: PCM data range is invalid");
        }
        long frames = dataSize / blockAlign;
        return new PcmWavInfo(validation.sampleRate, validation.channels, 16,
                (int) dataOffset, (int) dataSize, durationForFrames(frames, validation.sampleRate));
    }

    private static void requireDecodedSize(long size) {
        if (size <= 0) throw invalid("STT_AUDIO_EMPTY_DECODED: decoded PCM contains no samples");
        if (size > MAX_DECODED_PCM_BYTES) {
            throw new InputException(FailureKind.RESOURCE_EXHAUSTED,
                    "STT_AUDIO_DECODED_TOO_LARGE: decoded PCM exceeds the 100 MiB limit");
        }
    }

    private static Duration durationForFrames(long frames, int sampleRate) {
        long nanos = Math.multiplyExact(frames, 1_000_000_000L) / sampleRate;
        return Duration.ofNanos(nanos);
    }

    private static boolean startsWithRiff(byte[] bytes) {
        return bytes.length >= 4 && bytes[0] == 'R' && bytes[1] == 'I'
                && bytes[2] == 'F' && bytes[3] == 'F';
    }

    private static InputException invalid(String message) {
        return new InputException(FailureKind.INVALID_ARGUMENT, message);
    }
}
