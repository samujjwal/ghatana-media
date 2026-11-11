package com.ghatana.media.stt.engine.native_whisper;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WhisperNativeModelTest {
    @Test
    void closeWaitsForAdapterUseBeforeDisposingPointerAndRejectsFurtherUse() throws Exception {
        AtomicInteger disposeCount = new AtomicInteger();
        AtomicLong disposedPointer = new AtomicLong();
        WhisperNativeModel model = new WhisperNativeModel(42L, pointer -> {
            disposedPointer.set(pointer);
            disposeCount.incrementAndGet();
        });
        var closer = Executors.newSingleThreadExecutor();
        CountDownLatch closeStarted = new CountDownLatch(1);
        AtomicReference<Thread> closeThread = new AtomicReference<>();

        try (WhisperNativeModel.Use use = model.acquire()) {
            assertThat(use.pointer()).isEqualTo(42L);
            assertThatThrownBy(() -> closer.submit(use::pointer).get(5, TimeUnit.SECONDS))
                    .hasCauseInstanceOf(IllegalMonitorStateException.class)
                    .hasRootCauseMessage("Whisper model pointer must be used by its lease owner");

            var close = closer.submit(() -> {
                closeThread.set(Thread.currentThread());
                closeStarted.countDown();
                model.close(() -> {});
            });
            assertThat(closeStarted.await(5, TimeUnit.SECONDS)).isTrue();
            awaitWaiting(closeThread);
            assertThat(disposeCount).hasValue(0);

            use.close();
            close.get(5, TimeUnit.SECONDS);
        } finally {
            closer.shutdownNow();
        }

        model.close(() -> {});
        assertThat(disposeCount).hasValue(1);
        assertThat(disposedPointer).hasValue(42L);
        assertThatThrownBy(model::acquire)
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Whisper engine is closed");
    }

    @Test
    void closingUsePreventsLaterPointerAccess() {
        WhisperNativeModel model = new WhisperNativeModel(7L, ignored -> {});
        WhisperNativeModel.Use use = model.acquire();

        use.close();
        use.close();

        assertThatThrownBy(use::pointer)
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Whisper model use is closed");
        model.close(() -> {});
    }

    private static void awaitWaiting(AtomicReference<Thread> threadRef) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            Thread thread = threadRef.get();
            if (thread != null && thread.getState() == Thread.State.WAITING) return;
            Thread.yield();
        }
        throw new AssertionError("close did not queue behind the active Whisper model use");
    }
}
