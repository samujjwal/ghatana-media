package com.ghatana.media.vision.api;

import com.ghatana.media.common.ImageData;
import io.activej.promise.Promise;

/**
 * Narrow authority for object detection; it cannot imply captioning or model management.
 *
 * @doc.type interface
 * @doc.purpose Define the Object Detection Engine contract
 * @doc.layer product
 * @doc.pattern Engine
 */
public interface ObjectDetectionEngine {
    DetectionResult detect(ImageData image, DetectionOptions options);
    default Promise<DetectionResult> detectAsync(ImageData image, DetectionOptions options) {
        try { return Promise.of(detect(image, options)); }
        catch (Exception failure) { return Promise.ofException(failure); }
    }
}
