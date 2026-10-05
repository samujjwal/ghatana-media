package com.ghatana.media.vision.api;

import java.util.List;

/**
 * Detection result.
 *
 * @doc.type record
 * @doc.purpose Immutable object detection result payload
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record DetectionResult(
    List<DetectedObject> objects,
    int imageWidth,
    int imageHeight,
    long processingTimeMs,
    String modelId
) {
    public List<DetectedObject> getObjectsAboveConfidence(double threshold) {
        return objects.stream().filter(obj -> obj.confidence() >= threshold).toList();
    }

    public int count() {
        return objects.size();
    }
}
