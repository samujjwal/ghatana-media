package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.common.model.FileSystemModelStore;
import com.ghatana.audio.video.common.model.ModelMetadata;
import com.ghatana.audio.video.common.model.ModelRegistry;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.multimodal.engine.AudioVideoProcessingError;
import com.ghatana.audio.video.multimodal.engine.MultimodalAnalysisEngine;
import com.ghatana.audio.video.multimodal.engine.PlatformMultimodalAdapter;
import com.ghatana.audio.video.multimodal.engine.MultimodalResult;
import com.ghatana.audio.video.multimodal.engine.VideoAudioResult;
import com.ghatana.audio.video.multimodal.grpc.proto.*;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * gRPC service implementation for multimodal audio+video analysis.
 *
 * @doc.type class
 * @doc.purpose gRPC service exposing multimodal STT+vision analysis over gRPC transport
 * @doc.layer product
 * @doc.pattern Service, Adapter
 */
public class MultimodalGrpcService extends MultimodalServiceGrpc.MultimodalServiceImplBase {

    private static final Logger LOG = LoggerFactory.getLogger(MultimodalGrpcService.class);

    private final MultimodalAnalysisEngine engine;
    private final PlatformMultimodalAdapter platformAdapter;
    private final AtomicLong requestCount = new AtomicLong(0);
    private final AtomicLong totalProcessingTime = new AtomicLong(0);
    private final MediaProcessingMetrics mediaMetrics;
    private final ModelRegistry modelRegistry;

    public MultimodalGrpcService() {
        this(MediaProcessingMetrics.create());
    }

    public MultimodalGrpcService(MediaProcessingMetrics metrics) {
        this.platformAdapter = new PlatformMultimodalAdapter();
        this.engine = new MultimodalAnalysisEngine(platformAdapter);
        this.mediaMetrics = metrics;
        this.modelRegistry = new FileSystemModelStore();
        LOG.info("Multimodal service initialized against platform audio-video library");
    }

    /**
     * Package-private constructor for unit testing — inject a pre-configured engine.
     * Avoids native-library and file-system dependencies during tests.
     */
    MultimodalGrpcService(MultimodalAnalysisEngine engine, PlatformMultimodalAdapter platformAdapter,
                          MediaProcessingMetrics metrics) {
        this.engine = engine;
        this.platformAdapter = platformAdapter;
        this.mediaMetrics = metrics;
        this.modelRegistry = new FileSystemModelStore();
    }

