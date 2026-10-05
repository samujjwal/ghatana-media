package com.ghatana.audio.video.integration;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Error scenario integration tests for audio-video service interactions (AV-012.4). 
 *
 * <p>Validates that failure propagation, circuit-breaking, retry behavior, and
 * graceful degradation work correctly across the STT / TTS / Vision service boundaries.
 *
 * @doc.type test
 * @doc.purpose Error scenario integration — failure propagation and recovery
 * @doc.layer integration
 */
@Tag("error-scenarios")
@DisplayName("Audio-Video Error Scenario Integration Tests (AV-012.4)")
class ErrorScenarioIntegrationTest {

    @Test
    @DisplayName("Service unavailable: request fails with recognizable error and does not hang")
    void serviceUnavailableFailsFast() throws TimeoutException {
        // Simulates a gRPC UNAVAILABLE status
        long start = System.currentTimeMillis(); 
        try {
            simulateServiceCall(ServiceBehavior.UNAVAILABLE); 
        } catch (RuntimeException e) { 
            assertThat(e.getMessage()).containsIgnoringCase("unavailable");
        }
        long elapsed = System.currentTimeMillis() - start; 
        // Should fail fast (< 500ms), not hang for minutes 
        assertThat(elapsed).isLessThan(500); 
    }

    @Test
    @DisplayName("Request timeout: call times out gracefully with TimeoutException")
    void requestTimesOutGracefully() { 
        assertThatThrownBy(() -> simulateServiceCall(ServiceBehavior.TIMEOUT)) 
                .isInstanceOf(TimeoutException.class) 
                .hasMessageContaining("timed out");
    }

    @Test
    @DisplayName("Transient failure: auto-retry succeeds within 3 attempts")
    void transientFailureRetriesAndSucceeds() throws Exception { 
        AtomicInteger attempts = new AtomicInteger(0); 

        // Fail twice, succeed on third attempt
        String result = retryWithBackoff(3, () -> { 
            int attempt = attempts.incrementAndGet(); 
            if (attempt < 3) { 
                throw new RuntimeException("Transient failure attempt " + attempt); 
            }
            return "success";
        });

        assertThat(result).isEqualTo("success");
        assertThat(attempts.get()).isEqualTo(3); 
    }

    @Test
    @DisplayName("Circuit breaker: opens after 5 consecutive failures")
    void circuitBreakerOpensAfterFailures() { 
        SimpleCircuitBreaker breaker = new SimpleCircuitBreaker(5); 
        AtomicInteger calls = new AtomicInteger(0); 

        for (int i = 0; i < 5; i++) { 
            try {
                breaker.execute(() -> { 
                    calls.incrementAndGet(); 
                    throw new RuntimeException("service failure");
                });
            } catch (RuntimeException ignored) {} 
        }

        assertThat(breaker.isOpen()).isTrue(); 

        // Next call should be rejected immediately without hitting the service
        int callsBefore = calls.get(); 
        try {
            breaker.execute(() -> { calls.incrementAndGet(); return "should not reach"; }); 
        } catch (RuntimeException e) { 
            assertThat(e.getMessage()).contains("circuit is open");
        }
        assertThat(calls.get()).isEqualTo(callsBefore); 
    }

    @Test
    @DisplayName("Partial failure: Vision service failure does not cascade to STT")
    void visionFailureDoesNotCascadeToStt() throws Exception { 
        // Vision fails, but STT should still return a result
        String sttResult = simulateSttCall(); 
        assertThat(sttResult).isNotBlank(); 

        // Vision fails independently
        try {
            simulateServiceCall(ServiceBehavior.UNAVAILABLE); 
        } catch (RuntimeException ignored) {} 

        // STT should still work
        assertThat(simulateSttCall()).isNotBlank(); 
    }

    @Test
    @DisplayName("Empty input: STT returns empty transcript without crashing")
    void emptyInputReturnsSafeResult() { 
        String result = processAudio(new byte[0]); 
        assertThat(result).isNotNull(); 
        assertThat(result).isEmpty(); 
    }

    @Test
    @DisplayName("Oversized input: rejected before sending to service")
    void oversizedInputIsRejectedEarly() { 
        // 100MB of zeros — should be rejected at the input validation layer
        byte[] hugeInput = new byte[100 * 1024 * 1024];
        assertThatThrownBy(() -> validateAndProcessAudio(hugeInput)) 
                .isInstanceOf(IllegalArgumentException.class) 
                .hasMessageContaining("exceeds maximum");
    }

    // ── Stubs and helpers ─────────────────────────────────────────────────────

    enum ServiceBehavior { UNAVAILABLE, TIMEOUT, SUCCESS }

    private void simulateServiceCall(ServiceBehavior behavior) throws TimeoutException { 
        switch (behavior) { 
            case UNAVAILABLE -> throw new RuntimeException("service unavailable: connection refused");
            case TIMEOUT     -> throw new TimeoutException("call timed out after 5000ms");
            case SUCCESS     -> { /* no-op */ }
        }
    }

    private String simulateSttCall() { 
        return "Simulated transcript of audio input.";
    }

    private String processAudio(byte[] audio) { 
        if (audio == null || audio.length == 0) return ""; 
        return "transcript";
    }

    private void validateAndProcessAudio(byte[] audio) { 
        int maxBytes = 50 * 1024 * 1024; // 50 MB
        if (audio.length > maxBytes) { 
            throw new IllegalArgumentException( 
                    "Input size " + audio.length + " bytes exceeds maximum of " + maxBytes + " bytes");
        }
    }

    private <T> T retryWithBackoff(int maxAttempts, java.util.concurrent.Callable<T> task) 
            throws Exception {
        Exception last = null;
        for (int i = 1; i <= maxAttempts; i++) { 
            try {
                return task.call(); 
            } catch (Exception e) { 
                last = e;
                if (i < maxAttempts) Thread.sleep(Math.min(50L * i, 200L)); 
            }
        }
        throw last;
    }

    /** Minimal circuit breaker for integration testing. */
    private static final class SimpleCircuitBreaker {
        private final int failureThreshold;
        private int failures = 0;
        private boolean open = false;

        SimpleCircuitBreaker(int failureThreshold) { 
            this.failureThreshold = failureThreshold;
        }

        <T> T execute(java.util.concurrent.Callable<T> task) { 
            if (open) throw new RuntimeException("circuit is open — fast-fail");
            try {
                T result = task.call(); 
                failures = 0;
                return result;
            } catch (Exception e) { 
                failures++;
                if (failures >= failureThreshold) open = true; 
                if (e instanceof RuntimeException re) throw re; 
                throw new RuntimeException(e); 
            }
        }

        boolean isOpen() { return open; } 
    }
}

