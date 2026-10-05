package com.ghatana.media.stt.api;

import java.util.List;

/**
 * Streaming transcription output.
 *
 * @doc.type record
 * @doc.purpose Incremental STT streaming transcription result
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record StreamingTranscription(String text, boolean isFinal, double confidence, List<WordTiming> words) {}
