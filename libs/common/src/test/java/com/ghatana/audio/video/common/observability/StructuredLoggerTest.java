package com.ghatana.audio.video.common.observability;

import com.ghatana.media.common.ValidationError;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Unit tests for {@link StructuredLogger}.
 *
 * @doc.type class
 * @doc.purpose Tests for structured logging helpers and MDC lifecycle
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("StructuredLogger")
class StructuredLoggerTest {

    private static final org.slf4j.Logger LOG = LoggerFactory.getLogger(StructuredLoggerTest.class); 

    // ─── newCorrelationId() ─────────────────────────────────────────────────── 

    @Test
    @DisplayName("newCorrelationId() returns 8-char non-blank string")
    void newCorrelationId_returnsEightChars() { 
        String id = StructuredLogger.newCorrelationId(); 

        assertThat(id).hasSize(8).doesNotContainAnyWhitespaces(); 
    }

    @Test
    @DisplayName("two successive newCorrelationId() calls return different values")
    void newCorrelationId_uniqueValues() { 
        assertThat(StructuredLogger.newCorrelationId()) 
                .isNotEqualTo(StructuredLogger.newCorrelationId()); 
    }

    // ─── withContext(Runnable) ──────────────────────────────────────────────── 

    @Test
    @DisplayName("withContext(Runnable) sets MDC keys while block runs")
    void withContext_runnable_setsMdcDuringExecution() { 
        AtomicReference<String> capturedCid = new AtomicReference<>(); 
        AtomicReference<String> capturedSvc = new AtomicReference<>(); 
        AtomicReference<String> capturedOp  = new AtomicReference<>(); 

        StructuredLogger.withContext("abc12345", "stt-service", "transcribe", () -> { 
            capturedCid.set(MDC.get(StructuredLogger.MDC_CORRELATION_ID)); 
            capturedSvc.set(MDC.get(StructuredLogger.MDC_SERVICE)); 
            capturedOp.set(MDC.get(StructuredLogger.MDC_OPERATION)); 
        });

        assertThat(capturedCid.get()).isEqualTo("abc12345");
        assertThat(capturedSvc.get()).isEqualTo("stt-service");
        assertThat(capturedOp.get()).isEqualTo("transcribe");
    }

    @Test
    @DisplayName("withContext(Runnable) clears MDC keys after block completes")
    void withContext_runnable_clearsMdcAfterExecution() { 
        StructuredLogger.withContext("abc12345", "stt-service", "transcribe", () -> { 
            // no-op
        });

        assertThat(MDC.get(StructuredLogger.MDC_CORRELATION_ID)).isNull(); 
        assertThat(MDC.get(StructuredLogger.MDC_SERVICE)).isNull(); 
        assertThat(MDC.get(StructuredLogger.MDC_OPERATION)).isNull(); 
    }

    @Test
    @DisplayName("withContext(Runnable) clears MDC even when block throws")
    void withContext_runnable_clearsMdcOnException() { 
        try {
            StructuredLogger.withContext("err-id", "vision-service", "detect", () -> { 
                throw new RuntimeException("simulated failure");
            });
        } catch (RuntimeException ignored) { 
            // expected
        }

        assertThat(MDC.get(StructuredLogger.MDC_CORRELATION_ID)).isNull(); 
    }

    // ─── withContext(Supplier) ──────────────────────────────────────────────── 

    @Test
    @DisplayName("withContext(Supplier) returns the supplier result")
    void withContext_supplier_returnsResult() { 
        String result = StructuredLogger.withContext("abc", "svc", "op", () -> "hello"); 

        assertThat(result).isEqualTo("hello");
    }

    @Test
    @DisplayName("withContext(Supplier) clears MDC after returning result")
    void withContext_supplier_clearsMdcAfterReturn() { 
        StructuredLogger.withContext("abc", "svc", "op", () -> "result"); 

        assertThat(MDC.get(StructuredLogger.MDC_CORRELATION_ID)).isNull(); 
    }

    // ─── log methods — smoke tests (no assertion on log output, just verify no NPE) ── 

    @Test
    @DisplayName("logStarted() does not throw")
    void logStarted_doesNotThrow() { 
        StructuredLogger.logStarted(LOG, "transcribe"); 
    }

    @Test
    @DisplayName("logSucceeded() does not throw")
    void logSucceeded_doesNotThrow() { 
        StructuredLogger.logSucceeded(LOG, "transcribe", 42L); 
    }

    @Test
    @DisplayName("logFailed() with retryable error does not throw")
    void logFailed_retryableError_doesNotThrow() { 
        StructuredLogger.logFailed(LOG, "transcribe", 
                new com.ghatana.media.common.InferenceError("timeout", null, true)); 
    }

    @Test
    @DisplayName("logFailed() with non-retryable error does not throw")
    void logFailed_nonRetryableError_doesNotThrow() { 
        StructuredLogger.logFailed(LOG, "transcribe", new ValidationError("bad input"));
    }

    @Test
    @DisplayName("logFailed() with null throwable does not throw")
    void logFailed_nullThrowable_doesNotThrow() { 
        StructuredLogger.logFailed(LOG, "transcribe", null); 
    }

    @Test
    @DisplayName("logInvalid() does not throw")
    void logInvalid_doesNotThrow() { 
        StructuredLogger.logInvalid(LOG, "transcribe", "audio data empty"); 
    }
}
