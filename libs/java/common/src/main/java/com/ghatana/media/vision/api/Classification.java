package com.ghatana.media.vision.api;

/**
 * Image classification result.
 *
 * @doc.type record
 * @doc.purpose Immutable image classification prediction
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record Classification(String className, double confidence) {}
