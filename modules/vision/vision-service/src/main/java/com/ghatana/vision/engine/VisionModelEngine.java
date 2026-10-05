package com.ghatana.vision.engine;

import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.detection.VisionDetector.VisionCapability;
import com.ghatana.audio.video.vision.model.DetectionOptions;

import java.util.*;
import java.util.stream.Collectors;

/**
 * Vision model engine for object detection, classification, OCR, and face detection.
 *
 * <p>Integrates YOLO-based detection and ResNet classification as a unified
 * interface for frame-level and image-level vision tasks.
 *
 * @doc.type    class
 * @doc.purpose Vision engine: object detection, classification, OCR, face detection
 * @doc.layer   product
 * @doc.pattern Engine
 */
public class VisionModelEngine {

    /** Detected object with confidence and bounding box. */
    public record DetectedObject(
            String label,
            double confidence,
            double x, double y,
            double width, double height
    ) {}

    /** OCR extraction result. */
    public record OcrResult(String text, double confidence, List<DetectedObject> textRegions) {}

    /** Classification result. */
    public record ClassificationResult(String label, double confidence, List<String> topLabels) {}

    /** Detected face with landmarks. */
    public record FaceDetection(
            double x, double y, double width, double height,
            double confidence,
            Map<String, double[]> landmarks
    ) {}

    private final String modelId;
    private final double confidenceThreshold;
    /** Production vision detector. Missing or unavailable detectors fail closed. */
    private final VisionDetector detector;

    /**
     * Constructs an engine backed by a real {@link VisionDetector} (e.g. YoloV8Adapter).
     * Use this constructor in production wiring.
     */
    public VisionModelEngine(String modelId, double confidenceThreshold, VisionDetector detector) {
        Objects.requireNonNull(modelId, "modelId must not be null");
        if (confidenceThreshold < 0.0 || confidenceThreshold > 1.0) {
            throw new IllegalArgumentException("confidenceThreshold must be in [0.0, 1.0]");
        }
        this.modelId = modelId;
        this.confidenceThreshold = confidenceThreshold;
        this.detector = detector;
    }

    /**
     * Constructs an engine without an injected detector. Operations validate input
     * and then fail closed until production wiring supplies a detector.
     */
    public VisionModelEngine(String modelId, double confidenceThreshold) {
        this(modelId, confidenceThreshold, null);
    }

    /**
     * Detects objects in the given image bytes.
     *
     * @param imageData raw image bytes (JPEG, PNG, BMP, etc.)
     * @return list of detected objects above the confidence threshold
     * @throws VisionException if image data cannot be decoded
     */
    public List<DetectedObject> detectObjects(byte[] imageData) {
        validateImage(imageData);
        requireInitializedDetector("object detection");
        DetectionOptions options = DetectionOptions.builder()
                .confidenceThreshold(confidenceThreshold)
                .maxDetections(50)
                .build();
        try {
            return detector.detectObjects(imageData, options).stream()
                    .map(d -> new DetectedObject(
                            d.getClassName(),
                            d.getConfidence(),
                            d.getBoundingBox().getX(),
                            d.getBoundingBox().getY(),
                            d.getBoundingBox().getWidth(),
                            d.getBoundingBox().getHeight()))
                    .collect(Collectors.toList());
        } catch (VisionDetector.DetectionException ex) {
            throw new VisionException("Detection failed: " + ex.getMessage(), ex);
        }
    }

