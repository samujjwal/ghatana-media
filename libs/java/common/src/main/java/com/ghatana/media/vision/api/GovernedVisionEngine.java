package com.ghatana.media.vision.api;

import com.ghatana.media.common.EngineMetrics;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.common.ImageData;
import com.ghatana.media.common.ValidationError;
import com.ghatana.media.config.VisionConfig;
import io.activej.promise.Promise;

import java.util.List;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.EnumSet;
import java.util.function.Consumer;

/**
 * Truthful capability and resource boundary around a concrete vision provider.
 *
 * <p>Object detection is the canonical capability. Classification may be exposed only when
 * explicitly enabled and remains detection-derived. Caption generation, segmentation, tracking,
 * and model hot-swap are rejected until real providers are wired. Image memory bounds, result model
 * identity, model inventory, warmup, and lifecycle are enforced consistently.
 *
 * @doc.type class
 * @doc.purpose Enforce Vision provider capability truth and resource limits
 * @doc.layer platform
 * @doc.pattern Decorator
 */
public final class GovernedVisionEngine implements VisionEngine {

    private final VisionEngine delegate;
    private final VisionConfig config;
    private final AtomicBoolean closed = new AtomicBoolean();

    public GovernedVisionEngine(VisionEngine delegate, VisionConfig config) {
        this.delegate = Objects.requireNonNull(delegate, "delegate");
        this.config = Objects.requireNonNull(config, "config");
        if (config.enableTracking()) {
            throw new UnsupportedOperationException(
                    "Vision tracking requires a dedicated tracking provider");
        }
        if (config.enableSegmentation()) {
            throw new UnsupportedOperationException(
                    "Vision segmentation requires a segmentation-capable provider");
        }
    }

    @Override
    public VisionCapabilities capabilities() {
        EnumSet<VisionCapabilities.Capability> supported =
                EnumSet.of(VisionCapabilities.Capability.OBJECT_DETECTION);
        if (config.enableClassification()
                && delegate.capabilities().supports(VisionCapabilities.Capability.CLASSIFICATION)) {
            supported.add(VisionCapabilities.Capability.CLASSIFICATION);
        }
        // Captioning, segmentation, tracking, and model switching have no composed authority.
        return new VisionCapabilities(supported);
    }

    @Override
    public DetectionResult detect(ImageData image, DetectionOptions options) {
        ensureOpen();
        validateImage(image);
        Objects.requireNonNull(options, "options");
        DetectionResult result = Objects.requireNonNull(
                delegate.detect(image, options),
                "Vision provider returned null detection result");
        validateResult(result);
        return result;
    }

    @Override
    public Promise<DetectionResult> detectAsync(ImageData image, DetectionOptions options) {
        ensureOpen();
        validateImage(image);
        Objects.requireNonNull(options, "options");
        return delegate.detectAsync(image, options)
                .map(result -> {
                    if (result == null) {
                        throw new IllegalStateException("Vision provider returned null detection result");
                    }
                    validateResult(result);
                    return result;
                });
    }

    @Override
    public StreamingDetectionSession createStreamingSession(
            DetectionOptions options,
            Consumer<DetectionResult> resultCallback) {
        ensureOpen();
        Objects.requireNonNull(options, "options");
        Objects.requireNonNull(resultCallback, "resultCallback");
        return delegate.createStreamingSession(options, result -> {
            validateResult(result);
            resultCallback.accept(result);
        });
    }

    @Override
    public String caption(ImageData image) {
        throw new UnsupportedOperationException(
                "The configured object-detection provider does not implement image captioning");
    }

    @Override
    public List<Classification> classify(ImageData image, int topK) {
        ensureOpen();
        validateImage(image);
        if (!capabilities().supports(VisionCapabilities.Capability.CLASSIFICATION)) {
            throw new UnsupportedOperationException(
                    "detection-derived image classification is disabled");
        }
        if (topK < 1 || topK > config.defaultMaxDetections()) {
            throw new IllegalArgumentException(
                    "topK must be between 1 and " + config.defaultMaxDetections());
        }
        List<Classification> classifications = List.copyOf(delegate.classify(image, topK));
        if (classifications.size() > topK) {
            throw new IllegalStateException("Vision provider returned more than topK classifications");
        }
        for (Classification classification : classifications) {
            if (classification.confidence() < 0.0 || classification.confidence() > 1.0) {
                throw new IllegalStateException("Vision provider returned invalid classification confidence");
            }
        }
        return classifications;
    }

    @Override
    public List<DetectionModelInfo> getAvailableModels() {
        ensureOpen();
        return List.of(activeModel());
    }

    @Override
    public void loadModel(String modelId) {
        ensureOpen();
        String normalized = requireText(modelId, "modelId");
        if (!config.modelId().equals(normalized)) {
            throw new UnsupportedOperationException(
                    "This Vision provider owns only model " + config.modelId());
        }
    }

    @Override
    public DetectionModelInfo getActiveModel() {
        ensureOpen();
        return activeModel();
    }

    @Override
    public void warmup() {
        ensureOpen();
        delegate.warmup();
        ImageData probe = ImageData.builder()
                .data(new byte[Math.multiplyExact(Math.multiplyExact(config.inputSize(), config.inputSize()), 3)])
                .width(config.inputSize())
                .height(config.inputSize())
                .format(com.ghatana.media.common.ImageFormat.RAW)
                .build();
        detect(probe, DetectionOptions.defaults());
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) delegate.close();
    }

    @Override
    public EngineStatus getStatus() {
        return delegate.getStatus();
    }

    @Override
    public EngineMetrics getMetrics() {
        return delegate.getMetrics();
    }

    private DetectionModelInfo activeModel() {
        DetectionModelInfo model = Objects.requireNonNull(
                delegate.getActiveModel(),
                "Vision provider returned null active model");
        if (!config.modelId().equals(model.modelId())) {
            throw new IllegalStateException("Vision provider returned mismatched active model identity");
        }
        return model;
    }

    private void validateImage(ImageData image) {
        if (image == null) throw new ValidationError("Image data cannot be null");
        if (image.data() == null || image.data().length == 0) {
            throw new ValidationError("Image data cannot be empty");
        }
        if (image.data().length > config.maxMemoryBytes()) {
            throw new ValidationError(
                    "Image payload exceeds configured maxMemoryBytes: "
                            + image.data().length + " > " + config.maxMemoryBytes());
        }
        if (image.width() < 1 || image.height() < 1) {
            throw new ValidationError("Image dimensions must be positive");
        }
    }

    private void validateResult(DetectionResult result) {
        if (!config.modelId().equals(result.modelId())) {
            throw new IllegalStateException(
                    "Vision provider returned mismatched model identity: " + result.modelId());
        }
        if (result.objects().size() > config.defaultMaxDetections()) {
            throw new IllegalStateException(
                    "Vision provider exceeded configured detection bound");
        }
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("Vision Engine is closed");
    }

    private static String requireText(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        return value.trim();
    }
}
