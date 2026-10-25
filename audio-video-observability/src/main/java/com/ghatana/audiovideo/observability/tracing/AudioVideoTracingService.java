package com.ghatana.audiovideo.observability.tracing;

import io.opentelemetry.context.Context;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * @doc.type class
 * @doc.purpose OpenTelemetry distributed tracing for Audio-Video service operations
 * @doc.layer observability
 * @doc.pattern Service
 *
 * <p>Operation and tenant identifiers are reduced to presence flags; they are never copied into
 * span attributes or MDC, which structured logging commonly exports. Error messages and exception
 * payloads are also redacted.
 */
public class AudioVideoTracingService {

    private static final String CONTRACT_VERSION = "v1";
    private static final Set<String> LANGUAGES = Set.of(
            "auto", "en", "es", "fr", "de", "it", "pt", "nl", "ja", "ko", "zh", "ar", "hi", "ne");

    private static final Logger log = LoggerFactory.getLogger(AudioVideoTracingService.class);

    private final Tracer tracer;

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
                .setAttribute("method.name", safeMethod(methodName))
                .setAttribute("tenant.present", tenantId != null && !tenantId.isBlank())
                .setAttribute("media.contract.version", CONTRACT_VERSION)
                .setAttribute("correlation.present", correlationId != null)
                .startSpan();

