package com.ghatana.media.tts.engine.onnx;

import ai.onnxruntime.OnnxTensor;
import org.junit.jupiter.api.Test;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class PiperOnnxEngineLifecycleTest {

    @Test
    void sessionCloseFailureDoesNotLeakEnvironmentOrExecutor() {
        AtomicBoolean environmentClosed = new AtomicBoolean();
        ExecutorService executor = Executors.newSingleThreadExecutor();

        PiperOnnxEngine.closeResources(
                () -> { throw new Exception("session close failed"); },
                () -> environmentClosed.set(true),
                executor);

        assertThat(environmentClosed).isTrue();
        assertThat(executor.isShutdown()).isTrue();
    }

    @Test
    void sessionCloseErrorPropagatesAfterEnvironmentAndExecutorCleanup() {
        AtomicBoolean environmentClosed = new AtomicBoolean();
        ExecutorService executor = Executors.newSingleThreadExecutor();
        AssertionError nativeLinkFailure = new AssertionError("native link failed");

        assertThatThrownBy(() -> PiperOnnxEngine.closeResources(
                () -> { throw nativeLinkFailure; },
                () -> environmentClosed.set(true),
                executor))
                .isSameAs(nativeLinkFailure);

        assertThat(environmentClosed).isTrue();
        assertThat(executor.isShutdown()).isTrue();
    }

    @Test
    void inferenceTensorCloseFailureDoesNotSkipRemainingNativeInputs() throws Exception {
        OnnxTensor input = mock(OnnxTensor.class);
        OnnxTensor lengths = mock(OnnxTensor.class);
        OnnxTensor scales = mock(OnnxTensor.class);
        RuntimeException nativeCloseFailure = new IllegalStateException("tensor close failed");
        RuntimeException secondCloseFailure = new IllegalArgumentException("second tensor close failed");
        doThrow(nativeCloseFailure).when(input).close();
        doThrow(secondCloseFailure).when(lengths).close();

        assertThatThrownBy(() -> PiperOnnxEngine.closeInferenceTensors(null, input, lengths, scales, null))
                .isSameAs(nativeCloseFailure);

        verify(input).close();
        verify(lengths).close();
        verify(scales).close();
        assertThat(nativeCloseFailure.getSuppressed()).containsExactly(secondCloseFailure);
    }
}
