package com.ghatana.media.common;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Objects;

/**
 * Metadata extraction helpers for canonical audio payloads and basic PCM WAV containers.
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

    /**
     * Extract metadata from a PCM WAV byte buffer.
     * Compressed and extensible WAV encodings are deliberately outside this
     * parser's scope and fail closed rather than receiving guessed metadata.
     */
    public static AudioMetadata fromWavBytes(byte[] data) {
        Objects.requireNonNull(data, "data cannot be null");
        if (data.length < 12) {
            throw new ValidationError("WAV data too small to contain a RIFF header");
        }
        if (!matches(data, 0, "RIFF") || !matches(data, 8, "WAVE")) {
            throw new ValidationError("Invalid WAV header");
        }

        long riffEnd = 8L + readUnsignedLittleEndianInt(data, 4);
        if (riffEnd < 12L || riffEnd > data.length || riffEnd != data.length) {
            throw new ValidationError("WAV RIFF size is outside available data");
        }

        long offset = 12L;
        Integer sampleRate = null;
        Integer channels = null;
        Integer bitsPerSample = null;
        Integer blockAlign = null;
        Long byteRate = null;
        Long dataSize = null;
        boolean formatSeen = false;
        while (offset <= riffEnd - 8L) {
            int chunkOffset = Math.toIntExact(offset);
            String chunkId = new String(data, chunkOffset, 4, StandardCharsets.US_ASCII);
            long chunkSize = readUnsignedLittleEndianInt(data, chunkOffset + 4);
            long chunkDataOffset = offset + 8L;
            long chunkEnd = chunkDataOffset + chunkSize;
            if (chunkEnd < chunkDataOffset || chunkEnd > riffEnd) {
                throw new ValidationError("WAV chunk exceeds RIFF bounds");
            }
            long paddedChunkEnd = chunkEnd + (chunkSize & 1L);
            if (paddedChunkEnd < chunkEnd || paddedChunkEnd > riffEnd) {
                throw new ValidationError("WAV chunk padding exceeds RIFF bounds");
            }

            if ("fmt ".equals(chunkId)) {
                if (formatSeen) {
                    throw new ValidationError("WAV contains duplicate fmt chunks");
                }
                if (chunkSize < 16L) {
                    throw new ValidationError("WAV fmt chunk is shorter than the PCM header");
                }
                formatSeen = true;
                int fmtOffset = Math.toIntExact(chunkDataOffset);
                int audioFormat = readLittleEndianShort(data, fmtOffset);
                if (audioFormat != 1) {
                    throw new ValidationError("Unsupported WAV encoding; PCM is required");
                }
                channels = readLittleEndianShort(data, fmtOffset + 2);
                long sampleRateValue = readUnsignedLittleEndianInt(data, fmtOffset + 4);
                if (sampleRateValue > Integer.MAX_VALUE) {
                    throw new ValidationError("WAV sample rate exceeds supported range");
                }
                sampleRate = (int) sampleRateValue;
                byteRate = readUnsignedLittleEndianInt(data, fmtOffset + 8);
                blockAlign = readLittleEndianShort(data, fmtOffset + 12);
                bitsPerSample = readLittleEndianShort(data, fmtOffset + 14);
            } else if ("data".equals(chunkId)) {
                if (!formatSeen) {
                    throw new ValidationError("WAV data precedes fmt chunk");
                }
                if (dataSize != null) {
                    throw new ValidationError("WAV contains duplicate data chunks");
                }
                dataSize = chunkSize;
            }

            offset = paddedChunkEnd;
        }

        if (offset != riffEnd) {
            throw new ValidationError("WAV has an incomplete trailing chunk header");
        }
        if (!formatSeen || sampleRate == null || channels == null || bitsPerSample == null
                || blockAlign == null || byteRate == null) {
            throw new ValidationError("WAV fmt chunk missing required audio metadata");
        }
        if (dataSize == null) {
            throw new ValidationError("WAV data chunk missing");
        }
        if (sampleRate <= 0 || channels <= 0 || bitsPerSample <= 0 || bitsPerSample % 8 != 0) {
            throw new ValidationError("WAV PCM metadata values must be positive whole-byte values");
        }
        long bytesPerFrame = (long) channels * (bitsPerSample / 8L);
        long expectedByteRate = (long) sampleRate * bytesPerFrame;
        if (bytesPerFrame > 0xFFFFL || blockAlign.longValue() != bytesPerFrame
                || expectedByteRate > 0xFFFF_FFFFL || byteRate.longValue() != expectedByteRate) {
            throw new ValidationError("WAV PCM byte rate or block alignment disagrees with its format");
        }
        if (bytesPerFrame <= 0L || dataSize == 0L || dataSize % bytesPerFrame != 0L) {
            throw new ValidationError("WAV PCM data must contain complete nonempty sample frames");
        }
        long sampleCount = dataSize / bytesPerFrame;
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

    private static long readUnsignedLittleEndianInt(byte[] data, int offset) {
        return Integer.toUnsignedLong((data[offset] & 0xFF)
            | ((data[offset + 1] & 0xFF) << 8)
            | ((data[offset + 2] & 0xFF) << 16)
            | ((data[offset + 3] & 0xFF) << 24));
    }
}
