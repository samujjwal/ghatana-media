package com.ghatana.audio.video.common.model;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;
/**
 * File-system backed {@link ModelRegistry} with an in-memory LRU cache.
 *
 * <p>Models are registered with their filesystem paths. Loading a model verifies the file exists
 * and updates the in-memory cache. The cache evicts the least-recently-used entry when the
 * capacity limit is reached.
 *
 * @doc.type class
 * @doc.purpose File-based ModelRegistry with LRU in-memory caching
 * @doc.layer product
 * @doc.pattern Repository, Cache
 */
public final class FileSystemModelStore implements ModelRegistry {
    private static final Logger LOG = LoggerFactory.getLogger(FileSystemModelStore.class);
    /** Default maximum number of concurrently cached models per store. */
    public static final int DEFAULT_CACHE_CAPACITY = 8;
    /** Maximum cache size accepted from configuration. */
    public static final int MAX_CACHE_CAPACITY = 1_024;
    /** Maximum number of model descriptors retained by this in-memory registry. */
    public static final int MAX_REGISTERED_MODELS = 10_000;
    private final int cacheCapacity;
    private final ConcurrentHashMap<String, ModelMetadata> registry = new ConcurrentHashMap<>();
    private final LinkedHashMap<String, ModelMetadata> lruCache;
    public FileSystemModelStore() {
        this(DEFAULT_CACHE_CAPACITY);
    }
    public FileSystemModelStore(int cacheCapacity) {
        if (cacheCapacity < 1 || cacheCapacity > MAX_CACHE_CAPACITY) {
            throw new IllegalArgumentException("cacheCapacity must be between 1 and " + MAX_CACHE_CAPACITY);
        }
        this.cacheCapacity = cacheCapacity;
        this.lruCache = new LinkedHashMap<>(cacheCapacity + 1, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, ModelMetadata> eldest) {
                if (size() > cacheCapacity) {
                    LOG.info("LRU eviction: unloading model {}", eldest.getKey());
                    registry.put(eldest.getKey(), eldest.getValue().withLoaded(false));
                    return true;
                }
                return false;
            }
        };
    }
    @Override
    public synchronized void register(ModelMetadata metadata) {
        Objects.requireNonNull(metadata, "metadata cannot be null");
        if (registry.containsKey(metadata.modelId())) {
            throw new ModelRegistryException("Model already registered: " + metadata.modelId());
        }
        if (registry.size() >= MAX_REGISTERED_MODELS) {
            throw new ModelRegistryException("Model registry capacity reached");
        }
        registry.put(metadata.modelId(), metadata);
        LOG.info("Model registered: {} ({})", metadata.modelId(), metadata.type());
    }
    @Override
    public synchronized ModelMetadata load(String modelId) {
        Objects.requireNonNull(modelId, "modelId cannot be null");
        ModelMetadata meta = registry.get(modelId);
        if (meta == null) {
            throw new ModelRegistryException("Model not registered: " + modelId);
        }
        if (meta.loaded()) {
            lruCache.get(modelId); // refresh LRU position
            return meta;
        }
        if (meta.modelPath() != null) {
            Path p = meta.modelPath();
            if (!Files.exists(p)) {
                throw new ModelRegistryException("Model file not found for " + modelId + ": " + p);
            }
            long actualSize;
            try {
                actualSize = Files.size(p);
            } catch (IOException e) {
                throw new ModelRegistryException("Cannot read model file for " + modelId, e);
            }
            meta = ModelMetadata.builder()
                    .modelId(meta.modelId()).name(meta.name()).version(meta.version())
                    .type(meta.type()).modelPath(meta.modelPath())
                    .supportedLanguages(meta.supportedLanguages())
                    .sizeBytes(actualSize).supportsGpu(meta.supportsGpu())
                    .registeredAt(meta.registeredAt()).loaded(true)
                    .build();
        } else {
            meta = meta.withLoaded(true);
        }
        registry.put(modelId, meta);
        lruCache.put(modelId, meta);
        LOG.info("Model loaded: {} (cache {}/{})", modelId, lruCache.size(), cacheCapacity);
        return meta;
    }
    @Override
    public synchronized long unload(String modelId) {
        Objects.requireNonNull(modelId, "modelId cannot be null");
        ModelMetadata meta = registry.get(modelId);
        if (meta == null) {
            throw new ModelRegistryException("Model not registered: " + modelId);
        }
        if (!meta.loaded()) return 0L;
        long freed = meta.sizeBytes();
        registry.put(modelId, meta.withLoaded(false));
        lruCache.remove(modelId);
        LOG.info("Model unloaded: {} (freed ~{} bytes)", modelId, freed);
        return freed;
    }
    @Override
    public List<ModelMetadata> listModels(ModelMetadata.ModelType type) {
        return registry.values().stream()
                .filter(m -> type == null || m.type() == type)
                .sorted(Comparator
                        .comparing(ModelMetadata::loaded, Comparator.reverseOrder())
                        .thenComparing(ModelMetadata::modelId))
                .collect(Collectors.toUnmodifiableList());
    }
    @Override
    public Optional<ModelMetadata> findById(String modelId) {
        return Optional.ofNullable(registry.get(modelId));
    }

    /**
     * Returns a bounded, non-sensitive descriptor for a registered model.
     *
     * <p>{@code READY} means only that this store has the model loaded and its local asset is
     * currently available. It does not qualify a model, prove provider behavior, or imply a
     * successful engine effect. The source field is a source kind, never a filesystem path.
     */
    public synchronized Optional<ModelDescriptor> describe(String modelId) {
        Objects.requireNonNull(modelId, "modelId cannot be null");
        ModelMetadata metadata = registry.get(modelId);
        if (metadata == null) {
            return Optional.empty();
        }
        String source = metadata.modelPath() == null ? "in-memory" : "filesystem";
        boolean sourceAvailable = metadata.modelPath() == null
                || (Files.isRegularFile(metadata.modelPath()) && Files.isReadable(metadata.modelPath()));
        boolean cached = lruCache.containsKey(modelId);
        Readiness readiness = !cached || !metadata.loaded() || !sourceAvailable
                ? Readiness.NOT_READY
                : metadata.modelPath() == null ? Readiness.UNVERIFIED : Readiness.READY;
        return Optional.of(new ModelDescriptor(metadata.modelId(), metadata.version(), source,
                metadata.type(), readiness));
    }

    /** Asset-store readiness only; it is not model or engine qualification. */
    public enum Readiness {
        READY,
        NOT_READY,
        UNVERIFIED
    }

    /** Public descriptor with no local path or qualification claim. */
    public record ModelDescriptor(
            String modelId,
            String version,
            String source,
            ModelMetadata.ModelType type,
            Readiness readiness) {}
    @Override
    public synchronized Optional<ModelMetadata> getActiveModel(ModelMetadata.ModelType type) {
        return lruCache.values().stream()
                .filter(m -> type == null || m.type() == type)
                .reduce((first, second) -> second);
    }
    @Override
    public boolean isLoaded(String modelId) {
        ModelMetadata meta = registry.get(modelId);
        return meta != null && meta.loaded();
    }
    @Override
    public synchronized int loadedCount() {
        return lruCache.size();
    }
}
