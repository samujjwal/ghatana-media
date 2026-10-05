package com.ghatana.media.common;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Objects;

/**
 * Metadata extraction helpers for canonical audio payloads and WAV containers.
 *
 * @doc.type class
 * @doc.purpose Extract audio metadata without binding callers to engine implementations
 * @doc.layer platform
 * @doc.pattern Utility
 */
public final class AudioMetadataExtractor {

    private AudioMetadataExtractor() {}

    /** Extract metadata from canonical AudioData. */
    public static AudioMetadata fromAudioData(AudioData audio) {
        Objects.requireNonNull(audio, "audio cannot be null");
        long sampleCount = audio.getSampleCount();
        Duration duration = audio.duration() != null
            ? audio.duration()
            : Duration.ofNanos(Math.round((sampleCount * 1_000_000_000d) / audio.sampleRate()));
        return new AudioMetadata(
            audio.sampleRate(),
            audio.channels(),
            audio.bitsPerSample(),
            sampleCount,
            duration,
            audio.format().name()
        );
    }

    /** Extract metadata from a WAV byte buffer. */
    public static AudioMetadata fromWavBytes(byte[] data) {
        Objects.requireNonNull(data, "data cannot be null");
        if (data.length < 44) {
            throw new ValidationError("WAV data too small to contain a valid header");
        }
        if (!matches(data, 0, "RIFF") || !matches(data, 8, "WAVE")) {
            throw new ValidationError("Invalid WAV header");
        }

        int offset = 12;
        Integer sampleRate = null;
        Integer channels = null;
        Integer bitsPerSample = null;
        Integer dataSize = null;

        while (offset + 8 <= data.length) {
            String chunkId = new String(data, offset, 4, StandardCharsets.US_ASCII);
            int chunkSize = readLittleEndianInt(data, offset + 4);
            int chunkDataOffset = offset + 8;
            if ("fmt ".equals(chunkId) && chunkDataOffset + 16 <= data.length) {
                channels = readLittleEndianShort(data, chunkDataOffset + 2);
                sampleRate = readLittleEndianInt(data, chunkDataOffset + 4);
                bitsPerSample = readLittleEndianShort(data, chunkDataOffset + 14);
            } else if ("data".equals(chunkId)) {
                dataSize = Math.max(0, Math.min(chunkSize, data.length - chunkDataOffset));
            }

            offset += 8 + chunkSize;
            if ((chunkSize & 1) == 1) {
                offset++;
            }
        }

        if (sampleRate == null || channels == null || bitsPerSample == null) {
            throw new ValidationError("WAV fmt chunk missing required audio metadata");
        }

        int bytesPerSample = Math.max(1, bitsPerSample / 8);
        long sampleCount = dataSize == null ? 0L : dataSize / (long) (channels * bytesPerSample);
        long durationNanos = Math.round((sampleCount * 1_000_000_000d) / sampleRate);
        return new AudioMetadata(
            sampleRate,
            channels,
            bitsPerSample,
            sampleCount,
            Duration.ofNanos(Math.max(0L, durationNanos)),
            "WAV"
        );
    }

    private static boolean matches(byte[] data, int offset, String expected) {
        if (offset + expected.length() > data.length) {
            return false;
        }
        return new String(data, offset, expected.length(), StandardCharsets.US_ASCII).equals(expected);
    }

    private static int readLittleEndianShort(byte[] data, int offset) {
        return (data[offset] & 0xFF) | ((data[offset + 1] & 0xFF) << 8);
    }

    private static int readLittleEndianInt(byte[] data, int offset) {
        return (data[offset] & 0xFF)
            | ((data[offset + 1] & 0xFF) << 8)
            | ((data[offset + 2] & 0xFF) << 16)
            | ((data[offset + 3] & 0xFF) << 24);
    }
}
