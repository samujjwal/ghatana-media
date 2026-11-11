package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.model.FileSystemModelStore;
import com.ghatana.audio.video.common.model.ModelMetadata;
import com.ghatana.audio.video.common.model.ModelRegistry;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.grpc.proto.*;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.model.ObjectAttributes;
import com.ghatana.audio.video.vision.model.VisionCapabilityDisposition;
import com.ghatana.audio.video.vision.yolo.YoloV8Adapter;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audit.AuditEvent;
import com.ghatana.audit.AuditService;
import com.ghatana.audiovideo.observability.MediaWorkflowMetrics;
import com.ghatana.audiovideo.observability.tracing.AudioVideoTracingService;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Scope;
import io.grpc.Context;
import io.grpc.stub.ServerCallStreamObserver;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Metrics;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * gRPC service implementation for computer vision object detection.
 *
 * <p>Exposes YOLO-based object detection capabilities over gRPC for
 * both single-frame and streaming video detection use cases.
 *
 * @doc.type class
 * @doc.purpose gRPC service for computer vision object detection and classification
 * @doc.layer product
 * @doc.pattern Service
 */
public class VisionGrpcService extends VisionServiceGrpc.VisionServiceImplBase
        implements com.ghatana.audio.video.common.observability.MetricsScrapeSource {

    private static final Logger LOG = LoggerFactory.getLogger(VisionGrpcService.class);

    // AV-P1-013: Validation constants
    private static final long MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50MB
    private static final long MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500MB
    private static final long MAX_PROCESS_VIDEO_BYTES = 512L * 1024 * 1024;
    private static final int MAX_VIDEO_SAMPLE_FPS = 60;
    private static final int MAX_VIDEO_ANALYSIS_FRAMES = 10_000;
    private static final int DEFAULT_MAX_DETECTIONS = 100;
    private static final Set<String> SUPPORTED_IMAGE_FORMATS = Set.of("jpg", "jpeg", "png", "bmp", "webp");
    private static final Set<String> SUPPORTED_VIDEO_FORMATS = Set.of("mp4", "avi", "mov", "mkv");

    private final VisionDetector detector;
    private final VideoFrameExtractor frameExtractor;
    /** Codec work without an OS sandbox is allowed only for package-private in-process tests. */
    private final boolean allowVideoCodecForTestComposition;
    private final AtomicLong requestCount = new AtomicLong(0);
    private final AtomicLong totalProcessingTime = new AtomicLong(0);
    private volatile BooleanSupplier readinessProbe = () -> false;
    private final MediaProcessingMetrics mediaMetrics;
    private final MediaWorkflowMetrics modalityMetrics;
    private final ThreadLocal<Boolean> responseBoundaryFailurePending = ThreadLocal.withInitial(() -> false);
    private final ModelRegistry modelRegistry;
    private final AuditService auditService;
    private final AudioVideoTracingService tracingService;
    private volatile boolean degraded = false;
    private volatile String degradationReason = null;
    /** DI-only scene-text consumer (VIS-09); null keeps the RPC fail-closed. */
    private volatile com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService sceneTextService;
    /** Canonical source readback is available independently of the optional DI binding. */
    private volatile com.ghatana.audio.video.vision.scenetext.MediaRuntimeSceneTextSource mediaRuntimeSceneTextSource;
    /** Bounded worker pool for the blocking DI call; direct execution unless production binds one. */
    private volatile java.util.concurrent.Executor sceneTextExecutor = Runnable::run;
    /** Blocking detector calls use a separate finite pool in production; tests keep direct execution. */
    private volatile java.util.concurrent.Executor providerExecutor = Runnable::run;
    private final java.util.Set<com.ghatana.audio.video.common.resilience.ContextAwareBoundedExecutor.Submission<?>>
            providerSubmissions = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private final java.util.concurrent.atomic.AtomicBoolean providerExecutorClosing =
            new java.util.concurrent.atomic.AtomicBoolean();

    /** Package-private constructor for tests that inject an in-memory {@link VisionDetector}. */
    VisionGrpcService(VisionDetector detector, VideoFrameExtractor frameExtractor) {
        this(detector, frameExtractor, MediaProcessingMetrics.noop());
    }

    /** Package-private constructor for unit testing with metrics capture. */
    VisionGrpcService(VisionDetector detector, VideoFrameExtractor frameExtractor,
                      MediaProcessingMetrics metrics) {
        this(detector, frameExtractor, metrics, null);
    }

    /** Package-private constructor for unit testing with audit service. */
    VisionGrpcService(VisionDetector detector, VideoFrameExtractor frameExtractor,
                      MediaProcessingMetrics metrics, @Nullable AuditService auditService) {
        this(detector, frameExtractor, metrics, auditService, new FileSystemModelStore());
    }

    /** Package-private constructor for proving provider-gated model RPCs do not touch the registry. */
    VisionGrpcService(VisionDetector detector, VideoFrameExtractor frameExtractor,
                      MediaProcessingMetrics metrics, @Nullable AuditService auditService,
                      ModelRegistry modelRegistry) {
        this(detector, frameExtractor, metrics, auditService, modelRegistry, Metrics.globalRegistry);
    }

    VisionGrpcService(VisionDetector detector, VideoFrameExtractor frameExtractor,
                      MediaProcessingMetrics metrics, @Nullable AuditService auditService,
                      ModelRegistry modelRegistry, MeterRegistry providerMetrics) {
        this(detector, frameExtractor, metrics, auditService, modelRegistry, providerMetrics,
                new AudioVideoTracingService(GlobalOpenTelemetry.getTracer("ghatana-media-vision")));
    }

    VisionGrpcService(VisionDetector detector, VideoFrameExtractor frameExtractor,
                      MediaProcessingMetrics metrics, @Nullable AuditService auditService,
                      ModelRegistry modelRegistry, MeterRegistry providerMetrics,
                      AudioVideoTracingService tracingService) {
        this(detector, frameExtractor, metrics, auditService, modelRegistry, providerMetrics,
                tracingService, true);
    }

    /** Composition/test seam: installs the DI-bound scene-text consumer for the VIS-09 RPC. */
    void bindSceneTextService(
            com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService service) {
        this.sceneTextService = service;
    }

    /** Production seam: scene-text work runs on a bounded worker pool, off the gRPC executor. */
    void bindSceneTextService(
            com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService service,
            java.util.concurrent.Executor sceneTextExecutor) {
        this.sceneTextExecutor = Objects.requireNonNull(sceneTextExecutor, "sceneTextExecutor");
        this.sceneTextService = service;
    }

    /** Production seam: bind Media's authenticated immutable source-frame reader. */
    void bindMediaRuntimeSceneTextSource(
            com.ghatana.audio.video.vision.scenetext.MediaRuntimeSceneTextSource source) {
        this.mediaRuntimeSceneTextSource = Objects.requireNonNull(source, "source");
    }

    /** Production seam: detector inference runs on a bounded worker pool, away from gRPC threads. */
    void bindProviderExecutor(java.util.concurrent.Executor providerExecutor) {
        this.providerExecutor = Objects.requireNonNull(providerExecutor, "providerExecutor");
    }

    /** Fences accepted inference submissions during service shutdown. */
    void cancelProviderDispatch() {
        providerExecutorClosing.set(true);
        providerSubmissions.forEach(
                com.ghatana.audio.video.common.resilience.ContextAwareBoundedExecutor.Submission::cancel);
    }

    private VisionGrpcService(VisionDetector detector, VideoFrameExtractor frameExtractor,
                      MediaProcessingMetrics metrics, @Nullable AuditService auditService,
                      ModelRegistry modelRegistry, MeterRegistry providerMetrics,
                      AudioVideoTracingService tracingService, boolean allowVideoCodecForTestComposition) {
        this.detector = detector;
        this.frameExtractor = frameExtractor;
        this.allowVideoCodecForTestComposition = allowVideoCodecForTestComposition;
        this.mediaMetrics = metrics;
        this.modalityMetrics = new MediaWorkflowMetrics(
                Objects.requireNonNull(providerMetrics, "providerMetrics"), "vision");
        this.auditService = auditService;
        this.modelRegistry = modelRegistry;
        this.tracingService = Objects.requireNonNull(tracingService, "tracingService");
    }

    @Override
    public String scrapeMetrics() {
        return modalityMetrics.scrape();
    }

    public VisionGrpcService() {
        this(MediaProcessingMetrics.create());
    }

    public VisionGrpcService(MediaProcessingMetrics metrics) {
        this(metrics, null);
    }

    public VisionGrpcService(MediaProcessingMetrics metrics, @Nullable AuditService auditService) {
        this(ProductionVisionGrpcService.compose(System.getenv()), metrics, auditService);
    }

    VisionGrpcService(ProductionVisionGrpcService.Composition composition,
                      MediaProcessingMetrics metrics, @Nullable AuditService auditService) {
        this(composition, metrics, auditService, Metrics.globalRegistry);
    }

    VisionGrpcService(ProductionVisionGrpcService.Composition composition,
                      MediaProcessingMetrics metrics, @Nullable AuditService auditService,
                      MeterRegistry providerMetrics) {
        this(composition.detector(), composition.frameExtractor(), metrics, auditService,
                new FileSystemModelStore(), providerMetrics,
                new AudioVideoTracingService(GlobalOpenTelemetry.getTracer("ghatana-media-vision")), false);
        if (composition.profile() != null) {
            ModelMetadata defaultModel = ModelMetadata.builder()
                    .modelId(composition.profile().modelId())
                    .name(composition.profile().modelId())
                    .type(ModelMetadata.ModelType.VISION)
                    .version(composition.profile().version())
                    .sizeBytes(composition.profile().sizeBytes())
                    .loaded(true)
                    .build();
            try {
                modelRegistry.register(defaultModel);
            } catch (ModelRegistry.ModelRegistryException ignored) {
                // Registry is process-local and may already contain this model during test reuse.
            }
        }
    }

    @Override
    public void detectObjects(DetectRequest request, StreamObserver<DetectResponse> responseObserver) {
        io.grpc.Context operationContext = io.grpc.Context.current();
        Span trace = tracingService.startVisionDetectionSpan(null, resolveTenantId(), request.getConfidenceThreshold());
        StreamObserver<DetectResponse> cancellationObserver = responseObserver;
        TracedResponse<DetectResponse> traced = tracedResponse("detectObjects", trace, responseObserver);
        responseObserver = traced.observer;
        try (Scope scope = tracingService.createScope(trace)) {
        long startTime = System.currentTimeMillis();
        requestCount.incrementAndGet();
        mediaMetrics.recordStarted("vision.detect");

        // AV-P1-007: Enforce tenant authentication
        String tenantId = resolveTenantId();
        if (!tenantContextAvailable(tenantId)) {
            recordResponseFailure(responseObserver, io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant context — authenticate before calling Vision service")
                .asRuntimeException());
            mediaMetrics.recordFailed("vision.detect");
            return;
        }
        String userId = resolveUserId();
        int dataSize = 0;

        try {
            // The wire contract defines ROI coordinates, but the currently admitted detector
            // SPI has no crop-aware dispatch. Fail closed so a requested crop is never silently
            // returned as a full-frame result.
            if (request.hasSourceRasterRoi()) {
                dataSize = request.getImageData().size();
                if (dataSize == 0) {
                    recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                        .withDescription("Image data cannot be empty")
                        .asRuntimeException());
                    mediaMetrics.recordFailed("vision.detect");
                    return;
                }
                if (dataSize > MAX_IMAGE_BYTES) {
                    recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                        .withDescription("Image data exceeds maximum size of " + (MAX_IMAGE_BYTES / 1024 / 1024) + "MB")
                        .asRuntimeException());
                    mediaMetrics.recordFailed("vision.detect");
                    return;
                }
                try {
                    validateRoiRequestFields(request.getSourceRasterRoi());
                    // The wire coordinates are EXIF-oriented pixel edges; check them against the
                    // raster decoded from this request. This does not establish that the caller's
                    // source-frame version identifies these bytes, so dispatch remains refused.
                    var decoded = com.ghatana.audio.video.vision.image.BoundedImageDecoder
                            .decodeWithMetadata(request.getImageData().toByteArray());
                    var roi = new com.ghatana.audio.video.vision.yolo.SourceRasterRoi(
                            request.getSourceRasterRoi().getX(), request.getSourceRasterRoi().getY(),
                            request.getSourceRasterRoi().getWidth(), request.getSourceRasterRoi().getHeight(),
                            request.getSourceRasterRoi().getSourceFrameVersion());
                    roi.validateWithin(decoded.image().getWidth(), decoded.image().getHeight());
                } catch (IllegalArgumentException invalidRoi) {
                    recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                        .withDescription("Source-raster ROI must have valid geometry within the decoded source raster")
                        .asRuntimeException());
                    mediaMetrics.recordFailed("vision.detect");
                    return;
                }
                recordResponseFailure(responseObserver, io.grpc.Status.FAILED_PRECONDITION
                    .withDescription("Source-raster ROI detection is not admitted by the active Vision provider")
                    .asRuntimeException());
                mediaMetrics.recordFailed("vision.detect");
                return;
            }

            // AV-P1-013: Validate request size
            if (request.getImageData().isEmpty()) {
                recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Image data cannot be empty")
                    .asRuntimeException());
                mediaMetrics.recordFailed("vision.detect");
                return;
            }

            dataSize = request.getImageData().size();
            if (dataSize > MAX_IMAGE_BYTES) {
                recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Image data exceeds maximum size of " + (MAX_IMAGE_BYTES / 1024 / 1024) + "MB")
                    .asRuntimeException());
                mediaMetrics.recordFailed("vision.detect");
                return;
            }

            // AV-P1-013: Validate max detections
            int maxDetections = request.getMaxDetections() > 0 ? request.getMaxDetections() : DEFAULT_MAX_DETECTIONS;
            if (maxDetections > DEFAULT_MAX_DETECTIONS) {
                recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("maxDetections cannot exceed " + DEFAULT_MAX_DETECTIONS)
                    .asRuntimeException());
                mediaMetrics.recordFailed("vision.detect");
                return;
            }

            if (rejectWhenProviderUnavailable(responseObserver, "Object detection")) {
                mediaMetrics.recordFailed("vision.detect");
                return;
            }

            LOG.debug("Detecting objects in image ({} bytes)", dataSize);

            DetectionOptions.Builder optionsBuilder = DetectionOptions.builder()
                .targetClasses(new HashSet<>(request.getTargetClassesList()))
                .maxDetections(maxDetections);
            // Proto3 scalar zero is the existing omission sentinel for this request.
            // Leave the option unset so a verified provider can use its configured default.
            if (request.getConfidenceThreshold() > 0) {
                optionsBuilder.confidenceThreshold(request.getConfidenceThreshold());
            }
            DetectionOptions options = optionsBuilder.build();

            if (rpcCancelled(cancellationObserver, operationContext)) {
                traced.finishUnknown();
                return;
            }
            final int imageSizeBytes = dataSize;
            var submission = submitProviderExecution(() -> detector.detectObjects(
                    request.getImageData().toByteArray(), options));
            submission.result().whenComplete((detectedObjects, failure) -> {
                try (Scope completionScope = tracingService.createScope(trace)) {
                    if (failure != null) {
                        reportDetectionFailure(traced, cancellationObserver, operationContext,
                                tenantId, userId, imageSizeBytes, failure);
                        return;
                    }
                    try {
                        completeDetectionResponse(trace, traced, cancellationObserver, operationContext,
                                tenantId, userId, imageSizeBytes, startTime, detectedObjects);
                    } catch (RuntimeException completionFailure) {
                        reportDetectionFailure(traced, cancellationObserver, operationContext,
                                tenantId, userId, imageSizeBytes, completionFailure);
                    }
                }
            });
            return;

        } catch (io.grpc.StatusRuntimeException e) {
            mediaMetrics.recordFailed("vision.detect");
            recordResponseFailure(responseObserver, e);
        } catch (com.ghatana.audio.video.vision.image.BoundedImageDecoder.UnsupportedImageMetadataException e) {
            mediaMetrics.recordFailed("vision.detect");
            recordResponseFailure(responseObserver, io.grpc.Status.UNIMPLEMENTED
                    .withDescription("Unsupported image metadata").asRuntimeException());
        } catch (VisionDetector.DetectionException e) {
            LOG.error("Object detection engine failure ({})", e.getClass().getSimpleName());
            mediaMetrics.recordFailed("vision.detect");
            
            // AV-P1-012: Emit audit event for detection failure
            emitVisionAudit(tenantId, userId, "vision.detect", "FAILED",
                Map.of("errorCode", "DETECTION_FAILED", "imageSizeBytes", String.valueOf(dataSize)));
            
            recordResponseFailure(responseObserver, io.grpc.Status.INTERNAL
                .withDescription("Detection engine error")
                .asRuntimeException());
        } catch (IllegalArgumentException e) {
            LOG.warn("Invalid detection request ({})", e.getClass().getSimpleName());
            mediaMetrics.recordFailed("vision.detect");
            
            // AV-P1-012: Emit audit event for invalid request
            emitVisionAudit(tenantId, userId, "vision.detect", "INVALID",
                Map.of("errorCode", "INVALID_REQUEST", "imageSizeBytes", String.valueOf(dataSize)));
            
            recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                .withDescription("Invalid detection request")
                .asRuntimeException());
        } catch (Exception e) {
            LOG.error("Unexpected error during object detection ({})", e.getClass().getSimpleName());
            mediaMetrics.recordFailed("vision.detect");
            
            // AV-P1-012: Emit audit event for unexpected error
            emitVisionAudit(tenantId, userId, "vision.detect", "ERROR",
                Map.of("errorCode", "INTERNAL_ERROR", "imageSizeBytes", String.valueOf(dataSize)));
            
            recordResponseFailure(responseObserver, providerFailureStatus(e, "Internal detection error")
                    .asRuntimeException());
        }
        }
    }

    /** Validates wire-level ROI fields before the provider-admission check. */
    private static void validateRoiRequestFields(
            com.ghatana.audio.video.vision.grpc.proto.SourceRasterRoi roi) {
        new com.ghatana.audio.video.vision.yolo.SourceRasterRoi(
                roi.getX(), roi.getY(), roi.getWidth(), roi.getHeight(), roi.getSourceFrameVersion());
    }

    private com.ghatana.audio.video.common.resilience.ContextAwareBoundedExecutor.Submission<List<DetectedObject>>
            submitProviderExecution(Supplier<List<DetectedObject>> invocation) {
        if (providerExecutorClosing.get()) {
            return new com.ghatana.audio.video.common.resilience.ContextAwareBoundedExecutor(Runnable::run)
                    .submit(() -> { throw io.grpc.Status.UNAVAILABLE
                            .withDescription("Vision provider is shutting down")
                            .asRuntimeException(); }, false);
        }
        var submission = new com.ghatana.audio.video.common.resilience.ContextAwareBoundedExecutor(providerExecutor)
                .submit(() -> recordProviderExecution(invocation));
        providerSubmissions.add(submission);
        submission.result().whenComplete((ignored, failure) -> providerSubmissions.remove(submission));
        if (providerExecutorClosing.get()) submission.cancel();
        return submission;
    }

    private com.ghatana.audio.video.common.resilience.ContextAwareBoundedExecutor.Submission<List<DetectedObject>>
            submitProviderExecution(Context requestContext, Supplier<List<DetectedObject>> invocation) {
        // A client-streaming callback can be invoked on a transport thread whose current
        // Context differs from the one captured when processVideo opened. Reattach the
        // original RPC Context before the bounded executor snapshots it for the child.
        Context previous = requestContext.attach();
        try {
            return submitProviderExecution(invocation);
        } finally {
            previous.attach();
        }
    }

    private List<DetectedObject> recordProviderExecution(Supplier<List<DetectedObject>> invocation) {
        MediaWorkflowMetrics.ModalityTimingSample sample = modalityMetrics.startModalityTimer(
                MediaWorkflowMetrics.Modality.VISION, MediaWorkflowMetrics.Boundary.PROVIDER);
        MediaWorkflowMetrics.Outcome outcome = MediaWorkflowMetrics.Outcome.UNKNOWN;
        try {
            List<DetectedObject> result = invocation.get();
            Objects.requireNonNull(result, "provider result");
            for (DetectedObject detection : result) {
                com.ghatana.audio.video.vision.model.BoundingBox box =
                        detection == null ? null : detection.getBoundingBox();
                if (detection == null || detection.getClassName() == null || detection.getClassName().isBlank()
                        || !Double.isFinite(detection.getConfidence()) || detection.getConfidence() < 0
                        || detection.getConfidence() > 1 || box == null
                        || box.getX() < 0 || box.getY() < 0
                        || box.getWidth() <= 0 || box.getHeight() <= 0) {
                    throw new IllegalStateException("Provider returned an invalid detection result");
                }
            }
            if (!rpcCancelled(null)) outcome = MediaWorkflowMetrics.Outcome.SUCCESS;
            return result;
        } finally {
            modalityMetrics.stopModalityTimer(sample, outcome);
        }
    }

    private void completeDetectionResponse(Span trace, TracedResponse<DetectResponse> traced,
            StreamObserver<DetectResponse> cancellationObserver, io.grpc.Context operationContext,
            String tenantId, String userId,
            int imageSizeBytes, long startTime, List<DetectedObject> detectedObjects) {
        if (rpcCancelled(cancellationObserver, operationContext)) {
            mediaMetrics.recordFailed("vision.detect");
            recordResponseBoundary(() -> null, traced.observer, traced, cancellationObserver, operationContext);
            return;
        }
        validateProviderDetections(detectedObjects);
        tracingService.recordVisionDetectionResult(trace, detectedObjects.size(),
                detectedObjects.stream().mapToDouble(DetectedObject::getConfidence).max().orElse(Double.NaN));
        long processingTime = System.currentTimeMillis() - startTime;
        boolean delivered = recordResponseBoundary(() -> {
            DetectResponse.Builder responseBuilder = DetectResponse.newBuilder();
            for (DetectedObject obj : detectedObjects) {
                Detection detection = Detection.newBuilder()
                    .setClassName(obj.getClassName())
                    .setConfidence(obj.getConfidence())
                    .setBoundingBox(com.ghatana.audio.video.vision.grpc.proto.BoundingBox.newBuilder()
                        .setX(obj.getBoundingBox().getX())
                        .setY(obj.getBoundingBox().getY())
                        .setWidth(obj.getBoundingBox().getWidth())
                        .setHeight(obj.getBoundingBox().getHeight())
                        .build())
                    .putAllAttributes(convertAttributes(obj.getAttributes()))
                    .build();
                responseBuilder.addDetections(detection);
            }
            return responseBuilder.setProcessingTimeMs(processingTime).build();
        }, traced.observer, traced, cancellationObserver, operationContext);
        if (!delivered) {
            mediaMetrics.recordFailed("vision.detect");
            return;
        }
        totalProcessingTime.addAndGet(processingTime);
        mediaMetrics.recordSucceeded("vision.detect", processingTime);
        LOG.info("Detected {} objects in {}ms", detectedObjects.size(), processingTime);
        emitVisionAudit(tenantId, userId, "vision.detect", "SUCCESS",
                Map.of("objectCount", String.valueOf(detectedObjects.size()),
                        "processingTimeMs", String.valueOf(processingTime),
                        "imageSizeBytes", String.valueOf(imageSizeBytes)));
    }

    /** Rejects malformed provider geometry before it crosses the public pixel-XYWH response boundary. */
    private static void validateProviderDetections(List<DetectedObject> detectedObjects) {
        if (detectedObjects == null || detectedObjects.size() > DEFAULT_MAX_DETECTIONS) {
            throw new IllegalStateException("Vision provider returned an invalid detection collection");
        }
        for (DetectedObject detection : detectedObjects) {
            if (detection == null || detection.getClassName() == null || detection.getClassName().isBlank()
                    || !Double.isFinite(detection.getConfidence())
                    || detection.getConfidence() < 0.0 || detection.getConfidence() > 1.0
                    || detection.getBoundingBox() == null) {
                throw new IllegalStateException("Vision provider returned an invalid detection");
            }
            var box = detection.getBoundingBox();
            if (box.getX() < 0 || box.getY() < 0 || box.getWidth() <= 0 || box.getHeight() <= 0
                    || !Double.isFinite(box.getX() + box.getWidth())
                    || !Double.isFinite(box.getY() + box.getHeight())) {
                throw new IllegalStateException("Vision provider returned invalid source-raster geometry");
            }
        }
    }

    private void reportDetectionFailure(TracedResponse<DetectResponse> traced,
            StreamObserver<DetectResponse> cancellationObserver, io.grpc.Context operationContext,
            String tenantId, String userId,
            int imageSizeBytes, Throwable failure) {
        Throwable cause = failure;
        while (cause instanceof java.util.concurrent.CompletionException && cause.getCause() != null) {
            cause = cause.getCause();
        }
        mediaMetrics.recordFailed("vision.detect");
        if (rpcCancelled(cancellationObserver, operationContext)) {
            responseBoundaryFailurePending.remove();
            recordResponseBoundary(() -> null, traced.observer, traced, cancellationObserver, operationContext);
            return;
        }
        if (cause instanceof io.grpc.StatusRuntimeException statusFailure) {
            recordResponseFailure(traced.observer, statusFailure);
        } else if (cause instanceof com.ghatana.audio.video.vision.image.BoundedImageDecoder.UnsupportedImageMetadataException) {
            recordResponseFailure(traced.observer, io.grpc.Status.UNIMPLEMENTED
                    .withDescription("Unsupported image metadata").asRuntimeException());
        } else if (cause instanceof VisionDetector.DetectionException) {
            LOG.error("Object detection engine failure ({})", cause.getClass().getSimpleName());
            emitVisionAudit(tenantId, userId, "vision.detect", "FAILED",
                    Map.of("errorCode", "DETECTION_FAILED", "imageSizeBytes", String.valueOf(imageSizeBytes)));
            recordResponseFailure(traced.observer, io.grpc.Status.INTERNAL
                    .withDescription("Detection engine error").asRuntimeException());
        } else if (cause instanceof IllegalArgumentException) {
            LOG.warn("Invalid detection request ({})", cause.getClass().getSimpleName());
            emitVisionAudit(tenantId, userId, "vision.detect", "INVALID",
                    Map.of("errorCode", "INVALID_REQUEST", "imageSizeBytes", String.valueOf(imageSizeBytes)));
            recordResponseFailure(traced.observer, io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Invalid detection request").asRuntimeException());
        } else {
            LOG.error("Unexpected error during object detection ({})", cause.getClass().getSimpleName());
            emitVisionAudit(tenantId, userId, "vision.detect", "ERROR",
                    Map.of("errorCode", "INTERNAL_ERROR", "imageSizeBytes", String.valueOf(imageSizeBytes)));
            recordResponseFailure(traced.observer,
                    providerFailureStatus(cause, "Internal detection error").asRuntimeException());
        }
    }

    /** Keeps JDK provider timeout and cancellation signals in their corresponding gRPC classes. */
    private static io.grpc.Status providerFailureStatus(Throwable failure, String fallbackDescription) {
        if (failure instanceof java.util.concurrent.TimeoutException) {
            return io.grpc.Status.DEADLINE_EXCEEDED.withDescription("Vision provider deadline exceeded");
        }
        if (failure instanceof java.util.concurrent.CancellationException) {
            return io.grpc.Status.CANCELLED.withDescription("Vision provider operation was cancelled");
        }
        return io.grpc.Status.INTERNAL.withDescription(fallbackDescription);
    }

    /** Measures response mapping and observer delivery, keeping ambiguous transport failures UNKNOWN. */
    private <T> boolean recordResponseBoundary(Supplier<T> responseMapping, StreamObserver<T> observer) {
        return recordResponseBoundary(responseMapping, observer, null, null);
    }

    private <T> boolean recordResponseBoundary(Supplier<T> responseMapping, StreamObserver<T> observer,
            TracedResponse<T> traced, StreamObserver<?> cancellationObserver) {
        return recordResponseBoundary(responseMapping, observer, traced, cancellationObserver, null);
    }

    private <T> boolean recordResponseBoundary(Supplier<T> responseMapping, StreamObserver<T> observer,
            TracedResponse<T> traced, StreamObserver<?> cancellationObserver, io.grpc.Context operationContext) {
        MediaWorkflowMetrics.ModalityTimingSample sample = modalityMetrics.startModalityTimer(
                MediaWorkflowMetrics.Modality.VISION, MediaWorkflowMetrics.Boundary.RESPONSE);
        MediaWorkflowMetrics.Outcome outcome = MediaWorkflowMetrics.Outcome.UNKNOWN;
        try {
            if (cancellationObserver != null && rpcCancelled(cancellationObserver, operationContext)) {
                if (traced != null) traced.finishUnknown();
                return false;
            }
            T response;
            try {
                response = responseMapping.get();
            } catch (InvalidProviderMappingException invalidMapping) {
                outcome = MediaWorkflowMetrics.Outcome.FAILURE;
                responseBoundaryFailurePending.set(true);
                throw invalidMapping;
            } catch (RuntimeException mappingFailure) {
                outcome = MediaWorkflowMetrics.Outcome.FAILURE;
                responseBoundaryFailurePending.set(true);
                throw mappingFailure;
            }
            if (cancellationObserver != null && rpcCancelled(cancellationObserver, operationContext)) {
                if (traced != null) traced.finishUnknown();
                return false;
            }
            try {
                observer.onNext(response);
                observer.onCompleted();
            } catch (RuntimeException | Error ambiguousDelivery) {
                // The original response sample will record UNKNOWN. The enclosing RPC catch still
                // delivers its gRPC error callback, but that callback is part of this same response.
                responseBoundaryFailurePending.set(true);
                throw ambiguousDelivery;
            }
            if (!rpcCancelled(cancellationObserver == null ? observer : cancellationObserver)) {
                outcome = MediaWorkflowMetrics.Outcome.SUCCESS;
            }
            return outcome == MediaWorkflowMetrics.Outcome.SUCCESS;
        } finally {
            modalityMetrics.stopModalityTimer(sample, outcome);
        }
    }

    private static boolean rpcCancelled(StreamObserver<?> observer) {
        return rpcCancelled(observer, Context.current());
    }

    private static boolean rpcCancelled(StreamObserver<?> observer, Context operationContext) {
        return operationContext != null && (operationContext.isCancelled()
                || operationContext.getDeadline() != null && operationContext.getDeadline().isExpired())
                || observer instanceof ServerCallStreamObserver<?> call && call.isCancelled();
    }

    private static final class InvalidProviderMappingException extends RuntimeException {
        private InvalidProviderMappingException() {
            super("Provider attributes cannot be mapped to the Vision response contract");
        }
    }

    /** Measures a unary failure callback without changing its gRPC status or delivery behavior. */
    private void recordResponseFailure(StreamObserver<?> observer, Throwable failure) {
        if (responseBoundaryFailurePending.get()) {
            responseBoundaryFailurePending.remove();
            observer.onError(failure);
            return;
        }
        MediaWorkflowMetrics.ModalityTimingSample sample = modalityMetrics.startModalityTimer(
                MediaWorkflowMetrics.Modality.VISION, MediaWorkflowMetrics.Boundary.RESPONSE);
        MediaWorkflowMetrics.Outcome outcome = MediaWorkflowMetrics.Outcome.UNKNOWN;
        try {
            observer.onError(failure);
            if (!Context.current().isCancelled()) outcome = MediaWorkflowMetrics.Outcome.FAILURE;
        } finally {
            modalityMetrics.stopModalityTimer(sample, outcome);
        }
    }

    private void finishResponseBoundary(MediaWorkflowMetrics.ModalityTimingSample sample,
                                        java.util.concurrent.atomic.AtomicBoolean recorded,
                                        MediaWorkflowMetrics.Outcome outcome) {
        if (recorded.compareAndSet(false, true)) modalityMetrics.stopModalityTimer(sample, outcome);
    }

    /** Measures only a concrete admission decision; exceptions remain UNKNOWN. */
    private boolean recordAdmissionDecision(BooleanSupplier admissionDecision) {
        MediaWorkflowMetrics.ModalityTimingSample sample = modalityMetrics.startModalityTimer(
                MediaWorkflowMetrics.Modality.VISION, MediaWorkflowMetrics.Boundary.ADMISSION);
        MediaWorkflowMetrics.Outcome outcome = MediaWorkflowMetrics.Outcome.UNKNOWN;
        try {
            boolean admitted = admissionDecision.getAsBoolean();
            outcome = admitted ? MediaWorkflowMetrics.Outcome.SUCCESS : MediaWorkflowMetrics.Outcome.FAILURE;
            return admitted;
        } finally {
            modalityMetrics.stopModalityTimer(sample, outcome);
        }
    }

    @Override
    public void analyzeImage(AnalyzeRequest request, StreamObserver<AnalyzeResponse> responseObserver) {
        TracedResponse<AnalyzeResponse> traced = genericTracedResponse("analyzeImage", responseObserver);
        responseObserver = traced.observer;
        try (Scope scope = tracingService.createScope(traced.span)) {
        mediaMetrics.recordStarted("vision.analyze");
        String tenantId = resolveTenantId();
        if (!tenantContextAvailable(tenantId)) {
            mediaMetrics.recordFailed("vision.analyze");
            recordResponseFailure(responseObserver, io.grpc.Status.UNAUTHENTICATED
                    .withDescription("Missing tenant context")
                    .asRuntimeException());
            return;
        }
        if (request.getImageData().isEmpty()) {
            mediaMetrics.recordFailed("vision.analyze");
            recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Image data cannot be empty")
                    .asRuntimeException());
            return;
        }
        if (request.getImageData().size() > MAX_IMAGE_BYTES) {
            mediaMetrics.recordFailed("vision.analyze");
            recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Image data exceeds maximum size of 50MB")
                    .asRuntimeException());
            return;
        }
        for (String requestedIntent : request.getAnalysisTypesList()) {
            var disposition = VisionCapabilityDisposition.forIntentId(requestedIntent);
            if (disposition.isPresent()) {
                mediaMetrics.recordFailed("vision.analyze");
                recordResponseFailure(responseObserver, io.grpc.Status.UNIMPLEMENTED
                        .withDescription("Vision capability " + disposition.get().intentId() + " is "
                                + disposition.get().status())
                        .asRuntimeException());
                return;
            }
        }
        mediaMetrics.recordFailed("vision.analyze");
        recordResponseFailure(responseObserver, io.grpc.Status.UNIMPLEMENTED
                .withDescription("Image scene analysis is not admitted; object detections do not establish scene semantics")
                .asRuntimeException());
        }
    }

    // ── VIS-09: recognizeSceneText ────────────────────────────────────────────

    @Override
    public void recognizeSceneText(SceneTextRecognizeRequest request,
                                   StreamObserver<SceneTextRecognizeResponse> responseObserver) {
        TracedResponse<SceneTextRecognizeResponse> traced =
                genericTracedResponse("recognizeSceneText", responseObserver);
        responseObserver = traced.observer;
        try (Scope scope = tracingService.createScope(traced.span)) {
        mediaMetrics.recordStarted("vision.scene-text");
        String tenantId = resolveTenantId();
        if (!tenantContextAvailable(tenantId)) {
            mediaMetrics.recordFailed("vision.scene-text");
            recordResponseFailure(responseObserver, io.grpc.Status.UNAUTHENTICATED
                    .withDescription("Missing tenant context")
                    .asRuntimeException());
            return;
        }
        String principalId = resolveUserId();
        if (principalId == null || principalId.isBlank()) {
            mediaMetrics.recordFailed("vision.scene-text");
            recordResponseFailure(responseObserver, io.grpc.Status.UNAUTHENTICATED
                    .withDescription("Missing authenticated subject context")
                    .asRuntimeException());
            return;
        }
        AuthenticatedPrincipal authenticatedPrincipal = new AuthenticatedPrincipal(
                tenantId, principalId, Instant.now());
        var service = sceneTextService;
        if (service == null) {
            mediaMetrics.recordFailed("vision.scene-text");
            recordResponseFailure(responseObserver, io.grpc.Status.UNAVAILABLE
                    .withDescription("Scene text recognition is not composed; Document Intelligence is the only OCR provider")
                    .asRuntimeException());
            return;
        }
        boolean cropDeclarationAbsent = request.getCroppedBytes().isEmpty()
                && request.getCroppedFrameSha256().isEmpty();
        byte[] declaredCropBytes = cropDeclarationAbsent ? null : request.getCroppedBytes().toByteArray();
        String declaredCropSha256 = cropDeclarationAbsent ? null : request.getCroppedFrameSha256();
        var frameRequest = new com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.FrameRequest(
                request.getOperationId(), tenantId, principalId, request.getPurposeRef(),
                request.getSourceArtifactId(), request.getSourceVersion(), request.getFrameId(),
                request.getPtsUs(), request.getFrameWidth(), request.getFrameHeight(),
                new com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Roi(
                        request.getRoi().getX(), request.getRoi().getY(),
                        request.getRoi().getWidth(), request.getRoi().getHeight()),
                request.getMediaType(), declaredCropBytes,
                request.getOriginalFrameSha256(), declaredCropSha256,
                request.getLanguageHint().isBlank()
                        ? Optional.empty() : Optional.of(request.getLanguageHint()), authenticatedPrincipal);
        var cancellation = new com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.Cancellation();
        var observerRef = responseObserver;
        io.grpc.Context requestContext = io.grpc.Context.current();
        io.grpc.Context.CancellationListener cancellationListener = ignored -> cancellation.cancel();
        requestContext.addListener(cancellationListener, Runnable::run);
        if (responseObserver instanceof ServerCallStreamObserver<SceneTextRecognizeResponse> call) {
            call.setOnCancelHandler(cancellation::cancel);
        }
        var submission = new com.ghatana.audio.video.common.resilience.ContextAwareBoundedExecutor(sceneTextExecutor)
                .<com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Outcome>submit(
                        () -> service.recognize(frameRequest, cancellation));
        submission.result().whenComplete((outcome, failure) -> requestContext.removeListener(cancellationListener));
        submission.result().whenComplete((outcome, failure) -> {
                    if (failure != null) {
                        mediaMetrics.recordFailed("vision.scene-text");
                        Throwable cause = failure instanceof java.util.concurrent.CompletionException
                                && failure.getCause() != null ? failure.getCause() : failure;
                        recordResponseFailure(observerRef, cause instanceof io.grpc.StatusRuntimeException
                                ? cause : io.grpc.Status.UNAVAILABLE
                                        .withDescription("Scene text recognition worker failed")
                                        .withCause(cause).asRuntimeException());
                        return;
                    }
                    completeSceneText(frameRequest, outcome, observerRef);
                });
        }
    }

    private void completeSceneText(
            com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.FrameRequest frameRequest,
            com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Outcome outcome,
            StreamObserver<SceneTextRecognizeResponse> responseObserver) {
        if (outcome instanceof com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Recognized recognized) {
            var provenance = SceneTextProvenance.newBuilder()
                    .setProviderRef(recognized.provenance().providerRef())
                    .setProviderVersion(recognized.provenance().providerVersion())
                    .setModelRef(recognized.provenance().modelRef().orElse(""))
                    .setModelVersion(recognized.provenance().modelVersion().orElse(""))
                    .build();
            var body = SceneTextRecognized.newBuilder()
                    .setOperationId(recognized.operationId())
                    .setSourceArtifactId(recognized.sourceArtifactId())
                    .setSourceVersion(recognized.sourceVersion())
                    .setFrameId(recognized.frameId())
                    .setPtsUs(recognized.ptsUs())
                    .setRightsDecisionRef(recognized.rightsDecisionRef())
                    .setProvenance(provenance);
            if (recognized.videoFrameBinding() != null) {
                body.setSourceFrameResolution(sourceFrameResolution(recognized.videoFrameBinding(),
                        recognized.frameId(), recognized.ptsUs()));
            }
            for (var observation : recognized.observations()) {
                body.addObservations(SceneTextObservation.newBuilder()
                        .setText(observation.text())
                        .setConfidence(observation.confidence())
                        .setCropBox(box(observation.cropBox()))
                        .setFrameBox(box(observation.frameBox()))
                        .setBlockId(observation.blockId() == null ? "" : observation.blockId())
                        .setLineId(observation.lineId() == null ? "" : observation.lineId())
                        .setWireOrdinal(observation.wireOrdinal())
                        .setLanguageTag(observation.languageTag().orElse("")));
            }
            responseObserver.onNext(SceneTextRecognizeResponse.newBuilder()
                    .setRecognized(body).build());
        } else {
            var rejected = (com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Rejected) outcome;
            responseObserver.onNext(SceneTextRecognizeResponse.newBuilder()
                    .setRejected(SceneTextRejected.newBuilder()
                            .setCode(rejected.code().name())
                            .setRetryable(rejected.retryable())
                            .setWorkerCode(rejected.workerCode().orElse("")))
                    .build());
        }
        responseObserver.onCompleted();
    }

    private static SceneTextBox box(
            com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.Box value) {
        return SceneTextBox.newBuilder()
                .setX(value.x()).setY(value.y())
                .setWidth(value.width()).setHeight(value.height())
                .build();
    }

    private static SourceFrameResolution sourceFrameResolution(
            com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.VideoFrameBinding binding,
            String frameId, long ptsUs) {
        return SourceFrameResolution.newBuilder()
                .setTenantId(binding.tenantId())
                .setPrincipalId(binding.principalId())
                .setSourceArtifactId(binding.artifactId())
                .setSourceVersion(binding.artifactVersion())
                .setSourceSha256(binding.sourceSha256())
                .setFrameId(frameId)
                .setArtifactLocalEpoch(binding.artifactLocalEpoch())
                .setSourceStreamSelector(binding.sourceStreamSelector())
                .setFrameNumber(binding.frameNumber())
                .setSourcePts(binding.sourcePts())
                .setTimeBaseNumerator(binding.timeBaseNumerator())
                .setTimeBaseDenominator(binding.timeBaseDenominator())
                .setPtsUs(ptsUs)
                .setFrameWidth(binding.frameWidth())
                .setFrameHeight(binding.frameHeight())
                .setRoi(SceneTextRoi.newBuilder().setX(binding.roi().x()).setY(binding.roi().y())
                        .setWidth(binding.roi().width()).setHeight(binding.roi().height()))
                .setFrameSha256(binding.frameSha256())
                .setCropSha256(binding.cropSha256())
                .build();
    }

    private static SourceFrameResolution sourceFrameResolution(
            com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceFrameResolution value) {
        return SourceFrameResolution.newBuilder()
                .setTenantId(value.tenantId())
                .setPrincipalId(value.principalId())
                .setSourceArtifactId(value.sourceArtifactId())
                .setSourceVersion(value.sourceVersion())
                .setSourceSha256(value.sourceSha256())
                .setFrameId(value.frameId())
                .setArtifactLocalEpoch(value.artifactLocalEpoch())
                .setSourceStreamSelector(value.sourceStreamSelector())
                .setFrameNumber(value.frameNumber())
                .setSourcePts(value.sourcePts())
                .setTimeBaseNumerator(value.timeBaseNumerator())
                .setTimeBaseDenominator(value.timeBaseDenominator())
                .setPtsUs(value.ptsUs())
                .setFrameWidth(value.frameWidth())
                .setFrameHeight(value.frameHeight())
                .setRoi(SceneTextRoi.newBuilder().setX(value.roi().x()).setY(value.roi().y())
                        .setWidth(value.roi().width()).setHeight(value.roi().height()))
                .setFrameSha256(value.frameSha256())
                .setCropSha256(value.cropSha256())
                .build();
    }

    @Override
    public void resolveSourceFrame(SourceFrameResolveRequest request,
                                   StreamObserver<SourceFrameResolveResponse> responseObserver) {
        TracedResponse<SourceFrameResolveResponse> traced = genericTracedResponse("resolveSourceFrame", responseObserver);
        responseObserver = traced.observer;
        StreamObserver<SourceFrameResolveResponse> observerRef = responseObserver;
        try (Scope scope = tracingService.createScope(traced.span)) {
            String tenantId = resolveTenantId();
            String principalId = resolveUserId();
            if (tenantId == null || tenantId.isBlank() || principalId == null || principalId.isBlank()) {
                observerRef.onNext(sourceFrameRejected("AUTHENTICATION_REQUIRED", false));
                observerRef.onCompleted();
                return;
            }
            var reader = mediaRuntimeSceneTextSource;
            if (reader == null) {
                observerRef.onNext(sourceFrameRejected("SOURCE_NOT_ADMITTED", false));
                observerRef.onCompleted();
                return;
            }
            if (!request.hasRoi() || request.getSourceArtifactId().isBlank()
                    || request.getSourceVersion().isBlank() || request.getFrameId().isBlank()
                    || request.getPurposeRef().isBlank()
                    || request.getFrameWidth() <= 0 || request.getFrameHeight() <= 0) {
                observerRef.onNext(sourceFrameRejected("INVALID_REQUEST", false));
                observerRef.onCompleted();
                return;
            }
            var requestedRoi = request.getRoi();
            if (requestedRoi.getX() < 0 || requestedRoi.getY() < 0
                    || requestedRoi.getWidth() <= 0 || requestedRoi.getHeight() <= 0
                    || (long) requestedRoi.getX() + requestedRoi.getWidth() > request.getFrameWidth()
                    || (long) requestedRoi.getY() + requestedRoi.getHeight() > request.getFrameHeight()) {
                observerRef.onNext(sourceFrameRejected("INVALID_REQUEST", false));
                observerRef.onCompleted();
                return;
            }
            AuthenticatedPrincipal authenticatedPrincipal = new AuthenticatedPrincipal(
                    tenantId, principalId, Instant.now());
            var cropRequest = new com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.CropRequest(
                    tenantId, principalId, request.getPurposeRef(), request.getSourceArtifactId(),
                    request.getSourceVersion(), request.getFrameId(), request.getPtsUs(), request.getFrameWidth(),
                    request.getFrameHeight(), new com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Roi(
                            request.getRoi().getX(), request.getRoi().getY(), request.getRoi().getWidth(),
                            request.getRoi().getHeight()), "image/png", authenticatedPrincipal);
            io.grpc.Context requestContext = io.grpc.Context.current();
            var submission = new com.ghatana.audio.video.common.resilience.ContextAwareBoundedExecutor(providerExecutor)
                    .<com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceFrameResolutionOutcome>
                            submit(() -> reader.resolveSourceFrame(cropRequest));
            submission.result().whenComplete((outcome, failure) -> requestContext.run(() -> {
                // Extraction may finish after a client disconnect; never emit a stale metadata result.
                if (requestContext.isCancelled()) return;
                if (failure != null || outcome == null) {
                    observerRef.onNext(sourceFrameRejected("SOURCE_UNAVAILABLE", true));
                } else if (outcome instanceof com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceFrameResolved resolved) {
                    observerRef.onNext(SourceFrameResolveResponse.newBuilder()
                            .setResolved(sourceFrameResolution(resolved.metadata())).build());
                } else {
                    var refused = (com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceFrameRefused) outcome;
                    boolean retryable = refused.status()
                            == com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceStatus.UNAVAILABLE;
                    observerRef.onNext(sourceFrameRejected(refused.status().name(), retryable));
                }
                observerRef.onCompleted();
            }));
        } catch (RuntimeException failure) {
            observerRef.onNext(sourceFrameRejected("SOURCE_UNAVAILABLE", true));
            observerRef.onCompleted();
        }
    }

    private static SourceFrameResolveResponse sourceFrameRejected(String code, boolean retryable) {
        return SourceFrameResolveResponse.newBuilder().setRejected(SourceFrameResolveRejected.newBuilder()
                .setCode(code).setRetryable(retryable)).build();
    }

    // ── AV-003.5: classifyImage ────────────────────────────────────────────

    @Override
    public void classifyImage(ClassifyRequest request, StreamObserver<ClassifyResponse> responseObserver) {
        TracedResponse<ClassifyResponse> traced = genericTracedResponse("classifyImage", responseObserver);
        responseObserver = traced.observer;
        try (Scope scope = tracingService.createScope(traced.span)) {
        mediaMetrics.recordStarted("vision.classify");
        String tenantId = resolveTenantId();
        if (!tenantContextAvailable(tenantId)) {
            mediaMetrics.recordFailed("vision.classify");
            recordResponseFailure(responseObserver, io.grpc.Status.UNAUTHENTICATED
                    .withDescription("Missing tenant context")
                    .asRuntimeException());
            return;
        }
        if (request.getImageData().isEmpty()) {
            mediaMetrics.recordFailed("vision.classify");
            recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Image data cannot be empty")
                    .asRuntimeException());
            return;
        }
        if (request.getImageData().size() > MAX_IMAGE_BYTES) {
            mediaMetrics.recordFailed("vision.classify");
            recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Image data exceeds maximum size of 50MB")
                    .asRuntimeException());
            return;
        }
        mediaMetrics.recordFailed("vision.classify");
        recordResponseFailure(responseObserver, io.grpc.Status.UNIMPLEMENTED
                .withDescription("Image classification is not admitted by the active Vision provider")
                .asRuntimeException());
        }
    }

    // ── AV-003.1: loadModel ────────────────────────────────────────────────

    @Override
    public void loadModel(LoadModelRequest request, StreamObserver<LoadModelResponse> responseObserver) {
        TracedResponse<LoadModelResponse> traced = genericTracedResponse("loadModel", responseObserver);
        responseObserver = traced.observer;
        try (Scope scope = tracingService.createScope(traced.span)) {
        if (!hasTenantContext(responseObserver)) return;
        String modelId = request.getModelId();
        if (modelId == null || modelId.isBlank()) {
            recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                .withDescription("modelId must not be blank")
                .asRuntimeException());
            return;
        }
        recordResponseFailure(responseObserver, io.grpc.Status.UNAVAILABLE
            .withDescription("Model loading requires an admitted Vision provider profile")
            .asRuntimeException());
        }
    }

    // ── AV-003.2: unloadModel ──────────────────────────────────────────────

    @Override
    public void unloadModel(UnloadModelRequest request, StreamObserver<UnloadModelResponse> responseObserver) {
        TracedResponse<UnloadModelResponse> traced = genericTracedResponse("unloadModel", responseObserver);
        responseObserver = traced.observer;
        try (Scope scope = tracingService.createScope(traced.span)) {
        if (!hasTenantContext(responseObserver)) return;
        String modelId = request.getModelId();
        if (modelId == null || modelId.isBlank()) {
            recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                .withDescription("modelId must not be blank")
                .asRuntimeException());
            return;
        }
        recordResponseFailure(responseObserver, io.grpc.Status.UNAVAILABLE
            .withDescription("Model unloading requires an admitted Vision provider profile")
            .asRuntimeException());
        }
    }

    // ── AV-003.3: listModels ───────────────────────────────────────────────

    @Override
    public void listModels(ListModelsRequest request, StreamObserver<ListModelsResponse> responseObserver) {
        TracedResponse<ListModelsResponse> traced = genericTracedResponse("listModels", responseObserver);
        responseObserver = traced.observer;
        try (Scope scope = tracingService.createScope(traced.span)) {
        if (!hasTenantContext(responseObserver)) return;
        recordResponseFailure(responseObserver, io.grpc.Status.UNAVAILABLE
            .withDescription("Model listing requires an admitted Vision provider profile")
            .asRuntimeException());
        }
    }

    @Override
    public void analyzeVideoFile(VideoFileRequest request, StreamObserver<VideoFileResponse> responseObserver) {
        Span trace = tracingService.startVideoProcessingSpan(null, resolveTenantId());
        TracedResponse<VideoFileResponse> traced = tracedResponse("analyzeVideoFile", trace, responseObserver);
        responseObserver = traced.observer;
        try (Scope scope = tracingService.createScope(trace)) {
        long startTime = System.currentTimeMillis();
        Path tempDir = null;

        // AV-P1-007: Enforce tenant authentication
        String videoTenantId = resolveTenantId();
        if (!tenantContextAvailable(videoTenantId)) {
            recordResponseFailure(responseObserver, io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant context")
                .asRuntimeException());
            mediaMetrics.recordFailed("vision.analyzeVideo");
            return;
        }

        try {
            // AV-P1-013: Validate request size
            if (request.getVideoData().isEmpty()) {
                recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Video data cannot be empty")
                    .asRuntimeException());
                mediaMetrics.recordFailed("vision.analyzeVideo");
                return;
            }

            int dataSize = request.getVideoData().size();
            if (dataSize > MAX_VIDEO_BYTES) {
                recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Video data exceeds maximum size of " + (MAX_VIDEO_BYTES / 1024 / 1024) + "MB")
                    .asRuntimeException());
                mediaMetrics.recordFailed("vision.analyzeVideo");
                return;
            }

            int sampleFps = request.getSampleFps();
            int maxFrames = request.getMaxFrames();
            if (sampleFps < 0 || sampleFps > MAX_VIDEO_SAMPLE_FPS
                    || maxFrames < 0 || maxFrames > MAX_VIDEO_ANALYSIS_FRAMES) {
                recordResponseFailure(responseObserver, io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Video sampling settings exceed supported bounds")
                    .asRuntimeException());
                mediaMetrics.recordFailed("vision.analyzeVideo");
                return;
            }

            if (rejectWhenProviderUnavailable(responseObserver, "Video analysis")) return;

            // The production composition has no trusted OS-level per-worker codec sandbox.
            // Keep video codec work unavailable until such enforcement is part of the launch
            // boundary; image RPCs and isolated test compositions remain usable.
            if (!recordAdmissionDecision(() -> allowVideoCodecForTestComposition)) {
                recordResponseFailure(responseObserver, io.grpc.Status.UNAVAILABLE
                    .withDescription("VIDEO_CODEC_SANDBOX_UNAVAILABLE: bounded codec worker isolation is not configured")
                    .asRuntimeException());
                mediaMetrics.recordFailed("vision.analyzeVideo");
                return;
            }

            // AV-P1-012: Log request size without tenant/user identifiers.
            LOG.info("Analyzing video file ({} bytes)", dataSize);

            tempDir = Files.createTempDirectory("vision-video-");
            Path videoFile = tempDir.resolve("input.mp4");
            try (var output = Files.newOutputStream(videoFile)) {
                // ByteString is already held by the RPC request. Stream it to disk so a
                // second 500 MiB heap copy is not created before FFprobe/FFmpeg runs.
                request.getVideoData().writeTo(output);
            }

            VideoFrameExtractor.VideoMetadata metadata = frameExtractor.getVideoMetadata(videoFile);
            LOG.info("Video metadata: {}", metadata);

            int fps = sampleFps > 0 ? sampleFps : 1;
            maxFrames = maxFrames > 0 ? maxFrames : 50;

            VideoFrameExtractor.ExtractionConfig extractConfig = VideoFrameExtractor.ExtractionConfig.builder()
                .fps(fps)
                .maxFrames(maxFrames)
                .resolution(640, 640)
                .format("jpg")
                .build();

            Path framesDir = tempDir.resolve("frames");
            List<VideoFrameExtractor.ExtractedFrame> frames;
            MediaWorkflowMetrics.ModalityTimingSample decodeSample = modalityMetrics.startModalityTimer(
                    MediaWorkflowMetrics.Modality.VISION, MediaWorkflowMetrics.Boundary.DECODE);
            MediaWorkflowMetrics.Outcome decodeOutcome = MediaWorkflowMetrics.Outcome.UNKNOWN;
            try {
                frames = frameExtractor.extractFrames(videoFile, framesDir, extractConfig);
                decodeOutcome = MediaWorkflowMetrics.Outcome.SUCCESS;
            } catch (IOException | IllegalArgumentException rejectedInput) {
                decodeOutcome = MediaWorkflowMetrics.Outcome.FAILURE;
                throw rejectedInput;
            } catch (RuntimeException uncertainDecoderFailure) {
                decodeOutcome = MediaWorkflowMetrics.Outcome.UNKNOWN;
                throw uncertainDecoderFailure;
            } finally {
                modalityMetrics.stopModalityTimer(decodeSample, decodeOutcome);
            }

            LOG.info("Extracted {} frames for analysis", frames.size());

            DetectionOptions detectionOptions = DetectionOptions.builder()
                .confidenceThreshold(request.getConfidenceThreshold() > 0 ?
                    request.getConfidenceThreshold() : 0.5)
                .maxDetections(50)
                .targetClasses(request.getTargetClassesList().isEmpty() ?
                    null : new HashSet<>(request.getTargetClassesList()))
                .build();

            VideoFileResponse.Builder responseBuilder = VideoFileResponse.newBuilder();
            Map<String, Long> aggregatedCounts = new HashMap<>();

            for (VideoFrameExtractor.ExtractedFrame frame : frames) {
                byte[] frameBytes = Files.readAllBytes(frame.getPath());
                List<DetectedObject> detections = recordProviderExecution(
                        () -> detector.detectObjects(frameBytes, detectionOptions));

                VideoFrameDetections.Builder frameResult = mapSourceTimestamp(frame);

                for (DetectedObject obj : detections) {
                    frameResult.addDetections(Detection.newBuilder()
                        .setClassName(obj.getClassName())
                        .setConfidence(obj.getConfidence())
                        .setBoundingBox(com.ghatana.audio.video.vision.grpc.proto.BoundingBox.newBuilder()
                            .setX(obj.getBoundingBox().getX())
                            .setY(obj.getBoundingBox().getY())
                            .setWidth(obj.getBoundingBox().getWidth())
                            .setHeight(obj.getBoundingBox().getHeight())
                            .build())
                        .putAllAttributes(convertAttributes(obj.getAttributes()))
                        .build());
                    aggregatedCounts.merge(obj.getClassName(), 1L, Long::sum);
                }

                responseBuilder.addFrameResults(frameResult.build());
            }

            long processingTime = System.currentTimeMillis() - startTime;

            responseBuilder
                .setTotalFramesAnalyzed(frames.size())
                .setProcessingTimeMs(processingTime)
                .setVideoDurationMs((long) (metadata.getDurationSeconds() * 1000))
                .putAllObjectCounts(aggregatedCounts)
                .setTrackingStatus("NOT_ADMITTED")
                .setSummary(generateVideoSummary(aggregatedCounts, frames.size(),
                    metadata.getDurationSeconds()));

            recordResponseBoundary(responseBuilder::build, responseObserver);

            LOG.info("Video analysis completed: {} frames, {}ms", frames.size(), processingTime);

        } catch (io.grpc.StatusRuntimeException e) {
            recordResponseFailure(responseObserver, e);
        } catch (com.ghatana.audio.video.vision.image.BoundedImageDecoder.UnsupportedImageMetadataException e) {
            recordResponseFailure(responseObserver, io.grpc.Status.UNIMPLEMENTED
                .withDescription("Unsupported video metadata").asRuntimeException());
        } catch (IOException e) {
            LOG.error("Video analysis failed ({})", e.getClass().getSimpleName());
            recordResponseFailure(responseObserver, io.grpc.Status.INTERNAL
                .withDescription("Video analysis failed")
                .asRuntimeException());
        } catch (Exception e) {
            LOG.error("Video analysis failed ({})", e.getClass().getSimpleName());
            recordResponseFailure(responseObserver, io.grpc.Status.INTERNAL
                .withDescription("Video analysis failed")
                .asRuntimeException());
        } finally {
            if (tempDir != null) {
                cleanupTempDirectory(tempDir);
            }
        }
        }
    }

    static VideoFrameDetections.Builder mapSourceTimestamp(VideoFrameExtractor.ExtractedFrame frame) {
        var timestamp = frame.getSourceTimestamp();
        VideoFrameDetections.Builder result = VideoFrameDetections.newBuilder()
                .setFrameNumber(frame.getFrameNumber());
        if (timestamp.isKnown()) {
            return result.setTimestampMs(timestamp.timestampMs())
                    .setSourcePts(timestamp.pts())
                    .setSourceTimeBaseNumerator(timestamp.timeBaseNumerator())
                    .setSourceTimeBaseDenominator(timestamp.timeBaseDenominator())
                    .setTimestampStatus(SourceTimestampStatus.SOURCE_TIMESTAMP_KNOWN);
        }
        return result.setTimestampStatus(SourceTimestampStatus.SOURCE_TIMESTAMP_UNKNOWN)
                .setTimestampUnknownReason(timestamp.reason());
    }

    @Override
    public StreamObserver<VideoFrameRequest> processVideo(StreamObserver<VideoFrameResponse> responseObserver) {
        Context operationContext = Context.current();
        Span trace = tracingService.startGrpcStreamingSpan("ProcessVideo", resolveTenantId());
        TracedResponse<VideoFrameResponse> traced = tracedResponse("processVideo", trace, responseObserver);
        StreamObserver<VideoFrameResponse> tracedObserver = traced.observer;
        ServerCallStreamObserver<VideoFrameResponse> serverObserver =
                responseObserver instanceof ServerCallStreamObserver<?> raw
                        ? castServerObserver(raw) : null;
        java.util.concurrent.atomic.AtomicBoolean terminal = new java.util.concurrent.atomic.AtomicBoolean();
        java.util.concurrent.atomic.AtomicBoolean frameInFlight = new java.util.concurrent.atomic.AtomicBoolean();
        java.util.concurrent.atomic.AtomicBoolean inputCompleted = new java.util.concurrent.atomic.AtomicBoolean();
        java.util.concurrent.atomic.AtomicReference<com.ghatana.audio.video.common.resilience.ContextAwareBoundedExecutor.Submission<?>>
                pendingFrame = new java.util.concurrent.atomic.AtomicReference<>();
        MediaWorkflowMetrics.ModalityTimingSample responseSample = modalityMetrics.startModalityTimer(
                MediaWorkflowMetrics.Modality.VISION, MediaWorkflowMetrics.Boundary.RESPONSE);
        java.util.concurrent.atomic.AtomicBoolean responseBoundaryRecorded = new java.util.concurrent.atomic.AtomicBoolean();
        java.util.concurrent.atomic.AtomicBoolean responseDeliveryAmbiguous = new java.util.concurrent.atomic.AtomicBoolean();
        if (serverObserver != null) {
            serverObserver.disableAutoRequest();
            serverObserver.setOnCancelHandler(() -> {
                terminal.set(true);
                var submission = pendingFrame.get();
                if (submission != null) submission.cancel();
                traced.finishUnknown();
                finishResponseBoundary(responseSample, responseBoundaryRecorded, MediaWorkflowMetrics.Outcome.UNKNOWN);
            });
            serverObserver.request(1);
        }
        return new StreamObserver<VideoFrameRequest>() {
            private final VideoStreamBudget budget = new VideoStreamBudget();

            private void sendFailure(Throwable failure) {
                if (!terminal.compareAndSet(false, true)) return;
                var submission = pendingFrame.get();
                if (submission != null) submission.cancel();
                try {
                    tracedObserver.onError(failure);
                    MediaWorkflowMetrics.Outcome outcome = responseDeliveryAmbiguous.get()
                            || rpcCancelled(responseObserver, operationContext)
                            ? MediaWorkflowMetrics.Outcome.UNKNOWN : MediaWorkflowMetrics.Outcome.FAILURE;
                    finishResponseBoundary(responseSample, responseBoundaryRecorded, outcome);
                } catch (RuntimeException | Error callbackFailure) {
                    finishResponseBoundary(responseSample, responseBoundaryRecorded, MediaWorkflowMetrics.Outcome.UNKNOWN);
                    throw callbackFailure;
                }
            }

            private void finishInboundStream() {
                if (!terminal.compareAndSet(false, true)) return;
                try (Scope scope = tracingService.createScope(trace)) {
                    tracedObserver.onCompleted();
                    MediaWorkflowMetrics.Outcome outcome = responseDeliveryAmbiguous.get()
                            || rpcCancelled(responseObserver, operationContext)
                            ? MediaWorkflowMetrics.Outcome.UNKNOWN : MediaWorkflowMetrics.Outcome.SUCCESS;
                    finishResponseBoundary(responseSample, responseBoundaryRecorded, outcome);
                } catch (RuntimeException | Error callbackFailure) {
                    finishResponseBoundary(responseSample, responseBoundaryRecorded, MediaWorkflowMetrics.Outcome.UNKNOWN);
                    throw callbackFailure;
                }
                LOG.info("Video processing stream completed");
            }

            private void finishUnknown() {
                if (!terminal.compareAndSet(false, true)) return;
                var submission = pendingFrame.get();
                if (submission != null) submission.cancel();
                traced.finishUnknown();
                finishResponseBoundary(responseSample, responseBoundaryRecorded, MediaWorkflowMetrics.Outcome.UNKNOWN);
            }

            private void requestNextFrame() {
                frameInFlight.set(false);
                if (inputCompleted.get()) {
                    finishInboundStream();
                } else if (!terminal.get() && serverObserver != null) {
                    serverObserver.request(1);
                }
            }

            @Override
            public void onNext(VideoFrameRequest request) {
                if (terminal.get()) return;
                if (!frameInFlight.compareAndSet(false, true)) {
                    sendFailure(io.grpc.Status.RESOURCE_EXHAUSTED
                            .withDescription("A prior video frame is still being processed")
                            .asRuntimeException());
                    return;
                }
                try (Scope scope = tracingService.createScope(trace)) {
                try {
                    String tenantId = resolveTenantId();
                    if (!tenantContextAvailable(tenantId)) {
                        sendFailure(io.grpc.Status.UNAUTHENTICATED
                                .withDescription("Missing tenant context")
                                .asRuntimeException());
                        return;
                    }
                    // AV-P1-013: Validate frame size
                    if (request.getFrameData().isEmpty()) {
                        sendFailure(io.grpc.Status.INVALID_ARGUMENT
                            .withDescription("Frame data cannot be empty")
                            .asRuntimeException());
                        return;
                    }

                    int frameSize = request.getFrameData().size();
                    if (frameSize > MAX_IMAGE_BYTES) {
                        sendFailure(io.grpc.Status.INVALID_ARGUMENT
                            .withDescription("Frame data exceeds maximum size of " + (MAX_IMAGE_BYTES / 1024 / 1024) + "MB")
                            .asRuntimeException());
                        return;
                    }

                    if (!budget.tryAccept(frameSize)) {
                        sendFailure(io.grpc.Status.RESOURCE_EXHAUSTED
                            .withDescription("Video frame stream exceeds its cumulative resource budget")
                            .asRuntimeException());
                        return;
                    }

                    if (!recordAdmissionDecision(VisionGrpcService.this::isInferenceProviderAdmitted)) {
                        sendFailure(io.grpc.Status.UNAVAILABLE
                                .withDescription("Video frame processing is unavailable: PROVIDER_NOT_ADMITTED")
                                .asRuntimeException());
                        return;
                    }

                    LOG.debug("Processing video frame {} at {}ms ({} bytes)",
                        request.getFrameNumber(), request.getTimestampMs(), frameSize);

                    DetectionOptions options = DetectionOptions.builder()
                        .maxDetections(50)
                        .confidenceThreshold(0.6)
                        .build();
                    var submission = submitProviderExecution(operationContext, () -> detector.detectObjects(
                            request.getFrameData().toByteArray(), options));
                    pendingFrame.set(submission);
                    if (terminal.get() || rpcCancelled(responseObserver, operationContext)) {
                        submission.cancel();
                        return;
                    }
                    submission.result().whenComplete((detectedObjects, failure) -> {
                        try (Scope completionScope = tracingService.createScope(trace)) {
                            pendingFrame.compareAndSet(submission, null);
                            if (terminal.get()) {
                                frameInFlight.set(false);
                                return;
                            }
                            if (failure != null) {
                                Throwable cause = failure instanceof java.util.concurrent.CompletionException
                                        && failure.getCause() != null ? failure.getCause() : failure;
                                if (rpcCancelled(responseObserver, operationContext)) {
                                    finishUnknown();
                                } else if (cause instanceof io.grpc.StatusRuntimeException statusFailure) {
                                    sendFailure(statusFailure);
                                } else if (cause instanceof com.ghatana.audio.video.vision.image.BoundedImageDecoder.UnsupportedImageMetadataException) {
                                    sendFailure(io.grpc.Status.UNIMPLEMENTED
                                            .withDescription("Unsupported video frame metadata").asRuntimeException());
                                } else {
                                    LOG.error("Video frame processing failed ({})", cause.getClass().getSimpleName());
                                    sendFailure(providerFailureStatus(cause, "Video frame processing failed")
                                            .asRuntimeException());
                                }
                                return;
                            }
                            if (rpcCancelled(responseObserver, operationContext)) {
                                finishUnknown();
                                return;
                            }
                            try {
                                VideoFrameResponse.Builder responseBuilder = VideoFrameResponse.newBuilder()
                                        .setTimestampMs(request.getTimestampMs())
                                        .setFrameNumber(request.getFrameNumber());
                                for (DetectedObject obj : detectedObjects) {
                                    responseBuilder.addDetections(Detection.newBuilder()
                                            .setClassName(obj.getClassName())
                                            .setConfidence(obj.getConfidence())
                                            .setBoundingBox(com.ghatana.audio.video.vision.grpc.proto.BoundingBox.newBuilder()
                                                    .setX(obj.getBoundingBox().getX())
                                                    .setY(obj.getBoundingBox().getY())
                                                    .setWidth(obj.getBoundingBox().getWidth())
                                                    .setHeight(obj.getBoundingBox().getHeight())
                                                    .build())
                                            .putAllAttributes(convertAttributes(obj.getAttributes()))
                                            .build());
                                }
                                if (rpcCancelled(responseObserver, operationContext)) {
                                    finishUnknown();
                                    return;
                                }
                                try {
                                    tracedObserver.onNext(responseBuilder.build());
                                } catch (RuntimeException | Error observerFailure) {
                                    responseDeliveryAmbiguous.set(true);
                                    sendFailure(io.grpc.Status.INTERNAL
                                            .withDescription("Video frame response delivery failed").asRuntimeException());
                                    return;
                                }
                                requestNextFrame();
                            } catch (RuntimeException mappingFailure) {
                                sendFailure(io.grpc.Status.INTERNAL
                                        .withDescription("Video frame response mapping failed").asRuntimeException());
                            }
                        }
                    });

                } catch (io.grpc.StatusRuntimeException e) {
                    sendFailure(e);
                } catch (com.ghatana.audio.video.vision.image.BoundedImageDecoder.UnsupportedImageMetadataException e) {
                    sendFailure(io.grpc.Status.UNIMPLEMENTED
                            .withDescription("Unsupported video frame metadata").asRuntimeException());
                } catch (Exception e) {
                    LOG.error("Video frame processing failed ({})", e.getClass().getSimpleName());
                    sendFailure(io.grpc.Status.INTERNAL
                            .withDescription("Video frame processing failed").asRuntimeException());
                }
                }
            }

            @Override
            public void onError(Throwable t) {
                if (terminal.compareAndSet(false, true)) {
                    var submission = pendingFrame.get();
                    if (submission != null) submission.cancel();
                    traced.finishUnknown();
                    finishResponseBoundary(responseSample, responseBoundaryRecorded,
                            MediaWorkflowMetrics.Outcome.UNKNOWN);
                }
                LOG.error("Video processing stream error ({})", t.getClass().getSimpleName());
            }

            @Override
            public void onCompleted() {
                inputCompleted.set(true);
                if (!frameInFlight.get()) finishInboundStream();
            }
        };
    }

    @SuppressWarnings("unchecked")
    private static ServerCallStreamObserver<VideoFrameResponse> castServerObserver(ServerCallStreamObserver<?> observer) {
        return (ServerCallStreamObserver<VideoFrameResponse>) observer;
    }

    /** Tracks finite request-stream work independently of per-frame decoder bounds. */
    static final class VideoStreamBudget {
        static final int MAX_FRAMES = 10_000;
        private int frames;
        private long bytes;

        boolean tryAccept(int frameBytes) {
            if (frameBytes <= 0 || frames >= MAX_FRAMES
                    || frameBytes > MAX_PROCESS_VIDEO_BYTES - bytes) return false;
            frames++;
            bytes += frameBytes;
            return true;
        }
    }

    @Override
    public void getStatus(StatusRequest request, StreamObserver<StatusResponse> responseObserver) {
        TracedResponse<StatusResponse> traced = genericTracedResponse("getStatus", responseObserver);
        responseObserver = traced.observer;
        try (Scope scope = tracingService.createScope(traced.span)) {
        try {
            long count = requestCount.get();
            long totalTime = totalProcessingTime.get();
            double avgTime = count > 0 ? (double) totalTime / count : 0.0;

            // AV-P1-014: Report degraded status when model is unavailable
            // Detector initialization alone is not trusted provider/root admission.
            String status = "not_admitted";

            recordResponseBoundary(() -> StatusResponse.newBuilder()
                .setStatus(status)
                .setModelName("UNAVAILABLE")
                .setTotalRequests(count)
                .setAvgProcessingTimeMs(avgTime)
                .setDegradedReason("PROVIDER_NOT_ADMITTED")
                .build(), responseObserver);

        } catch (Exception e) {
            LOG.error("Failed to get status ({})", e.getClass().getSimpleName());
            recordResponseFailure(responseObserver, io.grpc.Status.INTERNAL
                    .withDescription("Failed to get status").asRuntimeException());
        }
        }
    }

    private <T> TracedResponse<T> genericTracedResponse(String operation, StreamObserver<T> observer) {
        Span span = tracingService.startVisionUnarySpan(operation, resolveTenantId());
        return tracedResponse(operation, span, observer);
    }

    private <T> TracedResponse<T> tracedResponse(String operation, Span span, StreamObserver<T> observer) {
        span.setAttribute("media.surface", "vision");
        span.setAttribute("media.rpc.operation", operation);
        long startNanos = System.nanoTime();
        var terminal = new java.util.concurrent.atomic.AtomicBoolean();
        StreamObserver<T> tracedObserver = new StreamObserver<>() {

            @Override public void onNext(T value) {
                if (!terminal.get()) {
                    try (Scope scope = tracingService.createScope(span)) { observer.onNext(value); }
                }
            }

            @Override public void onError(Throwable failure) {
                if (!terminal.compareAndSet(false, true)) return;
                long elapsedMs = Math.max(0L, java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(
                        System.nanoTime() - startNanos));
                try (Scope scope = tracingService.createScope(span)) {
                    tracingService.recordError(span,
                            failure instanceof Exception exception ? exception : new RuntimeException("RPC failed"),
                            elapsedMs);
                }
                observer.onError(failure);
            }

            @Override public void onCompleted() {
                if (!terminal.compareAndSet(false, true)) return;
                long elapsedMs = Math.max(0L, java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(
                        System.nanoTime() - startNanos));
                try (Scope scope = tracingService.createScope(span)) {
                    tracingService.recordSuccess(span, elapsedMs);
                }
                observer.onCompleted();
            }
        };
        return new TracedResponse<>(span, tracedObserver, terminal);
    }

    private final class TracedResponse<T> {
        private final Span span;
        private final StreamObserver<T> observer;
        private final java.util.concurrent.atomic.AtomicBoolean terminal;

        private TracedResponse(Span span, StreamObserver<T> observer,
                               java.util.concurrent.atomic.AtomicBoolean terminal) {
            this.span = span;
            this.observer = observer;
            this.terminal = terminal;
        }

        /** Client cancellation has no server response terminal callback or measured outcome. */
        private void finishUnknown() {
            if (terminal.compareAndSet(false, true)) {
                try (Scope scope = tracingService.createScope(span)) { span.end(); }
            }
        }
    }

    @Override
    public void healthCheck(HealthCheckRequest request, StreamObserver<HealthCheckResponse> responseObserver) {
        TracedResponse<HealthCheckResponse> traced = genericTracedResponse("healthCheck", responseObserver);
        responseObserver = traced.observer;
        try (Scope scope = tracingService.createScope(traced.span)) {
        try {
            boolean healthy;
            try {
                healthy = Boolean.TRUE.equals(readinessProbe.getAsBoolean());
            } catch (RuntimeException unavailable) {
                healthy = false;
            }
            String message = healthy
                    ? "VISION_SERVING"
                    : "VISION_NOT_SERVING: provider readiness unavailable";
            HealthCheckResponse healthResponse = HealthCheckResponse.newBuilder()
                    .setHealthy(healthy)
                    .setMessage(message)
                    .build();

            recordResponseBoundary(() -> healthResponse, responseObserver);

        } catch (Exception e) {
            LOG.error("Health check failed ({})", e.getClass().getSimpleName());
            recordResponseFailure(responseObserver, io.grpc.Status.UNAVAILABLE
                    .withDescription("Vision readiness is unavailable").asRuntimeException());
        }
        }
    }

    /** Test compositions may exercise the gRPC adapter with a fake detector. */
    protected boolean isProviderReady() {
        return false;
    }

    /** Production wrapper overrides this with provider admission before detector dispatch. */
    protected boolean isInferenceProviderAdmitted() {
        return true;
    }

    private boolean rejectWhenProviderUnavailable(StreamObserver<?> responseObserver, String operation) {
        if (recordAdmissionDecision(this::isInferenceProviderAdmitted)) return false;
        recordResponseFailure(responseObserver, io.grpc.Status.UNAVAILABLE
                .withDescription(operation + " is unavailable: PROVIDER_NOT_ADMITTED")
                .asRuntimeException());
        return true;
    }

    /** Bind the custom Vision health RPC to the shared gRPC and HTTP readiness lifecycle. */
    void setReadinessProbe(BooleanSupplier readinessProbe) {
        this.readinessProbe = Objects.requireNonNull(readinessProbe, "readinessProbe");
    }

    // ── Private helpers ────────────────────────────────────────────────────

    // AV-P1-012: Extract tenant/user from gRPC Context set by JwtServerInterceptor
    private String resolveTenantId() {
        String tenantId = JwtServerInterceptor.CTX_TENANT.get();
        if (tenantId == null || tenantId.isBlank()) {
            LOG.warn("Tenant ID not found in gRPC Context - request may not be authenticated");
        }
        return tenantId;
    }

    private boolean hasTenantContext(StreamObserver<?> responseObserver) {
        if (tenantContextAvailable(resolveTenantId())) return true;
        recordResponseFailure(responseObserver, io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant context")
                .asRuntimeException());
        return false;
    }

    private boolean tenantContextAvailable(String tenantId) {
        return recordAdmissionDecision(() -> tenantId != null && !tenantId.isBlank());
    }

    private String resolveUserId() {
        String userId = JwtServerInterceptor.CTX_SUBJECT.get();
        if (userId == null || userId.isBlank()) {
            LOG.warn("User ID not found in gRPC Context - request may not be authenticated");
        }
        return userId;
    }

    private Map<String, String> convertAttributes(ObjectAttributes attributes) {
        Map<String, String> map = new HashMap<>();
        if (attributes != null) {
            if (attributes.getSize() != null) {
                map.put("size", attributes.getSize());
            }
            if (attributes.getOrientation() != null) {
                map.put("source.orientation", attributes.getOrientation());
            }
            if (attributes.getAdditionalProperties() != null) {
                attributes.getAdditionalProperties().forEach((key, value) -> {
                    if (key == null) throw new InvalidProviderMappingException();
                    map.put(key, value == null ? "UNAVAILABLE" : String.valueOf(value));
                });
            }
        }
        return map;
    }

    private String generateVideoSummary(Map<String, Long> objectCounts, int frameCount,
                                         double durationSeconds) {
        if (objectCounts.isEmpty()) {
            return String.format("No objects detected across %d frames (%.1fs video)",
                frameCount, durationSeconds);
        }

        List<Map.Entry<String, Long>> sorted = new ArrayList<>(objectCounts.entrySet());
        sorted.sort((a, b) -> Long.compare(b.getValue(), a.getValue()));

        StringBuilder sb = new StringBuilder();
        sb.append(String.format("Video analysis (%.1fs, %d frames): detected ", durationSeconds, frameCount));

        int limit = Math.min(5, sorted.size());
        for (int i = 0; i < limit; i++) {
            if (i > 0) sb.append(i == limit - 1 ? " and " : ", ");
            sb.append(sorted.get(i).getKey())
              .append(" (")
              .append(sorted.get(i).getValue())
              .append(" detections)");
        }

        if (sorted.size() > limit) {
            sb.append(String.format(" and %d more object types", sorted.size() - limit));
        }

        return sb.toString();
    }

    private void cleanupTempDirectory(Path dir) {
        try {
            Files.walk(dir)
                .sorted(Comparator.reverseOrder())
                .forEach(path -> {
                    try { Files.deleteIfExists(path); }
                    catch (IOException e) { LOG.warn("Failed to delete temporary file"); }
                });
        } catch (IOException e) {
            LOG.warn("Failed to cleanup temporary directory");
        }
    }

    private String generateSceneDescription(List<DetectedObject> objects) {
        if (objects.isEmpty()) {
            return "No objects detected in the image";
        }

        Map<String, Long> objectCounts = new HashMap<>();
        for (DetectedObject obj : objects) {
            objectCounts.merge(obj.getClassName(), 1L, Long::sum);
        }

        StringBuilder description = new StringBuilder("The image contains ");
        List<String> parts = new ArrayList<>();

        for (Map.Entry<String, Long> entry : objectCounts.entrySet()) {
            long count = entry.getValue();
            String className = entry.getKey();
            if (count == 1) {
                parts.add("a " + className);
            } else {
                parts.add(count + " " + className + "s");
            }
        }

        for (int i = 0; i < parts.size(); i++) {
            if (i > 0 && i == parts.size() - 1) {
                description.append(" and ");
            } else if (i > 0) {
                description.append(", ");
            }
            description.append(parts.get(i));
        }

        description.append(".");
        return description.toString();
    }

    // AV-P1-012: Emit audit event for vision operations
    private void emitVisionAudit(String tenantId, String userId, String operation, 
                                   String status, Map<String, String> details) {
        if (auditService == null) {
            return; // Audit service not configured
        }
        
        try {
            AuditEvent event = AuditEvent.builder()
                .tenantId(tenantId != null ? tenantId : "unknown")
                .eventType(operation)
                .principal(userId != null ? userId : "system")
                .resourceType("vision")
                .resourceId("vision-operation")
                .success("SUCCESS".equals(status))
                .detail("status", status)
                .detail("operation", operation)
                .details(Map.copyOf(details))
                .build();
            
            auditService.record(event);
        } catch (Exception e) {
            LOG.warn("Failed to emit audit event for vision operation {} ({})",
                    operation, e.getClass().getSimpleName());
        }
    }
}
