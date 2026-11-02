package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.vision.model.VisionCapabilityProfile;
import com.ghatana.audio.video.vision.model.VisionModelProfile;
import com.ghatana.audio.video.vision.model.VisionProviderAdmission;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceHttpClient;
import com.ghatana.audio.video.vision.scenetext.MediaRuntimeSceneTextSource;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audio.video.vision.yolo.YoloV8Adapter;
import com.ghatana.media.runtime.MediaDeploymentProfiles;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Metrics;

import java.net.URI;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Collectors;

/**
 * Production composition gated by trusted model/license provider admission.
 *
 * <p>Two explicit capability profiles exist. {@code FULL_VISION} (default) preserves the
 * existing contract: an admitted YOLO detector is required before the server binds, and a
 * Document Intelligence scene-text binding is optional alongside it. {@code OCR_ONLY} composes
 * no detector at all; it requires a qualified DI binding and the canonical Media runtime port
 * that supplies source authorization and trusted frame pixels. Detector RPCs under
 * {@code OCR_ONLY} remain unavailable through the normal NOT_ADMITTED gate — never through a
 * dummy provider.
 */
public final class ProductionVisionGrpcService extends VisionGrpcService implements AutoCloseable {
    private final YoloV8Adapter detector;
    private final VisionCapabilityProfile capabilityProfile;
    private final SceneTextBinding sceneText;
    private final MediaProcessingRuntimePort mediaRuntimePort;
    private AutoCloseable ownedRuntimePort;
    private final AtomicBoolean closed = new AtomicBoolean();

    public ProductionVisionGrpcService(MediaProcessingMetrics metrics) {
        this(metrics, Metrics.globalRegistry, null);
    }

    /** Runtime integration seam; it does not qualify a model or authorize source processing. */
    public ProductionVisionGrpcService(MediaProcessingMetrics metrics, MediaProcessingRuntimePort mediaRuntimePort) {
        this(compose(System.getenv(), mediaRuntimePort), metrics, Metrics.globalRegistry, mediaRuntimePort);
    }

    ProductionVisionGrpcService(MediaProcessingMetrics metrics, MeterRegistry providerMetrics) {
        this(compose(System.getenv()), metrics, providerMetrics, null);
    }

    ProductionVisionGrpcService(MediaProcessingMetrics metrics, MeterRegistry providerMetrics,
                                MediaProcessingRuntimePort mediaRuntimePort) {
        this(compose(System.getenv(), mediaRuntimePort), metrics, providerMetrics, mediaRuntimePort);
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
        this.capabilityProfile = composition.capabilityProfile();
        this.sceneText = composition.sceneText();
        this.mediaRuntimePort = mediaRuntimePort;
        if (sceneText != null) {
            bindSceneTextService(sceneText.service(), sceneText.workers());
        }
    }

    MediaProcessingRuntimePort mediaRuntimePort() { return mediaRuntimePort; }

    void ownRuntimePort(MediaProcessingRuntimePort runtimePort) {
        if (runtimePort == null) return;
        if (runtimePort != mediaRuntimePort) {
            throw new IllegalArgumentException("owned runtime port must be the composed service port");
        }
        if (ownedRuntimePort != null) throw new IllegalStateException("runtime port ownership already assigned");
        ownedRuntimePort = runtimePort instanceof AutoCloseable closeable ? closeable : null;
    }

    @Override
    protected boolean isProviderReady() {
        if (closed.get()) return false;
        return switch (capabilityProfile) {
            case FULL_VISION -> detector.isInitialized();
            case OCR_ONLY -> sceneText != null && sceneText.service().providerCurrentlyAdmitted();
        };
    }

    @Override
    protected boolean isInferenceProviderAdmitted() {
        return capabilityProfile == VisionCapabilityProfile.FULL_VISION && isProviderReady();
    }

    static Composition compose(Map<String, String> environment) {
        return compose(environment, null);
    }

