package com.ghatana.audio.video.common.model;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Objects;

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
    /** Development bound aligned with the public media identifier contract. */
    public static final int MAX_MODEL_ID_LENGTH = 256;
    /** Conservative development bound for a registry display name; not a product maximum. */
    public static final int MAX_NAME_LENGTH = 512;
    /** Development bound aligned with public model-version contracts. */
    public static final int MAX_VERSION_LENGTH = 128;
    /** Maximum textual path size retained by the local registry; not an asset-size limit. */
    public static final int MAX_MODEL_PATH_LENGTH = 4_096;
    /** Development bounds aligned with public capability descriptors. */
    public static final int MAX_SUPPORTED_LANGUAGES = 512;
    public static final int MAX_LANGUAGE_LENGTH = 64;

    /**
     * Validates metadata regardless of whether it was created through the builder or directly.
     * These are bounded development metadata limits, not product maxima or model qualification.
     */
    public ModelMetadata {
        modelId = requireBoundedText(modelId, "modelId", MAX_MODEL_ID_LENGTH, true);
        if (name == null || name.isBlank()) {
            name = modelId;
        }
        name = requireBoundedText(name, "name", MAX_NAME_LENGTH, true);
        version = requireBoundedText(version, "version", MAX_VERSION_LENGTH, true);
        type = Objects.requireNonNull(type, "type");
        if (modelPath != null && modelPath.toString().length() > MAX_MODEL_PATH_LENGTH) {
            throw new IllegalArgumentException("modelPath exceeds " + MAX_MODEL_PATH_LENGTH + " characters");
        }
        Objects.requireNonNull(supportedLanguages, "supportedLanguages");
        if (supportedLanguages.size() > MAX_SUPPORTED_LANGUAGES) {
            throw new IllegalArgumentException("supportedLanguages exceeds " + MAX_SUPPORTED_LANGUAGES + " entries");
        }
        for (String language : supportedLanguages) {
            requireBoundedText(language, "supportedLanguages element", MAX_LANGUAGE_LENGTH, false);
        }
        supportedLanguages = List.copyOf(supportedLanguages);
        if (sizeBytes < 0) {
            throw new IllegalArgumentException("sizeBytes must be nonnegative");
        }
        registeredAt = Objects.requireNonNull(registeredAt, "registeredAt");
    }

    private static String requireBoundedText(String value, String field, int maxLength, boolean requireNonBlank) {
        Objects.requireNonNull(value, field);
        if ((requireNonBlank && value.isBlank()) || value.length() > maxLength) {
            throw new IllegalArgumentException(field + " must "
                    + (requireNonBlank ? "be nonblank and " : "")
                    + "contain at most " + maxLength + " characters");
        }
        return value;
    }

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
