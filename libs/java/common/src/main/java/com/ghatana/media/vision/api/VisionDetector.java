/**
 * @doc.type interface
 * @doc.purpose Vision detector abstraction for object detection backends
 * @doc.layer platform
 * @doc.pattern Strategy
 */
package com.ghatana.media.vision.api;

import java.util.List;

/**
 * Unified interface for vision detection backends (YOLO, ONNX, etc.)
 *
 * <p>Implementations must be thread-safe and handle concurrent detection requests.
 * The {@link #isInitialized()} method should be checked before calling {@link #detect(byte[], DetectionOptions)}.
 */
public interface VisionDetector {

    /**
     * Detect objects in an image.
     *
     * @param imageData raw image bytes (JPEG, PNG, etc.)
     * @param options detection options (confidence threshold, max detections, etc.)
     * @return list of detected objects
     * @throws DetectionException if detection fails or detector not initialized
     */
    List<DetectedObject> detect(byte[] imageData, DetectionOptions options);

    /**
     * Check if the detector is initialized and ready.
     *
     * @return true if detector is ready to process images
     */
    boolean isInitialized();

    /**
     * Get detector model information.
     *
     * @return model info (name, version, type)
     */
    ModelInfo getModelInfo();

    /**
     * Options for object detection.
     */
    class DetectionOptions {
        private final float confidenceThreshold;
        private final int maxDetections;
        private final boolean enableTracking;
        private final String[] targetClasses;

        public DetectionOptions(float confidenceThreshold, int maxDetections,
                              boolean enableTracking, String[] targetClasses) {
            this.confidenceThreshold = confidenceThreshold;
            this.maxDetections = maxDetections;
            this.enableTracking = enableTracking;
            this.targetClasses = targetClasses;
        }

        public static DetectionOptions defaults() {
            return new DetectionOptions(0.5f, 100, false, null);
        }

        public float getConfidenceThreshold() { return confidenceThreshold; }
        public int getMaxDetections() { return maxDetections; }
        public boolean isEnableTracking() { return enableTracking; }
        public String[] getTargetClasses() { return targetClasses; }

        public static Builder builder() {
            return new Builder();
        }

        public static class Builder {
            private float confidenceThreshold = 0.5f;
            private int maxDetections = 100;
            private boolean enableTracking = false;
            private String[] targetClasses = null;

            public Builder confidenceThreshold(float threshold) {
                this.confidenceThreshold = threshold;
                return this;
            }

            public Builder maxDetections(int max) {
                this.maxDetections = max;
                return this;
            }

            public Builder enableTracking(boolean enable) {
                this.enableTracking = enable;
                return this;
            }

            public Builder targetClasses(String[] classes) {
                this.targetClasses = classes;
                return this;
            }

            public DetectionOptions build() {
                return new DetectionOptions(confidenceThreshold, maxDetections, enableTracking, targetClasses);
            }
        }
    }

    /**
     * Detected object with bounding box and metadata.
     */
    class DetectedObject {
        private final String className;
        private final float confidence;
        private final BoundingBox boundingBox;
        private final long timestampMs;
        private final java.util.Map<String, Object> attributes;

        public DetectedObject(String className, float confidence, BoundingBox boundingBox,
                              long timestampMs, java.util.Map<String, Object> attributes) {
            this.className = className;
            this.confidence = confidence;
            this.boundingBox = boundingBox;
            this.timestampMs = timestampMs;
            this.attributes = attributes != null ? attributes : java.util.Map.of();
        }

        public String getClassName() { return className; }
        public float getConfidence() { return confidence; }
        public BoundingBox getBoundingBox() { return boundingBox; }
        public long getTimestampMs() { return timestampMs; }
        public java.util.Map<String, Object> getAttributes() { return attributes; }

        public static Builder builder() {
            return new Builder();
        }

        public static class Builder {
            private String className;
            private float confidence;
            private BoundingBox boundingBox;
            private long timestampMs;
            private java.util.Map<String, Object> attributes;

            public Builder className(String name) {
                this.className = name;
                return this;
            }

            public Builder confidence(float confidence) {
                this.confidence = confidence;
                return this;
            }

            public Builder boundingBox(BoundingBox box) {
                this.boundingBox = box;
                return this;
            }

            public Builder timestamp(long timestamp) {
                this.timestampMs = timestamp;
                return this;
            }

            public Builder attributes(java.util.Map<String, Object> attrs) {
                this.attributes = attrs;
                return this;
            }

            public DetectedObject build() {
                return new DetectedObject(className, confidence, boundingBox, timestampMs, attributes);
            }
        }
    }

    /**
     * Bounding box with normalized coordinates.
     */
    class BoundingBox {
        private final double x;
        private final double y;
        private final double width;
        private final double height;

        public BoundingBox(double x, double y, double width, double height) {
            this.x = x;
            this.y = y;
            this.width = width;
            this.height = height;
        }

        public double getX() { return x; }
        public double getY() { return y; }
        public double getWidth() { return width; }
        public double getHeight() { return height; }

        public double getCenterX() { return x + width / 2; }
        public double getCenterY() { return y + height / 2; }
        public double getArea() { return width * height; }

        public boolean intersects(BoundingBox other) {
            return x < other.x + other.width &&
                   x + width > other.x &&
                   y < other.y + other.height &&
                   y + height > other.y;
        }

        public double intersectionArea(BoundingBox other) {
            double xOverlap = Math.max(0, Math.min(x + width, other.x + other.width) - Math.max(x, other.x));
            double yOverlap = Math.max(0, Math.min(y + height, other.y + other.height) - Math.max(y, other.y));
            return xOverlap * yOverlap;
        }

        public double iou(BoundingBox other) {
            double intersection = intersectionArea(other);
            double union = getArea() + other.getArea() - intersection;
            return union > 0 ? intersection / union : 0;
        }

        public static Builder builder() {
            return new Builder();
        }

        public static class Builder {
            private double x, y, width, height;

            public Builder x(double x) { this.x = x; return this; }
            public Builder y(double y) { this.y = y; return this; }
            public Builder width(double w) { this.width = w; return this; }
            public Builder height(double h) { this.height = h; return this; }
            public BoundingBox build() { return new BoundingBox(x, y, width, height); }
        }
    }

    /**
     * Model information.
     */
    class ModelInfo {
        private final String name;
        private final String version;
        private final String type;
        private final String[] supportedClasses;

        public ModelInfo(String name, String version, String type, String[] supportedClasses) {
            this.name = name;
            this.version = version;
            this.type = type;
            this.supportedClasses = supportedClasses;
        }

        public String getName() { return name; }
        public String getVersion() { return version; }
        public String getType() { return type; }
        public String[] getSupportedClasses() { return supportedClasses; }
    }

    /**
     * Exception thrown during detection.
     */
    class DetectionException extends RuntimeException {
        private final boolean retryable;
        private final boolean uninitialized;

        public DetectionException(String message) {
            super(message);
            this.retryable = false;
            this.uninitialized = false;
        }

        public DetectionException(String message, Throwable cause) {
            super(message, cause);
            this.retryable = false;
            this.uninitialized = false;
        }

        public DetectionException(String message, Throwable cause, boolean retryable, boolean uninitialized) {
            super(message, cause);
            this.retryable = retryable;
            this.uninitialized = uninitialized;
        }

        public boolean isRetryable() { return retryable; }
        public boolean isUninitialized() { return uninitialized; }
    }
}
