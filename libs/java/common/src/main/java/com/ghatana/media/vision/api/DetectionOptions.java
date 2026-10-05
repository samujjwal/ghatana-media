package com.ghatana.media.vision.api;

import java.util.List;

/**
 * Detection options.
 *
 * @doc.type record
 * @doc.purpose Immutable vision detection options
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record DetectionOptions(
    double confidenceThreshold,
    int maxDetections,
    List<String> classFilter,
    boolean enableTracking,
    int inputSize,
    NonMaxSuppression nms
) {
    public static DetectionOptions defaults() {
        return new DetectionOptions(0.5, 100, null, false, 640, new NonMaxSuppression(0.45, true));
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private double confidenceThreshold = 0.5;
        private int maxDetections = 100;
        private List<String> classFilter;
        private boolean enableTracking = false;
        private int inputSize = 640;
        private NonMaxSuppression nms = new NonMaxSuppression(0.45, true);

        public Builder confidenceThreshold(double value) { this.confidenceThreshold = Math.max(0.0, Math.min(1.0, value)); return this; }
        public Builder maxDetections(int value) { this.maxDetections = Math.max(1, value); return this; }
        public Builder classFilter(List<String> value) { this.classFilter = value; return this; }
        public Builder enableTracking(boolean value) { this.enableTracking = value; return this; }
        public Builder inputSize(int value) { this.inputSize = value; return this; }
        public Builder nms(NonMaxSuppression value) { this.nms = value; return this; }

        public DetectionOptions build() {
            return new DetectionOptions(confidenceThreshold, maxDetections, classFilter, enableTracking, inputSize, nms);
        }
    }
}
