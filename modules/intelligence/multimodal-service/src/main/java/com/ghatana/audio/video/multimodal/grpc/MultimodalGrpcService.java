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
import java.util.UUID;
import java.util.Set;
import java.util.function.BooleanSupplier;

/**
 * gRPC service implementation for multimodal audio+video analysis.
 *
 * @doc.type class
 * @doc.purpose gRPC service exposing multimodal STT+vision analysis over gRPC transport
 * @doc.layer product
 * @doc.pattern Service, Adapter
 */
public class MultimodalGrpcService extends MultimodalServiceGrpc.MultimodalServiceImplBase {

    private static final int MAX_MODALITY_BYTES = 32 * 1024 * 1024;
    private static final int MAX_TOTAL_INPUT_BYTES = 64 * 1024 * 1024;
    private static final int MAX_TEXT_CHARS = 64 * 1024;

    private static final Logger LOG = LoggerFactory.getLogger(MultimodalGrpcService.class);

    private final MultimodalAnalysisEngine engine;
    private final PlatformMultimodalAdapter platformAdapter;
    private final AtomicLong requestCount = new AtomicLong(0);
    private final AtomicLong totalProcessingTime = new AtomicLong(0);
    private final MediaProcessingMetrics mediaMetrics;
    private final ModelRegistry modelRegistry;
    private final SourceAuthorization sourceAuthorization;
    private volatile BooleanSupplier readinessProbe = () -> false;

    public MultimodalGrpcService() {
        this(MediaProcessingMetrics.create());
    }

    public MultimodalGrpcService(MediaProcessingMetrics metrics) {
        this(metrics, SourceAuthorization.unavailable());
    }

    MultimodalGrpcService(MediaProcessingMetrics metrics, SourceAuthorization sourceAuthorization) {
        this.platformAdapter = new PlatformMultimodalAdapter();
        this.engine = new MultimodalAnalysisEngine(platformAdapter);
        this.mediaMetrics = metrics;
        this.modelRegistry = new FileSystemModelStore();
        this.sourceAuthorization = java.util.Objects.requireNonNull(sourceAuthorization, "sourceAuthorization");
        LOG.info("Multimodal service initialized against platform audio-video library");
    }

    /**
     * Package-private constructor for unit testing — inject a pre-configured engine.
     * Avoids native-library and file-system dependencies during tests.
     */
    MultimodalGrpcService(MultimodalAnalysisEngine engine, PlatformMultimodalAdapter platformAdapter,
                          MediaProcessingMetrics metrics) {
        this(engine, platformAdapter, metrics, SourceAuthorization.unavailable());
    }

    MultimodalGrpcService(MultimodalAnalysisEngine engine, PlatformMultimodalAdapter platformAdapter,
                          MediaProcessingMetrics metrics, SourceAuthorization sourceAuthorization) {
        this.engine = engine;
        this.platformAdapter = platformAdapter;
        this.mediaMetrics = metrics;
        this.modelRegistry = new FileSystemModelStore();
        this.sourceAuthorization = java.util.Objects.requireNonNull(sourceAuthorization, "sourceAuthorization");
    }

