package com.ghatana.stt.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.ghatana.stt.testutil.VerifiedJwtContext;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.common.resilience.RpcDeadlineServerInterceptor;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.Contexts;
import io.grpc.ManagedChannel;
import io.grpc.Server;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanBuilder;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.Map;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SttBoundedProviderDispatchTest {
    private static final String TENANT = "tenant-verified";
    private static final String PRINCIPAL = "00000000-0000-0000-0000-000000000001";
    private static final ScheduledExecutorService DEADLINE_TIMER =
            Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "stt-deadline-test-timer");
                thread.setDaemon(true);
                return thread;
            });

    @Test
    void authorizedRequestCompletesOnBoundedWorker() throws Exception {
        ThreadPoolExecutor workers = pool(1, 1);
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine engine = mock(SttEngine.class);
        AtomicBoolean authorized = new AtomicBoolean();
        when(library.getSttEngine()).thenReturn(engine);
        when(engine.transcribe(any(AudioData.class), any(TranscriptionOptions.class))).thenAnswer(invocation -> {
            assertThat(authorized).isTrue();
            return result();
        });
        SttGrpcService service = service(library, workers, request -> {
            authorized.set(true);
            return SttRequestAuthorization.Decision.ADMITTED;
        });
        TestObserver observer = new TestObserver();

        try {
            invoke(service, request(), observer);
            assertThat(observer.terminal.await(3, TimeUnit.SECONDS)).isTrue();
            assertThat(observer.failure).isNull();
            assertThat(observer.completed).isTrue();
            assertThat(observer.response.getText()).isEqualTo("bounded worker transcript");
            verify(engine).transcribe(any(AudioData.class), any(TranscriptionOptions.class));
        } finally {
            service.close();
        }
    }

    @Test
    void preCancelledCallDoesNotEnqueueOrDispatchProviderWork() throws Exception {
        AtomicInteger enqueued = new AtomicInteger();
        Executor countingExecutor = command -> {
            enqueued.incrementAndGet();
            command.run();
        };
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttGrpcService service = service(library, countingExecutor,
                request -> SttRequestAuthorization.Decision.ADMITTED);
        TestObserver observer = new TestObserver();
        Context.CancellableContext cancelled = authenticatedContext().withCancellation();
        cancelled.cancel(new RuntimeException("fixture pre-cancel"));

        try {
            invoke(cancelled, service, request(), observer);
            assertThat(enqueued).hasValue(0);
            verify(library, never()).getSttEngine();
            assertThat(observer.response).isNull();
            assertThat(observer.completed).isFalse();
        } finally {
            service.close();
        }
    }

    @Test
    void cancellationAfterProviderStartSurfacesUnknownAndSuppressesLateSuccess() throws Exception {
        ThreadPoolExecutor workers = pool(1, 1);
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine engine = mock(SttEngine.class);
        CountDownLatch providerStarted = new CountDownLatch(1);
        CountDownLatch releaseProvider = new CountDownLatch(1);
        CountDownLatch providerReturned = new CountDownLatch(1);
        TraceFixture trace = new TraceFixture();
        when(library.getSttEngine()).thenReturn(engine);
        when(engine.transcribe(any(AudioData.class), any(TranscriptionOptions.class))).thenAnswer(invocation -> {
            providerStarted.countDown();
            try {
                while (!releaseProvider.await(50, TimeUnit.MILLISECONDS)) { /* held by test */ }
            } catch (InterruptedException cancelled) {
                // Native/provider termination is not claimed; keep the fixture running to prove late suppression.
                while (releaseProvider.getCount() != 0) Thread.yield();
            } finally {
                providerReturned.countDown();
            }
            return result();
        });
        SttGrpcService service = new SttGrpcService(library, new SimpleMeterRegistry(), trace.tracer,
                request -> SttRequestAuthorization.Decision.ADMITTED, workers);
        TestObserver observer = new TestObserver();
        Context.CancellableContext call = authenticatedContext().withCancellation();

        try {
            invoke(call, service, request(), observer);
            assertThat(providerStarted.await(2, TimeUnit.SECONDS)).isTrue();
            call.cancel(new RuntimeException("fixture post-start cancellation"));
            assertThat(observer.terminal.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(Status.fromThrowable(observer.failure).getCode()).isEqualTo(Status.Code.UNKNOWN);
            assertThat(Status.fromThrowable(observer.failure).getDescription()).contains("UNKNOWN_OUTCOME");
            verify(trace.span).setAttribute("media.outcome", "unknown");
            verify(trace.span, never()).setStatus(eq(StatusCode.ERROR), anyString());
            verify(trace.span).end();
            releaseProvider.countDown();
            assertThat(providerReturned.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(observer.response).isNull();
            assertThat(observer.completed).isFalse();
        } finally {
            releaseProvider.countDown();
            service.close();
        }
    }

    @Test
    void deadlineAfterProviderStartSurfacesUnknownAndSuppressesLateSuccess() throws Exception {
        ThreadPoolExecutor workers = pool(1, 1);
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine engine = mock(SttEngine.class);
        CountDownLatch providerStarted = new CountDownLatch(1);
        CountDownLatch releaseProvider = new CountDownLatch(1);
        CountDownLatch providerReturned = new CountDownLatch(1);
        when(library.getSttEngine()).thenReturn(engine);
        when(engine.transcribe(any(AudioData.class), any(TranscriptionOptions.class))).thenAnswer(invocation -> {
            providerStarted.countDown();
            try {
                while (!releaseProvider.await(50, TimeUnit.MILLISECONDS)) { /* held by test */ }
            } catch (InterruptedException deadline) {
                // A deadline signal cannot prove that an arbitrary/native provider has stopped.
                while (releaseProvider.getCount() != 0) Thread.yield();
            } finally {
                providerReturned.countDown();
            }
            return result();
        });
        SttGrpcService service = service(library, workers,
                request -> SttRequestAuthorization.Decision.ADMITTED);
        TestObserver observer = new TestObserver();
        Context.CancellableContext deadline = authenticatedContext().withDeadlineAfter(
                150, TimeUnit.MILLISECONDS, DEADLINE_TIMER);

        try {
            invoke(deadline, service, request(), observer);
            assertThat(providerStarted.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(observer.terminal.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(Status.fromThrowable(observer.failure).getCode()).isEqualTo(Status.Code.UNKNOWN);
            assertThat(Status.fromThrowable(observer.failure).getDescription()).contains("UNKNOWN_OUTCOME");

            releaseProvider.countDown();
            assertThat(providerReturned.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(observer.response).isNull();
            assertThat(observer.completed).isFalse();
            verify(engine).transcribe(any(AudioData.class), any(TranscriptionOptions.class));
        } finally {
            deadline.cancel(new RuntimeException("deadline fixture cleanup"));
            releaseProvider.countDown();
            service.close();
        }
    }

    @Test
    void grpcClientDeadlineCancelsPropagatedProviderContextAndSuppressesLateResponse() throws Exception {
        ThreadPoolExecutor workers = pool(1, 1);
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine engine = mock(SttEngine.class);
        CountDownLatch providerStarted = new CountDownLatch(1);
        CountDownLatch releaseProvider = new CountDownLatch(1);
        CountDownLatch providerReturned = new CountDownLatch(1);
        AtomicReference<Context> providerContext = new AtomicReference<>();
        when(library.getSttEngine()).thenReturn(engine);
        when(engine.transcribe(any(AudioData.class), any(TranscriptionOptions.class))).thenAnswer(invocation -> {
            providerContext.set(Context.current());
            providerStarted.countDown();
            try {
                while (!releaseProvider.await(50, TimeUnit.MILLISECONDS)) { /* held by test */ }
            } catch (InterruptedException deadline) {
                while (releaseProvider.getCount() != 0) Thread.yield();
            } finally {
                providerReturned.countDown();
            }
            return result();
        });
        SttGrpcService service = service(library, workers,
                request -> SttRequestAuthorization.Decision.ADMITTED);
        java.lang.reflect.Field keyField = JwtServerInterceptor.class.getDeclaredField("VERIFIED_IDENTITY");
        keyField.setAccessible(true);
        @SuppressWarnings("unchecked")
        Context.Key<JwtServerInterceptor.VerifiedIdentity> identityKey =
                (Context.Key<JwtServerInterceptor.VerifiedIdentity>) keyField.get(null);
        String serverName = InProcessServerBuilder.generateName();
        Server server = InProcessServerBuilder.forName(serverName).directExecutor()
                .addService(service)
                .intercept(new RpcDeadlineServerInterceptor(Duration.ofSeconds(2), Map.of()))
                .intercept(verifiedIdentityInterceptor(identityKey, PRINCIPAL, TENANT))
                .build().start();
        ManagedChannel channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();
        CountDownLatch terminal = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        AtomicReference<TranscribeResponse> response = new AtomicReference<>();
        try {
            STTServiceGrpc.newStub(channel).withDeadlineAfter(150, TimeUnit.MILLISECONDS)
                    .transcribe(request(), new StreamObserver<>() {
                        @Override public void onNext(TranscribeResponse value) { response.set(value); }
                        @Override public void onError(Throwable error) { failure.set(error); terminal.countDown(); }
                        @Override public void onCompleted() { terminal.countDown(); }
                    });

            assertThat(providerStarted.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(terminal.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(Status.fromThrowable(failure.get()).getCode()).isEqualTo(Status.Code.DEADLINE_EXCEEDED);
            assertThat(providerContext.get()).isNotNull();
            long cancellationWaitUntil = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (!providerContext.get().isCancelled() && System.nanoTime() < cancellationWaitUntil) {
                Thread.yield();
            }
            assertThat(providerContext.get().isCancelled()).isTrue();

            releaseProvider.countDown();
            assertThat(providerReturned.await(2, TimeUnit.SECONDS)).isTrue();
            Thread.sleep(50);
            assertThat(response.get()).isNull();
            verify(engine).transcribe(any(AudioData.class), any(TranscriptionOptions.class));
        } finally {
            releaseProvider.countDown();
            channel.shutdownNow();
            server.shutdownNow();
            service.close();
            workers.shutdownNow();
        }
    }

    @Test
    void deadlineWhileQueuedExpiresBeforeProviderDispatch() throws Exception {
        ThreadPoolExecutor workers = pool(1, 1);
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine engine = mock(SttEngine.class);
        CountDownLatch providerStarted = new CountDownLatch(1);
        CountDownLatch releaseProvider = new CountDownLatch(1);
        AtomicInteger providerCalls = new AtomicInteger();
        when(library.getSttEngine()).thenReturn(engine);
        when(engine.transcribe(any(AudioData.class), any(TranscriptionOptions.class))).thenAnswer(invocation -> {
            if (providerCalls.incrementAndGet() == 1) {
                providerStarted.countDown();
                releaseProvider.await(3, TimeUnit.SECONDS);
            }
            return result();
        });
        SttGrpcService service = service(library, workers,
                request -> SttRequestAuthorization.Decision.ADMITTED);
        TestObserver active = new TestObserver();
        TestObserver queued = new TestObserver();
        Context.CancellableContext deadline = null;

        try {
            invoke(service, request(), active);
            assertThat(providerStarted.await(2, TimeUnit.SECONDS)).isTrue();
            deadline = authenticatedContext().withDeadlineAfter(2, TimeUnit.SECONDS, DEADLINE_TIMER);
            invoke(deadline, service, request(), queued);
            assertThat(workers.getQueue()).hasSize(1);
            assertThat(queued.terminal.await(3, TimeUnit.SECONDS)).isTrue();
            assertThat(Status.fromThrowable(queued.failure).getCode())
                    .isEqualTo(Status.Code.DEADLINE_EXCEEDED);
            assertThat(workers.getQueue()).isEmpty();

            releaseProvider.countDown();
            assertThat(active.terminal.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(active.failure).isNull();
            verify(engine).transcribe(any(AudioData.class), any(TranscriptionOptions.class));
            assertThat(providerCalls).hasValue(1);
            assertThat(queued.response).isNull();
            assertThat(queued.completed).isFalse();
        } finally {
            if (deadline != null) deadline.cancel(new RuntimeException("deadline fixture cleanup"));
            releaseProvider.countDown();
            service.close();
        }
    }

    @Test
    void saturatedWorkerQueueRejectsWithoutDispatchingExtraProviderCall() throws Exception {
        ThreadPoolExecutor workers = pool(1, 1);
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine engine = mock(SttEngine.class);
        CountDownLatch firstStarted = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        AtomicInteger providerCalls = new AtomicInteger();
        when(library.getSttEngine()).thenReturn(engine);
        when(engine.transcribe(any(AudioData.class), any(TranscriptionOptions.class))).thenAnswer(invocation -> {
            if (providerCalls.incrementAndGet() == 1) {
                firstStarted.countDown();
                releaseFirst.await(3, TimeUnit.SECONDS);
            }
            return result();
        });
        SttGrpcService service = service(library, workers,
                request -> SttRequestAuthorization.Decision.ADMITTED);
        TestObserver first = new TestObserver();
        TestObserver queued = new TestObserver();
        TestObserver rejected = new TestObserver();

        try {
            invoke(service, request(), first);
            assertThat(firstStarted.await(2, TimeUnit.SECONDS)).isTrue();
            invoke(service, request(), queued);
            invoke(service, request(), rejected);
            assertThat(rejected.terminal.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(Status.fromThrowable(rejected.failure).getCode())
                    .isEqualTo(Status.Code.RESOURCE_EXHAUSTED);
            assertThat(providerCalls).hasValue(1);

            releaseFirst.countDown();
            assertThat(first.terminal.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(queued.terminal.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(providerCalls).hasValue(2);
        } finally {
            releaseFirst.countDown();
            service.close();
        }
    }

    @Test
    void closeCompletesStartedAndQueuedCallsAndSuppressesLateSuccess() throws Exception {
        ThreadPoolExecutor workers = pool(1, 2);
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine engine = mock(SttEngine.class);
        CountDownLatch firstStarted = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        AtomicInteger providerCalls = new AtomicInteger();
        when(library.getSttEngine()).thenReturn(engine);
        when(engine.transcribe(any(AudioData.class), any(TranscriptionOptions.class))).thenAnswer(invocation -> {
            if (providerCalls.incrementAndGet() == 1) {
                firstStarted.countDown();
                try {
                    while (!releaseFirst.await(50, TimeUnit.MILLISECONDS)) { /* held by test */ }
                } catch (InterruptedException closeInterrupt) {
                    while (releaseFirst.getCount() != 0) Thread.yield();
                }
            }
            return result();
        });
        SttGrpcService service = service(library, workers,
                request -> SttRequestAuthorization.Decision.ADMITTED);
        TestObserver started = new TestObserver();
        TestObserver queued = new TestObserver();
        java.util.concurrent.ExecutorService closer = java.util.concurrent.Executors.newSingleThreadExecutor();

        try {
            invoke(service, request(), started);
            assertThat(firstStarted.await(2, TimeUnit.SECONDS)).isTrue();
            invoke(service, request(), queued);
            java.util.concurrent.Future<?> closing = closer.submit(service::close);

            assertThat(started.terminal.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(queued.terminal.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(Status.fromThrowable(started.failure).getCode()).isEqualTo(Status.Code.UNKNOWN);
            assertThat(Status.fromThrowable(queued.failure).getCode()).isEqualTo(Status.Code.CANCELLED);
            verify(engine).transcribe(any(AudioData.class), any(TranscriptionOptions.class));
            assertThat(started.response).isNull();
            assertThat(queued.response).isNull();

            releaseFirst.countDown();
            closing.get(3, TimeUnit.SECONDS);
            assertThat(queued.completed).isFalse();
            verify(engine).transcribe(any(AudioData.class), any(TranscriptionOptions.class));
        } finally {
            releaseFirst.countDown();
            closer.shutdownNow();
            workers.shutdownNow();
        }
    }

    @Test
    void rightsRevokedWhileQueuedPreventsProviderDispatch() throws Exception {
        ThreadPoolExecutor workers = pool(1, 1);
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine engine = mock(SttEngine.class);
        CountDownLatch firstStarted = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        AtomicBoolean queuedRightsRevoked = new AtomicBoolean();
        AtomicInteger providerCalls = new AtomicInteger();
        when(library.getSttEngine()).thenReturn(engine);
        when(engine.transcribe(any(AudioData.class), any(TranscriptionOptions.class))).thenAnswer(invocation -> {
            if (providerCalls.incrementAndGet() == 1) {
                firstStarted.countDown();
                releaseFirst.await(3, TimeUnit.SECONDS);
            }
            return result();
        });
        SttGrpcService service = service(library, workers, authorization -> {
            if ("queued-artifact".equals(authorization.resourceId()) && queuedRightsRevoked.get()) {
                return SttRequestAuthorization.Decision.REVOKED;
            }
            return SttRequestAuthorization.Decision.ADMITTED;
        });
        TestObserver first = new TestObserver();
        TestObserver queued = new TestObserver();

        try {
            invoke(service, requestWithArtifact("active-artifact"), first);
            assertThat(firstStarted.await(2, TimeUnit.SECONDS)).isTrue();
            invoke(service, requestWithArtifact("queued-artifact"), queued);
            queuedRightsRevoked.set(true);
            releaseFirst.countDown();

            assertThat(first.terminal.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(queued.terminal.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(first.failure).isNull();
            assertThat(Status.fromThrowable(queued.failure).getCode()).isEqualTo(Status.Code.PERMISSION_DENIED);
            assertThat(Status.fromThrowable(queued.failure).getDescription()).contains("STT_RIGHTS_REVOKED");
            verify(engine, org.mockito.Mockito.times(1))
                    .transcribe(any(AudioData.class), any(TranscriptionOptions.class));
            assertThat(providerCalls).hasValue(1);
        } finally {
            releaseFirst.countDown();
            service.close();
        }
    }

    @Test
    void productionCloseDoesNotCloseLibraryUntilActiveProviderReturns() throws Exception {
        ThreadPoolExecutor workers = pool(1, 1);
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine engine = mock(SttEngine.class);
        CountDownLatch providerStarted = new CountDownLatch(1);
        CountDownLatch releaseProvider = new CountDownLatch(1);
        when(library.getSttEngine()).thenReturn(engine);
        when(engine.transcribe(any(AudioData.class), any(TranscriptionOptions.class))).thenAnswer(invocation -> {
            providerStarted.countDown();
            try {
                while (!releaseProvider.await(50, TimeUnit.MILLISECONDS)) { /* held by test */ }
            } catch (InterruptedException closeInterrupt) {
                while (releaseProvider.getCount() != 0) Thread.yield();
            }
            return result();
        });
        ProductionSttGrpcService service = new ProductionSttGrpcService(library, new SimpleMeterRegistry(),
                request -> SttRequestAuthorization.Decision.ADMITTED, workers);
        TestObserver observer = new TestObserver();
        java.util.concurrent.ExecutorService closer = java.util.concurrent.Executors.newSingleThreadExecutor();

        try {
            invoke(service, request(), observer);
            assertThat(providerStarted.await(2, TimeUnit.SECONDS)).isTrue();
            java.util.concurrent.Future<?> closing = closer.submit(service::close);
            assertThat(observer.terminal.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(Status.fromThrowable(observer.failure).getCode()).isEqualTo(Status.Code.UNKNOWN);
            verify(library, never()).close();

            releaseProvider.countDown();
            closing.get(3, TimeUnit.SECONDS);
            verify(library).close();
            assertThat(observer.response).isNull();
            assertThat(observer.completed).isFalse();
        } finally {
            releaseProvider.countDown();
            closer.shutdownNow();
            workers.shutdownNow();
        }
    }

    private static SttGrpcService service(AudioVideoLibrary library, Executor executor,
            SttRequestAuthorization authorization) {
        return new SttGrpcService(library, new SimpleMeterRegistry(),
                io.opentelemetry.api.GlobalOpenTelemetry.getTracer("stt-bounded-worker-test"),
                authorization, executor);
    }

    private static io.grpc.ServerInterceptor verifiedIdentityInterceptor(
            Context.Key<JwtServerInterceptor.VerifiedIdentity> identityKey, String subject, String tenant) {
        return new io.grpc.ServerInterceptor() {
            @Override
            public <ReqT, RespT> io.grpc.ServerCall.Listener<ReqT> interceptCall(
                    io.grpc.ServerCall<ReqT, RespT> call, io.grpc.Metadata headers,
                    io.grpc.ServerCallHandler<ReqT, RespT> next) {
                Context context = Context.current().withValue(identityKey,
                        new JwtServerInterceptor.VerifiedIdentity(subject, tenant));
                return Contexts.interceptCall(context, call, headers, next);
            }
        };
    }

    private static ThreadPoolExecutor pool(int workers, int queueCapacity) {
        return new ThreadPoolExecutor(workers, workers, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(queueCapacity), new ThreadPoolExecutor.AbortPolicy());
    }

    private static Context authenticatedContext() {
        return VerifiedJwtContext.create(TENANT, PRINCIPAL);
    }

    private static void invoke(SttGrpcService service, TranscribeRequest request, TestObserver observer) {
        invoke(authenticatedContext(), service, request, observer);
    }

    private static void invoke(Context context, SttGrpcService service,
            TranscribeRequest request, TestObserver observer) {
        Context previous = context.attach();
        try {
            service.transcribe(request, observer);
        } finally {
            context.detach(previous);
        }
    }

    private static TranscribeRequest request() {
        return requestWithArtifact("");
    }

    private static TranscribeRequest requestWithArtifact(String artifactId) {
        return TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1, 2, 3, 4}))
                .setSampleRate(16_000)
                .setArtifactId(artifactId)
                .build();
    }

    private static TranscriptionResult result() {
        return new TranscriptionResult("bounded worker transcript", 0.9, List.of(), List.of(),
                Duration.ofMillis(5), "en", "fixture-model");
    }

    private static final class TestObserver implements StreamObserver<TranscribeResponse> {
        private final CountDownLatch terminal = new CountDownLatch(1);
        private volatile TranscribeResponse response;
        private volatile Throwable failure;
        private volatile boolean completed;

        @Override public void onNext(TranscribeResponse value) { response = value; }
        @Override public void onError(Throwable error) { failure = error; terminal.countDown(); }
        @Override public void onCompleted() { completed = true; terminal.countDown(); }
    }

    private static final class TraceFixture {
        private final Tracer tracer = mock(Tracer.class);
        private final SpanBuilder builder = mock(SpanBuilder.class);
        private final Span span = mock(Span.class);

        private TraceFixture() {
            when(tracer.spanBuilder("audiovideo.stt.transcribe")).thenReturn(builder);
            when(builder.setSpanKind(SpanKind.INTERNAL)).thenReturn(builder);
            when(builder.setAttribute(anyString(), anyBoolean())).thenReturn(builder);
            when(builder.setAttribute(anyString(), anyString())).thenReturn(builder);
            when(builder.startSpan()).thenReturn(span);
            when(span.makeCurrent()).thenReturn(mock(Scope.class));
            doAnswer(invocation -> null).when(span).end();
        }
    }
}
