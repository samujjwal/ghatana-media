package com.ghatana.audio.video.infrastructure.persistence.service;

import com.ghatana.testing.activej.EventloopTestBase;
import io.activej.promise.Promise;
import org.junit.jupiter.api.Test;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

class PersistenceOperationsTest extends EventloopTestBase {

    @Test
    void acceptedSupplierCompletesOnceAfterPromiseIsAbandonedAndRestoresAdmissionCapacity() {
        int capacity = PersistenceExecutors.MAX_OUTSTANDING_OPERATIONS;
        ThreadPoolExecutor executor = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(capacity), new ThreadPoolExecutor.AbortPolicy());
        PersistenceOperations operations = new PersistenceOperations(eventloop(), executor);
        CountDownLatch abandonedSupplierEntered = new CountDownLatch(1);
        CountDownLatch releaseAbandonedSupplier = new CountDownLatch(1);
        CountDownLatch firstBatchSupplierEntered = new CountDownLatch(1);
        CountDownLatch releaseFirstBatch = new CountDownLatch(1);
        AtomicInteger supplierCalls = new AtomicInteger();
        AtomicReference<Exception> overflowFailure = new AtomicReference<>();

        try {
            Integer lastResult = runPromise(() -> {
                // Deliberately keep no reference to this accepted Promise: the
                // supplier must continue even after its caller stops observing it.
                operations.submit(() -> {
                    supplierCalls.incrementAndGet();
                    abandonedSupplierEntered.countDown();
                    if (!releaseAbandonedSupplier.await(5, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("test did not release the abandoned supplier");
                    }
                    return 1;
                });
                assertThat(abandonedSupplierEntered.await(5, TimeUnit.SECONDS)).isTrue();
                releaseAbandonedSupplier.countDown();

                // The executor barrier runs after the abandoned operation wrapper
                // has returned and PersistenceOperations has released its permit.
                CountDownLatch operationWrapperFinished = new CountDownLatch(1);
                executor.execute(operationWrapperFinished::countDown);
                assertThat(operationWrapperFinished.await(5, TimeUnit.SECONDS)).isTrue();

                Promise<Integer> lastAccepted = null;
                for (int index = 0; index < capacity; index++) {
                    int result = index;
                    lastAccepted = operations.submit(() -> {
                        supplierCalls.incrementAndGet();
                        if (result == 0) {
                            firstBatchSupplierEntered.countDown();
                            if (!releaseFirstBatch.await(5, TimeUnit.SECONDS)) {
                                throw new IllegalStateException("test did not release the capacity batch");
                            }
                        }
                        return result;
                    });
                }
                assertThat(firstBatchSupplierEntered.await(5, TimeUnit.SECONDS)).isTrue();
                operations.submit(() -> -1).whenException(overflowFailure::set);
                releaseFirstBatch.countDown();
                return lastAccepted;
            });

            assertThat(lastResult).isEqualTo(capacity - 1);
            assertThat(overflowFailure.get()).isInstanceOf(RejectedExecutionException.class);
            assertThat(supplierCalls).hasValue(capacity + 1);

            Integer afterBatchResult = runPromise(() -> operations.submit(() -> {
                supplierCalls.incrementAndGet();
                return capacity;
            }));
            assertThat(afterBatchResult).isEqualTo(capacity);
            assertThat(supplierCalls).hasValue(capacity + 2);
        } finally {
            releaseAbandonedSupplier.countDown();
            releaseFirstBatch.countDown();
            shutdownAndAwait(executor);
        }
    }

    private static void shutdownAndAwait(ThreadPoolExecutor executor) {
        executor.shutdown();
        try {
            if (executor.awaitTermination(5, TimeUnit.SECONDS)) return;

            executor.shutdownNow();
            if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
                throw new AssertionError("persistence test executor did not terminate after forced shutdown");
            }
        } catch (InterruptedException interrupted) {
            executor.shutdownNow();
            try {
                executor.awaitTermination(5, TimeUnit.SECONDS);
            } catch (InterruptedException cleanupInterrupted) {
                interrupted.addSuppressed(cleanupInterrupted);
            }
            Thread.currentThread().interrupt();
            throw new AssertionError("interrupted while shutting down persistence test executor", interrupted);
        }
    }
}
