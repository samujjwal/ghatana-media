package com.ghatana.media.vision.api;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.EngineMetrics;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.common.ImageData;
import com.ghatana.media.common.InferenceError;
import com.ghatana.media.common.ValidationError;
import com.ghatana.media.config.VisionConfig;
import io.activej.promise.Promise;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Factory for governed Vision engine instances.
 *
 * <p>Real ONNX object detection is canonical. Synthetic fallback is explicit local/test behavior,
 * reports degraded status, and returns no detections. Every returned provider is wrapped by
 * {@link GovernedVisionEngine} for resource and capability truth.
 *
 * @doc.type factory
 * @doc.purpose Fail-closed Vision provider composition
 * @doc.layer platform
 * @doc.pattern Factory
 */
public final class VisionEngineFactory {

    private static final Logger LOG = Logger.getLogger(VisionEngineFactory.class.getName());

    private VisionEngineFactory() {}

    public static VisionEngine create(
            VisionConfig config,
            AudioVideoLibrary.LibraryState libraryState) {
        Objects.requireNonNull(config, "config");
        Objects.requireNonNull(libraryState, "libraryState");
        LOG.info("Creating Vision Engine with model: " + config.modelId());

        Exception modelFailure = null;
        if (isReadableRegularFile(config.modelPath())) {
            try {
                VisionEngine engine = new com.ghatana.media.vision.engine.onnx.YoloOnnxEngine(
                        config,
                        libraryState);
                LOG.info("Successfully loaded ONNX Vision engine from: " + config.modelPath());
                return new GovernedVisionEngine(engine, config);
            } catch (Exception failure) {
                modelFailure = failure;
                LOG.log(Level.WARNING, "Failed to load ONNX Vision engine", failure);
            }
        }

        if (!config.allowSyntheticFallback()) {
            String message = config.modelPath() == null
                    ? "No Vision model was configured and synthetic fallback is disabled"
                    : "The configured Vision model is unavailable and synthetic fallback is disabled";
            throw modelFailure == null
                    ? new IllegalStateException(message)
                    : new IllegalStateException(message, modelFailure);
        }

        libraryState.markUnhealthy("Synthetic Vision fallback active");
        LOG.warning(
                "Using explicitly enabled synthetic Vision fallback. It returns no detections and "
                        + "is not production evidence.");
        return new GovernedVisionEngine(new SyntheticVisionEngine(config), config);
    }

    private static boolean isReadableRegularFile(Path path) {
        return path != null && Files.isRegularFile(path) && Files.isReadable(path);
    }

    private static final class SyntheticVisionEngine implements VisionEngine {
        private final VisionConfig config;
        private final Semaphore permits;
        private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
        private final AtomicLong requests = new AtomicLong();
        private final AtomicBoolean closed = new AtomicBoolean();
        private final long startedAt = System.currentTimeMillis();

        private SyntheticVisionEngine(VisionConfig config) {
            this.config = config;
            this.permits = new Semaphore(config.maxConcurrentRequests());
        }

        @Override
        public DetectionResult detect(ImageData image, DetectionOptions options) {
            ensureOpen();
            validateImage(image);
            Objects.requireNonNull(options, "options");
            requests.incrementAndGet();
            long started = System.nanoTime();
            try {
                permits.acquire();
                try {
                    return new DetectionResult(
                            List.of(),
                            image.width(),
                            image.height(),
                            Math.max(0L, (System.nanoTime() - started) / 1_000_000L),
                            config.modelId());
                } finally {
                    permits.release();
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new InferenceError("Synthetic Vision detection interrupted", interrupted, true);
            }
        }

        @Override
        public Promise<DetectionResult> detectAsync(ImageData image, DetectionOptions options) {
            return Promise.ofBlocking(executor, () -> detect(image, options));
        }

        @Override
        public StreamingDetectionSession createStreamingSession(
                DetectionOptions options,
                Consumer<DetectionResult> resultCallback) {
            Objects.requireNonNull(options, "options");
            Objects.requireNonNull(resultCallback, "resultCallback");
            return new StreamingDetectionSession() {
                private final AtomicBoolean active = new AtomicBoolean(true);

                @Override
                public void feedFrame(ImageData frame, long frameNumber) {
                    if (!active.get()) throw new IllegalStateException("Vision stream is closed");
                    resultCallback.accept(detect(frame, options));
                }

                @Override public void endStream() { active.set(false); }
                @Override public boolean isActive() { return active.get(); }
                @Override public void close() { active.set(false); }
            };
        }

        @Override public String caption(ImageData image) { throw unsupported("captioning"); }
        @Override public List<Classification> classify(ImageData image, int topK) { throw unsupported("classification"); }
        @Override public List<DetectionModelInfo> getAvailableModels() { return List.of(getActiveModel()); }

        @Override
        public void loadModel(String modelId) {
            if (!config.modelId().equals(modelId)) {
                throw unsupported("model switching");
            }
        }

        @Override
        public DetectionModelInfo getActiveModel() {
            return new DetectionModelInfo(
                    config.modelId(),
                    "Synthetic local/test Vision",
                    "synthetic-local-v1",
                    new String[0],
                    0L,
                    false,
                    config.inputSize(),
                    config.inputSize(),
                    Optional.of("Returns no detections"));
        }

        @Override public void warmup() { ensureOpen(); }

        @Override
        public void close() {
            if (closed.compareAndSet(false, true)) executor.shutdownNow();
        }

        @Override
        public EngineStatus getStatus() {
            return new EngineStatus(
                    closed.get() ? EngineStatus.State.CLOSED : EngineStatus.State.DEGRADED,
                    config.modelId(),
                    "synthetic-local-v1",
                    System.currentTimeMillis() - startedAt,
                    closed.get() ? "Engine closed" : "Synthetic Vision fallback active");
        }

        @Override
        public EngineMetrics getMetrics() {
            return new EngineMetrics(
                    requests.get(),
                    0L,
                    0.0,
                    config.maxConcurrentRequests() - permits.availablePermits(),
                    0L);
        }

        private void validateImage(ImageData image) {
            if (image == null) throw new ValidationError("Image data cannot be null");
            if (image.data() == null || image.data().length == 0) {
                throw new ValidationError("Image data cannot be empty");
            }
        }

        private void ensureOpen() {
            if (closed.get()) throw new IllegalStateException("Vision Engine is closed");
        }

        private static UnsupportedOperationException unsupported(String capability) {
            return new UnsupportedOperationException(
                    "Synthetic Vision fallback does not support " + capability);
        }
    }
}
