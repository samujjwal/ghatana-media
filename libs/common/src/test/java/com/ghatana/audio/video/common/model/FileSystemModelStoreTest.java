package com.ghatana.audio.video.common.model;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.*;

/**
 * Unit tests for {@link FileSystemModelStore}.
 *
 * @doc.type class
 * @doc.purpose Verifies ModelRegistry: registration, load, unload, LRU eviction, listing
 * @doc.layer product
 * @doc.pattern TestCase
 */
@DisplayName("FileSystemModelStore")
class FileSystemModelStoreTest {

    @TempDir
    Path tempDir;

    private FileSystemModelStore store;

    @BeforeEach
    void setUp() { 
        store = new FileSystemModelStore(3); // small capacity for eviction tests 
    }

    // ── register ────────────────────────────────────────────────────────────

    @Test
    @DisplayName("register: stores metadata and is findable by ID")
    void register_storesMetadata() { 
        ModelMetadata meta = buildMeta("model-a", ModelMetadata.ModelType.STT); 
        store.register(meta); 

        Optional<ModelMetadata> found = store.findById("model-a");
        assertThat(found).isPresent(); 
        assertThat(found.get().modelId()).isEqualTo("model-a");
        assertThat(found.get().loaded()).isFalse(); 
    }

    @Test
    @DisplayName("register: duplicate model ID throws ModelRegistryException")
    void register_duplicate_throws() { 
        ModelMetadata meta = buildMeta("dup", ModelMetadata.ModelType.TTS); 
        store.register(meta); 

        assertThatThrownBy(() -> store.register(meta)) 
                .isInstanceOf(ModelRegistry.ModelRegistryException.class) 
                .hasMessageContaining("already registered");
    }

    @Test
    @DisplayName("register: registry refuses model counts beyond its finite descriptor bound")
    void register_atCapacity_rejectsAdditionalModel() {
        FileSystemModelStore bounded = new FileSystemModelStore(1);
        for (int i = 0; i < FileSystemModelStore.MAX_REGISTERED_MODELS; i++) {
            bounded.register(buildMeta("model-" + i, ModelMetadata.ModelType.STT));
        }

        assertThatThrownBy(() -> bounded.register(buildMeta("overflow", ModelMetadata.ModelType.STT)))
            .isInstanceOf(ModelRegistry.ModelRegistryException.class)
            .hasMessageContaining("capacity");
    }

    @Test
    @DisplayName("constructor: cache capacity has a finite upper bound")
    void constructor_cacheCapacityAboveBound_rejects() {
        assertThatThrownBy(() -> new FileSystemModelStore(FileSystemModelStore.MAX_CACHE_CAPACITY + 1))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("cacheCapacity");
    }

    // ── load ────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("load: model without path loads successfully")
    void load_withoutPath_succeeds() { 
        store.register(buildMeta("m1", ModelMetadata.ModelType.STT)); 

        ModelMetadata loaded = store.load("m1");

        assertThat(loaded.loaded()).isTrue(); 
        assertThat(store.isLoaded("m1")).isTrue();
        assertThat(store.loadedCount()).isEqualTo(1); 
    }

    @Test
    @DisplayName("load: model with existing file loads successfully and captures size")
    void load_withExistingFile_capturesSize() throws IOException { 
        Path modelFile = tempDir.resolve("whisper.onnx");
        Files.write(modelFile, new byte[1024]); 

        ModelMetadata meta = ModelMetadata.builder() 
                .modelId("whisper").type(ModelMetadata.ModelType.STT)
                .modelPath(modelFile).build(); 
        store.register(meta); 

        ModelMetadata loaded = store.load("whisper");

        assertThat(loaded.loaded()).isTrue(); 
        assertThat(loaded.sizeBytes()).isEqualTo(1024L); 
    }

    @Test
    @DisplayName("describe: reports asset readiness with source and version but no local path")
    void describe_reportsBoundedAssetReadiness() throws IOException {
        Path modelFile = tempDir.resolve("private-model-dir/model.onnx");
        Files.createDirectories(modelFile.getParent());
        Files.write(modelFile, new byte[] {1, 2, 3});
        ModelMetadata metadata = ModelMetadata.builder()
                .modelId("model-a").version("2.4.1").type(ModelMetadata.ModelType.STT)
                .modelPath(modelFile).build();
        store.register(metadata);

        var beforeLoad = store.describe("model-a").orElseThrow();
        assertThat(beforeLoad.version()).isEqualTo("2.4.1");
        assertThat(beforeLoad.source()).isEqualTo("filesystem");
        assertThat(beforeLoad.readiness()).isEqualTo(FileSystemModelStore.Readiness.NOT_READY);
        assertThat(beforeLoad.toString()).doesNotContain(modelFile.toString());

        store.load("model-a");
        assertThat(store.describe("model-a").orElseThrow().readiness())
                .isEqualTo(FileSystemModelStore.Readiness.READY);
    }

