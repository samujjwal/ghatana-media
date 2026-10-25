package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audiovideo.observability.tracing.AudioVideoTracingService;
import com.ghatana.audio.video.multimodal.engine.AudioVideoProcessingError;
import com.ghatana.audio.video.multimodal.engine.MultimodalAnalysisEngine;
import com.ghatana.audio.video.multimodal.engine.PlatformMultimodalAdapter;
import com.ghatana.audio.video.multimodal.engine.MultimodalResult;
import com.ghatana.audio.video.multimodal.engine.VideoAudioResult;
import com.ghatana.audio.video.multimodal.grpc.proto.*;
import io.grpc.Status;
import io.grpc.stub.ServerCallStreamObserver;
import io.grpc.stub.StreamObserver;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicBoolean;
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
    private static final int MAX_ARTIFACT_REF_BYTES = 256;

    private static final Logger LOG = LoggerFactory.getLogger(MultimodalGrpcService.class);

    private final MultimodalAnalysisEngine engine;
    private final PlatformMultimodalAdapter platformAdapter;
    private final AtomicLong requestCount = new AtomicLong(0);
    private final AtomicLong totalProcessingTime = new AtomicLong(0);
    private final MediaProcessingMetrics mediaMetrics;
    private final SourceAuthorization sourceAuthorization;
    private final AudioVideoTracingService tracingService;
    private volatile BooleanSupplier readinessProbe = () -> false;

    public MultimodalGrpcService() {
        this(MediaProcessingMetrics.create());
    }

    public MultimodalGrpcService(MediaProcessingMetrics metrics) {
        this(metrics, SourceAuthorization.unavailable());
    }

    MultimodalGrpcService(MediaProcessingMetrics metrics, SourceAuthorization sourceAuthorization) {
        this(metrics, sourceAuthorization, defaultTracingService());
    }

    MultimodalGrpcService(MediaProcessingMetrics metrics, SourceAuthorization sourceAuthorization,
                          AudioVideoTracingService tracingService) {
        this.platformAdapter = new PlatformMultimodalAdapter();
        this.engine = new MultimodalAnalysisEngine(platformAdapter);
        this.mediaMetrics = metrics;
        this.sourceAuthorization = java.util.Objects.requireNonNull(sourceAuthorization, "sourceAuthorization");
        this.tracingService = java.util.Objects.requireNonNull(tracingService, "tracingService");
        LOG.info("Multimodal service initialized with backend={}", platformAdapter.backendName());
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
        this(engine, platformAdapter, metrics, sourceAuthorization, defaultTracingService());
    }

    MultimodalGrpcService(MultimodalAnalysisEngine engine, PlatformMultimodalAdapter platformAdapter,
                          MediaProcessingMetrics metrics, SourceAuthorization sourceAuthorization,
                          AudioVideoTracingService tracingService) {
        this.engine = engine;
        this.platformAdapter = platformAdapter;
        this.mediaMetrics = metrics;
        this.sourceAuthorization = java.util.Objects.requireNonNull(sourceAuthorization, "sourceAuthorization");
        this.tracingService = java.util.Objects.requireNonNull(tracingService, "tracingService");
    }

    private static AudioVideoTracingService defaultTracingService() {
        return new AudioVideoTracingService(GlobalOpenTelemetry.getTracer("ghatana-media-multimodal"));
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
        if (utf8Length(request.getArtifactId()) > MAX_ARTIFACT_REF_BYTES) {
            responseObserver.onError(Status.INVALID_ARGUMENT.withDescription("Artifact reference exceeds configured limit")
                    .asRuntimeException());
            mediaMetrics.recordFailed("multimodal.analyse");
            return;
        }
        if (!authorized(identity, modalities(!request.getAudioData().isEmpty(),
                !request.getImageData().isEmpty(), !request.getVideoData().isEmpty(), !request.getText().isEmpty()),
                request.getArtifactId(), request.getAudioData().size() + request.getImageData().size()
                        + request.getVideoData().size() + utf8Length(request.getText()), "multimodal.analyse")) {
            responseObserver.onError(authorityUnavailable());
            mediaMetrics.recordFailed("multimodal.analyse");
            return;
        }
        if (!hasCanonicalCapabilityBinding()) {
            responseObserver.onError(multimodalFamilyNotAdmitted());
            mediaMetrics.recordFailed("multimodal.analyse");
            return;
        }
        TracedObserver<MultimodalResponse> trace = traceAnalysis("multimodal.analyse", identity.tenantId(), responseObserver);
        responseObserver = trace.observer();
        try {
            LOG.debug("Processing multimodal request with {} analysis types",
                    request.getAnalysisTypesList().size());

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

            MultimodalResult result;
            try (Scope ignored = trace.makeCurrent()) {
                result = engine.analyse(engineRequest);
            }
            if (trace.isCancelledOrTerminal()) {
                trace.finishUnknown();
                return;
            }

            if ((!request.getAudioData().isEmpty() && (result.getAudioResult() == null
                    || result.getAudioResult().isError()))
                    || ((!request.getImageData().isEmpty() || !request.getVideoData().isEmpty())
                    && (result.getVisualResult() == null || result.getVisualResult().isError()))) {
                responseObserver.onError(Status.UNAVAILABLE.withDescription(
                        "A requested multimodal provider did not produce a result").asRuntimeException());
                mediaMetrics.recordFailed("multimodal.analyse");
                return;
            }

            MultimodalResponse.Builder responseBuilder = MultimodalResponse.newBuilder()
                    .setCombinedAnalysis(result.getCombinedAnalysis())
                    .setProcessingTimeMs(result.getProcessingTimeMs());

            if (result.getAudioResult() != null && !result.getAudioResult().isError()) {
                AudioAnalysis.Builder audioAnalysis = AudioAnalysis.newBuilder()
                        .setTranscription(result.getAudioResult().getTranscription());
                if (result.getAudioResult().hasConfidence()) {
                    audioAnalysis.setConfidence(result.getAudioResult().getConfidence());
                }
                responseBuilder.setAudioAnalysis(audioAnalysis.build());
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
                    .putMetadata("audio_confidence_available", String.valueOf(
                            result.getAudioResult() != null && result.getAudioResult().hasConfidence()))
                    .putMetadata("audio_confidence_source_calibration", result.getAudioResult() == null
                            ? "UNKNOWN" : result.getAudioResult().getConfidenceCalibration().name())
                    .putMetadata("has_visual", String.valueOf(result.getVisualResult() != null))
                    .putMetadata("visual_confidence_available", String.valueOf(
                            result.getVisualResult() != null && result.getVisualResult().getConfidence() != null))
                    .putMetadata("has_text", String.valueOf(!request.getText().isEmpty()))
                    .putMetadata("processing_backend", platformAdapter.backendName())
                    .putMetadata("platform_metrics_enabled", String.valueOf(platformAdapter.metricsEnabled()));

            if (trace.completeResponse(responseBuilder.build(), () -> {
                totalProcessingTime.addAndGet(result.getProcessingTimeMs());
                mediaMetrics.recordSucceeded("multimodal.analyse", System.currentTimeMillis() - startTime);
            })) {
                LOG.info("Multimodal processing completed in {}ms", result.getProcessingTimeMs());
            }

        } catch (Exception e) {
            LOG.warn("Multimodal processing failed ({})", e.getClass().getSimpleName());
            mediaMetrics.recordFailed("multimodal.analyse");
            responseObserver.onError(safeFailureStatus(e, "Multimodal processing failed").asRuntimeException());
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
        if (!request.getExtractAudio() && !request.getAnalyzeFrames()) {
            responseObserver.onError(Status.INVALID_ARGUMENT
                    .withDescription("At least one of extract_audio or analyze_frames must be enabled")
                    .asRuntimeException());
            return;
        }
        if (!authorized(identity, modalities(request.getExtractAudio(), false, true, false),
                null, request.getVideoData().size(), "multimodal.video-audio-analysis")) {
            responseObserver.onError(authorityUnavailable());
            return;
        }
        if (!hasCanonicalCapabilityBinding()) {
            responseObserver.onError(multimodalFamilyNotAdmitted());
            return;
        }
        TracedObserver<VideoAudioResponse> trace = traceAnalysis(
                "multimodal.video-audio-analysis", identity.tenantId(), responseObserver);
        responseObserver = trace.observer();
        try {
            LOG.debug("Analyzing video with audio extraction: {}", request.getExtractAudio());

            VideoAudioResult result;
            try (Scope ignored = trace.makeCurrent()) {
                result = engine.analyseVideoWithAudio(
                        request.getVideoData().toByteArray(),
                        request.getExtractAudio(),
                        request.getAnalyzeFrames(),
                        request.getFrameSampleRate() > 0 ? request.getFrameSampleRate() : 1);
            }
            if (trace.isCancelledOrTerminal()) {
                trace.finishUnknown();
                return;
            }

            if ((request.getExtractAudio() && (result.getAudioResult() == null
                    || result.getAudioResult().isError()))
                    || (request.getAnalyzeFrames() && (result.getVideoResult() == null
                    || result.getVideoResult().isError()))) {
                responseObserver.onError(Status.UNAVAILABLE
                        .withDescription("A requested multimodal provider did not produce a result")
                        .asRuntimeException());
                return;
            }

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

            trace.completeResponse(responseBuilder.build(), () -> { });
            LOG.info("Video with audio analysis completed");

        } catch (Exception e) {
            LOG.warn("Video with audio analysis failed ({})", e.getClass().getSimpleName());
            responseObserver.onError(safeFailureStatus(e, "Video-audio analysis failed").asRuntimeException());
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
                null, request.getAudioData().size() + request.getImageData().size()
                        + utf8Length(request.getContext()), "multimodal.description")) {
            responseObserver.onError(authorityUnavailable());
            return;
        }
        if (!hasCanonicalCapabilityBinding()) {
            responseObserver.onError(multimodalFamilyNotAdmitted());
            return;
        }
        if (request.getAudioData().isEmpty() && request.getImageData().isEmpty()) {
            responseObserver.onError(Status.UNAVAILABLE
                    .withDescription("No qualified modality provider can ground a description from context alone")
                    .asRuntimeException());
            return;
        }
        TracedObserver<DescriptionResponse> trace = traceAnalysis(
                "multimodal.description", identity.tenantId(), responseObserver);
        responseObserver = trace.observer();
        try {
            LOG.debug("Generating description with style: {}", request.getStyle());

            com.ghatana.audio.video.multimodal.engine.MultimodalRequest engineRequest =
                    com.ghatana.audio.video.multimodal.engine.MultimodalRequest.builder()
                            .audioData(request.getAudioData().isEmpty() ? null : request.getAudioData().toByteArray())
                            .imageData(request.getImageData().isEmpty() ? null : request.getImageData().toByteArray())
                            .text(request.getContext())
                            .build();

            MultimodalResult analysis;
            try (Scope ignored = trace.makeCurrent()) {
                analysis = engine.analyse(engineRequest);
            }
            if (trace.isCancelledOrTerminal()) {
                trace.finishUnknown();
                return;
            }

            if ((!request.getAudioData().isEmpty() && (analysis.getAudioResult() == null
                    || analysis.getAudioResult().isError()))
                    || (!request.getImageData().isEmpty() && (analysis.getVisualResult() == null
                    || analysis.getVisualResult().isError()))) {
                responseObserver.onError(Status.UNAVAILABLE
                        .withDescription("A requested multimodal provider did not produce a result")
                        .asRuntimeException());
                return;
            }

            List<String> keyElements = new ArrayList<>();
            if (analysis.getAudioResult() != null && !analysis.getAudioResult().isError()) {
                keyElements.add("speech");
            }
            if (analysis.getVisualResult() != null && !analysis.getVisualResult().isError()) {
                keyElements.add("visual");
            }
            trace.completeResponse(DescriptionResponse.newBuilder()
                    .setDescription(analysis.getCombinedAnalysis())
                    .setConfidence(0.0)
                    .addAllKeyElements(keyElements)
                    .build(), () -> { });
            LOG.info("Description generation completed");

        } catch (Exception e) {
            LOG.warn("Description generation failed ({})", e.getClass().getSimpleName());
            responseObserver.onError(safeFailureStatus(e, "Description generation failed").asRuntimeException());
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
        if (request.getAudioData().isEmpty() || request.getVideoData().isEmpty()) {
            responseObserver.onError(Status.INVALID_ARGUMENT
                    .withDescription("Both audio_data and video_data are required for cross-modal analysis")
                    .asRuntimeException());
            return;
        }
        if (!authorized(identity, modalities(!request.getAudioData().isEmpty(), false,
                !request.getVideoData().isEmpty(), false), null,
                request.getAudioData().size() + request.getVideoData().size(), "multimodal.cross-modal-analysis")) {
            responseObserver.onError(authorityUnavailable());
            return;
        }
        if (!hasCanonicalCapabilityBinding()) {
            responseObserver.onError(multimodalFamilyNotAdmitted());
            return;
        }
        long startTime = System.currentTimeMillis();
        TracedObserver<CrossModalResponse> trace = traceAnalysis(
                "multimodal.cross-modal-analysis", identity.tenantId(), responseObserver);
        responseObserver = trace.observer();
        try {
            LOG.debug("Analyzing cross-modal alignment: audio={}, video={}",
                !request.getAudioData().isEmpty(), !request.getVideoData().isEmpty());

            // Analyse both modalities
            com.ghatana.audio.video.multimodal.engine.MultimodalRequest engineRequest =
                com.ghatana.audio.video.multimodal.engine.MultimodalRequest.builder()
                    .audioData(request.getAudioData().isEmpty() ? null : request.getAudioData().toByteArray())
                    .videoData(request.getVideoData().isEmpty() ? null : request.getVideoData().toByteArray())
                    .build();

            MultimodalResult result;
            try (Scope ignored = trace.makeCurrent()) {
                result = engine.analyse(engineRequest);
            }
            if (trace.isCancelledOrTerminal()) {
                trace.finishUnknown();
                return;
            }

            boolean hasAudio = result.getAudioResult() != null && !result.getAudioResult().isError();
            boolean hasVisual = result.getVisualResult() != null && !result.getVisualResult().isError();
            if (( !request.getAudioData().isEmpty() && !hasAudio)
                    || (!request.getVideoData().isEmpty() && !hasVisual)) {
                responseObserver.onError(Status.UNAVAILABLE
                        .withDescription("A requested multimodal provider did not produce a result")
                        .asRuntimeException());
                return;
            }

            // The current providers do not expose comparable source clocks or qualified
            // cross-modal features. A numeric heuristic must not masquerade as alignment.
            List<CrossModalEvent> events = List.of();

            long processingTime = System.currentTimeMillis() - startTime;
            String summary = String.format(
                "Cross-modal synchronization undetermined: audio=%s, visual=%s",
                hasAudio ? "present" : "absent",
                hasVisual ? "present" : "absent");

            LOG.info("Cross-modal synchronization remains undetermined: events={}", events.size());
            trace.completeResponse(CrossModalResponse.newBuilder()
                .addAllEvents(events)
                .setSummary(summary)
                .setProcessingTimeMs(processingTime)
                .setSynchronizationStatus(CrossModalResponse.SynchronizationStatus.SYNC_UNDETERMINED)
                .build(), () -> { });

        } catch (Exception e) {
            LOG.warn("Cross-modal analysis failed ({})", e.getClass().getSimpleName());
            responseObserver.onError(safeFailureStatus(e, "Cross-modal analysis failed").asRuntimeException());
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
                        + request.getVideoData().size() + utf8Length(request.getText()), "multimodal.insights")) {
            responseObserver.onError(authorityUnavailable());
            return;
        }
        // The current STT/Vision results do not expose claim-level source references,
        // calibrated semantic confidence, or a qualified insights provider. Heuristic
        // sentiment, entity, and action extraction would turn unversioned observations
        // into unsupported claims. Fail before dispatching modality providers until the
        // source-grounded insights contract is implemented.
        responseObserver.onError(Status.UNAVAILABLE
                .withDescription("No qualified source-grounded semantic provider is available for insights")
                .asRuntimeException());
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
        responseObserver.onError(modelProviderUnavailable());
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
        responseObserver.onError(modelProviderUnavailable());
    }

    // ── AV-004.3: listModels ───────────────────────────────────────────────

    @Override
    public void listModels(ListModelsRequest request, StreamObserver<ListModelsResponse> responseObserver) {
        responseObserver.onError(modelProviderUnavailable());
    }

    private static RuntimeException modelProviderUnavailable() {
        return Status.UNAVAILABLE
                .withDescription("Qualified multimodal model provider is unavailable")
                .asRuntimeException();
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
            LOG.warn("Failed to get status ({})", e.getClass().getSimpleName());
            responseObserver.onError(Status.INTERNAL
                    .withDescription("Status could not be retrieved")
                    .asRuntimeException());
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
            LOG.warn("Health check failed ({})", e.getClass().getSimpleName());
            responseObserver.onError(Status.INTERNAL
                    .withDescription("Health status could not be determined")
                    .asRuntimeException());
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

    private Status safeFailureStatus(Exception exception, String context) {
        Status classified = toStatus(exception, context);
        String message = exception instanceof IllegalArgumentException
                ? "Request validation failed"
                : "Analysis could not be completed";
        return classified.withDescription(message);
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

    private static boolean hasCanonicalCapabilityBinding() {
        // All four public family requests lack canonical operation/version/purpose binding fields.
        // Keep every family route closed until those contracts provide the required binding.
        return false;
    }

    private static RuntimeException multimodalFamilyNotAdmitted() {
        return Status.FAILED_PRECONDITION
                .withDescription("MULTIMODAL_FAMILY_NOT_ADMITTED: request/result is not bound to canonical capability operations")
                .asRuntimeException();
    }

    private boolean authorized(Identity identity, Set<SourceAuthorization.Modality> modalities,
                               String artifactId, long contentBytes, String purpose) {
        SourceAuthorization.AuthorizationRequest authorizationRequest =
                new SourceAuthorization.AuthorizationRequest(identity.tenantId(), identity.principalId(),
                        modalities, artifactId, null, purpose, null, contentBytes);
        try {
            return sourceAuthorization.authorize(authorizationRequest) == SourceAuthorization.Decision.ADMITTED;
        } catch (RuntimeException unavailable) {
            return false;
        }
    }

    private static int utf8Length(String value) {
        return value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
    }

    private <T> TracedObserver<T> traceAnalysis(String operation, String tenantId,
                                                StreamObserver<T> observer) {
        return new TracedObserver<>(observer,
                tracingService.startMultimodalAnalysisSpan(operation, tenantId));
    }

    /** One bounded application span for an actual engine dispatch and its terminal RPC callback. */
    private final class TracedObserver<T> implements StreamObserver<T> {
        private final StreamObserver<T> delegate;
        private final Span span;
        private final Context context;
        private final long startedNanos = System.nanoTime();
        private final Object callbackLock = new Object();
        private boolean terminal;

        private TracedObserver(StreamObserver<T> delegate, Span span) {
            this.delegate = java.util.Objects.requireNonNull(delegate, "delegate");
            this.span = java.util.Objects.requireNonNull(span, "span");
            this.context = Context.current().with(span);
            if (delegate instanceof ServerCallStreamObserver<?> serverObserver) {
                serverObserver.setOnCancelHandler(this::finishUnknown);
            }
        }

        private StreamObserver<T> observer() {
            return this;
        }

        private Scope makeCurrent() {
            return context.makeCurrent();
        }

        @Override
        public void onNext(T value) {
            synchronized (callbackLock) {
                if (terminal) {
                    return;
                }
                try (Scope ignored = context.makeCurrent()) {
                    try {
                        delegate.onNext(value);
                    } catch (RuntimeException | Error observerFailure) {
                        terminal = true;
                        finishUnknownWhileCurrent();
                        throw observerFailure;
                    }
                }
            }
        }

        @Override
        public void onError(Throwable error) {
            synchronized (callbackLock) {
                if (terminal) {
                    return;
                }
                terminal = true;
                try (Scope ignored = context.makeCurrent()) {
                    try {
                        delegate.onError(error);
                    } finally {
                        tracingService.recordError(span, asException(error), elapsedMillis());
                    }
                }
            }
        }

        @Override
        public void onCompleted() {
            synchronized (callbackLock) {
                if (terminal) {
                    return;
                }
                terminal = true;
                try (Scope ignored = context.makeCurrent()) {
                    try {
                        delegate.onCompleted();
                    } catch (RuntimeException | Error callbackFailure) {
                        finishUnknownWhileCurrent();
                        throw callbackFailure;
                    }
                    tracingService.recordSuccess(span, elapsedMillis());
                }
            }
        }

        private void finishUnknown() {
            synchronized (callbackLock) {
                if (terminal) {
                    return;
                }
                terminal = true;
                try (Scope ignored = context.makeCurrent()) {
                    finishUnknownWhileCurrent();
                }
            }
        }

        private boolean isCancelledOrTerminal() {
            synchronized (callbackLock) {
                if (terminal) {
                    return true;
                }
            }
            return delegate instanceof ServerCallStreamObserver<?> serverObserver
                    && serverObserver.isCancelled();
        }

        /** Serialize final delivery, success span closure, and success metrics with cancellation. */
        private boolean completeResponse(T value, Runnable recordSuccess) {
            synchronized (callbackLock) {
                if (terminal) {
                    return false;
                }
                if (transportCancelled()) {
                    terminal = true;
                    try (Scope ignored = context.makeCurrent()) {
                        finishUnknownWhileCurrent();
                    }
                    return false;
                }
                try (Scope ignored = context.makeCurrent()) {
                    try {
                        delegate.onNext(value);
                    } catch (RuntimeException | Error observerFailure) {
                        terminal = true;
                        finishUnknownWhileCurrent();
                        throw observerFailure;
                    }
                    if (terminal || transportCancelled()) {
                        if (!terminal) {
                            terminal = true;
                            finishUnknownWhileCurrent();
                        }
                        return false;
                    }
                    try {
                        delegate.onCompleted();
                    } catch (RuntimeException | Error observerFailure) {
                        terminal = true;
                        finishUnknownWhileCurrent();
                        throw observerFailure;
                    }
                    if (terminal || transportCancelled()) {
                        if (!terminal) {
                            terminal = true;
                            finishUnknownWhileCurrent();
                        }
                        return false;
                    }
                    terminal = true;
                    tracingService.recordSuccess(span, elapsedMillis());
                    recordSuccess.run();
                    return true;
                }
            }
        }

        private boolean transportCancelled() {
            return delegate instanceof ServerCallStreamObserver<?> serverObserver
                    && serverObserver.isCancelled();
        }

        private void finishUnknownWhileCurrent() {
            terminal = true;
            try {
                span.setAttribute("media.outcome", "unknown");
                span.setAttribute("duration.ms", elapsedMillis());
            } finally {
                span.end();
            }
        }

        private long elapsedMillis() {
            return java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos);
        }

        private Exception asException(Throwable error) {
            if (error instanceof Exception exception) {
                return exception;
            }
            return new RuntimeException("Multimodal analysis failed", error);
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
