package com.ghatana.audiovideo.observability.instrumentation;

import com.ghatana.audiovideo.observability.MediaWorkflowMetrics;
import com.ghatana.audiovideo.observability.tracing.AudioVideoTracingService;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Scope;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * @doc.type class
 * @doc.purpose Instrumentation for Audio-Video gRPC service operations with distributed tracing
 * @doc.layer observability
 * @doc.pattern Instrumentation
 */
public class AudioVideoGrpcInstrumentation {

    private static final Logger log = LoggerFactory.getLogger(AudioVideoGrpcInstrumentation.class);
    private final AudioVideoTracingService tracingService;
    private final MediaWorkflowMetrics workflowMetrics;

    public AudioVideoGrpcInstrumentation(AudioVideoTracingService tracingService) {
        this(tracingService, null);
    }

    /** Build instrumentation with optional bounded modality boundary metrics. */
    public AudioVideoGrpcInstrumentation(
            AudioVideoTracingService tracingService,
            MediaWorkflowMetrics workflowMetrics) {
        this.tracingService = tracingService;
        this.workflowMetrics = workflowMetrics;
    }

    /**
     * Instrument gRPC streaming operation with tracing
     */
    public <T> T instrumentGrpcStreaming(
            String methodName,
            String tenantId,
            GrpcStreamingTask<T> task) throws Exception {

        Span span = tracingService.startGrpcStreamingSpan(methodName, tenantId);
        long startTime = System.nanoTime();

        try (Scope scope = tracingService.createScope(span)) {
            log.info("Starting gRPC streaming operation");

            T result = task.execute();

            long duration = elapsedMillis(startTime);
            tracingService.recordSuccess(span, duration);

            log.info("gRPC streaming completed in {}ms", duration);
            return result;
        } catch (Exception e) {
            long duration = elapsedMillis(startTime);
            tracingService.recordError(span, e, duration);
            throw e;
        } finally {
            tracingService.clearContext();
        }
    }

    /**
     * Instrument video processing operation with tracing
     */
    public <T> T instrumentVideoProcessing(
            String processId,
            String tenantId,
            VideoProcessingTask<T> task) throws Exception {

        Span span = tracingService.startVideoProcessingSpan(processId, tenantId);
        long startTime = System.nanoTime();

        try (Scope scope = tracingService.createScope(span)) {
            log.info("Starting video processing operation");

            T result = task.execute();

            long duration = elapsedMillis(startTime);
            tracingService.recordSuccess(span, duration);

            log.info("Video processing completed in {}ms", duration);
            return result;
        } catch (Exception e) {
            long duration = elapsedMillis(startTime);
            tracingService.recordError(span, e, duration);
            throw e;
        } finally {
            tracingService.clearContext();
        }
    }

    /**
     * Instrument audio processing operation with tracing
     */
    public <T> T instrumentAudioProcessing(
            String processId,
            String tenantId,
            AudioProcessingTask<T> task) throws Exception {

        Span span = tracingService.startAudioProcessingSpan(processId, tenantId);
        long startTime = System.nanoTime();

        try (Scope scope = tracingService.createScope(span)) {
            log.info("Starting audio processing operation");

            T result = task.execute();

            long duration = elapsedMillis(startTime);
            tracingService.recordSuccess(span, duration);

            log.info("Audio processing completed in {}ms", duration);
            return result;
        } catch (Exception e) {
            long duration = elapsedMillis(startTime);
            tracingService.recordError(span, e, duration);
            throw e;
        } finally {
            tracingService.clearContext();
        }
    }

