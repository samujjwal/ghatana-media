package com.ghatana.media.vision.api;

/**
 * Keypoint for pose detection.
 *
 * @doc.type record
 * @doc.purpose Immutable pose detection keypoint
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record Keypoint(String name, double x, double y, double confidence) {}
