package com.ghatana.audio.video.vision.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Objects;
import java.util.Set;

/**
 * Configuration options for object detection.
 *
 * @doc.type model
 * @doc.purpose Configuration options for object detection
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public class DetectionOptions {

    @JsonProperty("confidence_threshold")
    private final double confidenceThreshold;

    @JsonProperty("nms_threshold")
    private final double nmsThreshold;

    @JsonProperty("target_classes")
    private final Set<String> targetClasses;

    @JsonProperty("max_detections")
    private final int maxDetections;

    @JsonProperty("include_attributes")
    private final boolean includeAttributes;

    @JsonProperty("track_objects")
    private final boolean trackObjects;

    private DetectionOptions(Builder builder) {
        this.confidenceThreshold = builder.confidenceThreshold;
        this.nmsThreshold = builder.nmsThreshold;
        this.targetClasses = builder.targetClasses == null ? null : Set.copyOf(builder.targetClasses);
        this.maxDetections = builder.maxDetections;
        this.includeAttributes = builder.includeAttributes;
        this.trackObjects = builder.trackObjects;
    }

    public double getConfidenceThreshold() {
        return confidenceThreshold;
    }

    public double getNmsThreshold() {
        return nmsThreshold;
    }

    public Set<String> getTargetClasses() {
        return targetClasses;
    }

    public int getMaxDetections() {
        return maxDetections;
    }

    public boolean isIncludeAttributes() {
        return includeAttributes;
    }

    public boolean isTrackObjects() {
        return trackObjects;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        DetectionOptions that = (DetectionOptions) o;
        return Double.compare(that.confidenceThreshold, confidenceThreshold) == 0 &&
               Double.compare(that.nmsThreshold, nmsThreshold) == 0 &&
               maxDetections == that.maxDetections &&
               includeAttributes == that.includeAttributes &&
               trackObjects == that.trackObjects &&
               Objects.equals(targetClasses, that.targetClasses);
    }

    @Override
    public int hashCode() {
        return Objects.hash(confidenceThreshold, nmsThreshold, targetClasses,
                           maxDetections, includeAttributes, trackObjects);
    }

    @Override
    public String toString() {
        return "DetectionOptions{" +
               "confidenceThreshold=" + confidenceThreshold +
               ", nmsThreshold=" + nmsThreshold +
               ", targetClasses=" + targetClasses +
               ", maxDetections=" + maxDetections +
               ", includeAttributes=" + includeAttributes +
               ", trackObjects=" + trackObjects +
               '}';
    }

    public static Builder builder() {
        return new Builder();
    }

    public static DetectionOptions defaults() {
        return builder().build();
    }

    public static DetectionOptions highPrecision() {
        return builder()
            .confidenceThreshold(0.8)
            .nmsThreshold(0.3)
            .build();
    }

    public static DetectionOptions highRecall() {
        return builder()
            .confidenceThreshold(0.3)
            .nmsThreshold(0.5)
            .build();
    }

    public static class Builder {
        private double confidenceThreshold = 0.5;
        private double nmsThreshold = 0.4;
        private Set<String> targetClasses = null;
        private int maxDetections = 100;
        private boolean includeAttributes = true;
        private boolean trackObjects = false;

        public Builder confidenceThreshold(double confidenceThreshold) {
            this.confidenceThreshold = Math.max(0.0, Math.min(1.0, confidenceThreshold));
            return this;
        }

        public Builder nmsThreshold(double nmsThreshold) {
            this.nmsThreshold = Math.max(0.0, Math.min(1.0, nmsThreshold));
            return this;
        }

        public Builder targetClasses(Set<String> targetClasses) {
            this.targetClasses = targetClasses == null ? null : Set.copyOf(targetClasses);
            return this;
        }

        public Builder maxDetections(int maxDetections) {
            this.maxDetections = Math.max(0, maxDetections);
            return this;
        }

        public Builder includeAttributes(boolean includeAttributes) {
            this.includeAttributes = includeAttributes;
            return this;
        }

        public Builder trackObjects(boolean trackObjects) {
            this.trackObjects = trackObjects;
            return this;
        }

        public DetectionOptions build() {
            return new DetectionOptions(this);
        }
    }
}
