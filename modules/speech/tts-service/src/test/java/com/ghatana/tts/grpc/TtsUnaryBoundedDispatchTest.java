package com.ghatana.tts.grpc;

import com.ghatana.audio.video.common.resilience.ContextAwareBoundedExecutor;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.tts.api.TtsStreamingSession;
import com.ghatana.media.tts.api.TtsStreamSink;
import com.ghatana.media.common.CanonicalAudioFormat;
import com.ghatana.media.common.AudioChunk;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeResponse;
import io.grpc.Context;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.time.Duration;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TtsUnaryBoundedDispatchTest {
    private final AudioVideoLibrary library = mock(AudioVideoLibrary.class);
    private final TtsEngine engine = mock(TtsEngine.class);
    private final SimpleMeterRegistry registry = new SimpleMeterRegistry();
    private Context identityContext;
    private Context previousContext;
    private ThreadPoolExecutor workers;
    private TtsGrpcService service;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() throws Exception {
        Field keyField = JwtServerInterceptor.class.getDeclaredField("VERIFIED_IDENTITY");
        keyField.setAccessible(true);
        Context.Key<JwtServerInterceptor.VerifiedIdentity> key =
                (Context.Key<JwtServerInterceptor.VerifiedIdentity>) keyField.get(null);
        identityContext = Context.current().withValue(key,
                new JwtServerInterceptor.VerifiedIdentity("subject-test", "tenant-test"));
        previousContext = identityContext.attach();
        when(library.getTtsEngine()).thenReturn(engine);
        workers = pool(1, 1);
        service = service(workers);
    }

    @AfterEach
    void tearDown() {
        identityContext.detach(previousContext);
        workers.shutdownNow();
        registry.close();
    }

    @Test
    void normalSynthesisRunsOnWorkerAndReturnsPcm() throws Exception {
        when(engine.synthesize(anyString(), any())).thenReturn(audio());
        CapturingObserver observer = new CapturingObserver();

        service.synthesize(request(), observer);

        assertThat(observer.terminal.await(2, TimeUnit.SECONDS)).isTrue();
        assertThat(observer.error).isNull();
        assertThat(observer.value).isNotNull();
        assertThat(observer.completed).isTrue();
        verify(engine).synthesize(anyString(), any());
    }

    @Test
    void preDispatchCancellationDoesNotInvokeProvider() throws Exception {
        Context.CancellableContext cancelled = Context.current().withCancellation();
        cancelled.cancel(null);
        CapturingObserver observer = new CapturingObserver();

        cancelled.run(() -> service.synthesize(request(), observer));

        assertThat(observer.terminal.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(Status.fromThrowable(observer.error).getCode()).isEqualTo(Status.Code.DEADLINE_EXCEEDED);
        verify(engine, never()).synthesize(anyString(), any());
    }

    @Test
    void startedCancellationReturnsUnknownAndSuppressesLateSuccess() throws Exception {
        CountDownLatch providerStarted = new CountDownLatch(1);
        CountDownLatch allowLateReturn = new CountDownLatch(1);
        when(engine.synthesize(anyString(), any())).thenAnswer(invocation -> {
            providerStarted.countDown();
            awaitIgnoringInterrupt(allowLateReturn);
            return audio();
        });
        Context.CancellableContext operation = Context.current().withCancellation();
        CapturingObserver observer = new CapturingObserver();
        operation.run(() -> service.synthesize(request(), observer));

        assertThat(providerStarted.await(2, TimeUnit.SECONDS)).isTrue();
        operation.cancel(null);
        assertThat(observer.terminal.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(Status.fromThrowable(observer.error).getCode()).isEqualTo(Status.Code.UNKNOWN);
        assertThat(Status.fromThrowable(observer.error).getDescription()).contains("UNKNOWN_OUTCOME");
        var responseUnknown = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("boundary", "response").tag("outcome", "unknown").timer();
        assertThat(responseUnknown).isNotNull();
        assertThat(responseUnknown.count()).isEqualTo(1);

        allowLateReturn.countDown();
        Thread.sleep(50);
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
        verify(engine).synthesize(anyString(), any());
    }

    @Test
    void deadlineAfterProviderDispatchReturnsUnknownAndSuppressesLateSuccess() throws Exception {
        CountDownLatch providerStarted = new CountDownLatch(1);
        CountDownLatch allowLateReturn = new CountDownLatch(1);
        when(engine.synthesize(anyString(), any())).thenAnswer(invocation -> {
            providerStarted.countDown();
            awaitIgnoringInterrupt(allowLateReturn);
            return audio();
        });
        var scheduler = java.util.concurrent.Executors.newSingleThreadScheduledExecutor();
        try {
            Context.CancellableContext operation = Context.current()
                    .withDeadlineAfter(100, TimeUnit.MILLISECONDS, scheduler);
            CapturingObserver observer = new CapturingObserver();
            operation.run(() -> service.synthesize(request(), observer));

            assertThat(providerStarted.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(observer.terminal.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(Status.fromThrowable(observer.error).getCode()).isEqualTo(Status.Code.UNKNOWN);
            assertThat(Status.fromThrowable(observer.error).getDescription()).contains("UNKNOWN_OUTCOME");

            allowLateReturn.countDown();
            Thread.sleep(50);
            assertThat(observer.value).isNull();
            assertThat(observer.completed).isFalse();
            verify(engine).synthesize(anyString(), any());
        } finally {
            allowLateReturn.countDown();
            scheduler.shutdownNow();
        }
    }

    @Test
    void providerExceptionKeepsProviderOutcomeUnknown() throws Exception {
        when(engine.synthesize(anyString(), any())).thenThrow(new IllegalStateException("provider interruption"));
        CapturingObserver observer = new CapturingObserver();

        service.synthesize(request(), observer);

        assertThat(observer.terminal.await(2, TimeUnit.SECONDS)).isTrue();
        assertThat(Status.fromThrowable(observer.error).getCode()).isEqualTo(Status.Code.FAILED_PRECONDITION);
        var providerUnknown = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("boundary", "provider").tag("outcome", "unknown").timer();
        assertThat(providerUnknown).isNotNull();
        assertThat(providerUnknown.count()).isEqualTo(1);
    }

    @Test
    void boundedQueueRejectsOverflowAsResourceExhausted() throws Exception {
        CountDownLatch firstProviderStarted = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        AtomicInteger invocations = new AtomicInteger();
        when(engine.synthesize(anyString(), any())).thenAnswer(invocation -> {
            if (invocations.incrementAndGet() == 1) {
                firstProviderStarted.countDown();
                awaitIgnoringInterrupt(releaseFirst);
            }
            return audio();
        });
        CapturingObserver first = new CapturingObserver();
        CapturingObserver queued = new CapturingObserver();
        CapturingObserver overflow = new CapturingObserver();
        Context firstContext = identityContext;
        firstContext.run(() -> service.synthesize(request(), first));
        assertThat(firstProviderStarted.await(2, TimeUnit.SECONDS)).isTrue();
        identityContext.run(() -> service.synthesize(request(), queued));
        identityContext.run(() -> service.synthesize(request(), overflow));

        assertThat(overflow.terminal.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(Status.fromThrowable(overflow.error).getCode()).isEqualTo(Status.Code.RESOURCE_EXHAUSTED);
        assertThat(invocations).hasValue(1);

        releaseFirst.countDown();
        assertThat(first.terminal.await(2, TimeUnit.SECONDS)).isTrue();
        assertThat(queued.terminal.await(2, TimeUnit.SECONDS)).isTrue();
        assertThat(first.error).isNull();
        assertThat(queued.error).isNull();
    }

    @Test
    void queuedRevocationPreventsUnaryProviderDispatch() throws Exception {
        CountDownLatch blockerStarted = new CountDownLatch(1);
        CountDownLatch releaseBlocker = new CountDownLatch(1);
        workers.execute(() -> {
            blockerStarted.countDown();
            awaitIgnoringInterrupt(releaseBlocker);
        });
        assertThat(blockerStarted.await(1, TimeUnit.SECONDS)).isTrue();
        AtomicReference<TtsRequestAuthorization.Decision> decision =
                new AtomicReference<>(TtsRequestAuthorization.Decision.ADMITTED);
        AtomicInteger checks = new AtomicInteger();
        TtsRequestAuthorization authorization = new TtsRequestAuthorization() {
            @Override public Decision authorize(Request request) {
                checks.incrementAndGet();
                return decision.get();
            }
            @Override public String configuredDefaultVoiceId() { return "voice-test"; }
        };
        service = service(workers, authorization);
        CapturingObserver observer = new CapturingObserver();

        identityContext.run(() -> service.synthesize(request(), observer));
        assertThat(checks).hasValue(1);
        decision.set(TtsRequestAuthorization.Decision.REVOKED);
        releaseBlocker.countDown();

        assertThat(observer.terminal.await(2, TimeUnit.SECONDS)).isTrue();
        assertThat(Status.fromThrowable(observer.error).getCode()).isEqualTo(Status.Code.PERMISSION_DENIED);
        assertThat(checks).hasValue(2);
        verify(engine, never()).synthesize(anyString(), any());
    }

    @Test
    void blockedStreamStartRunsOffCallerAndCloseWaitsBeforeClosingLibrary() throws Exception {
        CountDownLatch providerStarted = new CountDownLatch(1);
        CountDownLatch releaseProvider = new CountDownLatch(1);
        CountDownLatch closeFinished = new CountDownLatch(1);
        CountDownLatch sessionCompleted = new CountDownLatch(1);
        AtomicBoolean sessionCancelled = new AtomicBoolean();
        CompletableFuture<Void> completion = new CompletableFuture<>();
        TtsRequestAuthorization authorization = admittedAuthorization();
        ProductionTtsGrpcService production = new ProductionTtsGrpcService(library, registry,
                new TtsProviderAdmission.Decision(Set.of(TtsProviderAdmission.Capability.SYNTHESIS,
                        TtsProviderAdmission.Capability.PCM_STREAMING), "test-authority", null),
                "voice-test", "en", authorization);
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            providerStarted.countDown();
            awaitIgnoringInterrupt(releaseProvider);
            return new TtsStreamingSession() {
                @Override public boolean cancel() {
                    sessionCancelled.set(true);
                    completion.complete(null);
                    sessionCompleted.countDown();
                    return true;
                }
                @Override public boolean isCancelled() { return sessionCancelled.get(); }
                @Override public CompletableFuture<Void> completion() { return completion; }
            };
        });
        CapturingAudioChunkObserver observer = new CapturingAudioChunkObserver();
        java.util.concurrent.ExecutorService caller = java.util.concurrent.Executors.newSingleThreadExecutor();

        caller.submit(() -> identityContext.run(() -> production.streamSynthesize(productionRequest(), observer)))
                .get(1, TimeUnit.SECONDS);
        assertThat(providerStarted.await(1, TimeUnit.SECONDS)).isTrue();

        Thread closing = new Thread(() -> {
            production.close();
            closeFinished.countDown();
        }, "tts-stream-close-test");
        closing.setDaemon(true);
        closing.start();
        Thread.sleep(100);
        verify(library, never()).close();
        assertThat(closeFinished.getCount()).isEqualTo(1L);

        releaseProvider.countDown();
        assertThat(sessionCompleted.await(2, TimeUnit.SECONDS)).isTrue();
        assertThat(closeFinished.await(3, TimeUnit.SECONDS)).isTrue();
        verify(library).close();
        assertThat(sessionCancelled).isTrue();
        caller.shutdownNow();
    }

    @Test
    void timedOutBlockedStartCancelsLateSessionAndSuppressesLateChunks() throws Exception {
        CountDownLatch providerStarted = new CountDownLatch(1);
        CountDownLatch releaseProvider = new CountDownLatch(1);
        CountDownLatch providerReturned = new CountDownLatch(1);
        CountDownLatch lateSessionCancelled = new CountDownLatch(1);
        AtomicBoolean sessionCancelled = new AtomicBoolean();
        TtsGrpcService streaming = new TtsGrpcService(library, registry, () -> true, () -> true,
                Duration.ofMillis(100), admittedAuthorization(), (voice, language) -> true);
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            providerStarted.countDown();
            awaitIgnoringInterrupt(releaseProvider);
            TtsStreamSink sink = invocation.getArgument(2);
            sink.onAudioFormat(new CanonicalAudioFormat(
                    22_050, 1, 16, com.ghatana.media.common.AudioFormat.PCM));
            sink.onChunk(new AudioChunk(new byte[] {1, 2}, 0, true, 1));
            providerReturned.countDown();
            return TtsStreamingSession.create(sessionCancelled, CompletableFuture.completedFuture(null),
                    lateSessionCancelled::countDown);
        });
        CapturingAudioChunkObserver observer = new CapturingAudioChunkObserver();
        java.util.concurrent.ExecutorService caller = java.util.concurrent.Executors.newSingleThreadExecutor();

        caller.submit(() -> identityContext.run(() -> streaming.streamSynthesize(request(), observer)))
                .get(1, TimeUnit.SECONDS);
        assertThat(providerStarted.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(observer.terminal.await(2, TimeUnit.SECONDS)).isTrue();
        assertThat(Status.fromThrowable(observer.error).getCode()).isEqualTo(Status.Code.DEADLINE_EXCEEDED);

        releaseProvider.countDown();
        assertThat(providerReturned.await(2, TimeUnit.SECONDS)).isTrue();
        assertThat(lateSessionCancelled.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
        assertThat(sessionCancelled).isTrue();
        streaming.close();
        caller.shutdownNow();
    }

    @Test
    void closeCompletesQueuedAndStartedSubmissionFuturesTruthfully() throws Exception {
        CountDownLatch firstProviderStarted = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        when(engine.synthesize(anyString(), any())).thenAnswer(invocation -> {
            firstProviderStarted.countDown();
            awaitIgnoringInterrupt(releaseFirst);
            return audio();
        });
        CapturingObserver first = new CapturingObserver();
        CapturingObserver queued = new CapturingObserver();
        identityContext.run(() -> service.synthesize(request(), first));
        assertThat(firstProviderStarted.await(2, TimeUnit.SECONDS)).isTrue();
        identityContext.run(() -> service.synthesize(request(), queued));

        service.close();

        assertThat(first.terminal.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(Status.fromThrowable(first.error).getCode()).isEqualTo(Status.Code.UNKNOWN);
        assertThat(Status.fromThrowable(first.error).getDescription()).contains("UNKNOWN_OUTCOME");
        assertThat(queued.terminal.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(Status.fromThrowable(queued.error).getCode()).isEqualTo(Status.Code.DEADLINE_EXCEEDED);
        releaseFirst.countDown();
        Thread.sleep(50);
        assertThat(first.value).isNull();
        assertThat(queued.value).isNull();
        assertThat(first.completed).isFalse();
        assertThat(queued.completed).isFalse();
    }

    @Test
    void productionCloseWaitsForActiveSynthesisBeforeClosingOwnedLibrary() throws Exception {
        CountDownLatch providerStarted = new CountDownLatch(1);
        CountDownLatch releaseProvider = new CountDownLatch(1);
        CountDownLatch closeStarted = new CountDownLatch(1);
        CountDownLatch closeFinished = new CountDownLatch(1);
        when(library.getTtsEngine()).thenReturn(engine);
        when(engine.synthesize(anyString(), any())).thenAnswer(invocation -> {
            providerStarted.countDown();
            awaitIgnoringInterrupt(releaseProvider);
            return audio();
        });
        TtsRequestAuthorization authorization = new TtsRequestAuthorization() {
            @Override public Decision authorize(Request request) { return Decision.ADMITTED; }
            @Override public boolean isConfigured() { return true; }
            @Override public String configuredDefaultVoiceId() { return "voice-test"; }
        };
        ProductionTtsGrpcService production = new ProductionTtsGrpcService(library, registry,
                new TtsProviderAdmission.Decision(Set.of(TtsProviderAdmission.Capability.SYNTHESIS),
                        "test-authority", null),
                "voice-test", "en", authorization);
        CapturingObserver observer = new CapturingObserver();
        identityContext.run(() -> production.synthesize(productionRequest(), observer));
        assertThat(providerStarted.await(2, TimeUnit.SECONDS)).isTrue();

        Thread closing = new Thread(() -> {
            closeStarted.countDown();
            production.close();
            closeFinished.countDown();
        }, "tts-production-close-test");
        closing.setDaemon(true);
        closing.start();
        assertThat(closeStarted.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(observer.terminal.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(Status.fromThrowable(observer.error).getCode()).isEqualTo(Status.Code.UNKNOWN);
        Thread.sleep(100);
        verify(library, never()).close();
        assertThat(closeFinished.getCount()).isEqualTo(1L);

        releaseProvider.countDown();
        assertThat(closeFinished.await(3, TimeUnit.SECONDS)).isTrue();
        verify(library).close();
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
    }

    private TtsGrpcService service(ThreadPoolExecutor executor) {
        return service(executor, admittedAuthorization());
    }

    private TtsGrpcService service(ThreadPoolExecutor executor, TtsRequestAuthorization authorization) {
        return new TtsGrpcService(library, registry, () -> true, () -> false, null,
                new com.ghatana.audiovideo.observability.tracing.AudioVideoTracingService(
                        io.opentelemetry.api.GlobalOpenTelemetry.getTracer("tts-bounded-test")),
                authorization, (voice, language) -> true,
                new ContextAwareBoundedExecutor(executor));
    }

    private static TtsRequestAuthorization admittedAuthorization() {
        return new TtsRequestAuthorization() {
            @Override public Decision authorize(Request request) { return Decision.ADMITTED; }
            @Override public boolean isConfigured() { return true; }
            @Override public String configuredDefaultVoiceId() { return "voice-test"; }
        };
    }

    private static ThreadPoolExecutor pool(int threads, int capacity) {
        return new ThreadPoolExecutor(threads, threads, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(capacity), runnable -> {
                    Thread thread = new Thread(runnable, "tts-bounded-test-worker");
                    thread.setDaemon(true);
                    return thread;
                }, new ThreadPoolExecutor.AbortPolicy());
    }

    private static SynthesizeRequest request() {
        return SynthesizeRequest.newBuilder().setText("bounded worker test").setVoiceId("voice-test").build();
    }

    private static SynthesizeRequest productionRequest() {
        return SynthesizeRequest.newBuilder().setText("bounded worker test").setVoiceId("voice-test")
                .setOptions(com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder()
                        .setLanguage("en").build())
                .build();
    }

    private static AudioData audio() {
        byte[] pcm = new byte[44];
        for (int index = 0; index < pcm.length / 2; index++) {
            int sample = index % 2 == 0 ? 1024 : -1024;
            pcm[index * 2] = (byte) sample;
            pcm[index * 2 + 1] = (byte) (sample >> 8);
        }
        return new AudioData(pcm, 22_050, 1, 16, Duration.ofMillis(1), AudioFormat.PCM);
    }

    private static void awaitIgnoringInterrupt(CountDownLatch latch) {
        boolean released = false;
        while (!released) {
            try { released = latch.await(2, TimeUnit.SECONDS); }
            catch (InterruptedException ignored) { Thread.interrupted(); }
        }
    }

    private static final class CapturingObserver implements StreamObserver<SynthesizeResponse> {
        private final CountDownLatch terminal = new CountDownLatch(1);
        private volatile SynthesizeResponse value;
        private volatile Throwable error;
        private volatile boolean completed;
        @Override public void onNext(SynthesizeResponse response) { value = response; }
        @Override public void onError(Throwable failure) { error = failure; terminal.countDown(); }
        @Override public void onCompleted() { completed = true; terminal.countDown(); }
    }

    private static final class CapturingAudioChunkObserver implements StreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> {
        private final CountDownLatch terminal = new CountDownLatch(1);
        private volatile com.ghatana.tts.core.grpc.proto.AudioChunk value;
        private volatile Throwable error;
        private volatile boolean completed;
        @Override public void onNext(com.ghatana.tts.core.grpc.proto.AudioChunk chunk) { value = chunk; }
        @Override public void onError(Throwable failure) { error = failure; terminal.countDown(); }
        @Override public void onCompleted() { completed = true; terminal.countDown(); }
    }
}
