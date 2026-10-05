package com.ghatana.media.stt.api;

/**
 * Alternative transcription hypothesis.
 *
 * @doc.type record
 * @doc.purpose Alternate STT transcription hypothesis
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record Alternative(String text, double confidence) {}
