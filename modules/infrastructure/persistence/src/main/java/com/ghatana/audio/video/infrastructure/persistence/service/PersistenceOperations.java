package com.ghatana.audio.video.infrastructure.persistence.service;

import io.activej.eventloop.Eventloop;
import io.activej.promise.Promise;

import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Bounded admission for synchronous persistence calls submitted through ActiveJ promises.
 * ActiveJ's {@code Promise.ofBlocking} does not expose a task cancellation handle; accepted JPA
 * work therefore runs to completion even if a caller stops observing its promise.
 */
final class PersistenceOperations {

    private final Eventloop eventloop;
    private final ExecutorService executor;
    private final Semaphore outstanding = new Semaphore(PersistenceExecutors.MAX_OUTSTANDING_OPERATIONS);
    private final Semaphore databaseConcurrency =
        new Semaphore(PersistenceExecutors.MAX_CONCURRENT_DATABASE_OPERATIONS);

    PersistenceOperations(Eventloop eventloop, ExecutorService executor) {
        this.eventloop = Objects.requireNonNull(eventloop, "eventloop");
        this.executor = Objects.requireNonNull(executor, "executor");
    }

    <T> Promise<T> submit(ThrowingSupplier<T> operation) {
        if (!outstanding.tryAcquire()) {
            return Promise.ofException(new RejectedExecutionException(
                "Persistence executor is saturated (outstanding limit: "
                    + PersistenceExecutors.MAX_OUTSTANDING_OPERATIONS + ")"));
        }

        AtomicBoolean released = new AtomicBoolean();
        Runnable releaseOnce = () -> {
            if (released.compareAndSet(false, true)) {
                outstanding.release();
            }
        };

        try {
            return Promise.ofBlocking(executor, () -> {
                boolean acquiredDatabasePermit = false;
                try {
                    if (eventloop.inReactorThread()) {
                        throw new PersistenceOnEventloopException(
                            "Synchronous persistence operation cannot run on the ActiveJ eventloop");
                    }
                    databaseConcurrency.acquire();
                    acquiredDatabasePermit = true;
                    return operation.get();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw interrupted;
                } finally {
                    if (acquiredDatabasePermit) {
                        databaseConcurrency.release();
                    }
                    releaseOnce.run();
                }
            }).whenException(ignored -> releaseOnce.run());
        } catch (RuntimeException failure) {
            // Direct executors can make Promise.ofBlocking surface an inline supplier error here.
            // Preserve the service API's promise-based error contract and release this admission.
            releaseOnce.run();
            return Promise.ofException(failure);
        } catch (Error failure) {
            // Covers fatal failure before Promise.ofBlocking can arrange its completion callback.
            releaseOnce.run();
            throw failure;
        }
    }

    @FunctionalInterface
    interface ThrowingSupplier<T> {
        T get() throws Exception;
    }

    private static final class PersistenceOnEventloopException extends Exception {
        private static final long serialVersionUID = 1L;

        private PersistenceOnEventloopException(String message) {
            super(message);
        }
    }
}
