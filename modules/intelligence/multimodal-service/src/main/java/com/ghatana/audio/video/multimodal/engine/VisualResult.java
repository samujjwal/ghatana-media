package com.ghatana.audio.video.multimodal.engine;

import java.util.ArrayList;
import java.util.List;

/**
 * Result from vision analysis (image or video).
 * @doc.type class
 * @doc.purpose Provides visual result functionality.
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public final class VisualResult {

    private final String sceneDescription;
    private final List<DetectionResult> detections;
    private final List<FrameResult> frameResults;
    private final Double confidence;
    private final String error;

    private VisualResult(Builder builder) {
        this.sceneDescription = builder.sceneDescription;
        this.detections = builder.detections;
        this.frameResults = builder.frameResults;
        this.confidence = builder.confidence;
        this.error = builder.error;
    }

    public static VisualResult error(String message) {
        return builder().error(message).sceneDescription("").build();
    }

    public static Builder builder() {
        return new Builder();
    }

    public boolean isError() {
        return error != null && !error.isEmpty();
    }

    public String getSceneDescription() {
        return sceneDescription;
    }

    public List<DetectionResult> getDetections() {
        return detections;
    }

    public List<FrameResult> getFrameResults() {
        return frameResults;
    }

    public Double getConfidence() {
        return confidence;
    }

    public String getError() {
        return error;
    }

    public static class Builder {
        private String sceneDescription = "";
        private List<DetectionResult> detections = new ArrayList<>();
        private List<FrameResult> frameResults = new ArrayList<>();
        private Double confidence;
        private String error;

        public Builder sceneDescription(String s) {
            this.sceneDescription = s;
            return this;
        }

        public Builder detections(List<DetectionResult> d) {
            this.detections = d;
            return this;
        }

        public Builder frameResults(List<FrameResult> f) {
            this.frameResults = f;
            return this;
        }

        public Builder confidence(Double c) {
            this.confidence = c;
            return this;
        }

        public Builder error(String e) {
            this.error = e;
            return this;
        }

        public VisualResult build() {
            return new VisualResult(this);
        }
    }
}
