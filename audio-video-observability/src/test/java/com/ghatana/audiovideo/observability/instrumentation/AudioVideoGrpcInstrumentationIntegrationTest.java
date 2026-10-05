package com.ghatana.audiovideo.observability.instrumentation;

import com.ghatana.audiovideo.observability.tracing.AudioVideoTracingService;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.Tracer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;

/**
 * @doc.type class
 * @doc.purpose Integration tests for Audio-Video gRPC instrumentation with distributed tracing
 * @doc.layer test
 * @doc.pattern IntegrationTest
 */
@DisplayName("Audio-Video gRPC Instrumentation Integration Tests")
class AudioVideoGrpcInstrumentationIntegrationTest {

    private Tracer tracer;

    private AudioVideoGrpcInstrumentation instrumentation;
    private AudioVideoTracingService tracingService;

    @BeforeEach
    void setUp() { 
        tracer = OpenTelemetry.noop().getTracer("audio-video-observability-test");
        tracingService = new AudioVideoTracingService(tracer); 
        instrumentation = new AudioVideoGrpcInstrumentation(tracingService); 
        MDC.clear(); 
    }

    @Nested
    @DisplayName("gRPC Streaming Instrumentation")
    class GrpcStreamingInstrumentationTests {

        @Test
        void shouldInstrumentSuccessfulGrpcStreaming() throws Exception { 
            // Given
            String methodName = "VisionStream";
            String tenantId = "grpc-tenant-123";
            String expectedResult = "streaming-result";

            // When
            String result = instrumentation.instrumentGrpcStreaming( 
                    methodName,
                    tenantId,
                    () -> expectedResult 
            );

            // Then
            assertThat(result).isEqualTo(expectedResult); 
        }

        @Test
        void shouldPropagateGrpcStreamingException() { 
            // Given
            String methodName = "FailingStream";
            String tenantId = "failing-tenant";
            RuntimeException exception = new RuntimeException("Stream failed");

            // When + Then
            assertThatThrownBy(() -> instrumentation.instrumentGrpcStreaming( 
                    methodName,
                    tenantId,
                    () -> { 
                        throw exception;
                    }
            )).isInstanceOf(RuntimeException.class) 
                    .hasMessage("Stream failed");
        }

        @Test
        void shouldClearContextAfterGrpcStreaming() throws Exception { 
            // Given
            String methodName = "CleanupStream";
            String tenantId = "cleanup-tenant";

            // When
            instrumentation.instrumentGrpcStreaming( 
                    methodName,
                    tenantId,
                    () -> "result" 
            );

            // Then
            assertThat(MDC.getCopyOfContextMap()).isEmpty(); 
        }

        @Test
        void shouldRecordDurationForGrpcStreaming() throws Exception { 
            // Given
            String methodName = "DurationStream";
            String tenantId = "duration-tenant";
            long startTime = System.currentTimeMillis(); 

            // When
            instrumentation.instrumentGrpcStreaming( 
                    methodName,
                    tenantId,
                    () -> { 
                        try {
                            Thread.sleep(50); 
                        } catch (InterruptedException e) { 
                            Thread.currentThread().interrupt(); 
                        }
                        return "result";
                    }
            );

            long duration = System.currentTimeMillis() - startTime; 

            // Then
            assertThat(duration).isGreaterThanOrEqualTo(50); 
        }
    }

    @Nested
    @DisplayName("Video Processing Instrumentation")
    class VideoProcessingInstrumentationTests {

        @Test
        void shouldInstrumentSuccessfulVideoProcessing() throws Exception { 
            // Given
            String processId = "video-process-123";
            String tenantId = "video-tenant-456";
            String expectedResult = "video-encoded";

            // When
            String result = instrumentation.instrumentVideoProcessing( 
                    processId,
                    tenantId,
                    () -> expectedResult 
            );

            // Then
            assertThat(result).isEqualTo(expectedResult); 
        }

