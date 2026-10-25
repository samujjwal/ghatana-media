package com.ghatana.audiovideo.observability.tracing;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.SpanBuilder;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.Mockito.RETURNS_DEEP_STUBS;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.never;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.anyDouble;
import static org.mockito.ArgumentMatchers.anyLong;

/**
 * @doc.type class
 * @doc.purpose Unit tests for bounded OpenTelemetry span attributes and log-context redaction.
 * @doc.layer test
 * @doc.pattern UnitTest
 */
@DisplayName("AudioVideoTracingService — custom span attributes (AV-M2)")
class AudioVideoTracingServiceSpanAttributeTest {

    /**
     * Deep-stub tracer so that the SpanBuilder chain
     * (spanBuilder → setSpanKind → setAttribute → startSpan) does not NPE.
     */
    private Tracer tracer;
    private AudioVideoTracingService tracingService;

    @BeforeEach
    void setUp() {
        tracer = mock(Tracer.class, RETURNS_DEEP_STUBS);
        tracingService = new AudioVideoTracingService(tracer);
        MDC.clear();
    }

    @AfterEach
    void tearDown() {
        MDC.clear();
    }

    @Test
    @DisplayName("multimodal spans export only identifier presence flags")
    void shouldRedactMultimodalOperationAndTenantIdentifiers() {
        String marker = "tenant_secret_multimodal_operation_123";
        SpanBuilder builder = mock(SpanBuilder.class);
        Span span = mock(Span.class);
        when(tracer.spanBuilder("audiovideo.multimodal.analysis")).thenReturn(builder);
        when(builder.setSpanKind(SpanKind.INTERNAL)).thenReturn(builder);
        when(builder.setAttribute(org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyBoolean())).thenReturn(builder);
        when(builder.setAttribute(org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyString())).thenReturn(builder);
        when(builder.startSpan()).thenReturn(span);

        tracingService.startMultimodalAnalysisSpan(marker, marker);

        verify(builder).setAttribute(eq("operation.present"), eq(true));
        verify(builder).setAttribute(eq("tenant.present"), eq(true));
        verify(builder, never()).setAttribute(anyString(), eq(marker));
    }

    // -------------------------------------------------------------------------
    // STT transcription span — do not copy identifiers or content tags into log MDC
    // -------------------------------------------------------------------------

    @Nested
    @DisplayName("startTranscriptionSpan — redacted log context")
    class StartTranscriptionSpanTests {

        @Test
        @DisplayName("does not export caller-controlled correlation marker to spans")
        void shouldRedactCorrelationMarkerFromSpanAttributes() {
            String marker = "tenant_secret_request_123";
            SpanBuilder builder = mock(SpanBuilder.class);
            Span span = mock(Span.class);
            when(tracer.spanBuilder("audiovideo.stt.transcribe")).thenReturn(builder);
            when(builder.setSpanKind(SpanKind.INTERNAL)).thenReturn(builder);
            when(builder.setAttribute(org.mockito.ArgumentMatchers.anyString(),
                    org.mockito.ArgumentMatchers.anyBoolean())).thenReturn(builder);
            when(builder.setAttribute(org.mockito.ArgumentMatchers.anyString(),
                    org.mockito.ArgumentMatchers.anyString())).thenReturn(builder);
            when(builder.startSpan()).thenReturn(span);
            MDC.put("correlationId", marker);
            tracingService.startTranscriptionSpan(marker, marker, "en-US");

            verify(builder).setAttribute(eq("correlation.present"), eq(true));
            verify(builder).setAttribute(eq("stt.language"), eq("en"));
            verify(builder, never()).setAttribute(eq("correlation.id"), anyString());
            verify(builder, never()).setAttribute(anyString(), eq(marker));
            // Caller-owned MDC remains untouched; the sensitive value is excluded from span attributes.
            assertThat(MDC.get("correlationId")).isEqualTo(marker);
        }

        @Test
        @DisplayName("does not put transcription ID in MDC")
        void shouldNotSetTranscriptionIdInMdc() {
            Span span = tracingService.startTranscriptionSpan("txn-001", "tenant-en", "en");

            assertThat(span).isNotNull();
            assertThat(MDC.get("transcriptionId")).isNull();
        }

        @Test
        @DisplayName("does not put requested language in MDC")
        void shouldNotSetLanguageInMdc() {
            tracingService.startTranscriptionSpan("txn-002", "tenant-fr", "fr");

            assertThat(MDC.get("sttLanguage")).isNull();
        }

        @Test
        @DisplayName("does not put auto-detected language into MDC")
        void shouldDefaultLanguageToAutoWhenNull() {
            tracingService.startTranscriptionSpan("txn-003", "tenant-auto", null);

            assertThat(MDC.get("sttLanguage")).isNull();
        }

        @Test
        @DisplayName("does not put correlation ID in MDC")
        void shouldNotSetCorrelationIdInMdc() {
            tracingService.startTranscriptionSpan("txn-004", "tenant-x", "de");

            assertThat(MDC.get("correlationId")).isNull();
        }
    }

    // -------------------------------------------------------------------------
    // STT transcription span — confidence result attribute (null-safety)
    // -------------------------------------------------------------------------

    @Nested
    @DisplayName("recordTranscriptionResult — confidence attribute null-safety")
    class RecordTranscriptionResultTests {

