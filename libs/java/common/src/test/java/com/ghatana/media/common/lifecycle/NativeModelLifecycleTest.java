package com.ghatana.media.common.lifecycle;

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
    void closeByCurrentLeaseOwnerFailsFastAndCanBeRetriedAfterRelease() throws Exception {
        NativeModelLifecycle lifecycle = new NativeModelLifecycle("Whisper engine is closed");
        AtomicInteger disposeCount = new AtomicInteger();
        var executor = Executors.newSingleThreadExecutor(task -> {
            Thread thread = new Thread(task, "native-model-reentrant-close-test");
            thread.setDaemon(true);
            return thread;
        });

        try {
            var closeOnLeaseOwner = executor.submit(() -> {
                try (NativeModelLifecycle.Lease outer = lifecycle.acquire();
                     NativeModelLifecycle.Lease inner = lifecycle.acquire()) {
                    assertThatThrownBy(() -> lifecycle.close(disposeCount::incrementAndGet))
                            .isInstanceOf(IllegalStateException.class)
                            .hasMessage("Cannot close native model while holding an active lease");
                    inner.close();
                    assertThatThrownBy(() -> lifecycle.close(disposeCount::incrementAndGet))
                            .isInstanceOf(IllegalStateException.class)
                            .hasMessage("Cannot close native model while holding an active lease");
                    assertThat(disposeCount).hasValue(0);
                }
                lifecycle.close(disposeCount::incrementAndGet);
            });
            closeOnLeaseOwner.get(5, TimeUnit.SECONDS);
        } finally {
            executor.shutdownNow();
        }

        assertThat(disposeCount).hasValue(1);
    }

    @Test
    void wrongThreadCannotConsumeLeaseReleaseAndBlockClose() throws Exception {
        NativeModelLifecycle lifecycle = new NativeModelLifecycle("Whisper engine is closed");
        var executor = Executors.newSingleThreadExecutor();
        AtomicInteger disposeCount = new AtomicInteger();

        try (NativeModelLifecycle.Lease lease = lifecycle.acquire()) {
            var wrongThreadClose = executor.submit(() -> {
                lease.close();
                return null;
            });
            assertThatThrownBy(() -> wrongThreadClose.get(5, TimeUnit.SECONDS))
                    .hasCauseInstanceOf(IllegalMonitorStateException.class)
                    .hasRootCauseMessage("Native model lease must be released by its acquiring thread");

            // The failed cross-thread attempt must not mark the lease released; its owner can
            // still unlock it, allowing disposal to complete instead of leaving close blocked.
        }
        lifecycle.close(disposeCount::incrementAndGet);
        assertThat(disposeCount).hasValue(1);
        executor.shutdownNow();
    }

    @Test
    void queuedClosePreventsLaterReadersFromOvertakingIt() throws Exception {
        NativeModelLifecycle lifecycle = new NativeModelLifecycle("Whisper engine is closed");
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
        NativeModelLifecycle lifecycle = new NativeModelLifecycle("Whisper engine is closed");
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

    @Test
    void disposerFailureRemainsClosedAndIsNotRetried() {
        NativeModelLifecycle lifecycle = new NativeModelLifecycle("Whisper engine is closed");
        AtomicInteger disposeCount = new AtomicInteger();
        IllegalStateException disposalFailure = new IllegalStateException("native handle close failed");

        assertThatThrownBy(() -> lifecycle.close(() -> {
            disposeCount.incrementAndGet();
            throw disposalFailure;
        })).isSameAs(disposalFailure);

        assertThatThrownBy(() -> lifecycle.acquire())
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Whisper engine is closed");

        lifecycle.close(disposeCount::incrementAndGet);

        assertThat(disposeCount).hasValue(1);
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
