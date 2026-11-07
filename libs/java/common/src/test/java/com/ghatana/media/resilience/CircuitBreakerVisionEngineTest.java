package com.ghatana.media.resilience;

import com.ghatana.media.common.InferenceError;
import com.ghatana.media.vision.api.VisionEngine;
import com.ghatana.resilience.CircuitBreaker;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.concurrent.ExecutionException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

class CircuitBreakerVisionEngineTest {

    @Test
    void openCircuitRejectsSyncAsyncAndStreamingWithoutFakeSuccess() throws Exception {
        VisionEngine delegate = mock(VisionEngine.class);
        CircuitBreaker breaker = CircuitBreaker.builder("open-vision-test")
                .failureThreshold(1).resetTimeout(Duration.ofHours(1)).build();
        try {
            breaker.executeSync(() -> { throw new IllegalStateException("provider unavailable"); });
        } catch (RuntimeException expected) {
            // The failed probe opens the breaker before wrapper invocation.
        }
        CircuitBreakerVisionEngine protectedEngine = new CircuitBreakerVisionEngine(delegate, null, breaker);

        assertRetryableUnavailable(() -> protectedEngine.detect(null, null));
        assertRetryableUnavailable(() -> protectedEngine.caption(null));
        assertRetryableUnavailable(() -> protectedEngine.classify(null, 1));
        assertRetryableUnavailable(() -> protectedEngine.createStreamingSession(null, result -> { }));
        try {
            protectedEngine.detectAsync(null, null).toCompletableFuture().get();
            throw new AssertionError("open circuit should reject async detection");
        } catch (ExecutionException expected) {
            assertThat(expected.getCause()).isInstanceOf(InferenceError.class)
                    .satisfies(error -> assertThat(((InferenceError) error).isRetryable()).isTrue());
        }

        verify(delegate, never()).detect(any(), any());
        verify(delegate, never()).detectAsync(any(), any());
        verify(delegate, never()).caption(any());
        verify(delegate, never()).classify(any(), anyInt());
        verify(delegate, never()).createStreamingSession(any(), any());
    }

    private static void assertRetryableUnavailable(org.assertj.core.api.ThrowableAssert.ThrowingCallable call) {
        assertThatThrownBy(call).isInstanceOf(InferenceError.class)
                .satisfies(error -> assertThat(((InferenceError) error).isRetryable()).isTrue());
    }
}
