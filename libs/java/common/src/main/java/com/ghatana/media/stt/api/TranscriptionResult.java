package com.ghatana.media.stt.api;

import java.time.Duration;
import java.util.List;

/**
 * Transcription result.
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
    String modelId
) {
    public String getText() {
        return text;
    }
}
