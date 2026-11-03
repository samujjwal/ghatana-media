package com.ghatana.audio.video.infrastructure.persistence.service;

import io.activej.eventloop.Eventloop;
import io.activej.promise.Promise;
import io.activej.promise.SettablePromise;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.Semaphore;

/**
 * Bounded admission and dispatch for synchronous persistence calls submitted through ActiveJ promises.
 * The injected executor receives at most the configured database concurrency in tasks at once, so
 * even an unbounded executor cannot provision a thread for every admitted operation.
 * ActiveJ's {@code Promise.ofBlocking} does not expose a task cancellation handle; accepted JPA
 * work therefore runs to completion even if a caller stops observing its promise.
 */
final class PersistenceOperations {

    private final Eventloop eventloop;
    private final ExecutorService executor;
    private final ArrayDeque<Pending<?>> pending = new ArrayDeque<>();
    private final Object dispatchLock = new Object();
    private int dispatched;
    private boolean closed;
    private boolean shutdownExecutorWhenDrained;
    private final Semaphore outstanding = new Semaphore(PersistenceExecutors.MAX_OUTSTANDING_OPERATIONS);

    PersistenceOperations(Eventloop eventloop, ExecutorService executor) {
        this.eventloop = Objects.requireNonNull(eventloop, "eventloop");
        this.executor = Objects.requireNonNull(executor, "executor");
    }

    <T> Promise<T> submit(ThrowingSupplier<T> operation) {
        Objects.requireNonNull(operation, "operation");
        if (!outstanding.tryAcquire()) {
            return Promise.ofException(new RejectedExecutionException(
                "Persistence executor is saturated (outstanding limit: "
                    + PersistenceExecutors.MAX_OUTSTANDING_OPERATIONS + ")"));
        }

        SettablePromise<T> result = new SettablePromise<>();
        Pending<T> item = new Pending<>(operation, result);
        List<Pending<?>> ready;
        synchronized (dispatchLock) {
            if (closed) {
                outstanding.release();
                return Promise.ofException(new RejectedExecutionException("Persistence service is closed"));
            }
            pending.addLast(item);
            ready = takeDispatchable();
        }
        dispatch(ready);
        return result;
    }

    /** Stop new work, drain accepted staged calls, and optionally shut down the owned executor. */
    void close(boolean shutdownExecutor) {
        List<Pending<?>> ready;
        boolean shutdownNow;
        synchronized (dispatchLock) {
            closed = true;
            shutdownExecutorWhenDrained |= shutdownExecutor;
            ready = takeDispatchable();
            shutdownNow = shouldShutdownExecutor();
        }
        dispatch(ready);
        if (shutdownNow) executor.shutdown();
    }

    private List<Pending<?>> takeDispatchable() {
        List<Pending<?>> ready = new ArrayList<>();
        while (dispatched < PersistenceExecutors.MAX_CONCURRENT_DATABASE_OPERATIONS && !pending.isEmpty()) {
            dispatched++;
            ready.add(pending.removeFirst());
        }
        return ready;
    }

    private void dispatch(List<Pending<?>> ready) {
        for (Pending<?> item : ready) {
            try {
                executor.execute(() -> run(item));
            } catch (RuntimeException failure) {
                finish(item, null, failure);
            }
        }
    }

    private <T> void run(Pending<T> item) {
        if (eventloop.inReactorThread()) {
            finish(item, null, new PersistenceOnEventloopException(
                "Synchronous persistence operation cannot run on the ActiveJ eventloop"));
            return;
        }

        try {
            finish(item, item.operation.get(), null);
        } catch (Throwable failure) {
            finish(item, null, failure);
        }
    }

    private void finish(Pending<?> item, Object value, Throwable failure) {
        complete(item, value, failure);
        outstanding.release();

        List<Pending<?>> ready;
        boolean shutdownNow;
        synchronized (dispatchLock) {
            dispatched--;
            ready = takeDispatchable();
            shutdownNow = shouldShutdownExecutor();
        }
        dispatch(ready);
        if (shutdownNow) executor.shutdown();
    }

    private boolean shouldShutdownExecutor() {
        return shutdownExecutorWhenDrained && pending.isEmpty() && dispatched == 0;
    }

    private void complete(Pending<?> item, Object value, Throwable failure) {
        Runnable setResult = () -> {
            if (failure == null) {
                item.set(value);
            } else {
                item.setException(asException(failure));
            }
        };
        if (eventloop.inReactorThread()) {
            setResult.run();
        } else {
            eventloop.execute(setResult);
        }
    }

    private static Exception asException(Throwable failure) {
        return failure instanceof Exception exception
            ? exception
            : new java.util.concurrent.CompletionException(failure);
    }

    @FunctionalInterface
    interface ThrowingSupplier<T> {
        T get() throws Exception;
    }

    private static final class Pending<T> {
        private final ThrowingSupplier<T> operation;
        private final SettablePromise<T> result;

        private Pending(ThrowingSupplier<T> operation, SettablePromise<T> result) {
            this.operation = operation;
            this.result = result;
        }

        @SuppressWarnings("unchecked")
        private void set(Object value) {
            result.set((T) value);
        }

        private void setException(Exception failure) {
            result.setException(failure);
        }
    }

    private static final class PersistenceOnEventloopException extends Exception {
        private static final long serialVersionUID = 1L;

        private PersistenceOnEventloopException(String message) {
            super(message);
        }
    }
}
