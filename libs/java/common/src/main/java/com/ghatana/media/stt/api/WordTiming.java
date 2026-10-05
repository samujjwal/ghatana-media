package com.ghatana.media.stt.api;

/**
 * Word-level timing information.
 *
 * @doc.type record
 * @doc.purpose Timing metadata for a recognized word
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record WordTiming(String word, double startSec, double endSec, double confidence) {}
