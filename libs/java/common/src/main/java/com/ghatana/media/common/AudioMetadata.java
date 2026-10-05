package com.ghatana.media.common;

import java.time.Duration;

/**
 * Extracted metadata for an audio payload or container.
 *
 * @doc.type record
 * @doc.purpose Describe audio payload structure independently of engine-specific models
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record AudioMetadata(
    int sampleRate,
    int channels,
    int bitsPerSample,
    long sampleCount,
    Duration duration,
    String containerFormat
) {
}
