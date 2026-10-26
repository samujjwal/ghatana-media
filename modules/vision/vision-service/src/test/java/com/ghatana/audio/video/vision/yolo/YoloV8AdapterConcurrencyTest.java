package com.ghatana.audio.video.vision.yolo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

class YoloV8AdapterConcurrencyTest {
    @Test
    void serializesMutableNetworkInputAndForwardOperations() throws Exception {
        Object network = new Object();
        CountDownLatch firstEntered = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        CountDownLatch secondEntered = new CountDownLatch(1);
        AtomicInteger active = new AtomicInteger();
        AtomicInteger maximumActive = new AtomicInteger();
        ExecutorService workers = Executors.newFixedThreadPool(2);

        try {
            var first = workers.submit(() -> YoloV8Adapter.withNetworkLock(network, () -> {
                maximumActive.accumulateAndGet(active.incrementAndGet(), Math::max);
                firstEntered.countDown();
                try {
                    await(releaseFirst);
                } finally {
                    active.decrementAndGet();
                }
                return null;
            }));
            assertThat(firstEntered.await(2, TimeUnit.SECONDS)).isTrue();

            var second = workers.submit(() -> YoloV8Adapter.withNetworkLock(network, () -> {
                maximumActive.accumulateAndGet(active.incrementAndGet(), Math::max);
                secondEntered.countDown();
                active.decrementAndGet();
                return null;
            }));

            assertThat(secondEntered.await(100, TimeUnit.MILLISECONDS)).isFalse();
            releaseFirst.countDown();
            first.get(2, TimeUnit.SECONDS);
            second.get(2, TimeUnit.SECONDS);
            assertThat(maximumActive.get()).isEqualTo(1);
        } finally {
            releaseFirst.countDown();
            workers.shutdownNow();
        }
    }

    @Test
    void closeDrainsActiveInferenceAndRejectsQueuedInference() throws Exception {
        Object network = new Object();
        AtomicBoolean closed = new AtomicBoolean();
        CountDownLatch firstEntered = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        CountDownLatch closeStarted = new CountDownLatch(1);
        CountDownLatch closeCompleted = new CountDownLatch(1);
        CountDownLatch queuedStarted = new CountDownLatch(1);
        AtomicReference<Thread> queuedThread = new AtomicReference<>();
        AtomicBoolean queuedInferenceRan = new AtomicBoolean();
        ExecutorService workers = Executors.newFixedThreadPool(3);

        try {
            var activeInference = workers.submit(() -> YoloV8Adapter.withNetworkLock(
                    network, () -> !closed.get(), () -> {
                        firstEntered.countDown();
                        await(releaseFirst);
                        return null;
                    }));
            assertThat(firstEntered.await(2, TimeUnit.SECONDS)).isTrue();

            var closing = workers.submit(() -> {
                closed.set(true);
                closeStarted.countDown();
                YoloV8Adapter.withNetworkLock(network, () -> {
                    closeCompleted.countDown();
                    return null;
                });
            });
            assertThat(closeStarted.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(closeCompleted.await(100, TimeUnit.MILLISECONDS)).isFalse();

            var queuedInference = workers.submit(() -> {
                queuedThread.set(Thread.currentThread());
                queuedStarted.countDown();
                return YoloV8Adapter.withNetworkLock(network, () -> !closed.get(), () -> {
                    queuedInferenceRan.set(true);
                    return null;
                });
            });
            assertThat(queuedStarted.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(awaitBlocked(queuedThread.get(), 2, TimeUnit.SECONDS)).isTrue();

            releaseFirst.countDown();
            activeInference.get(2, TimeUnit.SECONDS);
            closing.get(2, TimeUnit.SECONDS);
            assertThat(closeCompleted.getCount()).isZero();
            assertThatThrownBy(() -> queuedInference.get(2, TimeUnit.SECONDS))
                    .hasCauseInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("YOLOv8 network is closed or replaced");
            assertThat(queuedInferenceRan).isFalse();
        } finally {
            releaseFirst.countDown();
            workers.shutdownNow();
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(2, TimeUnit.SECONDS)) throw new AssertionError("Timed out awaiting test release");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("Test worker was interrupted", interrupted);
        }
    }

    private static boolean awaitBlocked(Thread thread, long timeout, TimeUnit unit)
            throws InterruptedException {
        long deadline = System.nanoTime() + unit.toNanos(timeout);
        while (System.nanoTime() < deadline) {
            if (thread.getState() == Thread.State.BLOCKED) return true;
            Thread.sleep(1);
        }
        return false;
    }
}
