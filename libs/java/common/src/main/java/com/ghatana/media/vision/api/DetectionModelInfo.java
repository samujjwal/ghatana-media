package com.ghatana.media.vision.api;

import java.util.Optional;

/**
 * Detection model information.
 *
 * @doc.type record
 * @doc.purpose Metadata for an available vision detection model
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record DetectionModelInfo(
    String modelId,
    String name,
    String version,
    String[] supportedClasses,
    long sizeBytes,
    boolean supportsGpu,
    int inputWidth,
    int inputHeight,
    Optional<String> description
) {}