    /**
     * Classifies the top-level content of the given image.
     *
     * <p>Delegates to the backing {@link VisionDetector} when it supports
     * {@link VisionCapability#CLASSIFICATION}; otherwise fails closed.
     *
     * @param imageData raw image bytes
     * @return classification result with top label and alternatives
     */
    public ClassificationResult classify(byte[] imageData) {
        validateImage(imageData);
        requireCapability(VisionCapability.CLASSIFICATION, "classification");
        DetectionOptions options = DetectionOptions.builder()
                .confidenceThreshold(confidenceThreshold)
                .maxDetections(10)
                .build();
        try {
            var candidates = detector.classify(imageData, options);
            if (!candidates.isEmpty()) {
                String topLabel = candidates.get(0).label();
                double topConf = candidates.get(0).confidence();
                List<String> allLabels = candidates.stream()
                        .map(com.ghatana.audio.video.vision.model.ClassificationCandidate::label)
                        .collect(Collectors.toList());
                return new ClassificationResult(topLabel, topConf, allLabels);
            }
            throw new VisionException("Classification returned no candidates");
        } catch (VisionDetector.DetectionException ex) {
            throw new VisionException("Classification failed: " + ex.getMessage(), ex);
        }
    }

    /**
     * Extracts text from the given image using OCR.
     *
     * <p>Delegates to the backing {@link VisionDetector} when it supports
     * {@link VisionCapability#OCR}; otherwise fails closed.
     *
     * @param imageData raw image bytes
     * @return OCR result with extracted text
     */
    public OcrResult extractText(byte[] imageData) {
        validateImage(imageData);
        requireCapability(VisionCapability.OCR, "OCR");
        DetectionOptions options = DetectionOptions.builder()
                .confidenceThreshold(confidenceThreshold)
                .maxDetections(100)
                .build();
        try {
            String text = detector.extractText(imageData, options);
            return new OcrResult(text, 1.0, List.of());
        } catch (VisionDetector.DetectionException ex) {
            throw new VisionException("OCR failed: " + ex.getMessage(), ex);
        }
    }

    /**
     * Detects faces in the given image.
     *
     * <p>Delegates to the backing {@link VisionDetector} when it supports
     * {@link VisionCapability#FACE_DETECTION}; otherwise fails closed.
     *
     * @param imageData raw image bytes
     * @return list of detected faces above the confidence threshold
     */
    public List<FaceDetection> detectFaces(byte[] imageData) {
        validateImage(imageData);
        requireCapability(VisionCapability.FACE_DETECTION, "face detection");
        DetectionOptions options = DetectionOptions.builder()
                .confidenceThreshold(confidenceThreshold)
                .maxDetections(50)
                .build();
        try {
            return detector.detectFaces(imageData, options).stream()
                    .map(f -> {
                        Map<String, double[]> lm = new HashMap<>();
                        f.landmarks().forEach((k, p) -> lm.put(k, new double[]{p.getX(), p.getY()}));
                        return new FaceDetection(
                                f.boundingBox().getX(),
                                f.boundingBox().getY(),
                                f.boundingBox().getWidth(),
                                f.boundingBox().getHeight(),
                                f.confidence(),
                                lm
                        );
                    })
                    .collect(Collectors.toList());
        } catch (VisionDetector.DetectionException ex) {
            throw new VisionException("Face detection failed: " + ex.getMessage(), ex);
        }
    }

    /** @return the model ID this engine was initialized with */
    public String getModelId() { return modelId; }

    /** @return the confidence threshold for detection filtering */
    public double getConfidenceThreshold() { return confidenceThreshold; }

    private void validateImage(byte[] imageData) {
        if (imageData == null || imageData.length == 0) {
            throw new VisionException("Image data must not be null or empty");
        }
    }

    private void requireInitializedDetector(String operation) {
        if (detector == null) {
            throw new VisionException("Vision detector is required for " + operation);
        }
        if (!detector.isInitialized()) {
            throw new VisionException("Vision detector is not initialized for " + operation);
        }
    }

    private void requireCapability(VisionCapability capability, String operation) {
        requireInitializedDetector(operation);
        if (!detector.supportsCapability(capability)) {
            throw new VisionException("Vision detector does not support " + operation);
        }
    }

    /** Thrown when a vision processing error occurs. */
    public static class VisionException extends RuntimeException {
        public VisionException(String message) { super(message); }
        public VisionException(String message, Throwable cause) { super(message, cause); }
    }
}
