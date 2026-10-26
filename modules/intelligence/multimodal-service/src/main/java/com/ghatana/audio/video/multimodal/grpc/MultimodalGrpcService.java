package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.media.runtime.MediaProcessingRuntimePort;

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
import java.util.concurrent.Callable;

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
    private static final String CAP_OBSERVE = "media.multimodal.observe.source-grounded";
    private static final String OP_OBSERVE = "media.operation.capability.media-multimodal-observe-source-grounded";
    private static final String CAP_RELATE = "media.multimodal.relate.scene-audio";
    private static final String OP_RELATE = "media.operation.capability.media-multimodal-relate-scene-audio";
    private static final String CAP_DESCRIBE = "media.multimodal.describe";
    private static final String OP_DESCRIBE = "media.operation.capability.media-multimodal-describe";
    private static final String CAP_CROSS_MODAL = "media.multimodal.analyze.cross-modal";
    private static final String OP_CROSS_MODAL = "media.operation.capability.media-multimodal-analyze-cross-modal";
    private static final String CAP_SUMMARIZE = "media.multimodal.summarize";
    private static final String OP_SUMMARIZE = "media.operation.capability.media-multimodal-summarize";
    private static final String CAP_EXTRACT = "media.multimodal.extract.structured";
    private static final String OP_EXTRACT = "media.operation.capability.media-multimodal-extract-structured";

    private static final Logger LOG = LoggerFactory.getLogger(MultimodalGrpcService.class);

    private final MultimodalAnalysisEngine engine;
    private final PlatformMultimodalAdapter platformAdapter;
    private final AtomicLong requestCount = new AtomicLong(0);
    private final AtomicLong totalProcessingTime = new AtomicLong(0);
    private final MediaProcessingMetrics mediaMetrics;
    private final SourceAuthorization sourceAuthorization;
    private final MediaProcessingRuntimePort mediaRuntimePort;
    private final CanonicalOperationExecutor canonicalOperationExecutor;
    private final AudioVideoTracingService tracingService;
    private volatile BooleanSupplier readinessProbe = () -> false;

    public MultimodalGrpcService() {
        this(MediaProcessingMetrics.create());
    }

    public MultimodalGrpcService(MediaProcessingMetrics metrics) {
        this(metrics, SourceAuthorization.unavailable(), defaultTracingService(), null);
    }

    /** Runtime integration seam; unbound RPC inputs remain unavailable until canonical envelopes exist. */
    public MultimodalGrpcService(MediaProcessingMetrics metrics, MediaProcessingRuntimePort mediaRuntimePort) {
        this(metrics, SourceAuthorization.unavailable(), mediaRuntimePort);
    }

    MultimodalGrpcService(MediaProcessingMetrics metrics, SourceAuthorization sourceAuthorization) {
        this(metrics, sourceAuthorization, defaultTracingService(), null);
    }

    private MultimodalGrpcService(MediaProcessingMetrics metrics, SourceAuthorization sourceAuthorization,
                                  MediaProcessingRuntimePort mediaRuntimePort) {
        this(metrics, sourceAuthorization, defaultTracingService(), mediaRuntimePort);
    }

    MultimodalGrpcService(MediaProcessingMetrics metrics, SourceAuthorization sourceAuthorization,
                          AudioVideoTracingService tracingService) {
        this(metrics, sourceAuthorization, tracingService, null);
    }

    private MultimodalGrpcService(MediaProcessingMetrics metrics, SourceAuthorization sourceAuthorization,
                                  AudioVideoTracingService tracingService,
                                  MediaProcessingRuntimePort mediaRuntimePort) {
        this.platformAdapter = new PlatformMultimodalAdapter();
        this.engine = new MultimodalAnalysisEngine(platformAdapter);
        this.mediaMetrics = metrics;
        this.sourceAuthorization = java.util.Objects.requireNonNull(sourceAuthorization, "sourceAuthorization");
        this.tracingService = java.util.Objects.requireNonNull(tracingService, "tracingService");
        this.mediaRuntimePort = mediaRuntimePort;
        this.canonicalOperationExecutor = null;
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
                          MediaProcessingMetrics metrics, MediaProcessingRuntimePort mediaRuntimePort) {
        this(engine, platformAdapter, metrics, SourceAuthorization.unavailable(), defaultTracingService(),
                mediaRuntimePort);
    }

    MultimodalGrpcService(MultimodalAnalysisEngine engine, PlatformMultimodalAdapter platformAdapter,
                          MediaProcessingMetrics metrics, SourceAuthorization sourceAuthorization) {
        this(engine, platformAdapter, metrics, sourceAuthorization, defaultTracingService());
    }

    MultimodalGrpcService(MultimodalAnalysisEngine engine, PlatformMultimodalAdapter platformAdapter,
                          MediaProcessingMetrics metrics, SourceAuthorization sourceAuthorization,
                          CanonicalOperationExecutor canonicalOperationExecutor) {
        this(engine, platformAdapter, metrics, sourceAuthorization, defaultTracingService(),
                canonicalOperationExecutor);
    }

    MultimodalGrpcService(MultimodalAnalysisEngine engine, PlatformMultimodalAdapter platformAdapter,
                          MediaProcessingMetrics metrics, SourceAuthorization sourceAuthorization,
                          AudioVideoTracingService tracingService) {
        this(engine, platformAdapter, metrics, sourceAuthorization, tracingService,
                (MediaProcessingRuntimePort) null);
    }

    private MultimodalGrpcService(MultimodalAnalysisEngine engine, PlatformMultimodalAdapter platformAdapter,
                                  MediaProcessingMetrics metrics, SourceAuthorization sourceAuthorization,
                                  AudioVideoTracingService tracingService,
                                  MediaProcessingRuntimePort mediaRuntimePort) {
        this.engine = engine;
        this.platformAdapter = platformAdapter;
        this.mediaMetrics = metrics;
        this.sourceAuthorization = java.util.Objects.requireNonNull(sourceAuthorization, "sourceAuthorization");
        this.tracingService = java.util.Objects.requireNonNull(tracingService, "tracingService");
        this.mediaRuntimePort = mediaRuntimePort;
        this.canonicalOperationExecutor = null;
    }

    /** Test-only executor seam; production constructors remain unbound and fail closed. */
    MultimodalGrpcService(MultimodalAnalysisEngine engine, PlatformMultimodalAdapter platformAdapter,
                          MediaProcessingMetrics metrics, SourceAuthorization sourceAuthorization,
                          AudioVideoTracingService tracingService,
                          CanonicalOperationExecutor canonicalOperationExecutor) {
        this.engine = java.util.Objects.requireNonNull(engine, "engine");
        this.platformAdapter = java.util.Objects.requireNonNull(platformAdapter, "platformAdapter");
        this.mediaMetrics = java.util.Objects.requireNonNull(metrics, "metrics");
        this.sourceAuthorization = java.util.Objects.requireNonNull(sourceAuthorization, "sourceAuthorization");
        this.tracingService = java.util.Objects.requireNonNull(tracingService, "tracingService");
        this.mediaRuntimePort = null;
        this.canonicalOperationExecutor = java.util.Objects.requireNonNull(
                canonicalOperationExecutor, "canonicalOperationExecutor");
    }

    MediaProcessingRuntimePort mediaRuntimePort() { return mediaRuntimePort; }

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
                request.getVideoData().size(), utf8Length(request.getText()))) {
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
        if (!canonicalSelection(request.getOperationBinding(), CAP_OBSERVE, OP_OBSERVE)
                || (!request.getArtifactId().isBlank()
                && !request.getArtifactId().equals(request.getOperationBinding().getSourceArtifactId()))) {
            responseObserver.onError(multimodalFamilyNotAdmitted());
            mediaMetrics.recordFailed("multimodal.analyse");
            return;
        }
        RuntimeException authorizationFailure = authorizationFailure(identity, request.getOperationBinding(), modalities(!request.getAudioData().isEmpty(),
                !request.getImageData().isEmpty(), !request.getVideoData().isEmpty(), !request.getText().isEmpty()),
                request.getAudioData().size() + request.getImageData().size()
                        + request.getVideoData().size() + utf8Length(request.getText()),
                requestContentDigest(List.of(request.getAudioData(), request.getImageData(), request.getVideoData()),
                        request.getText()));
        if (authorizationFailure != null) {
            responseObserver.onError(authorizationFailure);
            mediaMetrics.recordFailed("multimodal.analyse");
            return;
        }
        if (!canonicalOperationExecutionAvailable()) {
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
                result = executeCanonical(request.getOperationBinding(), OP_OBSERVE,
                        () -> engine.analyse(engineRequest));
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
        if (!canonicalSelection(request.getOperationBinding(), CAP_RELATE, OP_RELATE)) {
            responseObserver.onError(multimodalFamilyNotAdmitted());
            return;
        }
        RuntimeException authorizationFailure = authorizationFailure(identity, request.getOperationBinding(),
                modalities(request.getExtractAudio(), false, true, false), request.getVideoData().size(),
                requestContentDigest(List.of(request.getVideoData()), ""));
        if (authorizationFailure != null) {
            responseObserver.onError(authorizationFailure);
            return;
        }
        if (!canonicalOperationExecutionAvailable()) {
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
                result = executeCanonical(request.getOperationBinding(), OP_RELATE, () ->
                        engine.analyseVideoWithAudio(
                        request.getVideoData().toByteArray(),
                        request.getExtractAudio(),
                        request.getAnalyzeFrames(),
                        request.getFrameSampleRate() > 0 ? request.getFrameSampleRate() : 1));
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
                    responseBuilder.addFrameAnalyses(toFrameAnalysis(fr));
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
                utf8Length(request.getContext()))) {
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
        if (!canonicalSelection(request.getOperationBinding(), CAP_DESCRIBE, OP_DESCRIBE)) {
            responseObserver.onError(multimodalFamilyNotAdmitted());
            return;
        }
        RuntimeException authorizationFailure = authorizationFailure(identity, request.getOperationBinding(), modalities(!request.getAudioData().isEmpty(),
                !request.getImageData().isEmpty(), false, !request.getContext().isEmpty()),
                request.getAudioData().size() + request.getImageData().size()
                        + utf8Length(request.getContext()),
                requestContentDigest(List.of(request.getAudioData(), request.getImageData()), request.getContext()));
        if (authorizationFailure != null) {
            responseObserver.onError(authorizationFailure);
            return;
        }
        if (!canonicalOperationExecutionAvailable()) {
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
                analysis = executeCanonical(request.getOperationBinding(), OP_DESCRIBE,
                        () -> engine.analyse(engineRequest));
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
        if (!canonicalSelection(request.getOperationBinding(), CAP_CROSS_MODAL, OP_CROSS_MODAL)) {
            responseObserver.onError(multimodalFamilyNotAdmitted());
            return;
        }
        RuntimeException authorizationFailure = authorizationFailure(identity, request.getOperationBinding(), modalities(!request.getAudioData().isEmpty(), false,
                !request.getVideoData().isEmpty(), false),
                request.getAudioData().size() + request.getVideoData().size(),
                requestContentDigest(List.of(request.getAudioData(), request.getVideoData()), ""));
        if (authorizationFailure != null) {
            responseObserver.onError(authorizationFailure);
            return;
        }
        if (!canonicalOperationExecutionAvailable()) {
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
                result = executeCanonical(request.getOperationBinding(), OP_CROSS_MODAL,
                        () -> engine.analyse(engineRequest));
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
                request.getVideoData().size(), utf8Length(request.getText()))) {
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
        boolean selectedSummary = canonicalSelection(request.getOperationBinding(), CAP_SUMMARIZE, OP_SUMMARIZE);
        boolean selectedExtraction = canonicalSelection(request.getOperationBinding(), CAP_EXTRACT, OP_EXTRACT);
        if (!selectedSummary && !selectedExtraction) {
            responseObserver.onError(multimodalFamilyNotAdmitted());
            return;
        }
        RuntimeException authorizationFailure = authorizationFailure(identity, request.getOperationBinding(), modalities(!request.getAudioData().isEmpty(),
                !request.getImageData().isEmpty(), !request.getVideoData().isEmpty(), !request.getText().isEmpty()),
                request.getAudioData().size() + request.getImageData().size()
                        + request.getVideoData().size() + utf8Length(request.getText()),
                requestContentDigest(List.of(request.getAudioData(), request.getImageData(), request.getVideoData()),
                        request.getText()));
        if (authorizationFailure != null) {
            responseObserver.onError(authorizationFailure);
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

    private static boolean withinInputBounds(int audioBytes, int imageBytes, int videoBytes, int textBytes) {
        long total = (long) audioBytes + imageBytes + videoBytes;
        return audioBytes <= MAX_MODALITY_BYTES && imageBytes <= MAX_MODALITY_BYTES
                && videoBytes <= MAX_MODALITY_BYTES && total <= MAX_TOTAL_INPUT_BYTES
                && textBytes <= MAX_TEXT_CHARS;
    }

    private static RuntimeException authorityUnavailable() {
        return Status.UNAVAILABLE
                .withDescription("Trusted artifact rights, purpose, and consent authority is not configured")
                .asRuntimeException();
    }

    private static boolean canonicalSelection(CanonicalOperationBinding binding,
                                              String capabilityRef, String operationRef) {
        if (binding == null || binding.getOperationVersion() != 1
                || !capabilityRef.equals(binding.getCapabilityRef())
                || !operationRef.equals(binding.getOperationRef())) return false;
        if (!opaqueId(binding.getRequestId(), 128)
                || !opaqueId(binding.getSourceArtifactId(), 128)
                || !opaqueVersion(binding.getSourceVersionId(), 128)
                || binding.getPurpose().isBlank() || binding.getPurpose().length() > 128
                || !binding.getPurpose().equals(binding.getPurpose().trim())
                || binding.getPurpose().chars().anyMatch(Character::isISOControl)
                || binding.getCorrelationId().length() > 128
                || (!binding.getCorrelationId().isBlank() && !opaqueId(binding.getCorrelationId(), 128))
                || binding.getDimensionsCount() > 32) return false;
        return binding.getDimensionsList().stream().allMatch(dimension -> opaqueId(dimension, 128));
    }

    private static boolean opaqueId(String value, int maxLength) {
        return value != null && value.length() >= 1 && value.length() <= maxLength
                && value.matches("[A-Za-z0-9][A-Za-z0-9._:-]*");
    }

    private static boolean opaqueVersion(String value, int maxLength) {
        return value != null && value.length() >= 1 && value.length() <= maxLength
                && value.matches("[A-Za-z0-9][A-Za-z0-9._:+-]*");
    }

    private boolean canonicalOperationExecutionAvailable() {
        // The additive request binding is now validated, but Media has no admitted per-operation
        // job/attempt/result executor here. Production constructors leave this null; only tests
        // may inject a fixture executor to exercise the transport and tracing paths.
        return canonicalOperationExecutor != null;
    }

    private <T> T executeCanonical(CanonicalOperationBinding binding, String operationRef,
                                   Callable<T> action) throws Exception {
        if (canonicalOperationExecutor == null) throw multimodalFamilyNotAdmitted();
        return canonicalOperationExecutor.execute(binding, operationRef, action);
    }

    private static RuntimeException multimodalFamilyNotAdmitted() {
        return Status.FAILED_PRECONDITION
                .withDescription("MULTIMODAL_FAMILY_NOT_ADMITTED: no admitted per-operation job, attempt, and result executor is configured")
                .asRuntimeException();
    }

    private RuntimeException authorizationFailure(Identity identity, CanonicalOperationBinding binding,
                                                  Set<SourceAuthorization.Modality> modalities, long contentBytes,
                                                  String contentSha256) {
        SourceAuthorization.AuthorizationRequest authorizationRequest =
                new SourceAuthorization.AuthorizationRequest(identity.tenantId(), identity.principalId(),
                        modalities, binding.getCapabilityRef(), binding.getOperationRef(),
                        binding.getOperationVersion(), binding.getRequestId(), binding.getSourceArtifactId(),
                        binding.getSourceVersionId(), binding.getPurpose(), binding.getCorrelationId(),
                        binding.getDimensionsList(), null, contentBytes, contentSha256);
        try {
            SourceAuthorization.Decision decision = sourceAuthorization.authorize(authorizationRequest);
            if (decision == SourceAuthorization.Decision.ADMITTED) return null;
            if (decision == SourceAuthorization.Decision.DENIED) {
                return Status.PERMISSION_DENIED
                        .withDescription("Source authorization denied this multimodal operation")
                        .asRuntimeException();
            }
            return authorityUnavailable();
        } catch (RuntimeException unavailable) {
            return authorityUnavailable();
        }
    }

    private static int utf8Length(String value) {
        return value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
    }

    /**
     * Request-bound fingerprint used by the source authority to compare caller payload with the
     * immutable artifact version. Until the authority verifies this against its own artifact
     * readback, it is only a request fingerprint and grants no source ownership or rights.
     */
    private static String requestContentDigest(List<com.google.protobuf.ByteString> parts, String text) {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            for (com.google.protobuf.ByteString part : parts) {
                java.nio.ByteBuffer bytes = part.asReadOnlyByteBuffer();
                digest.update(java.nio.ByteBuffer.allocate(Long.BYTES).putLong(bytes.remaining()).array());
                digest.update(bytes);
            }
            byte[] textBytes = text.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            digest.update(java.nio.ByteBuffer.allocate(Long.BYTES).putLong(textBytes.length).array());
            digest.update(textBytes);
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is required by the Java runtime", impossible);
        }
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

    /** Serialize a frame timestamp without overflowing its optional millisecond projection. */
    static FrameAnalysis toFrameAnalysis(com.ghatana.audio.video.multimodal.engine.FrameResult frame) {
        var timestamp = frame.getTimestamp();
        var timestampMs = frame.getRepresentableTimestampMs();
        String description = frame.hasTimestamp()
                ? timestampMs.isPresent()
                        ? "Frame " + frame.getFrameNumber() + " at " + timestampMs.getAsLong() + "ms"
                        : "Frame " + frame.getFrameNumber()
                                + " at a known timestamp (millisecond projection unavailable)"
                : "Frame " + frame.getFrameNumber() + " at unknown source time";
        FrameAnalysis.Builder result = FrameAnalysis.newBuilder().setDescription(description);

        if (frame.hasTimestamp()) {
            result.setTimestampStatus(FrameAnalysis.TimestampStatus.TIMESTAMP_STATUS_KNOWN)
                    .setTimeBaseNumerator(timestamp.timeBaseNumerator())
                    .setTimeBaseDenominator(timestamp.timeBaseDenominator())
                    .setClockDomain(toProtoClockDomain(timestamp.domain()));
            if (timestampMs.isPresent()) result.setTimestampMs(timestampMs.getAsLong());
            if (timestamp.domain() == com.ghatana.audio.video.multimodal.engine
                    .MediaClockTimestamp.ClockDomain.SOURCE) {
                result.setSourcePts(timestamp.ticks());
            }
        } else {
            result.setTimestampStatus(FrameAnalysis.TimestampStatus.TIMESTAMP_STATUS_UNKNOWN)
                    .setTimestampUnknownReason(timestamp.unknownReason());
        }

        for (com.ghatana.audio.video.multimodal.engine.DetectionResult detection : frame.getDetections()) {
            result.addObjects(Detection.newBuilder()
                    .setClassName(detection.getClassName())
                    .setConfidence(detection.getConfidence())
                    .build());
        }
        return result.build();
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