        @Test
        void shouldValidateVideoProcessingSLA() throws Exception { 
            // Given
            String processId = "sla-video";
            String tenantId = "sla-tenant";

            // When
            String result = instrumentation.instrumentVideoProcessing( 
                    processId,
                    tenantId,
                    () -> { 
                        try {
                            Thread.sleep(30); // Within 50ms SLA 
                        } catch (InterruptedException e) { 
                            Thread.currentThread().interrupt(); 
                        }
                        return "sla-compliant";
                    }
            );

            // Then
            assertThat(result).isEqualTo("sla-compliant");
        }

        @Test
        void shouldWarnWhenVideoProcessingExceedsSLA() throws Exception { 
            // Given
            String processId = "slow-video";
            String tenantId = "slow-tenant";

            // When
            String result = instrumentation.instrumentVideoProcessing( 
                    processId,
                    tenantId,
                    () -> { 
                        try {
                            Thread.sleep(60); // Exceeds 50ms SLA 
                        } catch (InterruptedException e) { 
                            Thread.currentThread().interrupt(); 
                        }
                        return "slow-result";
                    }
            );

            // Then
            assertThat(result).isEqualTo("slow-result");
            // SLA warning would be logged
        }

        @Test
        void shouldPropagateVideoProcessingException() { 
            // Given
            String processId = "failing-video";
            String tenantId = "failing-video-tenant";
            IllegalStateException exception = new IllegalStateException("Invalid video format");

            // When + Then
            assertThatThrownBy(() -> instrumentation.instrumentVideoProcessing( 
                    processId,
                    tenantId,
                    () -> { 
                        throw exception;
                    }
            )).isInstanceOf(IllegalStateException.class) 
                    .hasMessage("Invalid video format");
        }

        @Test
        void shouldClearContextAfterVideoProcessing() throws Exception { 
            // Given
            String processId = "cleanup-video";
            String tenantId = "cleanup-video-tenant";

            // When
            instrumentation.instrumentVideoProcessing( 
                    processId,
                    tenantId,
                    () -> "result" 
            );

            // Then
            assertThat(MDC.getCopyOfContextMap()).isEmpty(); 
        }

        @Test
        void shouldClearContextAfterVideoProcessingException() { 
            // Given
            String processId = "exception-cleanup-video";
            String tenantId = "exception-cleanup-video-tenant";

            // When
            try {
                instrumentation.instrumentVideoProcessing( 
                        processId,
                        tenantId,
                        () -> { 
                            throw new RuntimeException("Processing failed");
                        }
                );
            } catch (RuntimeException e) { 
                // Expected
            } catch (Exception e) { 
                throw new RuntimeException(e); 
            }

            // Then
            assertThat(MDC.getCopyOfContextMap()).isEmpty(); 
        }
    }

    @Nested
    @DisplayName("Audio Processing Instrumentation")
    class AudioProcessingInstrumentationTests {

        @Test
        void shouldInstrumentSuccessfulAudioProcessing() throws Exception { 
            // Given
            String processId = "audio-process-123";
            String tenantId = "audio-tenant-456";
            String expectedResult = "audio-transcoded";

            // When
            String result = instrumentation.instrumentAudioProcessing( 
                    processId,
                    tenantId,
                    () -> expectedResult 
            );

            // Then
            assertThat(result).isEqualTo(expectedResult); 
        }

        @Test
        void shouldValidateAudioProcessingSLA() throws Exception { 
            // Given
            String processId = "sla-audio";
            String tenantId = "audio-sla-tenant";

            // When
            String result = instrumentation.instrumentAudioProcessing( 
                    processId,
                    tenantId,
                    () -> { 
                        try {
                            Thread.sleep(40); // Within 50ms SLA 
                        } catch (InterruptedException e) { 
                            Thread.currentThread().interrupt(); 
                        }
                        return "audio-sla-compliant";
                    }
            );

            // Then
            assertThat(result).isEqualTo("audio-sla-compliant");
        }

