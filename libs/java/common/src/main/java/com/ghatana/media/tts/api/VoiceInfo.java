package com.ghatana.media.tts.api;

import java.util.Locale;

/**
 * Information about a voice.
 *
 * @doc.type record
 * @doc.purpose Metadata for an available TTS voice
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record VoiceInfo(
    String voiceId,
    String name,
    String description,
    Locale language,
    Gender gender,
    int sampleRate,
    boolean isCloned,
    long modelSizeBytes,
    /**
     * Speaker similarity score in [0.0, 1.0].
     * Built-in voices are {@code 1.0f} (reference quality).
     * Cloned voices carry a heuristic score based on sample count and training epochs;
     * a real ML-computed speaker-verification score replaces this once the engine
     * exposes one via the native API.
     */
    float similarityScore
) {
    public enum Gender {
        MALE, FEMALE, NEUTRAL
    }
}
