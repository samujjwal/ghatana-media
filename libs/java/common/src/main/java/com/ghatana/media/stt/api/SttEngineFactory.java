package com.ghatana.media.stt.api;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.config.SttConfig;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Objects;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Factory for governed STT engine instances.
 *
 * <p>Real Whisper ONNX loading is canonical. Synthetic fallback is explicit local/test behavior,
 * reports degraded status, and produces no semantic transcript. Every returned provider is wrapped
 * by {@link GovernedSttEngine} to enforce one-model authority, input bounds, truthful profiles, and
 * warmup failure propagation.
 *
 * @doc.type factory
 * @doc.purpose Fail-closed STT provider composition
 * @doc.layer platform
 * @doc.pattern Factory
 */
public final class SttEngineFactory {

    private static final Logger LOG = Logger.getLogger(SttEngineFactory.class.getName());

    private SttEngineFactory() {}

    public static SttEngine create(
            SttConfig config,
            AudioVideoLibrary.LibraryState libraryState) {
        Objects.requireNonNull(config, "config");
        Objects.requireNonNull(libraryState, "libraryState");
        LOG.info("Creating STT Engine with model: " + config.modelId());

        Path modelPath = resolveModelPath(config);
        Exception modelFailure = null;
        if (modelPath != null) {
            SttConfig resolved = copyWithResolvedModel(config, modelPath);
            try {
                SttEngine engine = new com.ghatana.media.stt.engine.onnx.WhisperOnnxEngine(
                        resolved,
                        libraryState);
                LOG.info("Successfully loaded ONNX STT engine from: " + modelPath);
                return new GovernedSttEngine(engine, resolved);
            } catch (Exception failure) {
                modelFailure = failure;
                LOG.log(Level.WARNING, "Failed to load ONNX STT engine from " + modelPath, failure);
            }
        }

        if (!config.allowSyntheticFallback()) {
            String message = modelPath == null
                    ? "No STT model was found and synthetic fallback is disabled"
                    : "The configured STT model failed to load and synthetic fallback is disabled";
            throw modelFailure == null
                    ? new IllegalStateException(message)
                    : new IllegalStateException(message, modelFailure);
        }

        libraryState.markUnhealthy("Synthetic STT fallback active");
        LOG.warning(
                "Using explicitly enabled synthetic STT fallback. It produces empty zero-confidence "
                        + "transcripts and is not production evidence.");
        return new GovernedSttEngine(new SyntheticSttEngine(config), config);
    }

    private static SttConfig copyWithResolvedModel(SttConfig config, Path modelPath) {
        return SttConfig.builder()
                .modelPath(modelPath)
                .modelId(config.modelId())
                .useGpu(config.useGpu())
                .maxConcurrentRequests(config.maxConcurrentRequests())
                .timeout(config.timeout())
                .beamSize(config.beamSize())
                .enableAdaptation(false)
                .enablePunctuation(config.enablePunctuation())
                .enableTimestamps(config.enableTimestamps())
                .profileStoragePath(config.profileStoragePath())
                .encryptionKeyId(config.encryptionKeyId())
                .cloudFallback(config.cloudFallback().orElse(null))
                .maxAudioLengthSeconds(config.maxAudioLengthSeconds())
                .allowSyntheticFallback(config.allowSyntheticFallback())
                .maxMemoryBytes(config.maxMemoryBytes())
                .build();
    }

    private static Path resolveModelPath(SttConfig config) {
        if (isReadableRegularFile(config.modelPath())) {
            return config.modelPath().toAbsolutePath().normalize();
        }

        String envPath = System.getenv("STT_MODEL_PATH");
        if (envPath != null && !envPath.isBlank()) {
            Path candidate = Paths.get(envPath.trim());
            if (isReadableRegularFile(candidate)) return candidate.toAbsolutePath().normalize();
        }

        for (String pathValue : java.util.List.of(
                "/models/whisper-" + config.modelId() + ".onnx",
                "/models/whisper-base.onnx",
                "/usr/local/share/whisper/models/" + config.modelId() + ".onnx",
                "models/whisper-" + config.modelId() + ".onnx")) {
            Path candidate = Paths.get(pathValue);
            if (isReadableRegularFile(candidate)) return candidate.toAbsolutePath().normalize();
        }

        String userHome = System.getProperty("user.home");
        if (userHome != null && !userHome.isBlank()) {
            Path candidate = Paths.get(
                    userHome,
                    ".cache",
                    "ghatana",
                    "models",
                    "whisper-" + config.modelId() + ".onnx");
            if (isReadableRegularFile(candidate)) return candidate.toAbsolutePath().normalize();
        }
        return null;
    }

    private static boolean isReadableRegularFile(Path path) {
        return path != null && Files.isRegularFile(path) && Files.isReadable(path);
    }
}
