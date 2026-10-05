package com.ghatana.audio.video.common.resilience;

import com.ghatana.media.resilience.CircuitBreakerVisionEngine;
import com.ghatana.media.vision.api.VisionEngine;
import com.ghatana.media.common.ImageData;
import com.ghatana.media.common.ColorSpace;
import com.ghatana.media.common.ImageFormat;
import com.ghatana.media.common.EngineMetrics;
import com.ghatana.media.vision.api.DetectionResult;
import com.ghatana.media.vision.api.DetectionOptions;
import com.ghatana.resilience.CircuitBreaker;
import io.activej.eventloop.Eventloop;
import io.activej.promise.Promise;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.atMostOnce;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Resilience pattern tests for the Vision circuit breaker (AV-P2-02). 
 *
 * <p>Verifies the circuit breaker open → half-open → closed lifecycle and that
 * degraded empty responses are returned when the circuit is open (cascade failure prevention). 
 *
 * @doc.type class
 * @doc.purpose Circuit breaker resilience tests for Vision engine cascading failure prevention (AV-P2-02) 
 * @doc.layer test
 * @doc.pattern Test
 */
@ExtendWith(MockitoExtension.class) 
@DisplayName("Vision Engine Circuit Breaker Resilience Tests (AV-P2-02)")
class VisionCircuitBreakerResilienceTest {

    @Mock
    private VisionEngine mockEngine;

    private Eventloop eventloop;
    private CircuitBreaker circuitBreaker;
    private CircuitBreakerVisionEngine protectedEngine;

    private static final ImageData DUMMY_IMAGE =
            new ImageData(new byte[]{1, 2, 3, 4}, 2, 2, ImageFormat.JPEG, ColorSpace.RGB); 

    @BeforeEach
    void setUp() { 
        eventloop = Eventloop.create(); 

        circuitBreaker = CircuitBreaker.builder("vision-test-circuit")
                .failureThreshold(3) 
                .successThreshold(1) 
                .resetTimeout(java.time.Duration.ofMillis(200)) // fast for tests 
                .maxBackoff(java.time.Duration.ofSeconds(2)) 
                .backoffMultiplier(1.0) 
                .build(); 

        protectedEngine = new CircuitBreakerVisionEngine(mockEngine, eventloop, circuitBreaker); 

        // Default stub for getMetrics (always needed by getMetrics()) 
        lenient().when(mockEngine.getMetrics()).thenReturn( 
                new EngineMetrics(0, 0, 0.0, 0, 0)); 
    }

    @Test
    @DisplayName("Circuit stays CLOSED and delegates to engine on success")
    void shouldDelegateToEngineWhenCircuitClosed() { 
        var emptyResult = new DetectionResult(List.of(), 0, 0, 0L, "ok"); 
        when(mockEngine.detect(any(), any())).thenReturn(emptyResult); 

        var result = protectedEngine.detect(DUMMY_IMAGE, DetectionOptions.defaults()); 

        assertThat(protectedEngine.getCircuitBreakerState()).isEqualTo(CircuitBreaker.State.CLOSED); 
        assertThat(result.modelId()).isEqualTo("ok");
    }

    @Test
    @DisplayName("Circuit opens after reaching failure threshold")
    void shouldOpenAfterFailureThreshold() { 
        when(mockEngine.detect(any(), any())) 
                .thenThrow(new RuntimeException("upstream failure #1"))
                .thenThrow(new RuntimeException("upstream failure #2"))
                .thenThrow(new RuntimeException("upstream failure #3"));

        for (int i = 0; i < 3; i++) { 
            try {
                protectedEngine.detect(DUMMY_IMAGE, DetectionOptions.defaults()); 
            } catch (RuntimeException ignored) { 
                // each individual failure propagates — that's expected
            }
        }

        assertThat(protectedEngine.getCircuitBreakerState()).isEqualTo(CircuitBreaker.State.OPEN); 
    }

    @Test
    @DisplayName("Returns degraded empty result when circuit is OPEN (cascade prevention)")
    void shouldReturnDegradedResultWhenCircuitOpen() { 
        when(mockEngine.detect(any(), any())) 
                .thenThrow(new RuntimeException("service down"));

        // Trip the circuit
        for (int i = 0; i < 3; i++) { 
            try {
                protectedEngine.detect(DUMMY_IMAGE, DetectionOptions.defaults()); 
            } catch (RuntimeException ignored) {} 
        }
        assertThat(protectedEngine.getCircuitBreakerState()).isEqualTo(CircuitBreaker.State.OPEN); 

        // Next call should fast-fail with degraded response (not propagate exception) 
        var result = protectedEngine.detect(DUMMY_IMAGE, DetectionOptions.defaults()); 

        assertThat(result).isNotNull(); 
        assertThat(result.objects()).isEmpty(); 
        assertThat(result.modelId()).isEqualTo("degraded");
    }

    @Test
    @DisplayName("Circuit transitions to CLOSED after successful probe in HALF_OPEN")
    void shouldRecoverAfterHalfOpenProbeSucceeds() throws InterruptedException { 
        when(mockEngine.detect(any(), any())) 
                .thenThrow(new RuntimeException("down"))
                .thenThrow(new RuntimeException("down"))
                .thenThrow(new RuntimeException("down"))
                // Recovery call succeeds
                .thenReturn(new DetectionResult(List.of(), 0, 0, 0L, "recovered")); 

        for (int i = 0; i < 3; i++) { 
            try {
                protectedEngine.detect(DUMMY_IMAGE, DetectionOptions.defaults()); 
            } catch (RuntimeException ignored) {} 
        }
        assertThat(protectedEngine.getCircuitBreakerState()).isEqualTo(CircuitBreaker.State.OPEN); 

        // Wait for reset timeout to expire → circuit becomes HALF_OPEN
        Thread.sleep(300); 

        // Single probe call succeeds → circuit closes
        var result = protectedEngine.detect(DUMMY_IMAGE, DetectionOptions.defaults()); 

        assertThat(result.modelId()).isEqualTo("recovered");
        assertThat(protectedEngine.getCircuitBreakerState()).isEqualTo(CircuitBreaker.State.CLOSED); 
    }

    @Test
    @DisplayName("getMetrics merges circuit breaker rejections into engine metrics")
    void shouldMergeCircuitBreakerRejectionsIntoMetrics() { 
        when(mockEngine.getMetrics()).thenReturn( 
                new EngineMetrics(10, 0, 50.0, 1, 0)); 
        when(mockEngine.detect(any(), any())) 
                .thenThrow(new RuntimeException("down"))
                .thenThrow(new RuntimeException("down"))
                .thenThrow(new RuntimeException("down"));

        for (int i = 0; i < 3; i++) { 
            try {
                protectedEngine.detect(DUMMY_IMAGE, DetectionOptions.defaults()); 
            } catch (RuntimeException ignored) {} 
        }
        // One additional call after circuit opens → rejection (returns degraded, no exception) 
        protectedEngine.detect(DUMMY_IMAGE, DetectionOptions.defaults()); 

        EngineMetrics metrics = protectedEngine.getMetrics(); 

        assertThat(metrics.requestCount()).isEqualTo(10); 
        assertThat(metrics.errorCount()).isGreaterThanOrEqualTo(3); 
        assertThat(metrics.activeRequests()).isGreaterThanOrEqualTo(1); // rejections stored here 
    }
}





