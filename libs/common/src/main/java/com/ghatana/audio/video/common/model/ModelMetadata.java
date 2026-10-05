package com.ghatana.audio.video.common.model;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;

/**
 * Immutable metadata for a managed AI model.
 *
 * @doc.type record
 * @doc.purpose Value object capturing identity, location, and versioning of a model asset
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public record ModelMetadata(
        String modelId,
        String name,
        String version,
        ModelType type,
        Path modelPath,
        List<String> supportedLanguages,
        long sizeBytes,
        boolean supportsGpu,
        Instant registeredAt,
        Instant lastLoadedAt,
        boolean loaded
) {
    /** Canonical model type taxonomy. */
    public enum ModelType {
        STT, TTS, VISION, MULTIMODAL
    }

    /** Builder for constructing {@link ModelMetadata}. */
    public static Builder builder() {
        return new Builder();
    }

    /** Returns a copy with {@code loaded} set to the given value. */
    public ModelMetadata withLoaded(boolean loaded) {
        return new ModelMetadata(modelId, name, version, type, modelPath,
                supportedLanguages, sizeBytes, supportsGpu, registeredAt,
                Instant.now(), loaded);
    }

    public static final class Builder {
        private String modelId;
        private String name;
        private String version = "0.0.1";
        private ModelType type = ModelType.STT;
        private Path modelPath;
        private List<String> supportedLanguages = List.of();
        private long sizeBytes = 0;
        private boolean supportsGpu = false;
        private Instant registeredAt = Instant.now();
        private Instant lastLoadedAt = null;
        private boolean loaded = false;

        public Builder modelId(String v)                { this.modelId = v; return this; }
        public Builder name(String v)                   { this.name = v; return this; }
        public Builder version(String v)                { this.version = v; return this; }
        public Builder type(ModelType v)                { this.type = v; return this; }
        public Builder modelPath(Path v)                { this.modelPath = v; return this; }
        public Builder supportedLanguages(List<String> v) { this.supportedLanguages = List.copyOf(v); return this; }
        public Builder sizeBytes(long v)               { this.sizeBytes = v; return this; }
        public Builder supportsGpu(boolean v)           { this.supportsGpu = v; return this; }
        public Builder registeredAt(Instant v)          { this.registeredAt = v; return this; }
        public Builder lastLoadedAt(Instant v)          { this.lastLoadedAt = v; return this; }
        public Builder loaded(boolean v)                { this.loaded = v; return this; }

        public ModelMetadata build() {
            if (modelId == null || modelId.isBlank()) {
                throw new IllegalStateException("modelId is required");
            }
            if (name == null || name.isBlank()) {
                name = modelId;
            }
            return new ModelMetadata(modelId, name, version, type, modelPath,
                    supportedLanguages, sizeBytes, supportsGpu, registeredAt, lastLoadedAt, loaded);
        }
    }
}
