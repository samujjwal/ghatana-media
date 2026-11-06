package com.ghatana.media.tts.engine.onnx;

import org.junit.jupiter.api.Test;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
}
