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
    private final int cacheCapacity;
    private final ConcurrentHashMap<String, ModelMetadata> registry = new ConcurrentHashMap<>();
    private final LinkedHashMap<String, ModelMetadata> lruCache;
    public FileSystemModelStore() {
        this(DEFAULT_CACHE_CAPACITY);
    }
    public FileSystemModelStore(int cacheCapacity) {
        if (cacheCapacity < 1) throw new IllegalArgumentException("cacheCapacity must be >= 1");
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
    public void register(ModelMetadata metadata) {
        Objects.requireNonNull(metadata, "metadata cannot be null");
        if (registry.putIfAbsent(metadata.modelId(), metadata) != null) {
            throw new ModelRegistryException("Model already registered: " + metadata.modelId());
        }
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
    @Override
    public Optional<ModelMetadata> getActiveModel(ModelMetadata.ModelType type) {
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
