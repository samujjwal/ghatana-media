package com.ghatana.media.resilience;

import com.ghatana.media.common.AudioChunk;
import com.ghatana.media.common.InferenceError;
import com.ghatana.media.tts.api.SynthesisOptions;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.resilience.CircuitBreaker;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.ExecutionException;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.never;

class CircuitBreakerTtsEngineTest {

    @Test
    void openCircuitRejectsSyncAndAsyncSynthesisWithoutCallingDelegate() throws Exception {
        TtsEngine delegate = mock(TtsEngine.class);
        CircuitBreaker breaker = CircuitBreaker.builder("open-tts-synthesis-test")
                .failureThreshold(1).resetTimeout(Duration.ofHours(1)).build();
        try {
            breaker.executeSync(() -> { throw new IllegalStateException("provider unavailable"); });
        } catch (RuntimeException expected) {
            // The failed probe opens the breaker before wrapper invocation.
        }
        CircuitBreakerTtsEngine protectedEngine = new CircuitBreakerTtsEngine(delegate, null, breaker);

        assertThatThrownBy(() -> protectedEngine.synthesize("hello", SynthesisOptions.defaults()))
                .isInstanceOf(InferenceError.class)
                .satisfies(error -> assertThat(((InferenceError) error).isRetryable()).isTrue());
        try {
            protectedEngine.synthesizeAsync("hello", SynthesisOptions.defaults()).toCompletableFuture().get();
            throw new AssertionError("open circuit should reject async synthesis");
        } catch (ExecutionException expected) {
            assertThat(expected.getCause()).isInstanceOf(InferenceError.class)
                    .satisfies(error -> assertThat(((InferenceError) error).isRetryable()).isTrue());
        }
        verify(delegate, never()).synthesize(anyString(), any());
        verify(delegate, never()).synthesizeAsync(anyString(), any());
    }

    @Test
    void openCircuitFailsStreamingWithoutEmittingFakeTerminalChunk() {
        TtsEngine delegate = mock(TtsEngine.class);
        CircuitBreaker breaker = CircuitBreaker.builder("open-tts-stream-test")
                .failureThreshold(1)
                .resetTimeout(Duration.ofHours(1))
                .build();
        try {
            breaker.executeSync(() -> {
                throw new IllegalStateException("provider unavailable");
            });
        } catch (RuntimeException expected) {
            // The failed probe opens the breaker before wrapper invocation.
        }
        assertThat(breaker.getState()).isEqualTo(CircuitBreaker.State.OPEN);

        CircuitBreakerTtsEngine protectedEngine =
                new CircuitBreakerTtsEngine(delegate, null, breaker);
        List<AudioChunk> chunks = new ArrayList<>();

        assertThatThrownBy(() -> protectedEngine.synthesizeStreaming(
                "hello", SynthesisOptions.defaults(), chunks::add))
                .isInstanceOf(InferenceError.class)
                .hasMessageContaining("was not attempted")
                .satisfies(error -> assertThat(((InferenceError) error).isRetryable()).isTrue());

        assertThat(chunks).isEmpty();
        verify(delegate, never()).synthesizeStreaming(anyString(), any(), any());
    }

    @Test
    void closedCircuitForwardsOnlyDelegateChunks() {
        TtsEngine delegate = mock(TtsEngine.class);
        AudioChunk providerChunk = new AudioChunk(new byte[]{1, 2}, 0, true, 17L);
        AtomicBoolean called = new AtomicBoolean();
        doAnswer(invocation -> {
            called.set(true);
            Consumer<AudioChunk> consumer = invocation.getArgument(2);
            consumer.accept(providerChunk);
            return null;
        }).when(delegate).synthesizeStreaming(anyString(), any(), any());

        CircuitBreakerTtsEngine protectedEngine = new CircuitBreakerTtsEngine(
                delegate,
                null,
                CircuitBreaker.builder("closed-tts-stream-test").failureThreshold(2).build());
        List<AudioChunk> chunks = new ArrayList<>();
        protectedEngine.synthesizeStreaming("hello", SynthesisOptions.defaults(), chunks::add);

        assertThat(called).isTrue();
        assertThat(chunks).containsExactly(providerChunk);
        verify(delegate).synthesizeStreaming(anyString(), any(), any());
    }
}
