package com.ghatana.audiovideo.observability.tracing;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

import java.util.UUID;

/**
 * @doc.type class
 * @doc.purpose OpenTelemetry distributed tracing for Audio-Video service operations
 * @doc.layer observability
 * @doc.pattern Service
 */
public class AudioVideoTracingService {

    private static final Logger log = LoggerFactory.getLogger(AudioVideoTracingService.class);

    private final Tracer tracer;
    private static final int SLA_THRESHOLD_MS = 50; // Audio-Video operations should be < 50ms

    public AudioVideoTracingService(Tracer tracer) {
        this.tracer = tracer;
    }

    /**
     * Start a span for gRPC streaming operation
     */
    public Span startGrpcStreamingSpan(String methodName, String tenantId) {
        String correlationId = getOrCreateCorrelationId();

        Span span = tracer.spanBuilder("audiovideo.grpc.streaming")
                .setSpanKind(SpanKind.INTERNAL)
                .setAttribute("method.name", methodName)
                .setAttribute("tenant.id", tenantId)
                .setAttribute("correlation.id", correlationId)
                .startSpan();

        MDC.put("methodName", methodName);
        MDC.put("correlationId", correlationId);

        return span;
    }

    /**
     * Start a span for video processing operation
     */
    public Span startVideoProcessingSpan(String processId, String tenantId) {
        String correlationId = getOrCreateCorrelationId();

        Span span = tracer.spanBuilder("audiovideo.video.processing")
                .setSpanKind(SpanKind.INTERNAL)
                .setAttribute("process.id", processId)
                .setAttribute("tenant.id", tenantId)
                .setAttribute("correlation.id", correlationId)
                .startSpan();

        MDC.put("processId", processId);

        return span;
    }

    /**
     * Start a span for audio processing operation
     */
    public Span startAudioProcessingSpan(String processId, String tenantId) {
        String correlationId = getOrCreateCorrelationId();

        Span span = tracer.spanBuilder("audiovideo.audio.processing")
                .setSpanKind(SpanKind.INTERNAL)
                .setAttribute("process.id", processId)
                .setAttribute("tenant.id", tenantId)
                .setAttribute("correlation.id", correlationId)
                .startSpan();

        MDC.put("processId", processId);

        return span;
    }

    /**
     * Start a span for synthesis operation
     */
    public Span startSynthesisSpan(String synthesisId, String tenantId) {
        String correlationId = getOrCreateCorrelationId();

        Span span = tracer.spanBuilder("audiovideo.synthesis")
                .setSpanKind(SpanKind.INTERNAL)
                .setAttribute("synthesis.id", synthesisId)
                .setAttribute("tenant.id", tenantId)
                .setAttribute("correlation.id", correlationId)
                .startSpan();

        MDC.put("synthesisId", synthesisId);

        return span;
    }

    /**
     * Record successful operation with SLA validation
     */
    public void recordSuccess(Span span, long durationMs) {
        if (span != null) {
            span.setStatus(StatusCode.OK);
            span.setAttribute("duration.ms", durationMs);

            if (durationMs > SLA_THRESHOLD_MS) {
                span.setAttribute("sla.warning", true);
                log.warn("Audio-Video operation exceeded SLA threshold: {}ms > {}ms",
                        durationMs, SLA_THRESHOLD_MS);
            }

            span.end();
            log.debug("Audio-Video operation completed successfully in {}ms", durationMs);
        }
    }

    /**
     * Record failed operation
     */
    public void recordError(Span span, Exception exception, long durationMs) {
        if (span != null) {
            span.setStatus(StatusCode.ERROR, exception.getMessage());
            span.recordException(exception);
            span.setAttribute("duration.ms", durationMs);
            span.setAttribute("error", true);
            span.setAttribute("error.type", exception.getClass().getName());
            span.end();

            log.error("Audio-Video operation failed after {}ms: {}",
                    durationMs, exception.getMessage(), exception);
        }
    }

    /**
     * Create a scope for a span
     */
    public Scope createScope(Span span) {
        return span.makeCurrent();
    }