        @Test
        @DisplayName("is a no-op and does not throw when span is null")
        void shouldTolerateNullSpan() {
            assertThatCode(() -> tracingService.recordTranscriptionResult(null, 0.92, "en"))
                    .doesNotThrowAnyException();
        }

        @Test
        @DisplayName("does not throw when detectedLanguage is blank")
        void shouldTolerateBlankDetectedLanguage() {
            Span span = tracingService.startTranscriptionSpan("txn-blank", "tenant-b", "fr");

            assertThatCode(() -> tracingService.recordTranscriptionResult(span, 0.78, ""))
                    .doesNotThrowAnyException();
        }

        @Test
        @DisplayName("does not throw when detectedLanguage is null")
        void shouldTolerateNullDetectedLanguage() {
            Span span = tracingService.startTranscriptionSpan("txn-null", "tenant-c", "es");

            assertThatCode(() -> tracingService.recordTranscriptionResult(span, 0.65, null))
                    .doesNotThrowAnyException();
        }

        @Test
        @DisplayName("does not throw for boundary confidence value 0.0")
        void shouldHandleZeroConfidence() {
            Span span = tracingService.startTranscriptionSpan("txn-zero", "tenant-d", "ja");

            assertThatCode(() -> tracingService.recordTranscriptionResult(span, 0.0, "ja"))
                    .doesNotThrowAnyException();
            verify(span).setAttribute("stt.confidence", 0.0);
        }

        @Test
        @DisplayName("does not export non-finite or out-of-range provider confidence")
        void shouldOmitInvalidConfidence() {
            Span span = tracingService.startTranscriptionSpan("txn-invalid", "tenant-e", "en");

            tracingService.recordTranscriptionResult(span, Double.NaN, null);
            tracingService.recordTranscriptionResult(span, Double.POSITIVE_INFINITY, null);
            tracingService.recordTranscriptionResult(span, -0.01, null);
            tracingService.recordTranscriptionResult(span, 1.01, null);

            verify(span, never()).setAttribute(eq("stt.confidence"), anyDouble());
        }
    }

    // -------------------------------------------------------------------------
    // Vision detection span — confidence threshold attribute
    // -------------------------------------------------------------------------

    @Nested
    @DisplayName("startVisionDetectionSpan — confidence threshold custom attribute")
    class StartVisionDetectionSpanTests {

        @Test
        @DisplayName("does not put detection ID in MDC")
        void shouldNotSetDetectionIdInMdc() {
            Span span = tracingService.startVisionDetectionSpan("det-001", "tenant-vis", 0.75);

            assertThat(span).isNotNull();
            assertThat(MDC.get("detectionId")).isNull();
        }

        @Test
        @DisplayName("does not put correlation ID in MDC")
        void shouldNotSetCorrelationIdInMdc() {
            tracingService.startVisionDetectionSpan("det-002", "tenant-v2", 0.5);

            assertThat(MDC.get("correlationId")).isNull();
        }

        @Test
        @DisplayName("does not throw for zero confidence threshold (detect everything)")
        void shouldHandleZeroConfidenceThreshold() {
            assertThatCode(() -> tracingService.startVisionDetectionSpan("det-003", "tenant-v3", 0.0))
                    .doesNotThrowAnyException();
        }

        @Test
        @DisplayName("does not throw for maximum confidence threshold 1.0")
        void shouldHandleMaxConfidenceThreshold() {
            assertThatCode(() -> tracingService.startVisionDetectionSpan("det-004", "tenant-v4", 1.0))
                    .doesNotThrowAnyException();
        }
    }

    // -------------------------------------------------------------------------
    // Vision detection result — null-safety
    // -------------------------------------------------------------------------

    @Nested
    @DisplayName("recordVisionDetectionResult — null-safety and NaN handling")
    class RecordVisionDetectionResultTests {

        @Test
        @DisplayName("is a no-op and does not throw when span is null")
        void shouldTolerateNullSpan() {
            assertThatCode(() -> tracingService.recordVisionDetectionResult(null, 3, 0.92))
                    .doesNotThrowAnyException();
        }

        @Test
        @DisplayName("does not throw when maxConfidence is NaN (no objects detected)")
        void shouldTolerateNaNMaxConfidence() {
            Span span = tracingService.startVisionDetectionSpan("det-nan", "tenant-nan", 0.5);

            assertThatCode(() -> tracingService.recordVisionDetectionResult(span, 0, Double.NaN))
                    .doesNotThrowAnyException();
        }

        @Test
        @DisplayName("does not throw for zero detectionCount with valid maxConfidence")
        void shouldHandleZeroDetections() {
            Span span = tracingService.startVisionDetectionSpan("det-zero", "tenant-z", 0.6);

            assertThatCode(() -> tracingService.recordVisionDetectionResult(span, 0, 0.0))
                    .doesNotThrowAnyException();
            verify(span).setAttribute("vision.detection_count", 0L);
            verify(span).setAttribute("vision.max_confidence", 0.0);
        }

        @Test
        @DisplayName("omits invalid detection counts and provider confidence")
        void shouldOmitInvalidDetectionTelemetry() {
            Span span = tracingService.startVisionDetectionSpan("det-invalid", "tenant-invalid", 0.5);

            tracingService.recordVisionDetectionResult(span, -1, Double.POSITIVE_INFINITY);

            verify(span, never()).setAttribute(eq("vision.detection_count"), anyLong());
            verify(span, never()).setAttribute(eq("vision.max_confidence"), anyDouble());
        }
    }
}
