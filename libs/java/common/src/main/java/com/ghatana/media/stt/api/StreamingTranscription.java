package com.ghatana.media.stt.api;

import java.util.List;

/**
 * Streaming transcription output. Callers must inspect {@link #confidenceAvailability()}
 * before interpreting the primitive confidence value.
 *
 * @doc.type record
 * @doc.purpose Incremental STT streaming transcription result
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record StreamingTranscription(String text, boolean isFinal, double confidence, List<WordTiming> words,
        TranscriptionResult.ConfidenceAvailability confidenceAvailability) {
    public StreamingTranscription(String text, boolean isFinal, double confidence, List<WordTiming> words) {
        this(text, isFinal, confidence, words, TranscriptionResult.ConfidenceAvailability.AVAILABLE);
    }

    public StreamingTranscription {
        if (confidenceAvailability == null) throw new NullPointerException("confidenceAvailability");
        if (confidenceAvailability == TranscriptionResult.ConfidenceAvailability.UNAVAILABLE
                && Double.doubleToLongBits(confidence) != Double.doubleToLongBits(0.0d)) {
            throw new IllegalArgumentException("Unavailable confidence must not carry a numeric score");
        }
    }

    public boolean hasConfidence() {
        return confidenceAvailability == TranscriptionResult.ConfidenceAvailability.AVAILABLE;
    }
}
