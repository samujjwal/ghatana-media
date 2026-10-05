package com.ghatana.media.vision.api;

/**
 * Non-max suppression settings.
 *
 * @doc.type record
 * @doc.purpose Immutable non-max suppression configuration
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record NonMaxSuppression(double iouThreshold, boolean enabled) {}