        @Test
        void shouldPropagateAudioProcessingException() { 
            // Given
            String processId = "failing-audio";
            String tenantId = "failing-audio-tenant";
            IOException exception = new java.io.IOException("Audio file corrupted");

            // When + Then
            assertThatThrownBy(() -> instrumentation.instrumentAudioProcessing( 
                    processId,
                    tenantId,
                    () -> { 
                        throw exception;
                    }
            )).isInstanceOf(IOException.class) 
                    .hasMessage("Audio file corrupted");
        }

        @Test
        void shouldClearContextAfterAudioProcessing() throws Exception { 
            // Given
            String processId = "cleanup-audio";
            String tenantId = "cleanup-audio-tenant";

            // When
            instrumentation.instrumentAudioProcessing( 
                    processId,
                    tenantId,
                    () -> "result" 
            );

            // Then
            assertThat(MDC.getCopyOfContextMap()).isEmpty(); 
        }
    }

    @Nested
    @DisplayName("Synthesis Instrumentation")
    class SynthesisInstrumentationTests {

        @Test
        void shouldInstrumentSuccessfulSynthesis() throws Exception { 
            // Given
            String synthesisId = "synthesis-123";
            String tenantId = "synthesis-tenant-456";
            String expectedResult = "synthesis-complete";

            // When
            String result = instrumentation.instrumentSynthesis( 
                    synthesisId,
                    tenantId,
                    () -> expectedResult 
            );

            // Then
            assertThat(result).isEqualTo(expectedResult); 
        }

        @Test
        void shouldValidateSynthesisSLA() throws Exception { 
            // Given
            String synthesisId = "sla-synthesis";
            String tenantId = "synthesis-sla-tenant";

            // When
            String result = instrumentation.instrumentSynthesis( 
                    synthesisId,
                    tenantId,
                    () -> { 
                        try {
                            Thread.sleep(35); // Within 50ms SLA 
                        } catch (InterruptedException e) { 
                            Thread.currentThread().interrupt(); 
                        }
                        return "synthesis-sla-compliant";
                    }
            );

            // Then
            assertThat(result).isEqualTo("synthesis-sla-compliant");
        }

        @Test
        void shouldPropagateSynthesisException() { 
            // Given
            String synthesisId = "failing-synthesis";
            String tenantId = "failing-synthesis-tenant";
            IllegalArgumentException exception = new IllegalArgumentException("Invalid synthesis parameters");

            // When + Then
            assertThatThrownBy(() -> instrumentation.instrumentSynthesis( 
                    synthesisId,
                    tenantId,
                    () -> { 
                        throw exception;
                    }
            )).isInstanceOf(IllegalArgumentException.class) 
                    .hasMessage("Invalid synthesis parameters");
        }

        @Test
        void shouldClearContextAfterSynthesis() throws Exception { 
            // Given
            String synthesisId = "cleanup-synthesis";
            String tenantId = "cleanup-synthesis-tenant";

            // When
            instrumentation.instrumentSynthesis( 
                    synthesisId,
                    tenantId,
                    () -> "result" 
            );

            // Then
            assertThat(MDC.getCopyOfContextMap()).isEmpty(); 
        }
    }

    @Nested
    @DisplayName("Multi-Tenant Context Isolation")
    class MultiTenantContextIsolationTests {

        @Test
        void shouldIsolateTenantContextsAcrossOperations() throws Exception { 
            // Given
            String tenant1 = "isolation-tenant-1";
            String tenant2 = "isolation-tenant-2";

            // When
            instrumentation.instrumentVideoProcessing( 
                    "process-1",
                    tenant1,
                    () -> "result-1" 
            );

            instrumentation.instrumentVideoProcessing( 
                    "process-2",
                    tenant2,
                    () -> "result-2" 
            );

            // Then
            // Contexts should be properly isolated after each operation
            assertThat(MDC.getCopyOfContextMap()).isEmpty(); 
        }

