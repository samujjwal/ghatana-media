/**
 * @doc.type interface
 * @doc.purpose Computer Vision Engine API for embedded library usage
 * @doc.layer platform
 * @doc.pattern ServiceInterface
 */
package com.ghatana.media.vision.api;

import com.ghatana.media.common.*;
import io.activej.promise.Promise;

import java.util.List;
import java.util.function.Consumer;

/**
 * Computer Vision Engine interface for object detection and image analysis.
 *
 * <p>Usage:
 * <pre>{@code
 * try (VisionEngine engine = library.getVisionEngine()) {
 *     // Object detection
 *     DetectionResult result = engine.detect(imageData);
 *
 *     // Detection with options
 *     DetectionResult result = engine.detect(imageData, DetectionOptions.builder()
 *         .confidenceThreshold(0.7)
 *         .maxDetections(10)
 *         .build());
 *
 *     // Streaming detection for video
 *     engine.detectStreaming(videoStream, options, result -> {
 *         drawBoundingBoxes(result.objects());
 *     });
 * }
 * }</pre>
 */
public interface VisionEngine extends AutoCloseable, ObjectDetectionEngine {

    /** Truthful capability inventory of the composed provider. */
    default VisionCapabilities capabilities() {
        return VisionCapabilities.objectDetectionOnly();
    }

    // ====================================================================================
    // Object Detection
    // ====================================================================================

    /**
     * Detect objects in an image.
     *
     * @param image image data
     * @return detection result
     * @throws ValidationError if image format is invalid
     * @throws InferenceError if detection fails
     */
    default DetectionResult detect(ImageData image) {
        return detect(image, DetectionOptions.defaults());
    }

    /**
     * Detect objects with options.
     *
     * @param image image data
     * @param options detection options
     * @return detection result
     */
    @Override
    DetectionResult detect(ImageData image, DetectionOptions options);

    /**
     * Detect objects asynchronously.
     *
     * @param image image data
     * @param options detection options
     * @return promise of detection result
     */
    @Override
    default Promise<DetectionResult> detectAsync(ImageData image, DetectionOptions options) {
        try {
            return Promise.of(detect(image, options));
        } catch (Exception e) {
            return Promise.ofException(e);
        }
    }

    /**
     * Detect asynchronously with default options.
     */
    default Promise<DetectionResult> detectAsync(ImageData image) {
        return detectAsync(image, DetectionOptions.defaults());
    }

    // ====================================================================================
    // Streaming Detection (for video)
    // ====================================================================================

    /**
     * Create a streaming detection session for video.
     *
     * @param options detection options
     * @param resultCallback callback for detection results
     * @return streaming session
     */
    StreamingDetectionSession createStreamingSession(DetectionOptions options, Consumer<DetectionResult> resultCallback);

    /**
     * Create streaming session with default options.
     */
    default StreamingDetectionSession createStreamingSession(Consumer<DetectionResult> resultCallback) {
        return createStreamingSession(DetectionOptions.defaults(), resultCallback);
    }

    // ====================================================================================
    // Image Analysis
    // ====================================================================================

    /**
     * Analyze image and generate caption.
     *
     * @param image image data
     * @return generated caption
     */
    String caption(ImageData image);

    /**
     * Analyze image asynchronously.
     */
    default Promise<String> captionAsync(ImageData image) {
        try {
            return Promise.of(caption(image));
        } catch (Exception e) {
            return Promise.ofException(e);
        }
    }

    /**
     * Classify image into categories.
     *
     * @param image image data
     * @param topK number of top categories to return
     * @return list of classifications
     */
    List<Classification> classify(ImageData image, int topK);

    /**
     * Classify with default top-5.
     */
    default List<Classification> classify(ImageData image) {
        return classify(image, 5);
    }

    // ====================================================================================
    // Model Management
    // ====================================================================================

    /**
     * Get available detection models.
     */
    List<DetectionModelInfo> getAvailableModels();

    /**
     * Load a specific model.
     *
     * @param modelId model identifier
     * @throws ModelLoadingError if model cannot be loaded
     */
    void loadModel(String modelId);

    /**
     * Get the currently active model.
     */
    DetectionModelInfo getActiveModel();

    /**
     * Warm up the engine.
     */
    void warmup();

    // ====================================================================================
    // Lifecycle
    // ====================================================================================

    @Override
    void close();

    /**
     * Get engine status.
     */
    EngineStatus getStatus();

    /**
     * Get engine metrics.
     */
    EngineMetrics getMetrics();
}
