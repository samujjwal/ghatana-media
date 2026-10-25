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
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audit.AuditEvent;
import com.ghatana.audit.AuditService;
import com.ghatana.audiovideo.observability.MediaWorkflowMetrics;
import io.grpc.Context;
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
public class VisionGrpcService extends VisionServiceGrpc.VisionServiceImplBase {

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
    private final AtomicLong requestCount = new AtomicLong(0);
    private final AtomicLong totalProcessingTime = new AtomicLong(0);
    private volatile BooleanSupplier readinessProbe = () -> false;
    private final MediaProcessingMetrics mediaMetrics;
    private final MediaWorkflowMetrics modalityMetrics;
    private final ModelRegistry modelRegistry;
    private final AuditService auditService;
    private volatile boolean degraded = false;
    private volatile String degradationReason = null;

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
        this.detector = detector;
        this.frameExtractor = frameExtractor;
        this.mediaMetrics = metrics;
        this.modalityMetrics = new MediaWorkflowMetrics(
                Objects.requireNonNull(providerMetrics, "providerMetrics"), "vision");
        this.auditService = auditService;
        this.modelRegistry = modelRegistry;
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
                new FileSystemModelStore(), providerMetrics);
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

    @Override
    public void detectObjects(DetectRequest request, StreamObserver<DetectResponse> responseObserver) {
        long startTime = System.currentTimeMillis();
        requestCount.incrementAndGet();
        mediaMetrics.recordStarted("vision.detect");

        // AV-P1-007: Enforce tenant authentication
        String tenantId = resolveTenantId();
        if (tenantId == null || tenantId.isBlank()) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant context — authenticate before calling Vision service")
                .asRuntimeException());
            mediaMetrics.recordFailed("vision.detect");
            return;
        }
        String userId = resolveUserId();
        int dataSize = 0;

        try {
            // AV-P1-013: Validate request size
            if (request.getImageData().isEmpty()) {
                responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Image data cannot be empty")
                    .asRuntimeException());
                mediaMetrics.recordFailed("vision.detect");
                return;
            }

            dataSize = request.getImageData().size();
            if (dataSize > MAX_IMAGE_BYTES) {
                responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Image data exceeds maximum size of " + (MAX_IMAGE_BYTES / 1024 / 1024) + "MB")
                    .asRuntimeException());
                mediaMetrics.recordFailed("vision.detect");
                return;
            }

            // AV-P1-013: Validate max detections
            int maxDetections = request.getMaxDetections() > 0 ? request.getMaxDetections() : DEFAULT_MAX_DETECTIONS;
            if (maxDetections > DEFAULT_MAX_DETECTIONS) {
                responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
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

            List<DetectedObject> detectedObjects = recordProviderExecution(() -> detector.detectObjects(
                request.getImageData().toByteArray(), options));

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

            long processingTime = System.currentTimeMillis() - startTime;
            totalProcessingTime.addAndGet(processingTime);
            mediaMetrics.recordSucceeded("vision.detect", processingTime);

            responseBuilder.setProcessingTimeMs(processingTime);

            responseObserver.onNext(responseBuilder.build());
            responseObserver.onCompleted();

            LOG.info("Detected {} objects in {}ms", detectedObjects.size(), processingTime);

            // AV-P1-012: Emit audit event for successful detection
            emitVisionAudit(tenantId, userId, "vision.detect", "SUCCESS",
                Map.of("objectCount", String.valueOf(detectedObjects.size()),
                       "processingTimeMs", String.valueOf(processingTime),
                       "imageSizeBytes", String.valueOf(dataSize)));

        } catch (com.ghatana.audio.video.vision.image.BoundedImageDecoder.UnsupportedImageMetadataException e) {
            mediaMetrics.recordFailed("vision.detect");
            responseObserver.onError(io.grpc.Status.UNIMPLEMENTED
                    .withDescription("Unsupported image metadata").asRuntimeException());
        } catch (VisionDetector.DetectionException e) {
            LOG.error("Object detection engine failure ({})", e.getClass().getSimpleName());
            mediaMetrics.recordFailed("vision.detect");
            
            // AV-P1-012: Emit audit event for detection failure
            emitVisionAudit(tenantId, userId, "vision.detect", "FAILED",
                Map.of("errorCode", "DETECTION_FAILED", "imageSizeBytes", String.valueOf(dataSize)));
            
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Detection engine error")
                .asRuntimeException());
        } catch (IllegalArgumentException e) {
            LOG.warn("Invalid detection request ({})", e.getClass().getSimpleName());
            mediaMetrics.recordFailed("vision.detect");
            
            // AV-P1-012: Emit audit event for invalid request
            emitVisionAudit(tenantId, userId, "vision.detect", "INVALID",
                Map.of("errorCode", "INVALID_REQUEST", "imageSizeBytes", String.valueOf(dataSize)));
            
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription("Invalid detection request")
                .asRuntimeException());
        } catch (Exception e) {
            LOG.error("Unexpected error during object detection ({})", e.getClass().getSimpleName());
            mediaMetrics.recordFailed("vision.detect");
            
            // AV-P1-012: Emit audit event for unexpected error
            emitVisionAudit(tenantId, userId, "vision.detect", "ERROR",
                Map.of("errorCode", "INTERNAL_ERROR", "imageSizeBytes", String.valueOf(dataSize)));
            
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Internal detection error")
                .asRuntimeException());
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
                if (detection == null || detection.getClassName() == null || detection.getClassName().isBlank()
                        || !Double.isFinite(detection.getConfidence()) || detection.getConfidence() < 0
                        || detection.getConfidence() > 1 || detection.getBoundingBox() == null) {
                    throw new IllegalStateException("Provider returned an invalid detection result");
                }
            }
            if (!Context.current().isCancelled()) outcome = MediaWorkflowMetrics.Outcome.SUCCESS;
            return result;
        } finally {
            modalityMetrics.stopModalityTimer(sample, outcome);
        }
    }

    @Override
    public void analyzeImage(AnalyzeRequest request, StreamObserver<AnalyzeResponse> responseObserver) {
        mediaMetrics.recordStarted("vision.analyze");
        String tenantId = resolveTenantId();
        if (tenantId == null || tenantId.isBlank()) {
            mediaMetrics.recordFailed("vision.analyze");
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                    .withDescription("Missing tenant context")
                    .asRuntimeException());
            return;
        }
        if (request.getImageData().isEmpty()) {
            mediaMetrics.recordFailed("vision.analyze");
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Image data cannot be empty")
                    .asRuntimeException());
            return;
        }
        if (request.getImageData().size() > MAX_IMAGE_BYTES) {
            mediaMetrics.recordFailed("vision.analyze");
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Image data exceeds maximum size of 50MB")
                    .asRuntimeException());
            return;
        }
        for (String requestedIntent : request.getAnalysisTypesList()) {
            var disposition = VisionCapabilityDisposition.forIntentId(requestedIntent);
            if (disposition.isPresent()) {
                mediaMetrics.recordFailed("vision.analyze");
                responseObserver.onError(io.grpc.Status.UNIMPLEMENTED
                        .withDescription("Vision capability " + disposition.get().intentId() + " is "
                                + disposition.get().status())
                        .asRuntimeException());
                return;
            }
        }
        mediaMetrics.recordFailed("vision.analyze");
        responseObserver.onError(io.grpc.Status.UNIMPLEMENTED
                .withDescription("Image scene analysis is not admitted; object detections do not establish scene semantics")
                .asRuntimeException());
    }

    // ── AV-003.5: classifyImage ────────────────────────────────────────────

    @Override
    public void classifyImage(ClassifyRequest request, StreamObserver<ClassifyResponse> responseObserver) {
        mediaMetrics.recordStarted("vision.classify");
        String tenantId = resolveTenantId();
        if (tenantId == null || tenantId.isBlank()) {
            mediaMetrics.recordFailed("vision.classify");
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                    .withDescription("Missing tenant context")
                    .asRuntimeException());
            return;
        }
        if (request.getImageData().isEmpty()) {
            mediaMetrics.recordFailed("vision.classify");
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Image data cannot be empty")
                    .asRuntimeException());
            return;
        }
        if (request.getImageData().size() > MAX_IMAGE_BYTES) {
            mediaMetrics.recordFailed("vision.classify");
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Image data exceeds maximum size of 50MB")
                    .asRuntimeException());
            return;
        }
        mediaMetrics.recordFailed("vision.classify");
        responseObserver.onError(io.grpc.Status.UNIMPLEMENTED
                .withDescription("Image classification is not admitted by the active Vision provider")
                .asRuntimeException());
    }

    // ── AV-003.1: loadModel ────────────────────────────────────────────────

    @Override
    public void loadModel(LoadModelRequest request, StreamObserver<LoadModelResponse> responseObserver) {
        if (!hasTenantContext(responseObserver)) return;
        String modelId = request.getModelId();
        if (modelId == null || modelId.isBlank()) {
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription("modelId must not be blank")
                .asRuntimeException());
            return;
        }
        responseObserver.onError(io.grpc.Status.UNAVAILABLE
            .withDescription("Model loading requires an admitted Vision provider profile")
            .asRuntimeException());
    }

    // ── AV-003.2: unloadModel ──────────────────────────────────────────────

    @Override
    public void unloadModel(UnloadModelRequest request, StreamObserver<UnloadModelResponse> responseObserver) {
        if (!hasTenantContext(responseObserver)) return;
        String modelId = request.getModelId();
        if (modelId == null || modelId.isBlank()) {
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription("modelId must not be blank")
                .asRuntimeException());
            return;
        }
        responseObserver.onError(io.grpc.Status.UNAVAILABLE
            .withDescription("Model unloading requires an admitted Vision provider profile")
            .asRuntimeException());
    }

    // ── AV-003.3: listModels ───────────────────────────────────────────────

    @Override
    public void listModels(ListModelsRequest request, StreamObserver<ListModelsResponse> responseObserver) {
        if (!hasTenantContext(responseObserver)) return;
        responseObserver.onError(io.grpc.Status.UNAVAILABLE
            .withDescription("Model listing requires an admitted Vision provider profile")
            .asRuntimeException());
    }

    @Override
    public void analyzeVideoFile(VideoFileRequest request, StreamObserver<VideoFileResponse> responseObserver) {
        long startTime = System.currentTimeMillis();
        Path tempDir = null;

        // AV-P1-007: Enforce tenant authentication
        String videoTenantId = resolveTenantId();
        if (videoTenantId == null || videoTenantId.isBlank()) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant context")
                .asRuntimeException());
            mediaMetrics.recordFailed("vision.analyzeVideo");
            return;
        }

        try {
            // AV-P1-013: Validate request size
            if (request.getVideoData().isEmpty()) {
                responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Video data cannot be empty")
                    .asRuntimeException());
                mediaMetrics.recordFailed("vision.analyzeVideo");
                return;
            }

            int dataSize = request.getVideoData().size();
            if (dataSize > MAX_VIDEO_BYTES) {
                responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Video data exceeds maximum size of " + (MAX_VIDEO_BYTES / 1024 / 1024) + "MB")
                    .asRuntimeException());
                mediaMetrics.recordFailed("vision.analyzeVideo");
                return;
            }

            int sampleFps = request.getSampleFps();
            int maxFrames = request.getMaxFrames();
            if (sampleFps < 0 || sampleFps > MAX_VIDEO_SAMPLE_FPS
                    || maxFrames < 0 || maxFrames > MAX_VIDEO_ANALYSIS_FRAMES) {
                responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Video sampling settings exceed supported bounds")
                    .asRuntimeException());
                mediaMetrics.recordFailed("vision.analyzeVideo");
                return;
            }

            if (rejectWhenProviderUnavailable(responseObserver, "Video analysis")) return;

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
            List<VideoFrameExtractor.ExtractedFrame> frames =
                frameExtractor.extractFrames(videoFile, framesDir, extractConfig);

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

            responseObserver.onNext(responseBuilder.build());
            responseObserver.onCompleted();

            LOG.info("Video analysis completed: {} frames, {}ms", frames.size(), processingTime);

        } catch (com.ghatana.audio.video.vision.image.BoundedImageDecoder.UnsupportedImageMetadataException e) {
            responseObserver.onError(io.grpc.Status.UNIMPLEMENTED
                .withDescription("Unsupported video metadata").asRuntimeException());
        } catch (IOException e) {
            LOG.error("Video analysis failed ({})", e.getClass().getSimpleName());
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Video analysis failed")
                .asRuntimeException());
        } catch (Exception e) {
            LOG.error("Video analysis failed ({})", e.getClass().getSimpleName());
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Video analysis failed")
                .asRuntimeException());
        } finally {
            if (tempDir != null) {
                cleanupTempDirectory(tempDir);
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
        return new StreamObserver<VideoFrameRequest>() {
            private final java.util.concurrent.atomic.AtomicBoolean terminal =
                    new java.util.concurrent.atomic.AtomicBoolean();
            private final VideoStreamBudget budget = new VideoStreamBudget();

            @Override
            public void onNext(VideoFrameRequest request) {
                if (terminal.get()) return;
                try {
                    String tenantId = resolveTenantId();
                    if (tenantId == null || tenantId.isBlank()) {
                        terminal.set(true);
                        responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                                .withDescription("Missing tenant context")
                                .asRuntimeException());
                        return;
                    }
                    // AV-P1-013: Validate frame size
                    if (request.getFrameData().isEmpty()) {
                        terminal.set(true);
                        responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                            .withDescription("Frame data cannot be empty")
                            .asRuntimeException());
                        return;
                    }

                    int frameSize = request.getFrameData().size();
                    if (frameSize > MAX_IMAGE_BYTES) {
                        terminal.set(true);
                        responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                            .withDescription("Frame data exceeds maximum size of " + (MAX_IMAGE_BYTES / 1024 / 1024) + "MB")
                            .asRuntimeException());
                        return;
                    }

                    if (!budget.tryAccept(frameSize)) {
                        terminal.set(true);
                        responseObserver.onError(io.grpc.Status.RESOURCE_EXHAUSTED
                            .withDescription("Video frame stream exceeds its cumulative resource budget")
                            .asRuntimeException());
                        return;
                    }

                    if (rejectWhenProviderUnavailable(responseObserver, "Video frame processing")) {
                        terminal.set(true);
                        return;
                    }

                    LOG.debug("Processing video frame {} at {}ms ({} bytes)",
                        request.getFrameNumber(), request.getTimestampMs(), frameSize);

                    DetectionOptions options = DetectionOptions.builder()
                        .maxDetections(50)
                        .confidenceThreshold(0.6)
                        .build();

                    List<DetectedObject> detectedObjects = recordProviderExecution(() -> detector.detectObjects(
                            request.getFrameData().toByteArray(), options));

                    VideoFrameResponse.Builder responseBuilder = VideoFrameResponse.newBuilder()
                        .setTimestampMs(request.getTimestampMs())
                        .setFrameNumber(request.getFrameNumber());

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

                    responseObserver.onNext(responseBuilder.build());

                } catch (com.ghatana.audio.video.vision.image.BoundedImageDecoder.UnsupportedImageMetadataException e) {
                    terminal.set(true);
                    responseObserver.onError(io.grpc.Status.UNIMPLEMENTED
                            .withDescription("Unsupported video frame metadata").asRuntimeException());
                } catch (Exception e) {
                    terminal.set(true);
                    LOG.error("Video frame processing failed ({})", e.getClass().getSimpleName());
                    responseObserver.onError(io.grpc.Status.INTERNAL
                            .withDescription("Video frame processing failed").asRuntimeException());
                }
            }

            @Override
            public void onError(Throwable t) {
                terminal.set(true);
                LOG.error("Video processing stream error ({})", t.getClass().getSimpleName());
            }

            @Override
            public void onCompleted() {
                if (!terminal.compareAndSet(false, true)) return;
                responseObserver.onCompleted();
                LOG.info("Video processing stream completed");
            }
        };
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
        try {
            long count = requestCount.get();
            long totalTime = totalProcessingTime.get();
            double avgTime = count > 0 ? (double) totalTime / count : 0.0;

            // AV-P1-014: Report degraded status when model is unavailable
            // Detector initialization alone is not trusted provider/root admission.
            String status = "not_admitted";

            StatusResponse response = StatusResponse.newBuilder()
                .setStatus(status)
                .setModelName("UNAVAILABLE")
                .setTotalRequests(count)
                .setAvgProcessingTimeMs(avgTime)
                .setDegradedReason("PROVIDER_NOT_ADMITTED")
                .build();

            responseObserver.onNext(response);
            responseObserver.onCompleted();

        } catch (Exception e) {
            LOG.error("Failed to get status ({})", e.getClass().getSimpleName());
            responseObserver.onError(io.grpc.Status.INTERNAL
                    .withDescription("Failed to get status").asRuntimeException());
        }
    }

    @Override
    public void healthCheck(HealthCheckRequest request, StreamObserver<HealthCheckResponse> responseObserver) {
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

            HealthCheckResponse response = HealthCheckResponse.newBuilder()
                .setHealthy(healthy)
                .setMessage(message)
                .build();

            responseObserver.onNext(response);
            responseObserver.onCompleted();

        } catch (Exception e) {
            LOG.error("Health check failed ({})", e.getClass().getSimpleName());
            responseObserver.onError(io.grpc.Status.UNAVAILABLE
                    .withDescription("Vision readiness is unavailable").asRuntimeException());
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
        if (isInferenceProviderAdmitted()) return false;
        responseObserver.onError(io.grpc.Status.UNAVAILABLE
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
        String tenantId = resolveTenantId();
        if (tenantId != null && !tenantId.isBlank()) return true;
        responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant context")
                .asRuntimeException());
        return false;
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
                attributes.getAdditionalProperties().forEach((key, value) ->
                        map.put(key, value == null ? "UNAVAILABLE" : String.valueOf(value)));
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