    static Composition compose(Map<String, String> environment, MediaProcessingRuntimePort mediaRuntimePort) {
        Objects.requireNonNull(environment, "environment");
        VisionCapabilityProfile capability = VisionCapabilityProfile.fromEnvironment(environment);
        boolean productionLike = MediaDeploymentProfiles.productionLike(environment.getOrDefault(
                "MEDIA_RUNTIME_ENVIRONMENT", environment.getOrDefault("MEDIA_PROFILE", "local")));
        if (capability == VisionCapabilityProfile.OCR_ONLY) {
            if (mediaRuntimePort == null) {
                throw new IllegalStateException(
                        "OCR_ONLY requires the canonical Media runtime port for source authority and trusted frame access");
            }
            return new Composition(null, new VideoFrameExtractor(productionLike), null, capability,
                    composeSceneText(environment, mediaRuntimePort, true));
        }
        VisionModelProfile profile = VisionModelProfile.fromEnvironment(environment);
        YoloV8Adapter.validateProfileMetadata(profile, profile.modelDirectory());
        VisionProviderAdmission.requireAdmitted(profile);
        double confidence = boundedDouble(environment, "VISION_CONFIDENCE_THRESHOLD", 0.5);
        double nms = boundedDouble(environment, "VISION_NMS_THRESHOLD", 0.4);
        YoloV8Adapter detector = new YoloV8Adapter(profile.modelDirectory(), confidence, nms);
        SceneTextBinding sceneText = null;
        try {
            detector.initialize(profile);
            if (!detector.isInitialized()) {
                throw new VisionModelProfile.VisionProviderUnavailableException(
                        VisionModelProfile.UnavailableReason.NATIVE_INITIALIZATION_FAILED,
                        "Vision detector did not become initialized");
            }
            sceneText = composeSceneText(environment, mediaRuntimePort, false);
            return new Composition(detector, new VideoFrameExtractor(productionLike), profile, capability, sceneText);
        } catch (LinkageError | RuntimeException failure) {
            if (sceneText != null) sceneText.close();
            detector.close();
            if (failure instanceof VisionModelProfile.VisionProviderUnavailableException unavailable) {
                throw unavailable;
            }
            throw new VisionModelProfile.VisionProviderUnavailableException(
                    VisionModelProfile.UnavailableReason.NATIVE_INITIALIZATION_FAILED,
                    "Vision detector initialization is unavailable", failure);
        }
    }

    /**
     * DI-only scene-text binding. When {@code required} is set a missing or malformed
     * {@code DI_*} configuration fails startup; otherwise an absent endpoint leaves the RPC
     * fail-closed while a malformed endpoint still fails loudly. Without a runtime port the
     * binding rejects every request through the unavailable source authority.
     */
    private static SceneTextBinding composeSceneText(
            Map<String, String> environment, MediaProcessingRuntimePort mediaRuntimePort, boolean required) {
        String endpoint = environment.getOrDefault("DI_ENDPOINT", "").trim();
        if (endpoint.isEmpty()) {
            if (required) {
                throw new IllegalStateException("OCR_ONLY requires DI_ENDPOINT for the Document Intelligence binding");
            }
            return null;
        }
        boolean productionLike = MediaDeploymentProfiles.productionLike(environment.getOrDefault(
                "MEDIA_RUNTIME_ENVIRONMENT", environment.getOrDefault("MEDIA_PROFILE", "local")));
        URI baseUri = URI.create(endpoint);
        String host = baseUri.getHost() == null ? "" : baseUri.getHost().toLowerCase(java.util.Locale.ROOT);
        Set<String> allowedHosts = csv(environment.get("DI_ALLOWED_HOSTS")).stream()
                .map(value -> value.toLowerCase(java.util.Locale.ROOT))
                .collect(Collectors.toUnmodifiableSet());
        if (allowedHosts.isEmpty()) {
            throw new IllegalArgumentException("DI_ALLOWED_HOSTS must independently allowlist the DI_ENDPOINT host");
        }
        if (host.isEmpty() || !allowedHosts.contains(host)) {
            throw new IllegalArgumentException("DI_ENDPOINT host is not in the independently configured DI_ALLOWED_HOSTS");
        }
        DocumentIntelligenceHttpClient.EndpointPolicy endpointPolicy =
                new DocumentIntelligenceHttpClient.EndpointPolicy(
                        allowedHosts, productionLike, Set.copyOf(csv(environment.get("DI_PLAINTEXT_HOSTS"))));
        Duration catalogTimeout = boundedDuration(environment, "DI_CATALOG_TIMEOUT_MS", 5_000L);
        long maxUploadBytes = boundedLong(environment, "DI_MAX_UPLOAD_BYTES", 20L * 1024 * 1024, 1L, 32L * 1024 * 1024);
        int maxConcurrent = (int) boundedLong(environment, "DI_MAX_CONCURRENT", 4L, 1L, 64L);
        HttpClient http = HttpClient.newBuilder()
                .connectTimeout(boundedDuration(environment, "DI_CONNECT_TIMEOUT_MS", 5_000L))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
        ExecutorService workers = new ThreadPoolExecutor(maxConcurrent, maxConcurrent, 0L, TimeUnit.MILLISECONDS,
                new LinkedBlockingQueue<>(maxConcurrent * 8), runnable -> {
                    Thread thread = new Thread(runnable, "vision-scene-text-worker");
                    thread.setDaemon(true);
                    return thread;
                });
        SceneTextRecognitionService service = null;
        try {
            DocumentIntelligenceHttpClient client = new DocumentIntelligenceHttpClient(
                    baseUri, http, catalogTimeout, maxUploadBytes, endpointPolicy, maxConcurrent);
            SceneTextRecognitionService.Policy policy = new SceneTextRecognitionService.Policy(
                    requiredEnv(environment, "DI_PROVIDER_REF"), requiredEnv(environment, "DI_PROVIDER_VERSION"),
                    requiredEnv(environment, "DI_MODEL_REF"), requiredEnv(environment, "DI_MODEL_VERSION"),
                    Set.copyOf(csv(environment.get("DI_ACCEPTED_MEDIA_TYPES"))),
                    Set.copyOf(csv(environment.get("DI_ACCEPTED_LANGUAGES"))),
                    boundedLong(environment, "DI_TIMEOUT_MS", 30_000L, 1L, 300_000L),
                    workerLimits(environment.get("DI_WORKER_LIMITS")));
            MediaRuntimeSceneTextSource runtimeSource = mediaRuntimePort == null
                    ? null : new MediaRuntimeSceneTextSource(mediaRuntimePort);
            SceneTextRecognitionService.SourceAuthority authority = runtimeSource != null
                    ? runtimeSource : check -> SceneTextRecognitionService.Decision.of(
                            SceneTextRecognitionService.SourceStatus.UNAVAILABLE);
            service = new SceneTextRecognitionService(Optional.of(client), authority, policy,
                    Optional.ofNullable(runtimeSource));
            return new SceneTextBinding(service, workers, http);
        } catch (RuntimeException failure) {
            workers.shutdown();
            http.close();
            throw failure;
        }
    }

