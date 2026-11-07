package com.ghatana.media.stt.engine.native_whisper;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class NativeModelLifecycleTest {
    @Test
    void queuedClosePreventsLaterReadersFromOvertakingIt() throws Exception {
        NativeModelLifecycle lifecycle = new NativeModelLifecycle();
        var executor = Executors.newFixedThreadPool(2);
        AtomicReference<Thread> closeThread = new AtomicReference<>();

        try (NativeModelLifecycle.Lease active = lifecycle.acquire()) {
            var close = executor.submit(() -> {
                closeThread.set(Thread.currentThread());
                lifecycle.close(() -> {});
            });
            awaitWaiting(closeThread);

            var laterReader = executor.submit(() -> {
                try (NativeModelLifecycle.Lease ignored = lifecycle.acquire()) {
                    return true;
                }
            });
            assertThat(laterReader.isDone()).isFalse();

            active.close();
            close.get(5, TimeUnit.SECONDS);
            assertThatThrownBy(() -> laterReader.get(5, TimeUnit.SECONDS))
                    .hasCauseInstanceOf(IllegalStateException.class);
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    void closeWaitsForActiveUseDisposesOnceAndRejectsLaterUse() throws Exception {
        NativeModelLifecycle lifecycle = new NativeModelLifecycle();
        CountDownLatch useStarted = new CountDownLatch(1);
        CountDownLatch releaseUse = new CountDownLatch(1);
        CountDownLatch disposed = new CountDownLatch(1);
        AtomicInteger disposeCount = new AtomicInteger();
        var executor = Executors.newFixedThreadPool(2);

        try {
            var activeUse = executor.submit(() -> {
                try (NativeModelLifecycle.Lease ignored = lifecycle.acquire()) {
                    useStarted.countDown();
                    if (!releaseUse.await(5, TimeUnit.SECONDS)) {
                        throw new AssertionError("test did not release active native use");
                    }
                }
                return null;
            });
            assertThat(useStarted.await(5, TimeUnit.SECONDS)).isTrue();

            var close = executor.submit(() -> lifecycle.close(() -> {
                disposeCount.incrementAndGet();
                disposed.countDown();
            }));
            assertThat(disposed.await(100, TimeUnit.MILLISECONDS)).isFalse();

            releaseUse.countDown();
            activeUse.get(5, TimeUnit.SECONDS);
            close.get(5, TimeUnit.SECONDS);
            lifecycle.close(disposeCount::incrementAndGet);

            assertThat(disposeCount).hasValue(1);
            assertThatThrownBy(lifecycle::acquire)
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessage("Whisper engine is closed");
        } finally {
            releaseUse.countDown();
            executor.shutdownNow();
        }
    }

    private static void awaitWaiting(AtomicReference<Thread> threadRef) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            Thread thread = threadRef.get();
            if (thread != null && thread.getState() == Thread.State.WAITING) return;
            Thread.yield();
        }
        throw new AssertionError("close did not queue behind the active model lease");
    }
}
