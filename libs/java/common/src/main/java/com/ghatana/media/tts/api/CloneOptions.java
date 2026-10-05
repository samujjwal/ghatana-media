package com.ghatana.media.tts.api;

import java.time.Duration;

/**
 * Voice cloning options.
 *
 * @doc.type record
 * @doc.purpose Immutable TTS voice cloning options
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record CloneOptions(int epochs, float learningRate, int samplesRequired, Duration minSampleDuration) {
    public static CloneOptions defaults() {
        return new CloneOptions(100, 0.001f, 3, Duration.ofSeconds(5));
    }
}