    @Override
    public void processMultimodal(MultimodalRequest request, StreamObserver<MultimodalResponse> responseObserver) {
        requestCount.incrementAndGet();
        long startTime = System.currentTimeMillis();
        mediaMetrics.recordStarted("multimodal.analyse");

        // AV-P1-008: Enforce tenant authentication
        Identity identity = requireIdentity(responseObserver);
        if (identity == null) {
            mediaMetrics.recordFailed("multimodal.analyse");
            return;
        }

        if (!withinInputBounds(request.getAudioData().size(), request.getImageData().size(),
                request.getVideoData().size(), request.getText().length())) {
            responseObserver.onError(Status.INVALID_ARGUMENT.withDescription("Multimodal input exceeds configured limits")
                    .asRuntimeException());
            mediaMetrics.recordFailed("multimodal.analyse");
            return;
        }
        if (request.getAudioData().isEmpty() && request.getImageData().isEmpty()
                && request.getVideoData().isEmpty() && request.getText().isEmpty()) {
            responseObserver.onError(Status.INVALID_ARGUMENT.withDescription("At least one modality must be provided")
                    .asRuntimeException());
            mediaMetrics.recordFailed("multimodal.analyse");
            return;
        }
        if (!authorized(identity, modalities(!request.getAudioData().isEmpty(),
                !request.getImageData().isEmpty(), !request.getVideoData().isEmpty(), !request.getText().isEmpty()),
                request.getArtifactId(), request.getAudioData().size() + request.getImageData().size()
                        + request.getVideoData().size())) {
            responseObserver.onError(authorityUnavailable());
            mediaMetrics.recordFailed("multimodal.analyse");
            return;
        }
        String tenantId = identity.tenantId().toString();

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
        Identity identity = requireIdentity(responseObserver);
        if (identity == null) {
            return;
        }
        if (!withinInputBounds(0, 0, request.getVideoData().size(), 0)) {
            responseObserver.onError(Status.INVALID_ARGUMENT.withDescription("Multimodal input exceeds configured limits")
                    .asRuntimeException());
            return;
        }
        if (request.getVideoData().isEmpty()) {
            responseObserver.onError(Status.INVALID_ARGUMENT.withDescription("video_data must not be empty")
                    .asRuntimeException());
            return;
        }
        if (request.getFrameSampleRate() < 0 || request.getFrameSampleRate() > 60) {
            responseObserver.onError(Status.INVALID_ARGUMENT
                    .withDescription("frame_sample_rate must be between 0 and 60")
                    .asRuntimeException());
            return;
        }
        if (!authorized(identity, modalities(request.getExtractAudio(), false, request.getAnalyzeFrames(), false),
                null, request.getVideoData().size())) {
            responseObserver.onError(authorityUnavailable());
            return;
        }
        String tenantId = identity.tenantId().toString();
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
            List<com.ghatana.audio.video.multimodal.engine.TemporalAlignment> alignments =
                    result.getTemporalAlignments();
            boolean synchronizationMeasured = alignments != null && !alignments.isEmpty()
                    && alignments.stream()
                            .allMatch(com.ghatana.audio.video.multimodal.engine.TemporalAlignment
                                    ::hasSyncMeasurement);
            responseBuilder.setSynchronizationStatus(synchronizationMeasured
                    ? VideoAudioResponse.SynchronizationStatus.MEASURED
                    : VideoAudioResponse.SynchronizationStatus.SYNC_UNDETERMINED);

            if (result.getAudioResult() != null && !result.getAudioResult().isError()) {
                responseBuilder
                        .setAudioTranscription(result.getAudioResult().getTranscription())
                        .setVideoSummary(result.getCombinedNarrative());
            }

            if (result.getVideoResult() != null && result.getVideoResult().getFrameResults() != null) {
                for (com.ghatana.audio.video.multimodal.engine.FrameResult fr
                        : result.getVideoResult().getFrameResults()) {
                    FrameAnalysis.Builder fa = FrameAnalysis.newBuilder()
                            .setDescription(fr.hasTimestamp()
                                    ? "Frame " + fr.getFrameNumber() + " at " + fr.getTimestampMs() + "ms"
                                    : "Frame " + fr.getFrameNumber() + " at unknown source time");
                    if (fr.hasTimestamp()) {
                        var timestamp = fr.getTimestamp();
                        fa.setTimestampMs(fr.getTimestampMs())
                                .setTimestampStatus(FrameAnalysis.TimestampStatus.TIMESTAMP_STATUS_KNOWN)
                                .setTimeBaseNumerator(timestamp.timeBaseNumerator())
                                .setTimeBaseDenominator(timestamp.timeBaseDenominator())
                                .setClockDomain(toProtoClockDomain(timestamp.domain()));
                        if (timestamp.domain() == com.ghatana.audio.video.multimodal.engine
                                .MediaClockTimestamp.ClockDomain.SOURCE) {
                            fa.setSourcePts(timestamp.ticks());
                        }
                    } else {
                        fa.setTimestampStatus(FrameAnalysis.TimestampStatus.TIMESTAMP_STATUS_UNKNOWN)
                                .setTimestampUnknownReason(fr.getTimestamp().unknownReason());
                    }
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
        Identity identity = requireIdentity(responseObserver);
        if (identity == null) {
            return;
        }
        if (!withinInputBounds(request.getAudioData().size(), request.getImageData().size(), 0,
                request.getContext().length())) {
            responseObserver.onError(Status.INVALID_ARGUMENT.withDescription("Multimodal input exceeds configured limits")
                    .asRuntimeException());
            return;
        }
        if (request.getAudioData().isEmpty() && request.getImageData().isEmpty()
                && request.getContext().isEmpty()) {
            responseObserver.onError(Status.INVALID_ARGUMENT
                    .withDescription("Audio, image, or context input must be provided")
                    .asRuntimeException());
            return;
        }
        if (!authorized(identity, modalities(!request.getAudioData().isEmpty(),
                !request.getImageData().isEmpty(), false, !request.getContext().isEmpty()),
                null, request.getAudioData().size() + request.getImageData().size())) {
            responseObserver.onError(authorityUnavailable());
            return;
        }
        String tenantId = identity.tenantId().toString();
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
        Identity identity = requireIdentity(responseObserver);
        if (identity == null) {
            return;
        }
        if (!withinInputBounds(request.getAudioData().size(), 0, request.getVideoData().size(), 0)) {
            responseObserver.onError(Status.INVALID_ARGUMENT.withDescription("Multimodal input exceeds configured limits")
                    .asRuntimeException());
            return;
        }
        if (request.getAudioData().isEmpty() && request.getVideoData().isEmpty()) {
            responseObserver.onError(Status.INVALID_ARGUMENT
                    .withDescription("At least one of audio_data or video_data must be provided")
                    .asRuntimeException());
            return;
        }
        if (!authorized(identity, modalities(!request.getAudioData().isEmpty(), false,
                !request.getVideoData().isEmpty(), false), null,
                request.getAudioData().size() + request.getVideoData().size())) {
            responseObserver.onError(authorityUnavailable());
            return;
        }
        String tenantId = identity.tenantId().toString();
        long startTime = System.currentTimeMillis();
        try {
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

            // The current providers do not expose comparable source clocks or qualified
            // cross-modal features. A numeric heuristic must not masquerade as alignment.
            List<CrossModalEvent> events = List.of();

            long processingTime = System.currentTimeMillis() - startTime;
            String summary = String.format(
                "Cross-modal synchronization undetermined: audio=%s, visual=%s",
                hasAudio ? "present" : "absent",
                hasVisual ? "present" : "absent");

            LOG.info("Cross-modal synchronization remains undetermined: events={}", events.size());
            responseObserver.onNext(CrossModalResponse.newBuilder()
                .addAllEvents(events)
                .setSummary(summary)
                .setProcessingTimeMs(processingTime)
                .setSynchronizationStatus(CrossModalResponse.SynchronizationStatus.SYNC_UNDETERMINED)
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
        Identity identity = requireIdentity(responseObserver);
        if (identity == null) {
            return;
        }
        if (!withinInputBounds(request.getAudioData().size(), request.getImageData().size(),
                request.getVideoData().size(), request.getText().length())) {
            responseObserver.onError(Status.INVALID_ARGUMENT.withDescription("Multimodal input exceeds configured limits")
                    .asRuntimeException());
            return;
        }
        if (request.getAudioData().isEmpty() && request.getImageData().isEmpty()
                && request.getVideoData().isEmpty() && request.getText().isEmpty()) {
            responseObserver.onError(Status.INVALID_ARGUMENT.withDescription("At least one modality must be provided")
                    .asRuntimeException());
            return;
        }
        if (!authorized(identity, modalities(!request.getAudioData().isEmpty(),
                !request.getImageData().isEmpty(), !request.getVideoData().isEmpty(), !request.getText().isEmpty()),
                null, request.getAudioData().size() + request.getImageData().size()
                        + request.getVideoData().size())) {
            responseObserver.onError(authorityUnavailable());
            return;
        }
        String tenantId = identity.tenantId().toString();
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
                    .setStatus("NOT_ADMITTED")
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
            boolean ready = Boolean.TRUE.equals(readinessProbe.getAsBoolean());
            responseObserver.onNext(HealthCheckResponse.newBuilder()
                    .setHealthy(ready)
                    .setMessage(ready
                            ? "MULTIMODAL_READY"
                            : "MULTIMODAL_NOT_SERVING: qualified child provider readiness unavailable")
                    .build());
            responseObserver.onCompleted();
        } catch (Exception e) {
            LOG.error("Health check failed", e);
            responseObserver.onError(e);
        }
    }

    /** The modality adapters have no qualified STT provider readiness source yet. */
    boolean isSttProviderReady() {
        return false;
    }

    /** The modality adapters have no qualified Vision provider readiness source yet. */
    boolean isVisionProviderReady() {
        return false;
    }

    void setReadinessProbe(BooleanSupplier readinessProbe) {
        this.readinessProbe = java.util.Objects.requireNonNull(readinessProbe, "readinessProbe");
    }

    private Status toStatus(Exception exception, String context) {
        AudioVideoProcessingError error = AudioVideoProcessingError.fromThrowable(context, exception);
        Status baseStatus = error.retryable() ? Status.UNAVAILABLE : Status.INTERNAL;
        if ("validation".equals(error.category())) {
            baseStatus = Status.INVALID_ARGUMENT;
        }
        return baseStatus.withDescription(error.code() + ": " + error.message());
    }

    private Identity requireIdentity(StreamObserver<?> observer) {
        String tenant = JwtServerInterceptor.CTX_TENANT.get();
        String subject = JwtServerInterceptor.CTX_SUBJECT.get();
        try {
            if (tenant == null || subject == null || tenant.isBlank() || subject.isBlank()) {
                throw new IllegalArgumentException("missing identity");
            }
            return new Identity(tenant, UUID.fromString(subject));
        } catch (IllegalArgumentException invalidIdentity) {
            observer.onError(Status.UNAUTHENTICATED
                    .withDescription("Authenticated tenant and principal UUID are required")
                    .asRuntimeException());
            return null;
        }
    }

    private static boolean withinInputBounds(int audioBytes, int imageBytes, int videoBytes, int textChars) {
        long total = (long) audioBytes + imageBytes + videoBytes;
        return audioBytes <= MAX_MODALITY_BYTES && imageBytes <= MAX_MODALITY_BYTES
                && videoBytes <= MAX_MODALITY_BYTES && total <= MAX_TOTAL_INPUT_BYTES
                && textChars <= MAX_TEXT_CHARS;
    }

    private static RuntimeException authorityUnavailable() {
        return Status.UNAVAILABLE
                .withDescription("Trusted artifact rights, purpose, and consent authority is not configured")
                .asRuntimeException();
    }

    private boolean authorized(Identity identity, Set<SourceAuthorization.Modality> modalities,
                               String artifactId, long contentBytes) {
        SourceAuthorization.AuthorizationRequest authorizationRequest =
                new SourceAuthorization.AuthorizationRequest(identity.tenantId(), identity.principalId(),
                        modalities, artifactId, null, null, null, contentBytes);
        try {
            return sourceAuthorization.authorize(authorizationRequest) == SourceAuthorization.Decision.ADMITTED;
        } catch (RuntimeException unavailable) {
            return false;
        }
    }

    private static Set<SourceAuthorization.Modality> modalities(boolean audio, boolean image,
                                                                 boolean video, boolean text) {
        java.util.EnumSet<SourceAuthorization.Modality> result =
                java.util.EnumSet.noneOf(SourceAuthorization.Modality.class);
        if (audio) result.add(SourceAuthorization.Modality.AUDIO);
        if (image) result.add(SourceAuthorization.Modality.IMAGE);
        if (video) result.add(SourceAuthorization.Modality.VIDEO);
        if (text) result.add(SourceAuthorization.Modality.TEXT);
        return Set.copyOf(result);
    }

    private static FrameAnalysis.ClockDomain toProtoClockDomain(
            com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.ClockDomain domain) {
        return switch (domain) {
            case SOURCE -> FrameAnalysis.ClockDomain.SOURCE;
            case MEDIA -> FrameAnalysis.ClockDomain.MEDIA;
            case SIMULATION -> FrameAnalysis.ClockDomain.SIMULATION;
            case WALL -> FrameAnalysis.ClockDomain.WALL;
        };
    }

    private record Identity(String tenantId, UUID principalId) {}
}
