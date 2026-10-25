package com.ghatana.media.stt.api;

import java.time.Duration;
import java.util.List;

/**
 * Transcription result. Callers must inspect {@link #confidenceAvailability()} before
 * interpreting {@link #confidence()}; unavailable scores use the primitive zero placeholder
 * only because the legacy accessor cannot be nullable.
 *
 * @doc.type record
 * @doc.purpose Immutable STT transcription result payload
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record TranscriptionResult(
    String text,
    double confidence,
    List<WordTiming> words,
    List<Alternative> alternatives,
    Duration processingTime,
    String language,
    String modelId,
    ConfidenceAvailability confidenceAvailability
) {
    /** Preserve the original constructor contract: supplied numeric confidence is available. */
    public TranscriptionResult(String text, double confidence, List<WordTiming> words,
            List<Alternative> alternatives, Duration processingTime, String language, String modelId) {
        this(text, confidence, words, alternatives, processingTime, language, modelId,
                ConfidenceAvailability.AVAILABLE);
    }

    public TranscriptionResult {
        if (confidenceAvailability == null) throw new NullPointerException("confidenceAvailability");
        if (confidenceAvailability == ConfidenceAvailability.UNAVAILABLE
                && (Double.doubleToLongBits(confidence) != Double.doubleToLongBits(0.0d))) {
            throw new IllegalArgumentException("Unavailable confidence must not carry a numeric score");
        }
    }

    public static TranscriptionResult withoutConfidence(String text, List<WordTiming> words,
            List<Alternative> alternatives, Duration processingTime, String language, String modelId) {
        return new TranscriptionResult(text, 0.0d, words, alternatives, processingTime, language, modelId,
                ConfidenceAvailability.UNAVAILABLE);
    }

    public boolean hasConfidence() {
        return confidenceAvailability == ConfidenceAvailability.AVAILABLE;
    }

    public enum ConfidenceAvailability { AVAILABLE, UNAVAILABLE }

    public String getText() {
        return text;
    }
}
