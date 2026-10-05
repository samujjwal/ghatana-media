package com.ghatana.audio.video.common.model;
import java.util.List;
import java.util.Optional;
/**
 * Shared interface for model lifecycle management across STT, TTS, Vision, and Multimodal services.
 *
 * @doc.type interface
 * @doc.purpose Unified model management contract for audio-video services
 * @doc.layer product
 * @doc.pattern ServiceInterface
 */
public interface ModelRegistry {
    /** Register model metadata without loading the model into memory. */
    void register(ModelMetadata metadata);
    /**
     * Load the model into the in-memory cache.
     * @throws ModelRegistryException if not registered or cannot be loaded
     */
    ModelMetadata load(String modelId);
    /**
     * Unload the model from the in-memory cache.
     * @return freed memory in bytes (0 if model was not loaded)
     * @throws ModelRegistryException if the model is not registered
     */
    long unload(String modelId);
    /**
     * List registered models, optionally filtered by type.
     * @param type model type filter; null returns all types
     */
    List<ModelMetadata> listModels(ModelMetadata.ModelType type);
    /** List all registered models regardless of type. */
    default List<ModelMetadata> listAllModels() {
        return listModels(null);
    }
    /** Look up a model by ID without loading it. */
    Optional<ModelMetadata> findById(String modelId);
    /** Retrieve the currently active (loaded) model for the given type. */
    Optional<ModelMetadata> getActiveModel(ModelMetadata.ModelType type);
    /** Check whether a model is currently loaded in the cache. */
    boolean isLoaded(String modelId);
    /** Return the number of models currently held in the in-memory cache. */
    int loadedCount();
    /** Exception raised for model registry errors. */
    class ModelRegistryException extends RuntimeException {
        public ModelRegistryException(String message) { super(message); }
        public ModelRegistryException(String message, Throwable cause) { super(message, cause); }
    }
}
