package com.ghatana.media.stt.api;

import java.util.Locale;

/**
 * STT model information.
 *
 * @doc.type record
 * @doc.purpose Metadata for an available STT model
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record ModelInfo(
    String modelId,
    String name,
    String version,
    Locale[] supportedLanguages,
    long sizeBytes,
    boolean supportsGpu
) {}
