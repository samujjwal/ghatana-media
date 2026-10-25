package com.ghatana.audiovideo.observability.tracing;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;
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

    // -------------------------------------------------------------------------
    // STT transcription span — do not copy identifiers or content tags into log MDC
    // -------------------------------------------------------------------------

    @Nested
    @DisplayName("startTranscriptionSpan — redacted log context")
    class StartTranscriptionSpanTests {

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
        }
    }
}