    @Override
    public void processMultimodal(MultimodalRequest request, StreamObserver<MultimodalResponse> responseObserver) {
        requestCount.incrementAndGet();
        long startTime = System.currentTimeMillis();
        mediaMetrics.recordStarted("multimodal.analyse");

        // AV-P1-008: Enforce tenant authentication
        String tenantId = resolveTenantId();
        if (tenantId == null || tenantId.isBlank()) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant context — authenticate before calling Multimodal service")
                .asRuntimeException());
            mediaMetrics.recordFailed("multimodal.analyse");
            return;
        }

        try {
            LOG.debug("Processing multimodal request with {} analysis types for tenant={}",
                    request.getAnalysisTypesList().size(), tenantId);

            // Build engine request from proto — ByteString.isEmpty() and toByteArray() are valid
            com.ghatana.audio.video.multimodal.engine.MultimodalRequest engineRequest =
                    com.ghatana.audio.video.multimodal.engine.MultimodalRequest.builder()
                            .audioData(request.getAudioData().isEmpty() ? null
                                    : request.getAudioData().toByteArray())
                            .imageData(request.getImageData().isEmpty() ? null
                                    : request.getImageData().toByteArray())
                            .videoData(request.getVideoData().isEmpty() ? null
                                    : request.getVideoData().toByteArray())
                            .text(request.getText())
                            .build();

            MultimodalResult result = engine.analyse(engineRequest);

            MultimodalResponse.Builder responseBuilder = MultimodalResponse.newBuilder()
                    .setCombinedAnalysis(result.getCombinedAnalysis())
                    .setProcessingTimeMs(result.getProcessingTimeMs());

            if (result.getAudioResult() != null && !result.getAudioResult().isError()) {
                responseBuilder.setAudioAnalysis(AudioAnalysis.newBuilder()
                        .setTranscription(result.getAudioResult().getTranscription())
                        .setConfidence(result.getAudioResult().getConfidence())
                        .build());
            }

            if (result.getVisualResult() != null && !result.getVisualResult().isError()) {
                responseBuilder.setVisualAnalysis(VisualAnalysis.newBuilder()
                        .setSceneDescription(result.getVisualResult().getSceneDescription())
                        .setConfidence(result.getVisualResult().getConfidence() != null
                                ? result.getVisualResult().getConfidence() : 0.0)
                        .build());
            }

            responseBuilder
                    .putMetadata("has_audio", String.valueOf(result.getAudioResult() != null))
                    .putMetadata("has_visual", String.valueOf(result.getVisualResult() != null))
                    .putMetadata("has_text", String.valueOf(!request.getText().isEmpty()))
                    .putMetadata("processing_backend", platformAdapter.backendName())
                    .putMetadata("platform_metrics_enabled", String.valueOf(platformAdapter.metricsEnabled()));

            totalProcessingTime.addAndGet(result.getProcessingTimeMs());
            mediaMetrics.recordSucceeded("multimodal.analyse", System.currentTimeMillis() - startTime);
            responseObserver.onNext(responseBuilder.build());
            responseObserver.onCompleted();

            LOG.info("Multimodal processing completed in {}ms", result.getProcessingTimeMs());

        } catch (Exception e) {
            LOG.error("Multimodal processing failed", e);
            mediaMetrics.recordFailed("multimodal.analyse");
            responseObserver.onError(toStatus(e, "Multimodal processing failed").asRuntimeException());
        }
    }

    @Override
    public void analyzeVideoWithAudio(VideoAudioRequest request,
                                       StreamObserver<VideoAudioResponse> responseObserver) {
        // AV-P1-008: Enforce tenant authentication
        String tenantId = resolveTenantId();
        if (tenantId == null || tenantId.isBlank()) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant context — authenticate before calling Multimodal service")
                .asRuntimeException());
            return;
        }
        try {
            LOG.debug("Analyzing video with audio extraction: {} for tenant={}",
                    request.getExtractAudio(), tenantId);

            VideoAudioResult result = engine.analyseVideoWithAudio(
                    request.getVideoData().toByteArray(),
                    request.getExtractAudio(),
                    request.getAnalyzeFrames(),
                    request.getFrameSampleRate() > 0 ? request.getFrameSampleRate() : 1);

            VideoAudioResponse.Builder responseBuilder = VideoAudioResponse.newBuilder()
                    .setCombinedNarrative(result.getCombinedNarrative());

            if (result.getAudioResult() != null && !result.getAudioResult().isError()) {
                responseBuilder
                        .setAudioTranscription(result.getAudioResult().getTranscription())
                        .setVideoSummary(result.getCombinedNarrative());
            }

            if (result.getVideoResult() != null && result.getVideoResult().getFrameResults() != null) {
                for (com.ghatana.audio.video.multimodal.engine.FrameResult fr
                        : result.getVideoResult().getFrameResults()) {
                    FrameAnalysis.Builder fa = FrameAnalysis.newBuilder()
                            .setTimestampMs(fr.getTimestampMs())
                            .setDescription("Frame " + fr.getFrameNumber() + " at "
                                    + fr.getTimestampMs() + "ms");
                    for (com.ghatana.audio.video.multimodal.engine.DetectionResult d
                            : fr.getDetections()) {
                        fa.addObjects(Detection.newBuilder()
                                .setClassName(d.getClassName())
                                .setConfidence(d.getConfidence())
                                .build());
                    }
                    responseBuilder.addFrameAnalyses(fa.build());
                }
            }

            responseObserver.onNext(responseBuilder.build());
            responseObserver.onCompleted();
            LOG.info("Video with audio analysis completed");

        } catch (Exception e) {
            LOG.error("Video with audio analysis failed", e);
            responseObserver.onError(toStatus(e, "Video-audio analysis failed").asRuntimeException());
        }
    }

    @Override
    public void generateDescription(DescriptionRequest request,
                                     StreamObserver<DescriptionResponse> responseObserver) {
        // AV-P1-008: Enforce tenant authentication
        String tenantId = resolveTenantId();
        if (tenantId == null || tenantId.isBlank()) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant context — authenticate before calling Multimodal service")
                .asRuntimeException());
            return;
        }
        try {
            LOG.debug("Generating description with style: {} for tenant={}",
                    request.getStyle(), tenantId);

            com.ghatana.audio.video.multimodal.engine.MultimodalRequest engineRequest =
                    com.ghatana.audio.video.multimodal.engine.MultimodalRequest.builder()
                            .audioData(request.getAudioData().isEmpty() ? null : request.getAudioData().toByteArray())
                            .imageData(request.getImageData().isEmpty() ? null : request.getImageData().toByteArray())
                            .text(request.getContext())
                            .build();

            MultimodalResult analysis = engine.analyse(engineRequest);

            List<String> keyElements = new ArrayList<>();
            if (analysis.getAudioResult() != null && !analysis.getAudioResult().isError()) {
                keyElements.add("speech");
            }
            if (analysis.getVisualResult() != null && !analysis.getVisualResult().isError()) {
                keyElements.add("visual");
            }
            if (!request.getContext().isEmpty()) {
                keyElements.add("context");
            }

            responseObserver.onNext(DescriptionResponse.newBuilder()
                    .setDescription(analysis.getCombinedAnalysis())
                    .setConfidence(keyElements.isEmpty() ? 0.0 : 0.85)
                    .addAllKeyElements(keyElements)
                    .build());
            responseObserver.onCompleted();
            LOG.info("Description generation completed");

        } catch (Exception e) {
            LOG.error("Description generation failed", e);
            responseObserver.onError(toStatus(e, "Description generation failed").asRuntimeException());
        }
    }

    // ── AV-004.4: analyzeCrossModal ────────────────────────────────────────

    @Override
    public void analyzeCrossModal(CrossModalRequest request,
                                   StreamObserver<CrossModalResponse> responseObserver) {
        // AV-P1-008: Enforce tenant authentication
        String tenantId = resolveTenantId();
        if (tenantId == null || tenantId.isBlank()) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant context — authenticate before calling Multimodal service")
                .asRuntimeException());
            return;
        }
        long startTime = System.currentTimeMillis();
        try {
            if (request.getAudioData().isEmpty() && request.getVideoData().isEmpty()) {
                responseObserver.onError(Status.INVALID_ARGUMENT
                    .withDescription("At least one of audio_data or video_data must be provided")
                    .asRuntimeException());
                return;
            }

            LOG.debug("Analyzing cross-modal alignment: audio={}, video={}",
                !request.getAudioData().isEmpty(), !request.getVideoData().isEmpty());

            // Analyse both modalities
            com.ghatana.audio.video.multimodal.engine.MultimodalRequest engineRequest =
                com.ghatana.audio.video.multimodal.engine.MultimodalRequest.builder()
                    .audioData(request.getAudioData().isEmpty() ? null : request.getAudioData().toByteArray())
                    .videoData(request.getVideoData().isEmpty() ? null : request.getVideoData().toByteArray())
                    .build();

            MultimodalResult result = engine.analyse(engineRequest);

            boolean hasAudio = result.getAudioResult() != null && !result.getAudioResult().isError();
            boolean hasVisual = result.getVisualResult() != null && !result.getVisualResult().isError();

            // Compute a simple alignment score: both modalities present and non-empty → high score
            double alignmentScore = 0.0;
            List<CrossModalEvent> events = new ArrayList<>();

            if (hasAudio && hasVisual) {
                // Heuristic alignment: check if audio mentions objects detected visually
                String transcription = result.getAudioResult().getTranscription().toLowerCase();
                String sceneDescription = result.getVisualResult().getSceneDescription().toLowerCase();

                // Count overlapping keywords
                String[] audioWords = transcription.split("\\s+");
                int matches = 0;
                for (String word : audioWords) {
                    if (word.length() > 3 && sceneDescription.contains(word)) {
                        matches++;
                    }
                }
                alignmentScore = Math.min(1.0, 0.5 + (matches * 0.1));

                events.add(CrossModalEvent.newBuilder()
                    .setTimestampMs(0)
                    .setEventType("sync")
                    .setDescription("Audio and visual streams aligned")
                    .setConfidence(alignmentScore)
                    .build());
            } else if (hasAudio) {
                alignmentScore = 0.4;
                events.add(CrossModalEvent.newBuilder()
                    .setTimestampMs(0)
                    .setEventType("mismatch")
                    .setDescription("Only audio stream available")
                    .setConfidence(0.4)
                    .build());
            } else if (hasVisual) {
                alignmentScore = 0.4;
                events.add(CrossModalEvent.newBuilder()
                    .setTimestampMs(0)
                    .setEventType("mismatch")
                    .setDescription("Only visual stream available")
                    .setConfidence(0.4)
                    .build());
            }

            long processingTime = System.currentTimeMillis() - startTime;
            String summary = String.format(
                "Cross-modal analysis: audio=%s, visual=%s, alignment=%.2f",
                hasAudio ? "present" : "absent",
                hasVisual ? "present" : "absent",
                alignmentScore);

            LOG.info("Cross-modal analysis completed: alignment={}, events={}",
                alignmentScore, events.size());
            responseObserver.onNext(CrossModalResponse.newBuilder()
                .setAlignmentScore(alignmentScore)
                .addAllEvents(events)
                .setSummary(summary)
                .setProcessingTimeMs(processingTime)
                .build());
            responseObserver.onCompleted();

        } catch (Exception e) {
            LOG.error("Cross-modal analysis failed", e);
            responseObserver.onError(toStatus(e, "Cross-modal analysis failed").asRuntimeException());
        }
    }

    // ── AV-004.5: getInsights ──────────────────────────────────────────────

    @Override
    public void getInsights(InsightsRequest request, StreamObserver<InsightsResponse> responseObserver) {
        // AV-P1-008: Enforce tenant authentication
        String tenantId = resolveTenantId();
        if (tenantId == null || tenantId.isBlank()) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant context — authenticate before calling Multimodal service")
                .asRuntimeException());
            return;
        }
        long startTime = System.currentTimeMillis();
        try {
            com.ghatana.audio.video.multimodal.engine.MultimodalRequest engineRequest =
                com.ghatana.audio.video.multimodal.engine.MultimodalRequest.builder()
                    .audioData(request.getAudioData().isEmpty() ? null : request.getAudioData().toByteArray())
                    .videoData(request.getVideoData().isEmpty() ? null : request.getVideoData().toByteArray())
                    .imageData(request.getImageData().isEmpty() ? null : request.getImageData().toByteArray())
                    .text(request.getText())
                    .build();

            MultimodalResult result = engine.analyse(engineRequest);

            InsightsResponse.Builder builder = InsightsResponse.newBuilder();
            List<String> topics = new ArrayList<>();
            List<String> entities = new ArrayList<>();
            List<String> actions = new ArrayList<>();

            // Extract audio insights
            if (result.getAudioResult() != null && !result.getAudioResult().isError()) {
                String transcription = result.getAudioResult().getTranscription();
                topics.add("speech");
                if (!transcription.isBlank()) {
                    // Simple NER heuristic: capitalized words as entities
                    for (String word : transcription.split("\\s+")) {
                        if (word.length() > 1 && Character.isUpperCase(word.charAt(0))) {
                            String clean = word.replaceAll("[^\\w]", "");
                            if (!clean.isBlank()) entities.add(clean);
                        }
                    }
                }

                // Simple sentiment based on transcription content
                String lower = transcription.toLowerCase();
                builder.setOverallSentiment(
                    lower.contains("good") || lower.contains("great") || lower.contains("happy") ? "positive"
                    : lower.contains("bad") || lower.contains("fail") || lower.contains("error") ? "negative"
                    : "neutral");
            }

            // Extract visual insights
            if (result.getVisualResult() != null && !result.getVisualResult().isError()) {
                topics.add("visual");
                String sceneDesc = result.getVisualResult().getSceneDescription();
                if (!sceneDesc.isBlank()) {
                    // Infer actions from scene description verbs
                    if (sceneDesc.contains("running") || sceneDesc.contains("walking")) {
                        actions.add("movement");
                    }
                    if (sceneDesc.contains("talking") || sceneDesc.contains("speaking")) {
                        actions.add("communication");
                    }
                }
            }

            // Text insights
            if (!request.getText().isBlank()) {
                topics.add("text");
            }

            // Build confidence scores
            builder.addAllTopics(topics)
                .addAllEntities(entities.stream().distinct().limit(10).toList())
                .addAllActions(actions)
                .putConfidenceScores("audio", result.getAudioResult() != null ? 0.85 : 0.0)
                .putConfidenceScores("visual", result.getVisualResult() != null ? 0.80 : 0.0)
                .putConfidenceScores("text", !request.getText().isBlank() ? 0.90 : 0.0)
                .setProcessingTimeMs(System.currentTimeMillis() - startTime);

            if (builder.getOverallSentiment().isBlank()) {
                builder.setOverallSentiment("neutral");
            }

            LOG.info("Insights extracted: topics={}, entities={}", topics.size(), entities.size());
            responseObserver.onNext(builder.build());
            responseObserver.onCompleted();

        } catch (Exception e) {
            LOG.error("Insights extraction failed", e);
            responseObserver.onError(toStatus(e, "Insights extraction failed").asRuntimeException());
        }
    }

    // ── AV-004.1: loadModel ────────────────────────────────────────────────

    @Override
    public void loadModel(LoadModelRequest request, StreamObserver<LoadModelResponse> responseObserver) {
        String modelId = request.getModelId();
        if (modelId == null || modelId.isBlank()) {
            responseObserver.onError(Status.INVALID_ARGUMENT
                .withDescription("modelId must not be blank")
                .asRuntimeException());
            return;
        }
        long startTime = System.currentTimeMillis();
        try {
            if (modelRegistry.findById(modelId).isEmpty()) {
                modelRegistry.register(ModelMetadata.builder()
                    .modelId(modelId).name(modelId)
                    .type(ModelMetadata.ModelType.MULTIMODAL)
                    .build());
            }
            modelRegistry.load(modelId);
            long loadTimeMs = System.currentTimeMillis() - startTime;

            LOG.info("Multimodal model loaded: {} in {}ms", modelId, loadTimeMs);
            responseObserver.onNext(LoadModelResponse.newBuilder()
                .setSuccess(true)
                .setMessage("Model loaded: " + modelId)
                .setModelId(modelId)
                .setLoadTimeMs(loadTimeMs)
                .build());
            responseObserver.onCompleted();
        } catch (ModelRegistry.ModelRegistryException e) {
            responseObserver.onError(Status.NOT_FOUND
                .withDescription("Model not found: " + modelId)
                .asRuntimeException());
        } catch (Exception e) {
            LOG.error("Error loading multimodal model {}: {}", modelId, e.getMessage(), e);
            responseObserver.onError(Status.INTERNAL
                .withDescription("Failed to load model: " + e.getMessage())
                .asRuntimeException());
        }
    }

    // ── AV-004.2: unloadModel ──────────────────────────────────────────────

    @Override
    public void unloadModel(UnloadModelRequest request, StreamObserver<UnloadModelResponse> responseObserver) {
        String modelId = request.getModelId();
        if (modelId == null || modelId.isBlank()) {
            responseObserver.onError(Status.INVALID_ARGUMENT
                .withDescription("modelId must not be blank")
                .asRuntimeException());
            return;
        }
        try {
            long freed = modelRegistry.unload(modelId);
            LOG.info("Multimodal model unloaded: {} (freed ~{} bytes)", modelId, freed);
            responseObserver.onNext(UnloadModelResponse.newBuilder()
                .setSuccess(true)
                .setMessage("Model unloaded: " + modelId)
                .setMemoryFreedBytes(freed)
                .build());
            responseObserver.onCompleted();
        } catch (ModelRegistry.ModelRegistryException e) {
            responseObserver.onError(Status.NOT_FOUND
                .withDescription("Model not registered: " + modelId)
                .asRuntimeException());
        } catch (Exception e) {
            LOG.error("Error unloading multimodal model {}: {}", modelId, e.getMessage(), e);
            responseObserver.onError(Status.INTERNAL
                .withDescription("Failed to unload model: " + e.getMessage())
                .asRuntimeException());
        }
    }

    // ── AV-004.3: listModels ───────────────────────────────────────────────

    @Override
    public void listModels(ListModelsRequest request, StreamObserver<ListModelsResponse> responseObserver) {
        try {
            List<ModelMetadata> models = modelRegistry.listModels(ModelMetadata.ModelType.MULTIMODAL);

            ListModelsResponse.Builder builder = ListModelsResponse.newBuilder();
            int loadedCount = 0;
            for (ModelMetadata m : models) {
                if (request.getIncludeLoadedOnly() && !m.loaded()) continue;
                if (m.loaded()) loadedCount++;

                builder.addModels(MultimodalModelInfo.newBuilder()
                    .setModelId(m.modelId())
                    .setName(m.name())
                    .setVersion(m.version())
                    .setIsLoaded(m.loaded())
                    .setSizeBytes(m.sizeBytes())
                    .addAllModalities(List.of("audio", "video", "image", "text"))
                    .build());
            }
            builder.setTotalCount(builder.getModelsCount());
            builder.setLoadedCount(loadedCount);

            LOG.debug("Listed {} multimodal models", builder.getTotalCount());
            responseObserver.onNext(builder.build());
            responseObserver.onCompleted();
        } catch (Exception e) {
            LOG.error("Failed to list multimodal models: {}", e.getMessage(), e);
            responseObserver.onError(Status.INTERNAL
                .withDescription("Failed to list models: " + e.getMessage())
                .asRuntimeException());
        }
    }

    @Override
    public void getStatus(StatusRequest request, StreamObserver<StatusResponse> responseObserver) {
        try {
            long count = requestCount.get();
            long totalTime = totalProcessingTime.get();
            double avgTime = count > 0 ? (double) totalTime / count : 0.0;

            responseObserver.onNext(StatusResponse.newBuilder()
                    .setStatus("healthy:" + platformAdapter.backendName())
                    .setTotalRequests(count)
                    .setAvgProcessingTimeMs(avgTime)
                    .build());
            responseObserver.onCompleted();

        } catch (Exception e) {
            LOG.error("Failed to get status", e);
            responseObserver.onError(e);
        }
    }

    @Override
    public void healthCheck(HealthCheckRequest request,
                             StreamObserver<HealthCheckResponse> responseObserver) {
        try {
            responseObserver.onNext(HealthCheckResponse.newBuilder()
                    .setHealthy(true)
                    .setMessage("Multimodal service is healthy")
                    .build());
            responseObserver.onCompleted();
        } catch (Exception e) {
            LOG.error("Health check failed", e);
            responseObserver.onError(e);
        }
    }

    private Status toStatus(Exception exception, String context) {
        AudioVideoProcessingError error = AudioVideoProcessingError.fromThrowable(context, exception);
        Status baseStatus = error.retryable() ? Status.UNAVAILABLE : Status.INTERNAL;
        if ("validation".equals(error.category())) {
            baseStatus = Status.INVALID_ARGUMENT;
        }
        return baseStatus.withDescription(error.code() + ": " + error.message());
    }

    // AV-P1-008: Extract tenant from gRPC Context set by JwtServerInterceptor
    private String resolveTenantId() {
        String tenantId = JwtServerInterceptor.CTX_TENANT.get();
        if (tenantId == null || tenantId.isBlank()) {
            LOG.warn("Tenant ID not found in gRPC Context — request may not be authenticated");
        }
        return tenantId;
    }
}