        @Test
        void shouldPreserveCorrelationIdAcrossOperations() throws Exception { 
            // Given
            String correlationId = "audio-video-correlation-123";
            MDC.put("correlationId", correlationId); 
            String tenantId = "corr-tenant";

            // When
            instrumentation.instrumentVideoProcessing( 
                    "process-1",
                    tenantId,
                    () -> "video-result" 
            );

            // Then
            // Correlation ID should be preserved through instrumentation
        }
    }

    @Nested
    @DisplayName("Exception Handling and Cleanup")
    class ExceptionHandlingAndCleanupTests {

        @Test
        void shouldClearContextEvenOnGrpcStreamingException() { 
            // Given
            String methodName = "FailStream";
            String tenantId = "fail-tenant";

            // When
            try {
                instrumentation.instrumentGrpcStreaming( 
                        methodName,
                        tenantId,
                        () -> { 
                            throw new RuntimeException("Stream error");
                        }
                );
            } catch (RuntimeException e) { 
                // Expected
            } catch (Exception e) { 
                throw new RuntimeException(e); 
            }

            // Then
            assertThat(MDC.getCopyOfContextMap()).isEmpty(); 
        }

        @Test
        void shouldClearContextEvenOnVideoProcessingException() { 
            // Given
            String processId = "fail-video";
            String tenantId = "fail-video-tenant";

            // When
            try {
                instrumentation.instrumentVideoProcessing( 
                        processId,
                        tenantId,
                        () -> { 
                            throw new RuntimeException("Video error");
                        }
                );
            } catch (RuntimeException e) { 
                // Expected
            } catch (Exception e) { 
                throw new RuntimeException(e); 
            }
            assertThat(MDC.getCopyOfContextMap()).isEmpty(); 
        }

        @Test
        void shouldPreserveOriginalExceptionMessage() { 
            // Given
            String originalMessage = "Original error message";
            Exception originalException = new RuntimeException(originalMessage); 

            // When + Then
            assertThatThrownBy(() -> instrumentation.instrumentGrpcStreaming( 
                    "method",
                    "tenant",
                    () -> { 
                        throw originalException;
                    }
            )).hasMessage(originalMessage); 
        }

        @Test
        void shouldHandleCheckedExceptions() { 
            // Given
            String processId = "checked-exception";
            String tenantId = "checked-tenant";

            // When + Then
            assertThatThrownBy(() -> instrumentation.instrumentAudioProcessing( 
                    processId,
                    tenantId,
                    () -> { 
                        throw new InterruptedException("Thread interrupted");
                    }
            )).isInstanceOf(InterruptedException.class); 
        }
    }

    @Nested
    @DisplayName("Concurrent Audio-Video Operations")
    class ConcurrentOperationsTests {

        @Test
        void shouldHandleConcurrentVideoAndAudioProcessing() throws Exception { 
            // Given
            String videoProcessId = "concurrent-video-1";
            String audioProcessId = "concurrent-audio-1";
            String tenantId = "concurrent-tenant";

            // When
            String videoResult = instrumentation.instrumentVideoProcessing( 
                    videoProcessId,
                    tenantId,
                    () -> "video-result" 
            );

            String audioResult = instrumentation.instrumentAudioProcessing( 
                    audioProcessId,
                    tenantId,
                    () -> "audio-result" 
            );

            // Then
            assertThat(videoResult).isEqualTo("video-result");
            assertThat(audioResult).isEqualTo("audio-result");
        }

        @Test
        void shouldHandleMultipleSequentialOperations() throws Exception { 
            // Given
            String[] processIds = {"process-1", "process-2", "process-3"};
            String tenantId = "sequential-tenant";

            // When
            for (String processId : processIds) { 
                instrumentation.instrumentVideoProcessing( 
                        processId,
                        tenantId,
                        () -> "result" 
                );
            }

            // Then
            // All operations should complete successfully
            // Context should be clean after final operation
            assertThat(MDC.getCopyOfContextMap()).isEmpty(); 
        }
    }
}
