package com.ghatana.audio.video.vision.detection;

import com.ghatana.audio.video.vision.model.ClassificationCandidate;
import com.ghatana.audio.video.vision.model.DetectedFace;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.core.exception.ServiceException;

import java.util.List;

/**
 * Strategy interface for vision inference backends.
 *
 * <p>The core contract is object detection ({@link #detectObjects}). Backends that
 * support additional operations (classification, face detection) declare them via
 * {@link #supportsCapability(VisionCapability)} and implement the corresponding
 * default method overrides.
 *
 * <p>Implementations include {@link com.ghatana.audio.video.vision.yolo.YoloV8Adapter}
 * for production object detection, plus in-memory test doubles in test sources.
 *
 * @doc.type    interface
 * @doc.purpose Vision backend abstraction for testability and engine swap
 * @doc.layer   product
 * @doc.pattern Strategy
 */
public interface VisionDetector {

    /**
     * Optional vision capabilities beyond basic object detection.
     * Backends should return {@code true} from {@link #supportsCapability} only for
     * capabilities they genuinely implement.
     */
    enum VisionCapability {
        /** Standard object detection ({@link #detectObjects}). Always supported. */
        OBJECT_DETECTION,
        /** Image-level classification ({@link #classify}). */
        CLASSIFICATION,
        /** Face detection with optional landmarks ({@link #detectFaces}). */
        FACE_DETECTION,
        /** Optical character recognition ({@link #extractText}). */
        OCR
    }

    /**
     * Detect objects in the supplied raw image bytes.
     *
     * @param imageData raw image bytes (JPEG, PNG, etc.)
     * @param options   detection configuration
     * @return ordered list of detected objects, highest confidence first
     * @throws DetectionException on unrecoverable failure
     */
    List<DetectedObject> detectObjects(byte[] imageData, DetectionOptions options);

    /**
     * Whether this detector has been successfully initialised and is ready.
     */
    boolean isInitialized();

    /**
     * Whether this backend supports the given optional capability.
     * Defaults to {@code true} for {@link VisionCapability#OBJECT_DETECTION}
     * and {@code false} for all others. Override to advertise extra capabilities.
     */
    default boolean supportsCapability(VisionCapability capability) {
        return capability == VisionCapability.OBJECT_DETECTION;
    }

    /**
     * Classify the dominant scene or content type in the supplied image.
     * Returns candidates ordered by confidence, highest first.
     *
     * <p>Only callable when {@code supportsCapability(CLASSIFICATION)} is {@code true}.
     *
     * @param imageData raw image bytes
     * @param options   detection/inference configuration
     * @return classification candidates, highest confidence first
     * @throws UnsupportedOperationException if this backend does not support classification
     * @throws DetectionException on unrecoverable failure
     */
    default List<ClassificationCandidate> classify(byte[] imageData, DetectionOptions options) {
        throw new UnsupportedOperationException(
                "Classification not supported by " + getClass().getSimpleName());
    }

    /**
     * Detect faces in the supplied image.
     * Returns faces ordered by confidence, highest first.
     *
     * <p>Only callable when {@code supportsCapability(FACE_DETECTION)} is {@code true}.
     *
     * @param imageData raw image bytes
     * @param options   detection/inference configuration
     * @return detected faces, highest confidence first
     * @throws UnsupportedOperationException if this backend does not support face detection
     * @throws DetectionException on unrecoverable failure
     */
    default List<DetectedFace> detectFaces(byte[] imageData, DetectionOptions options) {
        throw new UnsupportedOperationException(
                "Face detection not supported by " + getClass().getSimpleName());
    }

    /**
     * Extract text regions from the supplied image using OCR.
     * Returns text content as a single concatenated string.
     *
     * <p>Only callable when {@code supportsCapability(OCR)} is {@code true}.
     *
     * @param imageData raw image bytes
     * @param options   detection/inference configuration
     * @return extracted text (empty string when no text is detected)
     * @throws UnsupportedOperationException if this backend does not support OCR
     * @throws DetectionException on unrecoverable failure
     */
    default String extractText(byte[] imageData, DetectionOptions options) {
        throw new UnsupportedOperationException(
                "OCR not supported by " + getClass().getSimpleName());
    }

    /**
     * Checked exception thrown by detector implementations.
     */
    class DetectionException extends ServiceException {
        public DetectionException(String message, Throwable cause) {
            super(message, cause);
        }
        public DetectionException(String message) {
            super(message);
        }
    }
}
