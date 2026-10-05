package com.ghatana.media.vision.api;

import com.ghatana.media.common.BoundingBox;

import java.util.List;

/**
 * Detected object.
 *
 * @doc.type record
 * @doc.purpose Immutable detected object payload
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record DetectedObject(
    String className,
    double confidence,
    BoundingBox bbox,
    Integer trackingId,
    List<Keypoint> keypoints
) {
    public DetectedObject(String className, double confidence, BoundingBox bbox) {
        this(className, confidence, bbox, null, null);
    }

    public DetectedObject(String className, double confidence, BoundingBox bbox, List<Keypoint> keypoints) {
        this(className, confidence, bbox, null, keypoints);
    }
}
