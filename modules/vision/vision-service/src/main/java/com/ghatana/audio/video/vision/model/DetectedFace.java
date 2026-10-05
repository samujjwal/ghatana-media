package com.ghatana.audio.video.vision.model;

import java.util.List;
import java.util.Map;

/**
 * A detected face within an image, including its bounding region, confidence,
 * and optional facial landmark coordinates.
 *
 * <p>Landmark keys are detector-specific (e.g. {@code "left_eye"}, {@code "nose_tip"});
 * callers should treat them as advisory.
 *
 * @doc.type    class
 * @doc.purpose Models a face detection result from a vision backend
 * @doc.layer   product
 * @doc.pattern Model
 */
public record DetectedFace(
        BoundingBox boundingBox,
        double confidence,
        Map<String, Point> landmarks
) {
    public DetectedFace {
        if (boundingBox == null) throw new IllegalArgumentException("boundingBox must not be null");
        if (confidence < 0.0 || confidence > 1.0) {
            throw new IllegalArgumentException("confidence must be in [0.0, 1.0]");
        }
        landmarks = landmarks == null ? Map.of() : Map.copyOf(landmarks);
    }

    /** Convenience constructor without landmarks. */
    public DetectedFace(BoundingBox boundingBox, double confidence) {
        this(boundingBox, confidence, Map.of());
    }
}
