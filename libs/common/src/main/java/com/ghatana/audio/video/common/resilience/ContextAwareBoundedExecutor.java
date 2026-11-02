package com.ghatana.audio.video.common.resilience;

import io.grpc.Context;
import io.grpc.Status;

import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Submits blocking child work to a caller-owned finite executor with gRPC context propagation.
 * Cancellation interrupts the task, but does not pretend that arbitrary work stopped.
 */
public final class ContextAwareBoundedExecutor {
    private final Executor executor;

    public ContextAwareBoundedExecutor(Executor executor) {
        this.executor = Objects.requireNonNull(executor, "executor");
    }

    public <T> Submission<T> submit(java.util.concurrent.Callable<T> callable) {
        return submit(callable, true);
    }

    /**
     * @param effectMayCommit true for work whose cancellation cannot prove that an effect did not commit
     */
    public <T> Submission<T> submit(java.util.concurrent.Callable<T> callable, boolean effectMayCommit) {
        Objects.requireNonNull(callable, "callable");
        Context context = Context.current();
        AtomicBoolean started = new AtomicBoolean();
        AtomicBoolean terminal = new AtomicBoolean();
        AtomicReference<Future<?>> task = new AtomicReference<>();
        CompletableFuture<T> result = new CompletableFuture<>();
        Submission<T> submission = new Submission<>(context, result, started, terminal, task, executor,
                effectMayCommit);
        Runnable work = context.wrap(() -> {
            if (!submission.beginDispatch()) return;
            try {
                T value = callable.call();
                if (context.isCancelled() || deadlineExpired(context) || terminal.get()) {
                    terminal.set(true);
                    result.completeExceptionally(cancellationOutcome(context, effectMayCommit));
                } else {
                    terminal.set(true);
                    result.complete(value);
                }
            } catch (Throwable failure) {
                terminal.set(true);
                result.completeExceptionally(context.isCancelled() || deadlineExpired(context)
                        ? cancellationOutcome(context, effectMayCommit) : failure);
            }
        });
        try {
            // FutureTask exposes interruption while leaving the public result uncancelled so it
            // can report UNKNOWN_OUTCOME when started work may still commit after cancellation.
            java.util.concurrent.FutureTask<Void> future = new java.util.concurrent.FutureTask<>(work, null);
            task.set(future);
            Context.CancellationListener listener = cancelled -> submission.cancel();
            context.addListener(listener, Runnable::run);
            submission.setListener(listener);
            if (context.isCancelled() || deadlineExpired(context)) {
                submission.cancel();
                return submission;
            }
            executor.execute(future);
            // Cancellation can win after the pre-dispatch check but before execute enqueues
            // the FutureTask. In that race cancel()'s first remove may run too early, so
            // recheck after enqueue and free a cancelled task that never began dispatch.
            submission.removeCancelledQueuedTask(future);
        } catch (RejectedExecutionException saturated) {
            submission.reject(saturated);
        }
        return submission;
    }

    private static RuntimeException unknownOutcome() {
        return Status.UNKNOWN
                .withDescription("UNKNOWN_OUTCOME: child work started and may have committed; reconcile before replay")
                .asRuntimeException();
    }

    private static RuntimeException cancellationOutcome(Context context, boolean effectMayCommit) {
        return effectMayCommit ? unknownOutcome()
                : knownNoEffectCancellation(context);
    }

    private static RuntimeException preDispatchCancellation(Context context) {
        if (deadlineExpired(context)) {
            return Status.DEADLINE_EXCEEDED
                    .withDescription("RPC deadline elapsed before child dispatch")
                    .asRuntimeException();
        }
        return Status.CANCELLED
                .withDescription("RPC cancelled before child dispatch")
                .asRuntimeException();
    }

    private static RuntimeException knownNoEffectCancellation(Context context) {
        if (deadlineExpired(context)) {
            return Status.DEADLINE_EXCEEDED
                    .withDescription("RPC deadline elapsed; child operation is known to have no effect")
                    .asRuntimeException();
        }
        return Status.CANCELLED
                .withDescription("RPC cancelled; child operation is known to have no effect")
                .asRuntimeException();
    }

    private static boolean deadlineExpired(Context context) {
        return context.getDeadline() != null && context.getDeadline().isExpired();
    }

    public static final class Submission<T> {
        private final Context context;
        private final CompletableFuture<T> result;
        private final AtomicBoolean started;
        private final AtomicBoolean terminal;
        private final AtomicReference<Future<?>> task;
        private final Executor executor;
        private final boolean effectMayCommit;
        private final Object dispatchGate = new Object();
        private volatile Context.CancellationListener listener;

        private Submission(Context context, CompletableFuture<T> result, AtomicBoolean started,
                           AtomicBoolean terminal, AtomicReference<Future<?>> task, Executor executor,
                           boolean effectMayCommit) {
            this.context = context;
            this.result = result;
            this.started = started;
            this.terminal = terminal;
            this.task = task;
            this.executor = executor;
            this.effectMayCommit = effectMayCommit;
        }

        public CompletableFuture<T> result() { return result; }
        public boolean started() { return started.get(); }

        private boolean beginDispatch() {
            synchronized (dispatchGate) {
                if (terminal.get()) return false;
                if (context.isCancelled() || deadlineExpired(context)) {
                    terminal.set(true);
                    result.completeExceptionally(preDispatchCancellation(context));
                    return false;
                }
                // Linearization point: cancellation after this point is classified as a started
                // operation and effect-capable work is therefore UNKNOWN.
                started.set(true);
                return true;
            }
        }

        public void cancel() {
            Future<?> running;
            boolean wasStarted;
            synchronized (dispatchGate) {
                if (!terminal.compareAndSet(false, true)) return;
                running = task.get();
                wasStarted = started.get();
                result.completeExceptionally(wasStarted && effectMayCommit ? unknownOutcome()
                        : knownNoEffectCancellation(context));
            }
            if (running != null) {
                running.cancel(true);
                // A cancelled FutureTask can otherwise occupy a bounded queue behind a
                // noncooperative worker until that worker returns. Remove only queued work;
                // started work keeps its worker slot until its callable actually exits.
                if (!wasStarted && running instanceof Runnable queuedTask
                        && executor instanceof ThreadPoolExecutor threadPool) {
                    threadPool.remove(queuedTask);
                }
            }
        }

        private void removeCancelledQueuedTask(Runnable queuedTask) {
            if (terminal.get() && !started.get() && executor instanceof ThreadPoolExecutor threadPool) {
                threadPool.remove(queuedTask);
            }
        }

        private void reject(RejectedExecutionException saturated) {
            synchronized (dispatchGate) {
                if (!terminal.compareAndSet(false, true)) return;
                result.completeExceptionally(Status.RESOURCE_EXHAUSTED
                        .withDescription("Bounded modality worker queue is full")
                        .withCause(saturated).asRuntimeException());
            }
        }

        private void setListener(Context.CancellationListener listener) {
            this.listener = listener;
            result.whenComplete((value, failure) -> context.removeListener(listener));
        }
    }
}