    /**
     * Instrument synthesis operation with tracing
     */
    public <T> T instrumentSynthesis(
            String synthesisId,
            String tenantId,
            SynthesisTask<T> task) throws Exception {

        Span span = tracingService.startSynthesisSpan(synthesisId, tenantId);
        long startTime = System.nanoTime();
        MediaWorkflowMetrics.ModalityTimingSample modelSample = startModalityTimer(
                MediaWorkflowMetrics.Modality.TTS, MediaWorkflowMetrics.Boundary.PROVIDER);

        try (Scope scope = tracingService.createScope(span)) {
            log.info("Starting synthesis operation");

            T result = task.execute();

            long duration = elapsedMillis(startTime);
            stopModalityTimer(modelSample, MediaWorkflowMetrics.Outcome.SUCCESS);
            tracingService.recordSuccess(span, duration);

            log.info("Synthesis completed in {}ms", duration);
            return result;
        } catch (Exception e) {
            long duration = elapsedMillis(startTime);
            stopModalityTimer(modelSample, MediaWorkflowMetrics.Outcome.UNKNOWN);
            tracingService.recordError(span, e, duration);
            throw e;
        } finally {
            tracingService.clearContext();
        }
    }

    /**
     * Functional interface for gRPC streaming task
     */
    @FunctionalInterface
    public interface GrpcStreamingTask<T> {
        T execute() throws Exception;
    }

    /**
     * Functional interface for video processing task
     */
    @FunctionalInterface
    public interface VideoProcessingTask<T> {
        T execute() throws Exception;
    }

    /**
     * Functional interface for audio processing task
     */
    @FunctionalInterface
    public interface AudioProcessingTask<T> {
        T execute() throws Exception;
    }

    /**
     * Instrument an STT transcription operation with tenant, language, and confidence
     * span attributes.
     *
     * <p>The {@code task} receives the active {@link io.opentelemetry.api.trace.Span} so
     * that the caller can invoke
     * {@link AudioVideoTracingService#recordTranscriptionResult} once the model result is
     * available but before the span is closed.
     *
     * @param transcriptionId unique request identifier
     * @param tenantId        tenant performing the request
     * @param language        requested language (BCP-47) or {@code "auto"}
     * @param task            lambda that executes the transcription and receives the span
     * @param <T>             result type
     */
    public <T> T instrumentTranscription(
            String transcriptionId,
            String tenantId,
            String language,
            TranscriptionTask<T> task) throws Exception {

        io.opentelemetry.api.trace.Span span =
                tracingService.startTranscriptionSpan(transcriptionId, tenantId, language);
        long startTime = System.nanoTime();
        MediaWorkflowMetrics.ModalityTimingSample modelSample = startModalityTimer(
                MediaWorkflowMetrics.Modality.STT, MediaWorkflowMetrics.Boundary.PROVIDER);

        try (io.opentelemetry.context.Scope scope = tracingService.createScope(span)) {
            log.info("Starting STT transcription operation");

            T result = task.execute(span);

            long duration = elapsedMillis(startTime);
            stopModalityTimer(modelSample, MediaWorkflowMetrics.Outcome.SUCCESS);
            tracingService.recordSuccess(span, duration);

            log.info("STT transcription completed in {}ms", duration);
            return result;
        } catch (Exception e) {
            long duration = elapsedMillis(startTime);
            stopModalityTimer(modelSample, MediaWorkflowMetrics.Outcome.UNKNOWN);
            tracingService.recordError(span, e, duration);
            throw e;
        } finally {
            tracingService.clearContext();
        }
    }

