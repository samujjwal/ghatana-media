package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.model.FileSystemModelStore;
import com.ghatana.audio.video.common.model.ModelMetadata;
import com.ghatana.audio.video.common.model.ModelRegistry;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.grpc.proto.*;
import com.ghatana.audio.video.vision.model.*;
import com.ghatana.audio.video.vision.yolo.YoloV8Adapter;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audit.AuditEvent;
import com.ghatana.audit.AuditService;
import io.grpc.Context;
import io.grpc.stub.StreamObserver;
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
    private static final int DEFAULT_MAX_DETECTIONS = 100;
    private static final Set<String> SUPPORTED_IMAGE_FORMATS = Set.of("jpg", "jpeg", "png", "bmp", "webp");
    private static final Set<String> SUPPORTED_VIDEO_FORMATS = Set.of("mp4", "avi", "mov", "mkv");

    private final VisionDetector detector;
    private final VideoFrameExtractor frameExtractor;
    private final AtomicLong requestCount = new AtomicLong(0);
    private final AtomicLong totalProcessingTime = new AtomicLong(0);
    private final MediaProcessingMetrics mediaMetrics;
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
        this.detector = detector;
        this.frameExtractor = frameExtractor;
        this.mediaMetrics = metrics;
        this.auditService = auditService;
        this.modelRegistry = new FileSystemModelStore();
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
        this(composition.detector(), composition.frameExtractor(), metrics, auditService);
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

            LOG.debug("Detecting objects in image ({} bytes) for tenant={}, user={}", dataSize, tenantId, userId);

            DetectionOptions options = DetectionOptions.builder()
                .targetClasses(new HashSet<>(request.getTargetClassesList()))
                .maxDetections(maxDetections)
                .confidenceThreshold(request.getConfidenceThreshold() > 0 ? request.getConfidenceThreshold() : 0.5)
                .build();

            List<DetectedObject> detectedObjects = detector.detectObjects(
                request.getImageData().toByteArray(),
                options
            );

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
                    .withDescription(e.getMessage()).asRuntimeException());
        } catch (VisionDetector.DetectionException e) {
            LOG.error("Object detection engine failure", e);
            mediaMetrics.recordFailed("vision.detect");
            
            // AV-P1-012: Emit audit event for detection failure
            emitVisionAudit(tenantId, userId, "vision.detect", "FAILED",
                Map.of("error", e.getMessage(), "imageSizeBytes", String.valueOf(dataSize)));
            
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Detection engine error: " + e.getMessage())
                .asRuntimeException());
        } catch (IllegalArgumentException e) {
            LOG.warn("Invalid detection request: {}", e.getMessage());
            mediaMetrics.recordFailed("vision.detect");
            
            // AV-P1-012: Emit audit event for invalid request
            emitVisionAudit(tenantId, userId, "vision.detect", "INVALID",
                Map.of("error", e.getMessage(), "imageSizeBytes", String.valueOf(dataSize)));
            
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription(e.getMessage())
                .asRuntimeException());
        } catch (Exception e) {
            LOG.error("Unexpected error during object detection", e);
            mediaMetrics.recordFailed("vision.detect");
            
            // AV-P1-012: Emit audit event for unexpected error
            emitVisionAudit(tenantId, userId, "vision.detect", "ERROR",
                Map.of("error", e.getMessage(), "imageSizeBytes", String.valueOf(dataSize)));
            
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Internal detection error")
                .asRuntimeException());
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
        String modelId = request.getModelId();
        if (modelId == null || modelId.isBlank()) {
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription("modelId must not be blank")
                .asRuntimeException());
            return;
        }
        responseObserver.onError(io.grpc.Status.UNIMPLEMENTED
            .withDescription("Dynamic model loading is not supported; restart with an admitted model profile")
            .asRuntimeException());
    }

    // ── AV-003.2: unloadModel ──────────────────────────────────────────────

    @Override
    public void unloadModel(UnloadModelRequest request, StreamObserver<UnloadModelResponse> responseObserver) {
        String modelId = request.getModelId();
        if (modelId == null || modelId.isBlank()) {
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription("modelId must not be blank")
                .asRuntimeException());
            return;
        }
        responseObserver.onError(io.grpc.Status.UNIMPLEMENTED
            .withDescription("Dynamic model unloading is not supported by the active Vision service")
            .asRuntimeException());
    }

    // ── AV-003.3: listModels ───────────────────────────────────────────────

    @Override
    public void listModels(ListModelsRequest request, StreamObserver<ListModelsResponse> responseObserver) {
        try {
            List<ModelMetadata> models = modelRegistry.listModels(ModelMetadata.ModelType.VISION)
                    .stream().filter(ModelMetadata::loaded).toList();

            ListModelsResponse.Builder builder = ListModelsResponse.newBuilder();
            int loadedCount = 0;
            for (ModelMetadata m : models) {
                if (request.getIncludeLoadedOnly() && !m.loaded()) continue;
                if (m.loaded()) loadedCount++;

                builder.addModels(VisionModelInfo.newBuilder()
                    .setModelId(m.modelId())
                    .setName(m.name())
                    .setVersion(m.version())
                    .setIsLoaded(m.loaded())
                    .setSizeBytes(m.sizeBytes())
                    .addSupportedTasks("detection")
                    .build());
            }
            builder.setTotalCount(builder.getModelsCount());
            builder.setLoadedCount(loadedCount);

            LOG.debug("Listed {} vision models", builder.getTotalCount());
            responseObserver.onNext(builder.build());
            responseObserver.onCompleted();
        } catch (Exception e) {
            LOG.error("Failed to list vision models: {}", e.getMessage(), e);
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Failed to list models: " + e.getMessage())
                .asRuntimeException());
        }
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

            // AV-P1-012: Log with tenant/user context
            String tenantId = resolveTenantId();
            String userId = resolveUserId();
            LOG.info("Analyzing video file ({} bytes) for tenant={}, user={}", dataSize, tenantId, userId);

            tempDir = Files.createTempDirectory("vision-video-");
            Path videoFile = tempDir.resolve("input.mp4");
            Files.write(videoFile, request.getVideoData().toByteArray());

            VideoFrameExtractor.VideoMetadata metadata = frameExtractor.getVideoMetadata(videoFile);
            LOG.info("Video metadata: {}", metadata);

            int fps = request.getSampleFps() > 0 ? request.getSampleFps() : 1;
            int maxFrames = request.getMaxFrames() > 0 ? request.getMaxFrames() : 50;

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
                List<DetectedObject> detections = detector.detectObjects(frameBytes, detectionOptions);

                VideoFrameDetections.Builder frameResult = VideoFrameDetections.newBuilder()
                    .setTimestampMs(frame.getTimestampMs())
                    .setFrameNumber(frame.getFrameNumber());

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
                .setSummary(generateVideoSummary(aggregatedCounts, frames.size(),
                    metadata.getDurationSeconds()));

            responseObserver.onNext(responseBuilder.build());
            responseObserver.onCompleted();

            LOG.info("Video analysis completed: {} frames, {}ms", frames.size(), processingTime);

        } catch (com.ghatana.audio.video.vision.image.BoundedImageDecoder.UnsupportedImageMetadataException e) {
            responseObserver.onError(io.grpc.Status.UNIMPLEMENTED
                .withDescription(e.getMessage()).asRuntimeException());
        } catch (IOException e) {
            LOG.error("Video analysis failed", e);
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Video analysis failed: " + e.getMessage())
                .asRuntimeException());
        } finally {
            if (tempDir != null) {
                cleanupTempDirectory(tempDir);
            }
        }
    }

    @Override
    public StreamObserver<VideoFrameRequest> processVideo(StreamObserver<VideoFrameResponse> responseObserver) {
        return new StreamObserver<VideoFrameRequest>() {
            @Override
            public void onNext(VideoFrameRequest request) {
                try {
                    // AV-P1-013: Validate frame size
                    if (request.getFrameData().isEmpty()) {
                        responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                            .withDescription("Frame data cannot be empty")
                            .asRuntimeException());
                        return;
                    }

                    int frameSize = request.getFrameData().size();
                    if (frameSize > MAX_IMAGE_BYTES) {
                        responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                            .withDescription("Frame data exceeds maximum size of " + (MAX_IMAGE_BYTES / 1024 / 1024) + "MB")
                            .asRuntimeException());
                        return;
                    }

                    LOG.debug("Processing video frame {} at {}ms ({} bytes)",
                        request.getFrameNumber(), request.getTimestampMs(), frameSize);

                    DetectionOptions options = DetectionOptions.builder()
                        .maxDetections(50)
                        .confidenceThreshold(0.6)
                        .build();

                    List<DetectedObject> detectedObjects = detector.detectObjects(
                        request.getFrameData().toByteArray(),
                        options
                    );

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
                    responseObserver.onError(io.grpc.Status.UNIMPLEMENTED
                            .withDescription(e.getMessage()).asRuntimeException());
                } catch (Exception e) {
                    LOG.error("Video frame processing failed", e);
                    responseObserver.onError(e);
                }
            }

            @Override
            public void onError(Throwable t) {
                LOG.error("Video processing stream error", t);
            }

            @Override
            public void onCompleted() {
                responseObserver.onCompleted();
                LOG.info("Video processing stream completed");
            }
        };
    }

    @Override
    public void getStatus(StatusRequest request, StreamObserver<StatusResponse> responseObserver) {
        try {
            long count = requestCount.get();
            long totalTime = totalProcessingTime.get();
            double avgTime = count > 0 ? (double) totalTime / count : 0.0;

            String activeModel = modelRegistry.getActiveModel(ModelMetadata.ModelType.VISION)
                    .map(ModelMetadata::modelId).orElse("YOLOv8");

            // AV-P1-014: Report degraded status when model is unavailable
            String status;
            if (degraded) {
                status = "degraded";
            } else if (detector.isInitialized()) {
                status = "healthy";
            } else {
                status = "not_initialized";
            }

            StatusResponse response = StatusResponse.newBuilder()
                .setStatus(status)
                .setModelName(activeModel)
                .setTotalRequests(count)
                .setAvgProcessingTimeMs(avgTime)
                .setDegradedReason(degraded ? degradationReason : "")
                .build();

            responseObserver.onNext(response);
            responseObserver.onCompleted();

        } catch (Exception e) {
            LOG.error("Failed to get status", e);
            responseObserver.onError(e);
        }
    }

    @Override
    public void healthCheck(HealthCheckRequest request, StreamObserver<HealthCheckResponse> responseObserver) {
        try {
            // AV-P1-014: Health check returns degraded instead of failing when model is missing
            boolean healthy = !degraded && detector.isInitialized();
            String message;
            if (degraded) {
                message = "Vision service is degraded: " + degradationReason;
            } else if (healthy) {
                message = "Vision service is healthy";
            } else {
                message = "Vision service not initialized";
            }

            HealthCheckResponse response = HealthCheckResponse.newBuilder()
                .setHealthy(healthy)
                .setMessage(message)
                .build();

            responseObserver.onNext(response);
            responseObserver.onCompleted();

        } catch (Exception e) {
            LOG.error("Health check failed", e);
            responseObserver.onError(e);
        }
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
                    catch (IOException e) { LOG.warn("Failed to delete temp file: {}", path); }
                });
        } catch (IOException e) {
            LOG.warn("Failed to cleanup temp directory: {}", dir);
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
            LOG.warn("Failed to emit audit event for vision operation {}: {}", operation, e.getMessage());
        }
    }
}