        return span;
    }

    /**
     * Start a span for video processing operation
     */
    public Span startVideoProcessingSpan(String processId, String tenantId) {
        String correlationId = getOrCreateCorrelationId();

        Span span = tracer.spanBuilder("audiovideo.video.processing")
                .setSpanKind(SpanKind.INTERNAL)
                .setAttribute("process.present", processId != null && !processId.isBlank())
                .setAttribute("tenant.present", tenantId != null && !tenantId.isBlank())
                .setAttribute("media.contract.version", CONTRACT_VERSION)
                .setAttribute("correlation.present", correlationId != null)
                .startSpan();

        return span;
    }

    /**
     * Start a span for audio processing operation
     */
    public Span startAudioProcessingSpan(String processId, String tenantId) {
        String correlationId = getOrCreateCorrelationId();

        Span span = tracer.spanBuilder("audiovideo.audio.processing")
                .setSpanKind(SpanKind.INTERNAL)
                .setAttribute("process.present", processId != null && !processId.isBlank())
                .setAttribute("tenant.present", tenantId != null && !tenantId.isBlank())
                .setAttribute("media.contract.version", CONTRACT_VERSION)
                .setAttribute("correlation.present", correlationId != null)
                .startSpan();

        return span;
    }

    /** Start a source-redacted span around the multimodal analysis model boundary. */
    public Span startMultimodalAnalysisSpan(String operationId, String tenantId) {
        String correlationId = getOrCreateCorrelationId();

        return tracer.spanBuilder("audiovideo.multimodal.analysis")
                .setSpanKind(SpanKind.INTERNAL)
                .setAttribute("operation.present", operationId != null && !operationId.isBlank())
                .setAttribute("tenant.present", tenantId != null && !tenantId.isBlank())
                .setAttribute("media.contract.version", CONTRACT_VERSION)
                .setAttribute("correlation.present", correlationId != null)
                .startSpan();
    }

    /**
     * Start a span for synthesis operation
     */
    public Span startSynthesisSpan(String synthesisId, String tenantId) {
        String correlationId = getOrCreateCorrelationId();

        Span span = tracer.spanBuilder("audiovideo.synthesis")
                .setSpanKind(SpanKind.INTERNAL)
                .setAttribute("synthesis.present", synthesisId != null && !synthesisId.isBlank())
                .setAttribute("tenant.present", tenantId != null && !tenantId.isBlank())
                .setAttribute("media.contract.version", CONTRACT_VERSION)
                .setAttribute("correlation.present", correlationId != null)
                .startSpan();

        return span;
    }

    /** Record successful operation duration without applying an unqualified latency target. */
    public void recordSuccess(Span span, long durationMs) {
        if (span != null) {
            span.setStatus(StatusCode.OK);
            if (durationMs >= 0) {
                span.setAttribute("duration.ms", durationMs);
                log.debug("Audio-Video operation completed successfully in {}ms", durationMs);
            } else {
                log.debug("Audio-Video operation completed successfully with unknown duration");
            }

            span.end();
        }
    }

    /**
     * Record failed operation
     */
    public void recordError(Span span, Exception exception, long durationMs) {
        if (span != null) {
            // Exception messages can contain user supplied paths, tokens, or media metadata.
            span.setStatus(StatusCode.ERROR, "Media operation failed");
            if (durationMs >= 0) {
                span.setAttribute("duration.ms", durationMs);
            }
            span.setAttribute("error", true);
            span.setAttribute("error.type", exception.getClass().getSimpleName());
            span.end();

            if (durationMs >= 0) {
                log.error("Audio-Video operation failed after {}ms (type={})",
                        durationMs, exception.getClass().getSimpleName());
            } else {
                log.error("Audio-Video operation failed (type={})", exception.getClass().getSimpleName());
            }
        }
    }

    /**
     * Create a scope for a span
     */
    public Scope createScope(Span span) {
        return span.makeCurrent();
    }

    /** Capture the current OTel context for work submitted to an executor. */
    public Runnable propagateRunnable(Runnable task) {
        return Context.current().wrap(task);
    }

    /** Capture the current OTel context for asynchronous suppliers. */
    public <T> Supplier<T> propagateSupplier(Supplier<T> task) {
        return Context.current().wrapSupplier(task);
    }

    /** Capture the current OTel context for asynchronous functions. */
    public <T, R> Function<T, R> propagateFunction(Function<T, R> task) {
        return Context.current().wrapFunction(task);
    }

    /** Capture the current OTel context for checked asynchronous work. */
    public <T> Callable<T> propagateCallable(Callable<T> task) {
        return Context.current().wrap(task);
    }

    /**
     * Get or create correlation ID
     */
    private String getOrCreateCorrelationId() {
        String correlationId = MDC.get("correlationId");
        // Only expose whether a caller supplied context; never export the caller-controlled value.
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
                .setAttribute("transcription.present", transcriptionId != null && !transcriptionId.isBlank())
                .setAttribute("tenant.present", tenantId != null && !tenantId.isBlank())
                .setAttribute("media.contract.version", CONTRACT_VERSION)
                .setAttribute("stt.language", safeLanguage(language))
                .setAttribute("correlation.present", correlationId != null)
                .startSpan();

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
        // Provider output is untrusted input. Keep malformed confidence values out of
        // telemetry instead of exporting NaN, infinity, or values outside the documented
        // probability range as if they were measurements.
        if (Double.isFinite(confidence) && confidence >= 0.0 && confidence <= 1.0) {
            span.setAttribute("stt.confidence", confidence);
        }
        if (detectedLanguage != null && !detectedLanguage.isBlank()) {
            span.setAttribute("stt.detected_language", safeLanguage(detectedLanguage));
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
                .setAttribute("detection.present", detectionId != null && !detectionId.isBlank())
                .setAttribute("tenant.present", tenantId != null && !tenantId.isBlank())
                .setAttribute("media.contract.version", CONTRACT_VERSION)
                .setAttribute("vision.confidence_threshold_band", confidenceBand(confidenceThreshold))
                .setAttribute("correlation.present", correlationId != null)
                .startSpan();

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
        if (detectionCount >= 0) {
            span.setAttribute("vision.detection_count", detectionCount);
        }
        if (Double.isFinite(maxConfidence) && maxConfidence >= 0.0 && maxConfidence <= 1.0) {
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

    /** Capture the caller's logging context so synchronous instrumentation can restore it. */
    public Map<String, String> captureMdcContext() {
        Map<String, String> context = MDC.getCopyOfContextMap();
        return context == null ? java.util.Collections.emptyMap() : Map.copyOf(context);
    }

    /** Restore the logging context that was present before a synchronous instrumented call. */
    public void restoreMdcContext(Map<String, String> context) {
        if (context == null || context.isEmpty()) {
            MDC.clear();
        } else {
            MDC.setContextMap(context);
        }
    }

    private static String safeMethod(String methodName) {
        if (methodName == null || !methodName.matches("[A-Za-z][A-Za-z0-9_.]{0,63}")) return "unknown";
        return Set.of("VisionStream", "ProcessVideo", "StreamAudio", "Transcribe", "Synthesize")
                .contains(methodName) ? methodName : "unknown";
    }

    private static String safeLanguage(String language) {
        if (language == null || language.equalsIgnoreCase("auto")) return "auto";
        if (!language.matches("(?i)[a-z]{2,3}(-[a-z0-9]{2,8})*")) return "other";
        String primary = language.substring(0, language.indexOf('-') < 0 ? language.length() : language.indexOf('-'))
                .toLowerCase(java.util.Locale.ROOT);
        return LANGUAGES.contains(primary) ? primary : "other";
    }

    private static String confidenceBand(double confidence) {
        if (!Double.isFinite(confidence) || confidence < 0 || confidence > 1) return "invalid";
        if (confidence < 0.34) return "low";
        if (confidence < 0.67) return "medium";
        return "high";
    }
}
