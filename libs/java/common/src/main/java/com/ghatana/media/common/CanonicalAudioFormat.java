package com.ghatana.media.common;

/**
 * Canonical audio stream descriptor shared across language boundaries.
 *
 * @doc.type record
 * @doc.purpose Canonical audio format descriptor for cross-platform media contracts
 * @doc.layer common
 * @doc.pattern ValueObject
 */
public record CanonicalAudioFormat(
    int sampleRate,
    int channels,
    int bitsPerSample,
    AudioFormat format
) {
    public CanonicalAudioFormat {
        if (sampleRate <= 0) {
            throw new IllegalArgumentException("sampleRate must be positive");
        }
        if (channels <= 0) {
            throw new IllegalArgumentException("channels must be positive");
        }
        if (bitsPerSample <= 0) {
            throw new IllegalArgumentException("bitsPerSample must be positive");
        }
    }
}