    /**
     * Get or create correlation ID
     */
    private String getOrCreateCorrelationId() {
        String correlationId = MDC.get("correlationId");
        if (correlationId == null) {
            correlationId = UUID.randomUUID().toString();
            MDC.put("correlationId", correlationId);
        }
        return correlationId;
    }

    /**
     * Start a span for an STT transcription operation, including the requested language
     * as a custom attribute so the language distribution can be queried in Jaeger/Grafana.
     *
     * @param transcriptionId unique ID for this transcription request
     * @param tenantId        tenant performing the request
     * @param language        BCP-47 language tag (e.g. {@code "en"}, {@code "fr"})
     *                        or {@code "auto"} when auto-detection is requested
     */
    public Span startTranscriptionSpan(String transcriptionId, String tenantId, String language) {
        String correlationId = getOrCreateCorrelationId();

        Span span = tracer.spanBuilder("audiovideo.stt.transcribe")
                .setSpanKind(SpanKind.INTERNAL)
                .setAttribute("transcription.id", transcriptionId)
                .setAttribute("tenant.id", tenantId)
                .setAttribute("stt.language", language != null ? language : "auto")
                .setAttribute("correlation.id", correlationId)
                .startSpan();

        MDC.put("transcriptionId", transcriptionId);
        MDC.put("sttLanguage", language != null ? language : "auto");

        return span;
    }

    /**
     * Set transcription result attributes on an in-flight span once the STT result is known.
     *
     * <p>Call this before ending the span (i.e. before {@link #recordSuccess} or
     * {@link #recordError}).
     *
     * @param span             the active span returned by {@link #startTranscriptionSpan}
     * @param confidence       model confidence score in {@code [0.0, 1.0]}
     * @param detectedLanguage BCP-47 tag of the language actually detected by the model,
     *                         or {@code null} when the model does not return a language
     */
    public void recordTranscriptionResult(Span span, double confidence, String detectedLanguage) {
        if (span == null) {
            return;
        }
        span.setAttribute("stt.confidence", confidence);
        if (detectedLanguage != null && !detectedLanguage.isBlank()) {
            span.setAttribute("stt.detected_language", detectedLanguage);
        }
    }

    /**
     * Start a span for a vision object-detection operation, including the configured
     * confidence threshold so detection quality can be correlated with latency in traces.
     *
     * @param detectionId         unique ID for this detection request
     * @param tenantId            tenant performing the request
     * @param confidenceThreshold minimum detection confidence in {@code [0.0, 1.0]}
     */
    public Span startVisionDetectionSpan(String detectionId, String tenantId, double confidenceThreshold) {
        String correlationId = getOrCreateCorrelationId();

        Span span = tracer.spanBuilder("audiovideo.vision.detect")
                .setSpanKind(SpanKind.INTERNAL)
                .setAttribute("detection.id", detectionId)
                .setAttribute("tenant.id", tenantId)
                .setAttribute("vision.confidence_threshold", confidenceThreshold)
                .setAttribute("correlation.id", correlationId)
                .startSpan();

        MDC.put("detectionId", detectionId);

        return span;
    }

    /**
     * Set vision detection result attributes on an in-flight span once detection completes.
     *
     * @param span            the active span returned by {@link #startVisionDetectionSpan}
     * @param detectionCount  number of objects detected above the confidence threshold
     * @param maxConfidence   highest confidence score among detected objects, or
     *                        {@link Double#NaN} when no objects were detected
     */
    public void recordVisionDetectionResult(Span span, int detectionCount, double maxConfidence) {
        if (span == null) {
            return;
        }
        span.setAttribute("vision.detection_count", detectionCount);
        if (!Double.isNaN(maxConfidence)) {
            span.setAttribute("vision.max_confidence", maxConfidence);
        }
    }

    /**
     * Clear all MDC context
     */
    public void clearContext() {
        MDC.clear();
        MDC.setContextMap(java.util.Collections.emptyMap());
    }
}
