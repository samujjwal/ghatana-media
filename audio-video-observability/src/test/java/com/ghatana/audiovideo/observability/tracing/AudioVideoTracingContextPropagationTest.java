package com.ghatana.audiovideo.observability.tracing;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import org.junit.jupiter.api.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

class AudioVideoTracingContextPropagationTest {
    private final AudioVideoTracingService tracing = new AudioVideoTracingService(
            io.opentelemetry.api.OpenTelemetry.noop().getTracer("test"));

    @Test
    void propagatesParentSpanToAsyncChildWork() throws Exception {
        Span parent = Span.wrap(SpanContext.create("0123456789abcdef0123456789abcdef",
                "0123456789abcdef", TraceFlags.getSampled(), TraceState.getDefault()));
        CompletableFuture<String> future;
        try (Scope ignored = Context.current().with(parent).makeCurrent()) {
            future = CompletableFuture.supplyAsync(tracing.propagateSupplier(
                    () -> Span.current().getSpanContext().getSpanId()));
        }
        assertThat(future.get()).isEqualTo(parent.getSpanContext().getSpanId());
        assertThat(Span.current().getSpanContext().isValid()).isFalse();
    }

    @Test
    void restoresWorkerContextAfterAsyncFailure() {
        Span parent = Span.wrap(SpanContext.create("fedcba9876543210fedcba9876543210",
                "fedcba9876543210", TraceFlags.getSampled(), TraceState.getDefault()));
        CompletableFuture<Void> future;
        try (Scope ignored = Context.current().with(parent).makeCurrent()) {
            future = CompletableFuture.runAsync(tracing.propagateRunnable(() -> {
                assertThat(Span.current().getSpanContext().getSpanId()).isEqualTo(parent.getSpanContext().getSpanId());
                throw new IllegalStateException("sensitive media marker");
            }));
        }
        assertThatThrownBy(future::join).hasCauseInstanceOf(IllegalStateException.class);
        assertThat(Span.current().getSpanContext().isValid()).isFalse();
    }

    @Test
    void restoresWorkerContextWhenWrappedFutureIsCancelled() throws Exception {
        ExecutorService executor = Executors.newSingleThreadExecutor();
        CountDownLatch blockerStarted = new CountDownLatch(1);
        CountDownLatch releaseBlocker = new CountDownLatch(1);
        CountDownLatch wrappedStarted = new CountDownLatch(1);
        CountDownLatch wrappedExited = new CountDownLatch(1);
        Span parent = Span.wrap(SpanContext.create("8899aabbccddeeff8899aabbccddeeff",
                "8899aabbccddeeff", TraceFlags.getSampled(), TraceState.getDefault()));
        try {
            executor.submit(() -> {
                blockerStarted.countDown();
                try { releaseBlocker.await(); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            });
            assertThat(blockerStarted.await(2, TimeUnit.SECONDS)).isTrue();
            Future<?> future;
            try (Scope ignored = Context.current().with(parent).makeCurrent()) {
                future = executor.submit(tracing.propagateRunnable(() -> {
                    try {
                        wrappedStarted.countDown();
                        new CountDownLatch(1).await();
                    } catch (InterruptedException ignoredInterrupt) {
                        Thread.currentThread().interrupt();
                    } finally {
                        assertThat(Span.current().getSpanContext().getSpanId())
                                .isEqualTo(parent.getSpanContext().getSpanId());
                        wrappedExited.countDown();
                    }
                }));
            }
            releaseBlocker.countDown();
            assertThat(wrappedStarted.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(future.cancel(true)).isTrue();
            assertThat(wrappedExited.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(executor.submit(() -> {
                Thread.interrupted();
                return Span.current().getSpanContext().isValid();
            }).get(2, TimeUnit.SECONDS)).isFalse();
        } finally {
            releaseBlocker.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void exceptionContentIsNeverCopiedToSpanAttributes() {
        Span span = mock(Span.class);
        String sensitiveMarker = "private-media-content-7f4c";
        tracing.recordError(span, new IllegalStateException(sensitiveMarker), 12);
        verify(span, never()).setAttribute(anyString(), org.mockito.ArgumentMatchers.contains(sensitiveMarker));
    }
}
