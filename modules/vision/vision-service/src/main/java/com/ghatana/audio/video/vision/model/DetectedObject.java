package com.ghatana.audio.video.vision.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.Instant;
import java.util.Objects;

/**
 * Represents a detected object in an image or video frame.
 *
 * @doc.type model
 * @doc.purpose Represents a detected object in an image or video frame
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public class DetectedObject {

    @JsonProperty("class_name")
    private final String className;

    @JsonProperty("confidence")
    private final double confidence;

    @JsonProperty("bounding_box")
    private final BoundingBox boundingBox;

    @JsonProperty("attributes")
    private final ObjectAttributes attributes;

    @JsonProperty("timestamp")
    private final Instant timestamp;

    private DetectedObject(Builder builder) {
        this.className = builder.className;
        this.confidence = builder.confidence;
        this.boundingBox = builder.boundingBox;
        this.attributes = builder.attributes;
        this.timestamp = builder.timestamp != null ? builder.timestamp : Instant.now();
    }

    public String getClassName() {
        return className;
    }

    public double getConfidence() {
        return confidence;
    }

    public BoundingBox getBoundingBox() {
        return boundingBox;
    }

    public ObjectAttributes getAttributes() {
        return attributes;
    }

    public Instant getTimestamp() {
        return timestamp;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        DetectedObject that = (DetectedObject) o;
        return Double.compare(that.confidence, confidence) == 0 &&
               Objects.equals(className, that.className) &&
               Objects.equals(boundingBox, that.boundingBox) &&
               Objects.equals(attributes, that.attributes);
    }

    @Override
    public int hashCode() {
        return Objects.hash(className, confidence, boundingBox, attributes);
    }

    @Override
    public String toString() {
        return "DetectedObject{" +
               "className='" + className + '\'' +
               ", confidence=" + confidence +
               ", boundingBox=" + boundingBox +
               ", attributes=" + attributes +
               ", timestamp=" + timestamp +
               '}';
    }

    public static Builder builder() {
        return new Builder();
    }

    public static class Builder {
        private String className;
        private double confidence;
        private BoundingBox boundingBox;
        private ObjectAttributes attributes;
        private Instant timestamp;

        public Builder className(String className) {
            this.className = className;
            return this;
        }

        public Builder confidence(double confidence) {
            this.confidence = confidence;
            return this;
        }

        public Builder boundingBox(BoundingBox boundingBox) {
            this.boundingBox = boundingBox;
            return this;
        }

        public Builder attributes(ObjectAttributes attributes) {
            this.attributes = attributes;
            return this;
        }

        public Builder timestamp(Instant timestamp) {
            this.timestamp = timestamp;
            return this;
        }

        public DetectedObject build() {
            return new DetectedObject(this);
        }
    }
}