    @Test
    @DisplayName("describe: missing and unregistered models do not report ready")
    void describe_missingSourceAndUnknownModel_areNotReady() {
        Path missingFile = tempDir.resolve("missing.onnx");
        store.register(ModelMetadata.builder().modelId("missing-source")
                .modelPath(missingFile).build());

        assertThat(store.describe("missing-source").orElseThrow().readiness())
                .isEqualTo(FileSystemModelStore.Readiness.NOT_READY);
        assertThat(store.describe("ghost")).isEmpty();
    }

    @Test
    @DisplayName("describe: caller-supplied loaded metadata is not store readiness")
    void describe_preloadedMetadataRequiresStoreCacheMembership() {
        store.register(ModelMetadata.builder().modelId("preloaded")
                .modelPath(tempDir.resolve("exists.onnx")).loaded(true).build());

        assertThat(store.describe("preloaded").orElseThrow().readiness())
                .isEqualTo(FileSystemModelStore.Readiness.NOT_READY);
    }

    @Test
    @DisplayName("describe: cached in-memory registration remains unverified")
    void describe_inMemoryModelIsUnverified() {
        store.register(buildMeta("memory-model", ModelMetadata.ModelType.STT));
        store.load("memory-model");

        assertThat(store.describe("memory-model").orElseThrow().readiness())
                .isEqualTo(FileSystemModelStore.Readiness.UNVERIFIED);
    }

    @Test
    @DisplayName("load: model with missing file throws ModelRegistryException")
    void load_missingFile_throws() { 
        Path missingFile = tempDir.resolve("missing.onnx");
        ModelMetadata meta = ModelMetadata.builder() 
                .modelId("missing").type(ModelMetadata.ModelType.STT)
                .modelPath(missingFile).build(); 
        store.register(meta); 

        assertThatThrownBy(() -> store.load("missing"))
                .isInstanceOf(ModelRegistry.ModelRegistryException.class) 
                .hasMessageContaining("not found");
    }

    @Test
    @DisplayName("load: unregistered model ID throws ModelRegistryException")
    void load_unregistered_throws() { 
        assertThatThrownBy(() -> store.load("ghost"))
                .isInstanceOf(ModelRegistry.ModelRegistryException.class) 
                .hasMessageContaining("not registered");
    }

    @Test
    @DisplayName("load: already-loaded model is idempotent")
    void load_alreadyLoaded_idempotent() { 
        store.register(buildMeta("m1", ModelMetadata.ModelType.STT)); 
        store.load("m1");
        ModelMetadata second = store.load("m1");

        assertThat(second.loaded()).isTrue(); 
        assertThat(store.loadedCount()).isEqualTo(1); 
    }

    // ── unload ──────────────────────────────────────────────────────────────

    @Test
    @DisplayName("unload: unloads loaded model and returns 0 size for path-less model")
    void unload_loadedModel_succeeds() { 
        store.register(buildMeta("m1", ModelMetadata.ModelType.STT)); 
        store.load("m1");

        long freed = store.unload("m1");

        assertThat(store.isLoaded("m1")).isFalse();
        assertThat(store.loadedCount()).isEqualTo(0); 
        assertThat(freed).isGreaterThanOrEqualTo(0L); 
    }

    @Test
    @DisplayName("unload: calling on unloaded model returns 0")
    void unload_notLoaded_returnsZero() { 
        store.register(buildMeta("m1", ModelMetadata.ModelType.STT)); 

        long freed = store.unload("m1");

        assertThat(freed).isEqualTo(0L); 
    }

    @Test
    @DisplayName("unload: unregistered model ID throws ModelRegistryException")
    void unload_unregistered_throws() { 
        assertThatThrownBy(() -> store.unload("ghost"))
                .isInstanceOf(ModelRegistry.ModelRegistryException.class) 
                .hasMessageContaining("not registered");
    }

    // ── LRU eviction ────────────────────────────────────────────────────────

