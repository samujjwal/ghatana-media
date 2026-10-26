package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.vision.model.VisionModelProfile;
import com.ghatana.audio.video.vision.model.VisionProviderAdmission;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audio.video.vision.yolo.YoloV8Adapter;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Metrics;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/** Production composition gated by trusted model/license provider admission. */
public final class ProductionVisionGrpcService extends VisionGrpcService implements AutoCloseable {
    private final YoloV8Adapter detector;
    private final MediaProcessingRuntimePort mediaRuntimePort;
    private final AtomicBoolean closed = new AtomicBoolean();

    public ProductionVisionGrpcService(MediaProcessingMetrics metrics) {
        this(metrics, Metrics.globalRegistry, null);
    }

    /** Runtime integration seam; it does not qualify a model or authorize source processing. */
    public ProductionVisionGrpcService(MediaProcessingMetrics metrics, MediaProcessingRuntimePort mediaRuntimePort) {
        this(compose(System.getenv()), metrics, Metrics.globalRegistry, mediaRuntimePort);
    }

    ProductionVisionGrpcService(MediaProcessingMetrics metrics, MeterRegistry providerMetrics) {
        this(compose(System.getenv()), metrics, providerMetrics, null);
    }

    ProductionVisionGrpcService(MediaProcessingMetrics metrics, MeterRegistry providerMetrics,
                                MediaProcessingRuntimePort mediaRuntimePort) {
        this(compose(System.getenv()), metrics, providerMetrics, mediaRuntimePort);
    }

    ProductionVisionGrpcService(Composition composition, MediaProcessingMetrics metrics) {
        this(composition, metrics, Metrics.globalRegistry);
    }

    ProductionVisionGrpcService(Composition composition, MediaProcessingMetrics metrics,
                                MeterRegistry providerMetrics) {
        this(composition, metrics, providerMetrics, null);
    }

    ProductionVisionGrpcService(Composition composition, MediaProcessingMetrics metrics,
                                MeterRegistry providerMetrics, MediaProcessingRuntimePort mediaRuntimePort) {
        super(composition, metrics, null, providerMetrics);
        this.detector = composition.detector();
        this.mediaRuntimePort = mediaRuntimePort;
    }

    MediaProcessingRuntimePort mediaRuntimePort() { return mediaRuntimePort; }

    @Override
    protected boolean isProviderReady() {
        return !closed.get() && detector.isInitialized();
    }

    @Override
    protected boolean isInferenceProviderAdmitted() {
        return isProviderReady();
    }

    static Composition compose(Map<String, String> environment) {
        Objects.requireNonNull(environment, "environment");
        VisionModelProfile profile = VisionModelProfile.fromEnvironment(environment);
        YoloV8Adapter.validateProfileMetadata(profile, profile.modelDirectory());
        VisionProviderAdmission.requireAdmitted(profile);
        double confidence = boundedDouble(environment, "VISION_CONFIDENCE_THRESHOLD", 0.5);
        double nms = boundedDouble(environment, "VISION_NMS_THRESHOLD", 0.4);
        YoloV8Adapter detector = new YoloV8Adapter(profile.modelDirectory(), confidence, nms);
        try {
            detector.initialize(profile);
            if (!detector.isInitialized()) {
                throw new VisionModelProfile.VisionProviderUnavailableException(
                        VisionModelProfile.UnavailableReason.NATIVE_INITIALIZATION_FAILED,
                        "Vision detector did not become initialized");
            }
            return new Composition(detector, new VideoFrameExtractor(), profile);
        } catch (LinkageError | RuntimeException failure) {
            detector.close();
            if (failure instanceof VisionModelProfile.VisionProviderUnavailableException unavailable) {
                throw unavailable;
            }
            throw new VisionModelProfile.VisionProviderUnavailableException(
                    VisionModelProfile.UnavailableReason.NATIVE_INITIALIZATION_FAILED,
                    "Vision detector initialization is unavailable", failure);
        }
    }

    @Override public void close() {
        if (closed.compareAndSet(false, true)) detector.close();
    }

    private static double boundedDouble(Map<String, String> environment, String key, double fallback) {
        String raw = environment.get(key);
        double value;
        try { value = raw == null || raw.isBlank() ? fallback : Double.parseDouble(raw.trim()); }
        catch (NumberFormatException failure) { throw new IllegalArgumentException(key + " must be numeric", failure); }
        if (!Double.isFinite(value) || value < 0 || value > 1) {
            throw new IllegalArgumentException(key + " must be between 0 and 1");
        }
        return value;
    }

    record Composition(YoloV8Adapter detector, VideoFrameExtractor frameExtractor, VisionModelProfile profile) {
        Composition {
            Objects.requireNonNull(detector, "detector");
            Objects.requireNonNull(frameExtractor, "frameExtractor");
            Objects.requireNonNull(profile, "profile");
        }
    }
}