    @Override public void close() {
        if (closed.compareAndSet(false, true)) {
            try {
                if (detector != null) detector.close();
            } finally {
                try {
                    if (sceneText != null) sceneText.close();
                } finally {
                    if (ownedRuntimePort != null) {
                        try { ownedRuntimePort.close(); }
                        catch (Exception closeFailure) {
                            org.slf4j.LoggerFactory.getLogger(ProductionVisionGrpcService.class)
                                    .error("Media runtime port shutdown failed", closeFailure);
                        }
                    }
                }
            }
        }
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

    private static long boundedLong(Map<String, String> environment, String key, long fallback, long min, long max) {
        String raw = environment.get(key);
        long value;
        try { value = raw == null || raw.isBlank() ? fallback : Long.parseLong(raw.trim()); }
        catch (NumberFormatException failure) { throw new IllegalArgumentException(key + " must be an integer", failure); }
        if (value < min || value > max) {
            throw new IllegalArgumentException(key + " must be between " + min + " and " + max);
        }
        return value;
    }

    private static Duration boundedDuration(Map<String, String> environment, String key, long fallbackMs) {
        return Duration.ofMillis(boundedLong(environment, key, fallbackMs, 1L, 300_000L));
    }

    private static String requiredEnv(Map<String, String> environment, String key) {
        String value = environment.getOrDefault(key, "").trim();
        if (value.isEmpty()) throw new IllegalArgumentException(key + " is required for the DI scene-text binding");
        return value;
    }

    private static java.util.List<String> csv(String raw) {
        if (raw == null || raw.isBlank()) return java.util.List.of();
        return Arrays.stream(raw.split(",")).map(String::trim).filter(value -> !value.isEmpty())
                .collect(Collectors.toList());
    }

    private static Map<String, Integer> workerLimits(String raw) {
        Map<String, Integer> limits = new LinkedHashMap<>();
        for (String pair : csv(raw)) {
            String[] parts = pair.split("=", 2);
            if (parts.length != 2) throw new IllegalArgumentException("DI_WORKER_LIMITS entries must be name=value");
            try {
                limits.put(parts[0], Integer.parseInt(parts[1]));
            } catch (NumberFormatException failure) {
                throw new IllegalArgumentException("DI_WORKER_LIMITS values must be integers", failure);
            }
        }
        return limits;
    }

    /** Bound DI scene-text worker pool and transport owned by this composition. */
    record SceneTextBinding(SceneTextRecognitionService service, ExecutorService workers, HttpClient http)
            implements AutoCloseable {
        SceneTextBinding {
            Objects.requireNonNull(service, "service");
            Objects.requireNonNull(workers, "workers");
            Objects.requireNonNull(http, "http");
        }

        @Override public void close() {
            workers.shutdown();
            http.close();
        }
    }

    record Composition(YoloV8Adapter detector, VideoFrameExtractor frameExtractor, VisionModelProfile profile,
                       VisionCapabilityProfile capabilityProfile, SceneTextBinding sceneText) {
        Composition(YoloV8Adapter detector, VideoFrameExtractor frameExtractor, VisionModelProfile profile) {
            this(detector, frameExtractor, profile, VisionCapabilityProfile.FULL_VISION, null);
        }

        Composition {
            Objects.requireNonNull(frameExtractor, "frameExtractor");
            Objects.requireNonNull(capabilityProfile, "capabilityProfile");
            switch (capabilityProfile) {
                case FULL_VISION -> {
                    Objects.requireNonNull(detector, "detector");
                    Objects.requireNonNull(profile, "profile");
                }
                case OCR_ONLY -> Objects.requireNonNull(
                        sceneText, "OCR_ONLY requires a composed DI scene-text binding");
            }
        }
    }
}
