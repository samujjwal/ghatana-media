package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audio.video.vision.yolo.YoloV8Adapter;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Fail-closed production composition for {@link VisionGrpcService}.
 *
 * <p>The detector is initialized before the gRPC service can be registered. Missing models,
 * malformed thresholds, native-library failures, and initialization errors therefore abort startup
 * rather than exposing a degraded no-op detector. The service owns and closes the detector when the
 * shared gRPC server shuts down.
 *
 * @doc.type class
 * @doc.purpose Eager production YOLO detector composition and lifecycle ownership
 * @doc.layer product
 * @doc.pattern CompositionRoot
 */
public final class ProductionVisionGrpcService
        extends VisionGrpcService
        implements AutoCloseable {

    private final YoloV8Adapter detector;
    private final AtomicBoolean closed = new AtomicBoolean();

    public ProductionVisionGrpcService(MediaProcessingMetrics metrics) {
        this(compose(System.getenv()), metrics);
    }

    ProductionVisionGrpcService(
            Composition composition,
            MediaProcessingMetrics metrics) {
        super(composition.detector(), composition.frameExtractor(), metrics);
        this.detector = composition.detector();
    }

    static Composition compose(Map<String, String> environment) {
        Objects.requireNonNull(environment, "environment");
        Path modelDirectory = Path.of(requireText(
                environment.getOrDefault(
                        "VISION_MODEL_PATH",
                        Path.of(System.getProperty("user.home"), ".ghatana", "models", "vision").toString()),
                "VISION_MODEL_PATH"))
                .toAbsolutePath()
                .normalize();
        if (!Files.isDirectory(modelDirectory) || !Files.isReadable(modelDirectory)) {
            throw new IllegalStateException(
                    "VISION_MODEL_PATH must be a readable directory: " + modelDirectory);
        }
        String modelName = requireText(
                environment.getOrDefault("VISION_MODEL_NAME", "yolov8n"),
                "VISION_MODEL_NAME");
        double confidence = boundedDouble(
                environment,
                "VISION_CONFIDENCE_THRESHOLD",
                0.5,
                0.0,
                1.0);
        double nms = boundedDouble(
                environment,
                "VISION_NMS_THRESHOLD",
                0.4,
                0.0,
                1.0);

        YoloV8Adapter detector = new YoloV8Adapter(modelDirectory, confidence, nms);
        try {
            detector.initialize(modelName);
            if (!detector.isInitialized()) {
                throw new IllegalStateException("Vision detector did not become initialized");
            }
            return new Composition(detector, new VideoFrameExtractor());
        } catch (RuntimeException failure) {
            detector.close();
            throw failure;
        }
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) detector.close();
    }

    private static double boundedDouble(
            Map<String, String> environment,
            String key,
            double fallback,
            double minimum,
            double maximum) {
        String raw = environment.get(key);
        double value;
        try {
            value = raw == null || raw.isBlank()
                    ? fallback
                    : Double.parseDouble(raw.trim());
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException(key + " must be numeric", failure);
        }
        if (!Double.isFinite(value) || value < minimum || value > maximum) {
            throw new IllegalArgumentException(
                    key + " must be between " + minimum + " and " + maximum);
        }
        return value;
    }

    private static String requireText(String value, String key) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(key + " must not be blank");
        }
        return value.trim();
    }

    record Composition(YoloV8Adapter detector, VideoFrameExtractor frameExtractor) {
        Composition {
            Objects.requireNonNull(detector, "detector");
            Objects.requireNonNull(frameExtractor, "frameExtractor");
        }
    }
}