    @Test
    @DisplayName("LRU eviction: exceeding capacity evicts oldest model")
    void lruEviction_evictsOldest() { 
        for (String id : List.of("a", "b", "c", "d")) { 
            store.register(buildMeta(id, ModelMetadata.ModelType.STT)); 
        }
        store.load("a");
        store.load("b");
        store.load("c");
        // Now at capacity=3; loading "d" should evict "a" (oldest) 
        store.load("d");

        assertThat(store.loadedCount()).isEqualTo(3); 
        assertThat(store.isLoaded("a")).isFalse();
        assertThat(store.isLoaded("b")).isTrue();
        assertThat(store.isLoaded("c")).isTrue();
        assertThat(store.isLoaded("d")).isTrue();
        // "a" should still be registered (just unloaded) 
        assertThat(store.findById("a")).isPresent();
    }

    // ── listModels ──────────────────────────────────────────────────────────

    @Test
    @DisplayName("listModels: returns all models when type is null")
    void listModels_nullType_returnsAll() { 
        store.register(buildMeta("stt1", ModelMetadata.ModelType.STT)); 
        store.register(buildMeta("tts1", ModelMetadata.ModelType.TTS)); 

        List<ModelMetadata> all = store.listAllModels(); 
        assertThat(all).hasSize(2); 
    }

    @Test
    @DisplayName("listModels: filters by type correctly")
    void listModels_byType_filtersCorrectly() { 
        store.register(buildMeta("stt1", ModelMetadata.ModelType.STT)); 
        store.register(buildMeta("tts1", ModelMetadata.ModelType.TTS)); 

        List<ModelMetadata> sttOnly = store.listModels(ModelMetadata.ModelType.STT); 
        assertThat(sttOnly).hasSize(1); 
        assertThat(sttOnly.get(0).modelId()).isEqualTo("stt1");
    }

    @Test
    @DisplayName("listModels: loaded models appear before unloaded")
    void listModels_loadedFirst() { 
        store.register(buildMeta("unloaded", ModelMetadata.ModelType.STT)); 
        store.register(buildMeta("loaded", ModelMetadata.ModelType.STT)); 
        store.load("loaded");

        List<ModelMetadata> models = store.listModels(ModelMetadata.ModelType.STT); 
        assertThat(models.get(0).modelId()).isEqualTo("loaded");
    }

    // ── getActiveModel ──────────────────────────────────────────────────────

    @Test
    @DisplayName("getActiveModel: returns most recently loaded model of given type")
    void getActiveModel_returnsMostRecent() { 
        store.register(buildMeta("stt1", ModelMetadata.ModelType.STT)); 
        store.register(buildMeta("stt2", ModelMetadata.ModelType.STT)); 
        store.load("stt1");
        store.load("stt2");

        Optional<ModelMetadata> active = store.getActiveModel(ModelMetadata.ModelType.STT); 
        assertThat(active).isPresent(); 
        assertThat(active.get().modelId()).isEqualTo("stt2");
    }

    @Test
    @DisplayName("getActiveModel: returns empty when no model loaded")
    void getActiveModel_noneLoaded_empty() { 
        Optional<ModelMetadata> active = store.getActiveModel(ModelMetadata.ModelType.VISION); 
        assertThat(active).isEmpty(); 
    }

    @Test
    @DisplayName("getActiveModel: concurrent reads and cache mutations remain safe")
    void getActiveModel_concurrentCacheAccessIsSafe() throws Exception {
        for (String id : List.of("a", "b", "c", "d")) {
            store.register(buildMeta(id, ModelMetadata.ModelType.STT));
        }
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<?> cacheMutations = workers.submit(() -> {
                for (int i = 0; i < 500; i++) {
                    String id = List.of("a", "b", "c", "d").get(i % 4);
                    store.load(id);
                    store.unload(id);
                }
            });
            Future<?> activeReads = workers.submit(() -> {
                for (int i = 0; i < 2_000; i++) {
                    store.getActiveModel(ModelMetadata.ModelType.STT);
                }
            });

            cacheMutations.get(5, TimeUnit.SECONDS);
            activeReads.get(5, TimeUnit.SECONDS);
        } finally {
            workers.shutdownNow();
        }
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private static ModelMetadata buildMeta(String id, ModelMetadata.ModelType type) { 
        return ModelMetadata.builder() 
                .modelId(id) 
                .name(id + "-model") 
                .type(type) 
                .build(); 
    }
}
