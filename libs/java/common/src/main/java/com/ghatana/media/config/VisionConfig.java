package com.ghatana.media.config;

import java.nio.file.Path;
import java.time.Duration;

/**
 * Vision engine configuration.
 *
 * <p>Synthetic fallback is disabled by default and must be explicitly enabled by local/test
 * composition. Production-like launchers must reject it.
 *
 * @doc.type record
 * @doc.purpose Configuration for embedded vision engine instances
 * @doc.layer platform
 * @doc.pattern Configuration
 */
public record VisionConfig(
    Path modelPath,
    String modelId,
    String modelType,
    boolean useGpu,
    int maxConcurrentRequests,
    Duration timeout,
    int batchSize,
    double defaultConfidenceThreshold,
    int defaultMaxDetections,
    int inputSize,
    boolean enableTracking,
    boolean enableSegmentation,
    boolean enableClassification,
    boolean allowSyntheticFallback,
    long maxMemoryBytes
) {
    public VisionConfig {
        if (modelId == null || modelId.isBlank()) {
            throw new IllegalArgumentException("modelId must not be blank");
        }
        modelId = modelId.trim();
        if (modelType == null || modelType.isBlank()) {
            throw new IllegalArgumentException("modelType must not be blank");
        }
        modelType = modelType.trim().toLowerCase(java.util.Locale.ROOT);
        if (maxConcurrentRequests < 1 || maxConcurrentRequests > 1_000) {
            throw new IllegalArgumentException("maxConcurrentRequests must be between 1 and 1000");
        }
        if (timeout == null || timeout.isZero() || timeout.isNegative()
                || timeout.compareTo(Duration.ofMinutes(10)) > 0) {
            throw new IllegalArgumentException("timeout must be between 1 ms and 10 minutes");
        }
        if (batchSize < 1 || batchSize > 10_000) {
            throw new IllegalArgumentException("batchSize must be between 1 and 10000");
        }
        if (defaultConfidenceThreshold < 0.0 || defaultConfidenceThreshold > 1.0) {
            throw new IllegalArgumentException("defaultConfidenceThreshold must be in [0.0, 1.0]");
        }
        if (defaultMaxDetections < 1 || defaultMaxDetections > 100_000) {
            throw new IllegalArgumentException("defaultMaxDetections must be between 1 and 100000");
        }
        if (inputSize < 32 || inputSize > 16_384) {
            throw new IllegalArgumentException("inputSize must be between 32 and 16384");
        }
        if (maxMemoryBytes < 1L * 1024 * 1024
                || maxMemoryBytes > 8L * 1024 * 1024 * 1024) {
            throw new IllegalArgumentException("maxMemoryBytes must be between 1 MiB and 8 GiB");
        }
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Path modelPath;
        private String modelId = "yolov8n";
        private String modelType = "yolo";
        private boolean useGpu;
        private int maxConcurrentRequests = 10;
        private Duration timeout = Duration.ofSeconds(10);
        private int batchSize = 1;
        private double defaultConfidenceThreshold = 0.5;
        private int defaultMaxDetections = 100;
        private int inputSize = 640;
        private boolean enableTracking;
        private boolean enableSegmentation;
        private boolean enableClassification;
        private boolean allowSyntheticFallback;
        private long maxMemoryBytes = 512L * 1024 * 1024;

        public Builder modelPath(Path value) { this.modelPath = value; return this; }
        public Builder modelId(String value) { this.modelId = value; return this; }
        public Builder modelType(String value) { this.modelType = value; return this; }
        public Builder useGpu(boolean value) { this.useGpu = value; return this; }
        public Builder maxConcurrentRequests(int value) { this.maxConcurrentRequests = value; return this; }
        public Builder timeout(Duration value) { this.timeout = value; return this; }
        public Builder batchSize(int value) { this.batchSize = value; return this; }
        public Builder defaultConfidenceThreshold(double value) { this.defaultConfidenceThreshold = value; return this; }
        public Builder defaultMaxDetections(int value) { this.defaultMaxDetections = value; return this; }
        public Builder inputSize(int value) { this.inputSize = value; return this; }
        public Builder enableTracking(boolean value) { this.enableTracking = value; return this; }
        public Builder enableSegmentation(boolean value) { this.enableSegmentation = value; return this; }
        public Builder enableClassification(boolean value) { this.enableClassification = value; return this; }
        public Builder allowSyntheticFallback(boolean value) { this.allowSyntheticFallback = value; return this; }
        public Builder maxMemoryBytes(long value) { this.maxMemoryBytes = value; return this; }

        public VisionConfig build() {
            return new VisionConfig(
                modelPath,
                modelId,
                modelType,
                useGpu,
                maxConcurrentRequests,
                timeout,
                batchSize,
                defaultConfidenceThreshold,
                defaultMaxDetections,
                inputSize,
                enableTracking,
                enableSegmentation,
                enableClassification,
                allowSyntheticFallback,
                maxMemoryBytes
            );
        }
    }
}
