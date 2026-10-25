package com.ghatana.audio.video.vision.yolo;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
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

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(2, TimeUnit.SECONDS)) throw new AssertionError("Timed out awaiting test release");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("Test worker was interrupted", interrupted);
        }
    }
}