    /**
     * Instrument a vision detection operation with tenant, confidence threshold, and
     * detection result attributes.
     *
     * <p>The {@code task} receives the active span so that the caller can invoke
     * {@link AudioVideoTracingService#recordVisionDetectionResult} once detection is done.
     *
     * @param detectionId         unique request identifier
     * @param tenantId            tenant performing the request
     * @param confidenceThreshold minimum detection confidence in {@code [0.0, 1.0]}
     * @param task                lambda that executes detection and receives the span
     * @param <T>                 result type
     */
    public <T> T instrumentVisionDetection(
            String detectionId,
            String tenantId,
            double confidenceThreshold,
            VisionDetectionTask<T> task) throws Exception {

        io.opentelemetry.api.trace.Span span =
                tracingService.startVisionDetectionSpan(detectionId, tenantId, confidenceThreshold);
        long startTime = System.nanoTime();
        MediaWorkflowMetrics.ModalityTimingSample modelSample = startModalityTimer(
                MediaWorkflowMetrics.Modality.VISION, MediaWorkflowMetrics.Boundary.PROVIDER);

        try (io.opentelemetry.context.Scope scope = tracingService.createScope(span)) {
            log.info("Starting vision detection operation");

            T result = task.execute(span);

            long duration = elapsedMillis(startTime);
            stopModalityTimer(modelSample, MediaWorkflowMetrics.Outcome.SUCCESS);
            tracingService.recordSuccess(span, duration);

            log.info("Vision detection completed in {}ms", duration);
            return result;
        } catch (Exception e) {
            long duration = elapsedMillis(startTime);
            stopModalityTimer(modelSample, MediaWorkflowMetrics.Outcome.UNKNOWN);
            tracingService.recordError(span, e, duration);
            throw e;
        } finally {
            tracingService.clearContext();
        }
    }

    /** Instrument the real multimodal provider boundary with an aggregate bounded timer. */
    public <T> T instrumentMultimodalAnalysis(
            String operationId,
            String tenantId,
            MultimodalAnalysisTask<T> task) throws Exception {

        Span span = tracingService.startMultimodalAnalysisSpan(operationId, tenantId);
        long startTime = System.nanoTime();
        MediaWorkflowMetrics.ModalityTimingSample modelSample = startModalityTimer(
                MediaWorkflowMetrics.Modality.MULTIMODAL, MediaWorkflowMetrics.Boundary.PROVIDER);

        try (Scope scope = tracingService.createScope(span)) {
            log.info("Starting multimodal analysis operation");
            T result = task.execute(span);
            long duration = elapsedMillis(startTime);
            stopModalityTimer(modelSample, MediaWorkflowMetrics.Outcome.SUCCESS);
            tracingService.recordSuccess(span, duration);
            log.info("Multimodal analysis completed in {}ms", duration);
            return result;
        } catch (Exception e) {
            long duration = elapsedMillis(startTime);
            stopModalityTimer(modelSample, MediaWorkflowMetrics.Outcome.UNKNOWN);
            tracingService.recordError(span, e, duration);
            throw e;
        } finally {
            tracingService.clearContext();
        }
    }

    /**
     * Functional interface for synthesis task
     */
    @FunctionalInterface
    public interface SynthesisTask<T> {
        T execute() throws Exception;
    }

    /**
     * Functional interface for transcription task; receives the active span so callers
     * can set confidence/language result attributes.
     */
    @FunctionalInterface
    public interface TranscriptionTask<T> {
        T execute(io.opentelemetry.api.trace.Span span) throws Exception;
    }

    /**
     * Functional interface for vision detection task; receives the active span so callers
     * can set detection count and max-confidence result attributes.
     */
    @FunctionalInterface
    public interface VisionDetectionTask<T> {
        T execute(io.opentelemetry.api.trace.Span span) throws Exception;
    }

    /** Functional interface for multimodal analysis tasks receiving the active span. */
    @FunctionalInterface
    public interface MultimodalAnalysisTask<T> {
        T execute(Span span) throws Exception;
    }

    private static long elapsedMillis(long startedNanos) {
        return java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos);
    }

    private MediaWorkflowMetrics.ModalityTimingSample startModalityTimer(
            MediaWorkflowMetrics.Modality modality, MediaWorkflowMetrics.Boundary boundary) {
        return workflowMetrics == null ? null : workflowMetrics.startModalityTimer(modality, boundary);
    }

    private void stopModalityTimer(
            MediaWorkflowMetrics.ModalityTimingSample sample, MediaWorkflowMetrics.Outcome outcome) {
        if (workflowMetrics != null) workflowMetrics.stopModalityTimer(sample, outcome);
    }
}
