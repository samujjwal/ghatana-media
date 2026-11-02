package com.ghatana.audio.video.common.resilience;

import io.grpc.Context;
import io.grpc.Deadline;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.Status;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.*;

class RpcDeadlineServerInterceptorTest {
    private static final ScheduledExecutorService TIMER = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "deadline-test-timer");
        thread.setDaemon(true);
        return thread;
    });

    @Test
    void appliesConfiguredMaximumAndPreservesShorterClientDeadline() {
        var interceptor = new RpcDeadlineServerInterceptor(Duration.ofSeconds(5), Map.of(
                "media.STT/Transcribe", Duration.ofMillis(900)));
        AtomicReference<Deadline> observed = new AtomicReference<>();
        ServerCall<String, String> call = call("media.STT/Transcribe");
        interceptor.interceptCall(call, new Metadata(), (ignored, headers) -> {
            observed.set(Context.current().getDeadline());
            return new ServerCall.Listener<>() {};
        });
        assertThat(observed.get()).isNotNull();
        assertThat(observed.get().timeRemaining(TimeUnit.MILLISECONDS)).isBetween(1L, 900L);

        Context parent = Context.current().withDeadline(Deadline.after(60, TimeUnit.MILLISECONDS), TIMER);
        Context previous = parent.attach();
        try {
            AtomicReference<Deadline> clientBound = new AtomicReference<>();
            interceptor.interceptCall(call("media.TTS/Synthesize"), new Metadata(), (ignored, headers) -> {
                clientBound.set(Context.current().getDeadline());
                return new ServerCall.Listener<>() {};
            });
            assertThat(clientBound.get().timeRemaining(TimeUnit.MILLISECONDS)).isBetween(1L, 60L);
        } finally {
            parent.detach(previous);
        }
    }

    @Test
    void noArgInterceptorLoadsExactMethodOverrideAndKeepsGlobalDefaultForOtherMethods() {
        String defaultProperty = RpcDeadlineServerInterceptor.DEFAULT_MAX_DEADLINE_MILLIS_PROPERTY;
        String methodProperty = RpcDeadlineServerInterceptor.METHOD_MAX_DEADLINE_MILLIS_PROPERTY_PREFIX
                + "media.STT/Transcribe";
        String previousDefault = System.getProperty(defaultProperty);
        String previousMethod = System.getProperty(methodProperty);
        System.setProperty(defaultProperty, "5000");
        System.setProperty(methodProperty, "600");
        try {
            var interceptor = new RpcDeadlineServerInterceptor();
            assertThat(maximumFor(interceptor, "media.STT/Transcribe")).isBetween(1L, 600L);
            assertThat(maximumFor(interceptor, "media.TTS/Synthesize")).isBetween(1L, 5000L);
        } finally {
            restoreProperty(defaultProperty, previousDefault);
            restoreProperty(methodProperty, previousMethod);
        }
    }

    @Test
    void noArgInterceptorRejectsInvalidPerMethodOverrideConfiguration() {
        String defaultProperty = RpcDeadlineServerInterceptor.DEFAULT_MAX_DEADLINE_MILLIS_PROPERTY;
        String methodProperty = RpcDeadlineServerInterceptor.METHOD_MAX_DEADLINE_MILLIS_PROPERTY_PREFIX
                + "media.STT/Transcribe";
        String previousDefault = System.getProperty(defaultProperty);
        String previousMethod = System.getProperty(methodProperty);
        System.setProperty(defaultProperty, "5000");
        try {
            for (String invalid : new String[] {"0", "600001", "not-a-number"}) {
                System.setProperty(methodProperty, invalid);
                assertThatThrownBy(RpcDeadlineServerInterceptor::new)
                        .isInstanceOf(IllegalArgumentException.class);
            }
        } finally {
            restoreProperty(defaultProperty, previousDefault);
            restoreProperty(methodProperty, previousMethod);
        }
    }

    private static long maximumFor(RpcDeadlineServerInterceptor interceptor, String fullMethodName) {
        AtomicReference<Deadline> observed = new AtomicReference<>();
        interceptor.interceptCall(call(fullMethodName), new Metadata(), (ignored, headers) -> {
            observed.set(Context.current().getDeadline());
            return new ServerCall.Listener<>() {};
        });
        return observed.get().timeRemaining(TimeUnit.MILLISECONDS);
    }

    private static void restoreProperty(String name, String previous) {
        if (previous == null) System.clearProperty(name);
        else System.setProperty(name, previous);
    }

    @Test
    void expiredParentDeadlineRejectsBeforeServiceDispatch() {
        var interceptor = new RpcDeadlineServerInterceptor(Duration.ofSeconds(2), Map.of());
        Context parent = Context.current().withDeadline(Deadline.after(-1, TimeUnit.MILLISECONDS), TIMER);
        Context previous = parent.attach();
        @SuppressWarnings("unchecked") ServerCall<String, String> call = mock(ServerCall.class);
        when(call.getMethodDescriptor()).thenReturn(descriptor("media.Vision/Recognize"));
        @SuppressWarnings("unchecked") ServerCallHandler<String, String> next = mock(ServerCallHandler.class);
        try {
            interceptor.interceptCall(call, new Metadata(), next);
            verify(call).close(argThat(status -> status.getCode() == Status.Code.DEADLINE_EXCEEDED), any());
            verifyNoInteractions(next);
        } finally {
            parent.detach(previous);
        }
    }

    @Test
    void explicitlyCancelledParentWithoutDeadlineRejectsAsCancelledBeforeServiceDispatch() {
        var interceptor = new RpcDeadlineServerInterceptor(Duration.ofSeconds(2), Map.of());
        Context.CancellableContext parent = Context.current().withCancellation();
        parent.cancel(null);
        Context previous = parent.attach();
        @SuppressWarnings("unchecked") ServerCall<String, String> call = mock(ServerCall.class);
        when(call.getMethodDescriptor()).thenReturn(descriptor("media.STT/Transcribe"));
        @SuppressWarnings("unchecked") ServerCallHandler<String, String> next = mock(ServerCallHandler.class);
        try {
            interceptor.interceptCall(call, new Metadata(), next);
            verify(call).close(argThat(status -> status.getCode() == Status.Code.CANCELLED), any());
            verifyNoInteractions(next);
        } finally {
            parent.detach(previous);
        }
    }

    @Test
    void configuredMaximumCancelsContextAndClosesTransportAsUnknownOutcome() throws Exception {
        var interceptor = new RpcDeadlineServerInterceptor(Duration.ofMillis(35), Map.of());
        CountDownLatch contextCancelled = new CountDownLatch(1);
        @SuppressWarnings("unchecked") ServerCall<String, String> call = mock(ServerCall.class);
        when(call.getMethodDescriptor()).thenReturn(descriptor("media.Multimodal/Analyze"));
        interceptor.interceptCall(call, new Metadata(), (ignored, headers) -> {
            Context.current().addListener(cancelled -> contextCancelled.countDown(), Runnable::run);
            return new ServerCall.Listener<>() {};
        });
        assertThat(contextCancelled.await(1, TimeUnit.SECONDS)).isTrue();
        verify(call, timeout(500)).close(argThat(status -> status.getCode() == Status.Code.UNKNOWN), any());
    }

    @Test
    void deadlineCancelsCooperativeWorkerAndClassifiesEffectCapableLateWorkAsUnknown() throws Exception {
        ThreadPoolExecutor pool = pool(1, 1);
        try {
            Context.CancellableContext request = Context.current().withCancellation();
            Context previous = request.attach();
            CountDownLatch started = new CountDownLatch(1);
            CountDownLatch interrupted = new CountDownLatch(1);
            AtomicInteger dispatches = new AtomicInteger();
            ContextAwareBoundedExecutor.Submission<String> submission;
            try {
                submission = new ContextAwareBoundedExecutor(pool).submit(() -> {
                    dispatches.incrementAndGet();
                    started.countDown();
                    try {
                        new CountDownLatch(1).await();
                        return "too late";
                    } catch (InterruptedException expected) {
                        interrupted.countDown();
                        return "late cooperative result";
                    }
                });
            } finally {
                request.detach(previous);
            }
            assertThat(started.await(1, TimeUnit.SECONDS)).isTrue();
            request.cancel(null);
            assertThat(interrupted.await(1, TimeUnit.SECONDS)).isTrue();
            assertStatus(submission, Status.Code.UNKNOWN);
            assertThat(dispatches).hasValue(1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void alreadyCancelledContextNeverDispatchesCallableAndReturnsCancelled() throws Exception {
        ThreadPoolExecutor pool = pool(1, 1);
        try {
            Context.CancellableContext request = Context.current().withCancellation();
            request.cancel(null);
            Context previous = request.attach();
            AtomicInteger dispatches = new AtomicInteger();
            ContextAwareBoundedExecutor.Submission<String> submission;
            try {
                submission = new ContextAwareBoundedExecutor(pool).submit(() -> {
                    dispatches.incrementAndGet();
                    return "must not run";
                });
            } finally {
                request.detach(previous);
            }
            assertStatus(submission, Status.Code.CANCELLED);
            assertThat(dispatches).hasValue(0);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void deadlineExpiredWhileQueuedNeverDispatchesCallable() throws Exception {
        ThreadPoolExecutor pool = pool(1, 1);
        CountDownLatch blockerStarted = new CountDownLatch(1);
        CountDownLatch releaseBlocker = new CountDownLatch(1);
        AtomicInteger dispatches = new AtomicInteger();
        try {
            pool.execute(() -> {
                blockerStarted.countDown();
                try {
                    releaseBlocker.await();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            });
            assertThat(blockerStarted.await(1, TimeUnit.SECONDS)).isTrue();

            Deadline callerDeadline = Deadline.after(80, TimeUnit.MILLISECONDS);
            Context request = Context.current().withDeadline(callerDeadline, TIMER);
            Context previous = request.attach();
            ContextAwareBoundedExecutor.Submission<String> submission;
            try {
                submission = new ContextAwareBoundedExecutor(pool).submit(() -> {
                    dispatches.incrementAndGet();
                    return "must not run after deadline";
                });
            } finally {
                request.detach(previous);
            }
            assertThat(pool.getQueue()).hasSize(1);
            long waitDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
            while (!callerDeadline.isExpired() && System.nanoTime() < waitDeadline) {
                Thread.yield();
            }
            assertThat(callerDeadline.isExpired()).isTrue();
            releaseBlocker.countDown();

            assertStatus(submission, Status.Code.DEADLINE_EXCEEDED);
            assertThat(dispatches).hasValue(0);
        } finally {
            releaseBlocker.countDown();
            pool.shutdownNow();
            pool.awaitTermination(1, TimeUnit.SECONDS);
        }
    }

    @Test
    void expiredQueuedTaskIsRemovedWhileNoncooperativeWorkerKeepsItsSlot() throws Exception {
        ThreadPoolExecutor pool = pool(1, 1);
        CountDownLatch blockerStarted = new CountDownLatch(1);
        CountDownLatch releaseBlocker = new CountDownLatch(1);
        CountDownLatch laterTaskRan = new CountDownLatch(1);
        AtomicInteger expiredDispatches = new AtomicInteger();
        try {
            var blocker = new ContextAwareBoundedExecutor(pool).submit(() -> {
                blockerStarted.countDown();
                while (true) {
                    try {
                        if (releaseBlocker.await(10, TimeUnit.MILLISECONDS)) break;
                    } catch (InterruptedException ignored) {
                        // The running callable models work that does not stop on interruption.
                    }
                }
                return "blocker finished";
            });
            assertThat(blockerStarted.await(1, TimeUnit.SECONDS)).isTrue();

            Context request = Context.current().withDeadline(Deadline.after(300, TimeUnit.MILLISECONDS), TIMER);
            Context previous = request.attach();
            ContextAwareBoundedExecutor.Submission<String> expired;
            try {
                expired = new ContextAwareBoundedExecutor(pool).submit(() -> {
                    expiredDispatches.incrementAndGet();
                    return "must not dispatch";
                });
            } finally {
                request.detach(previous);
            }
            assertThat(pool.getQueue()).hasSize(1);
            assertStatus(expired, Status.Code.DEADLINE_EXCEEDED);

            // Cancellation removes the queued task promptly, while the running callable
            // continues to occupy the sole worker until its actual exit.
            assertThat(pool.getQueue()).isEmpty();
            assertThat(pool.getActiveCount()).isEqualTo(1);
            assertThat(blocker.result().isDone()).isFalse();
            assertThat(expiredDispatches).hasValue(0);

            var later = new ContextAwareBoundedExecutor(pool).submit(() -> {
                laterTaskRan.countDown();
                return "later task";
            });
            assertThat(pool.getQueue()).hasSize(1);
            assertThat(laterTaskRan.getCount()).isEqualTo(1);

            releaseBlocker.countDown();
            assertThat(blocker.result().get(1, TimeUnit.SECONDS)).isEqualTo("blocker finished");
            assertThat(later.result().get(1, TimeUnit.SECONDS)).isEqualTo("later task");
            assertThat(laterTaskRan.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(expiredDispatches).hasValue(0);
        } finally {
            releaseBlocker.countDown();
            pool.shutdownNow();
            pool.awaitTermination(1, TimeUnit.SECONDS);
        }
    }

    @Test
    void cancellationBeforeExecutorEnqueueDoesNotLeaveCancelledTaskInBoundedQueue() throws Exception {
        CountDownLatch blockerStarted = new CountDownLatch(1);
        CountDownLatch releaseBlocker = new CountDownLatch(1);
        CountDownLatch executePaused = new CountDownLatch(1);
        CountDownLatch allowEnqueue = new CountDownLatch(1);
        AtomicBoolean pauseNextExecute = new AtomicBoolean();
        AtomicInteger cancelledDispatches = new AtomicInteger();
        ThreadPoolExecutor pool = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(1)) {
            @Override
            public void execute(Runnable command) {
                if (pauseNextExecute.compareAndSet(true, false)) {
                    executePaused.countDown();
                    try {
                        if (!allowEnqueue.await(1, TimeUnit.SECONDS)) {
                            throw new IllegalStateException("test did not release the enqueue gate");
                        }
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException("enqueue gate interrupted", interrupted);
                    }
                }
                super.execute(command);
            }
        };
        Context.CancellableContext request = Context.current().withCancellation();
        FutureTask<ContextAwareBoundedExecutor.Submission<String>> submitCall = new FutureTask<>(() -> {
            Context previous = request.attach();
            try {
                return new ContextAwareBoundedExecutor(pool).submit(() -> {
                    cancelledDispatches.incrementAndGet();
                    return "cancelled work must not run";
                });
            } finally {
                request.detach(previous);
            }
        });
        Thread submitter = new Thread(submitCall, "bounded-submit-cancel-race-test");
        try {
            pool.execute(() -> {
                blockerStarted.countDown();
                while (true) {
                    try {
                        if (releaseBlocker.await(10, TimeUnit.MILLISECONDS)) break;
                    } catch (InterruptedException ignored) {
                        // Keep the only worker occupied while the bounded queue race is exercised.
                    }
                }
            });
            assertThat(blockerStarted.await(1, TimeUnit.SECONDS)).isTrue();

            pauseNextExecute.set(true);
            submitter.start();
            assertThat(executePaused.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(pool.getQueue()).isEmpty();

            // The cancellation listener removes before super.execute has enqueued the future.
            request.cancel(null);
            allowEnqueue.countDown();
            ContextAwareBoundedExecutor.Submission<String> cancelled = submitCall.get(1, TimeUnit.SECONDS);
            assertStatus(cancelled, Status.Code.CANCELLED);
            assertThat(pool.getQueue()).isEmpty();
            assertThat(cancelledDispatches).hasValue(0);

            // The cancelled future must not consume the sole queue slot behind the worker.
            var later = new ContextAwareBoundedExecutor(pool).submit(() -> "later task");
            assertThat(pool.getQueue()).hasSize(1);
            releaseBlocker.countDown();
            assertThat(later.result().get(1, TimeUnit.SECONDS)).isEqualTo("later task");
            assertThat(cancelledDispatches).hasValue(0);
        } finally {
            allowEnqueue.countDown();
            releaseBlocker.countDown();
            pool.shutdownNow();
            pool.awaitTermination(1, TimeUnit.SECONDS);
            if (submitter.isAlive()) submitter.join(1_000);
        }
    }

    @Test
    void nonCooperativeWorkerRetainsCapacityAndSaturationRejectsWithoutDuplicateDispatch() throws Exception {
        ThreadPoolExecutor pool = pool(1, 1);
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch effectCommitted = new CountDownLatch(1);
        AtomicInteger effects = new AtomicInteger();
        try {
            var executor = new ContextAwareBoundedExecutor(pool);
            var first = executor.submit(() -> {
                started.countDown();
                while (true) {
                    try {
                        if (release.await(20, TimeUnit.MILLISECONDS)) break;
                    } catch (InterruptedException ignored) {
                        // Simulates native/provider code that does not honor Java interruption.
                    }
                }
                effects.incrementAndGet();
                effectCommitted.countDown();
                return "committed after cancellation";
            });
            assertThat(started.await(1, TimeUnit.SECONDS)).isTrue();
            var queued = executor.submit(() -> "not dispatched");
            var saturated = executor.submit(() -> "must reject");
            assertStatus(saturated, Status.Code.RESOURCE_EXHAUSTED);

            first.cancel();
            assertStatus(first, Status.Code.UNKNOWN);
            assertThat(effects).hasValue(0);
            queued.cancel();
            assertStatus(queued, Status.Code.CANCELLED);
            release.countDown();
            assertThat(pool.awaitTermination(10, TimeUnit.MILLISECONDS)).isFalse();
            assertThatThrownBy(() -> first.result().get(50, TimeUnit.MILLISECONDS))
                    .isInstanceOf(ExecutionException.class);
            assertThat(effectCommitted.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(effects).hasValue(1);
            // The callable returned normally after cancellation, but its late success must not
            // replace the caller-visible UNKNOWN_OUTCOME selected at cancellation time.
            assertStatus(first, Status.Code.UNKNOWN);
            assertThat(first.result().isCompletedExceptionally()).isTrue();
        } finally {
            release.countDown();
            pool.shutdownNow();
            pool.awaitTermination(1, TimeUnit.SECONDS);
        }
    }

    @Test
    void explicitCancellationOfKnownNoEffectWorkReturnsCancelled() throws Exception {
        ThreadPoolExecutor pool = pool(1, 1);
        CountDownLatch started = new CountDownLatch(1);
        try {
            var submission = new ContextAwareBoundedExecutor(pool).submit(() -> {
                started.countDown();
                new CountDownLatch(1).await();
                return "pure result";
            }, false);
            assertThat(started.await(1, TimeUnit.SECONDS)).isTrue();
            submission.cancel();
            assertStatus(submission, Status.Code.CANCELLED);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void deadlineCancellationOfKnownNoEffectWorkReturnsDeadlineExceeded() throws Exception {
        ThreadPoolExecutor pool = pool(1, 1);
        CountDownLatch started = new CountDownLatch(1);
        try {
            Context request = Context.current().withDeadline(Deadline.after(50, TimeUnit.MILLISECONDS), TIMER);
            Context previous = request.attach();
            ContextAwareBoundedExecutor.Submission<String> submission;
            try {
                submission = new ContextAwareBoundedExecutor(pool).submit(() -> {
                    started.countDown();
                    new CountDownLatch(1).await();
                    return "no effect";
                }, false);
            } finally {
                request.detach(previous);
            }
            assertThat(started.await(1, TimeUnit.SECONDS)).isTrue();
            assertStatus(submission, Status.Code.DEADLINE_EXCEEDED);
        } finally {
            pool.shutdownNow();
        }
    }

    private static void assertStatus(ContextAwareBoundedExecutor.Submission<?> submission,
                                     Status.Code code) throws Exception {
        assertThatThrownBy(() -> submission.result().get(1, TimeUnit.SECONDS))
                .isInstanceOf(ExecutionException.class)
                .satisfies(error -> assertThat(Status.fromThrowable(error.getCause()).getCode()).isEqualTo(code));
    }

    private static ThreadPoolExecutor pool(int workers, int queueSize) {
        return new ThreadPoolExecutor(workers, workers, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(queueSize));
    }

    @SuppressWarnings("unchecked")
    private static ServerCall<String, String> call(String method) {
        ServerCall<String, String> call = mock(ServerCall.class);
        when(call.getMethodDescriptor()).thenReturn(descriptor(method));
        return call;
    }

    private static MethodDescriptor<String, String> descriptor(String method) {
        return MethodDescriptor.<String, String>newBuilder()
                .setType(MethodDescriptor.MethodType.UNARY)
                .setFullMethodName(method)
                .setRequestMarshaller(marshaller())
                .setResponseMarshaller(marshaller())
                .build();
    }

    private static MethodDescriptor.Marshaller<String> marshaller() {
        return new MethodDescriptor.Marshaller<>() {
            @Override public InputStream stream(String value) {
                return new ByteArrayInputStream(value.getBytes(StandardCharsets.UTF_8));
            }
            @Override public String parse(InputStream stream) { return ""; }
        };
    }
}
