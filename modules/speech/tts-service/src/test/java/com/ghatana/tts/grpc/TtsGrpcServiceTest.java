package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.tts.api.TtsStreamSink;
import com.ghatana.media.tts.api.TtsStreamingSession;
import com.ghatana.media.tts.api.VoiceInfo;
import com.ghatana.tts.engine.PcmAudioValidator;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.common.CanonicalAudioFormat;
import com.ghatana.audiovideo.observability.tracing.AudioVideoTracingService;
import com.ghatana.tts.core.grpc.proto.CloneVoiceRequest;
import com.ghatana.tts.core.grpc.proto.CloneVoiceResponse;
import com.ghatana.tts.core.grpc.proto.CreateProfileRequest;
import com.ghatana.tts.core.grpc.proto.FeedbackRequest;
import com.ghatana.tts.core.grpc.proto.FeedbackResponse;
import com.ghatana.tts.core.grpc.proto.GetVoicesRequest;
import com.ghatana.tts.core.grpc.proto.GetVoicesResponse;
import com.ghatana.tts.core.grpc.proto.GetProfileRequest;
import com.ghatana.tts.core.grpc.proto.LoadVoiceRequest;
import com.ghatana.tts.core.grpc.proto.LoadVoiceResponse;
import com.ghatana.tts.core.grpc.proto.MetricsRequest;
import com.ghatana.tts.core.grpc.proto.MetricsResponse;
import com.ghatana.tts.core.grpc.proto.StatusRequest;
import com.ghatana.tts.core.grpc.proto.StatusResponse;
import com.ghatana.tts.core.grpc.proto.UpdateProfileRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeResponse;
import com.google.protobuf.ByteString;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.Context;
import io.grpc.stub.ServerCallStreamObserver;
import io.grpc.stub.StreamObserver;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Locale;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.LockSupport;
import java.lang.reflect.Field;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * @doc.type class
 * @doc.purpose Verifies TTS gRPC validation, capability mapping, and library-owned engine lifecycle
 * @doc.layer product
 * @doc.pattern UnitTest
 */
@ExtendWith(MockitoExtension.class)
class TtsGrpcServiceTest {

    private static final TtsRequestAuthorization TEST_ADMITTED_AUTHORIZATION =
            new TtsRequestAuthorization() {
                @Override public Decision authorize(Request request) { return Decision.ADMITTED; }
                @Override public String configuredDefaultVoiceId() { return "test-only-configured-voice"; }
            };

    @Mock
    private AudioVideoLibrary library;

    @Mock
    private TtsEngine engine;

    private SimpleMeterRegistry registry;
    private TtsGrpcService service;
    private Context testIdentityContext;
    private Context previousContext;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() throws ReflectiveOperationException {
        Field identityKeyField = JwtServerInterceptor.class.getDeclaredField("VERIFIED_IDENTITY");
        identityKeyField.setAccessible(true);
        Context.Key<JwtServerInterceptor.VerifiedIdentity> identityKey =
                (Context.Key<JwtServerInterceptor.VerifiedIdentity>) identityKeyField.get(null);
        testIdentityContext = Context.current().withValue(identityKey,
                new JwtServerInterceptor.VerifiedIdentity("test-subject", "test-tenant"));
        previousContext = testIdentityContext.attach();
        registry = new SimpleMeterRegistry();
        service = new TtsGrpcService(library, registry);
        lenient().when(library.getTtsEngine()).thenReturn(engine);
    }

    @org.junit.jupiter.api.AfterEach
    void restoreContext() {
        testIdentityContext.detach(previousContext);
    }

    private TtsGrpcService admittedService(
            java.util.function.BooleanSupplier synthesisAdmitted,
            java.util.function.BooleanSupplier streamingAdmitted) {
        return new TtsGrpcService(library, registry, synthesisAdmitted, streamingAdmitted,
                null, TEST_ADMITTED_AUTHORIZATION,
                (voiceId, language) -> synthesisAdmitted.getAsBoolean());
    }

    private TtsGrpcService admittedService(
            java.util.function.BooleanSupplier synthesisAdmitted,
            java.util.function.BooleanSupplier streamingAdmitted,
            Duration timeout) {
        return new TtsGrpcService(library, registry, synthesisAdmitted, streamingAdmitted,
                timeout, TEST_ADMITTED_AUTHORIZATION,
                (voiceId, language) -> synthesisAdmitted.getAsBoolean());
    }

    private TtsGrpcService admittedService(
            java.util.function.BooleanSupplier synthesisAdmitted,
            java.util.function.BooleanSupplier streamingAdmitted,
            Duration timeout,
            AudioVideoTracingService tracing) {
        return new TtsGrpcService(library, registry, synthesisAdmitted, streamingAdmitted,
                timeout, tracing, TEST_ADMITTED_AUTHORIZATION);
    }

    @Test
    void synthesizeFailsBeforeProviderLookupWithoutExactAdmittedVoiceLanguageRightsProfile() {
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        service.synthesize(
                SynthesizeRequest.newBuilder().setText("Hello world").build(),
                observer);

        assertStatus(observer, Status.Code.UNAVAILABLE);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getDescription())
                .isEqualTo("TTS_NOT_ADMITTED: synthesis provider or capability is unavailable");
        verify(engine, never()).synthesize(anyString(), any());
        verify(library, never()).getTtsEngine();
        verify(engine, never()).close();
        assertThat(registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("boundary", "provider").timer()).isNull();
    }

    @Test
    void productionCompositionCannotReturnRepeatingByteSyntheticFallback() {
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        try (ProductionTtsGrpcService production = new ProductionTtsGrpcService(library, registry)) {
            production.synthesize(SynthesizeRequest.newBuilder().setText("should not dispatch").build(), observer);
        }

        assertStatus(observer, Status.Code.UNAVAILABLE);
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
        verify(library, never()).getTtsEngine();
        verify(engine, never()).synthesize(anyString(), any());
    }

    @Test
    void synthesisRejectsEncodedAudioLabeledAsPcmBeforeResponse() {
        TtsGrpcService admitted = admittedService(() -> true, () -> false);
        when(engine.synthesize(anyString(), any())).thenReturn(new AudioData(
                new byte[44], 22_050, 1, 16, Duration.ofMillis(1), AudioFormat.MP3));
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        admitted.synthesize(SynthesizeRequest.newBuilder().setText("codec mismatch").build(), observer);

        assertStatus(observer, Status.Code.FAILED_PRECONDITION);
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
        verify(engine).synthesize(anyString(), any());
    }

    @Test
    void synthesizeTraceUsesNoContentIdentifiersAndKeepsProviderMetricSingle() {
        TraceHarness trace = new TraceHarness();
        TtsGrpcService admitted = admittedService(() -> true, () -> false, null, trace.tracing);
        when(engine.synthesize(anyString(), any())).thenAnswer(invocation -> {
            trace.assertCurrentOperationSpan();
            byte[] pcm = audiblePcmFixture();
            return new AudioData(pcm, 22_050, 1, 16, Duration.ofMillis(1), AudioFormat.PCM);
        });
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();
        String protectedText = "private synthesis phrase 103857";

        admitted.synthesize(SynthesizeRequest.newBuilder().setText(protectedText).build(), observer);

        assertThat(observer.error).isNull();
        assertThat(observer.value).isNotNull();
        SpanData span = trace.finishedSpan();
        assertThat(span.getStatus().getStatusCode().name()).isEqualTo("OK");
        assertNoProtectedMarker(span, protectedText, "protected-voice-8062");
        Timer providerTimer = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("boundary", "provider")
                .tag("execution_class", "model").tag("outcome", "success").timer();
        assertThat(providerTimer).isNotNull();
        assertThat(providerTimer.count()).isEqualTo(1);
    }

    @Test
    void failClosedSynthesisRecordsTraceErrorWithoutPassingTextOrVoiceId() {
        TraceHarness trace = new TraceHarness();
        TtsGrpcService failClosed = new TtsGrpcService(library, registry, () -> false, () -> false,
                null, trace.tracing);
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        failClosed.synthesize(SynthesizeRequest.newBuilder()
                .setText("sensitive text 205941")
                .setVoiceId("protected-voice-8062")
                .build(), observer);

        assertStatus(observer, Status.Code.UNAVAILABLE);
        SpanData span = trace.finishedSpan();
        assertThat(span.getStatus().getStatusCode().name()).isEqualTo("ERROR");
        assertThat(span.getStatus().getDescription()).isEqualTo("Media operation failed");
        assertThat(span.getAttributes().get(io.opentelemetry.api.common.AttributeKey.stringKey("error.type")))
                .isEqualTo("StatusRuntimeException");
        assertNoProtectedMarker(span, "sensitive text 205941", "protected-voice-8062");
        verify(engine, never()).synthesize(anyString(), any());
        verify(library, never()).getTtsEngine();
    }

    @Test
    void streamingProviderAndResponseCallbacksRunWithOperationSpan() throws Exception {
        TraceHarness trace = new TraceHarness();
        TtsGrpcService admitted = admittedService(() -> true, () -> true, Duration.ofSeconds(2), trace.tracing);
        CountDownLatch completed = new CountDownLatch(1);
        AtomicReference<Runnable> cancelHandler = new AtomicReference<>();
        String protectedText = "private stream phrase 908173";
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            trace.assertCurrentOperationSpan();
            TtsStreamSink sink = invocation.getArgument(2);
            sink.onAudioFormat(new CanonicalAudioFormat(22_050, 1, 16, AudioFormat.PCM));
            sink.onChunk(new com.ghatana.media.common.AudioChunk(
                    new byte[]{1, 2, 3, 4}, 0, true, System.currentTimeMillis()));
            CompletableFuture<Void> done = CompletableFuture.completedFuture(null);
            return TtsStreamingSession.create(new AtomicBoolean(), done);
        });
        @SuppressWarnings("unchecked")
        ServerCallStreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer =
                mock(ServerCallStreamObserver.class);
        when(observer.isReady()).thenReturn(true);
        when(observer.isCancelled()).thenReturn(false);
        doAnswer(invocation -> { cancelHandler.set(invocation.getArgument(0)); return null; })
                .when(observer).setOnCancelHandler(any(Runnable.class));
        doAnswer(invocation -> {
            trace.assertCurrentOperationSpan();
            assertThat(((com.ghatana.tts.core.grpc.proto.AudioChunk) invocation.getArgument(0))
                    .getAudioData()).isNotEmpty();
            return null;
        }).when(observer).onNext(any());
        doAnswer(invocation -> {
            trace.assertCurrentOperationSpan();
            trace.assertNoFinishedSpans();
            cancelHandler.get().run(); // Reentrant transport cancellation cannot replace the reserved success terminal.
            completed.countDown();
            return null;
        }).when(observer).onCompleted();

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText(protectedText).build(), observer);

        assertThat(completed.await(5, TimeUnit.SECONDS)).isTrue();
        verify(observer, never()).onError(any());
        cancelHandler.get().run(); // Cancellation after successful terminal delivery must not rewrite success.
        long metricDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
        Timer responseSuccess;
        do {
            responseSuccess = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("service", "tts")
                .tag("boundary", "response").tag("execution_class", "control")
                .tag("outcome", "success").timer();
            if (responseSuccess != null && responseSuccess.count() == 1) break;
            Thread.yield();
        } while (System.nanoTime() < metricDeadline);
        assertThat(responseSuccess).isNotNull();
        assertThat(responseSuccess.count()).isEqualTo(1);
        // Streaming has separate voice/profile, provider, and rights decisions.
        assertAdmissionBoundary("success", 3);
        assertThat(responseSuccess.getId().getTags()).extracting("key")
                .doesNotContain("tenant", "subject", "request", "text", "content");
        assertThat(registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("service", "tts")
                .tag("boundary", "response").tag("execution_class", "control")
                .tag("outcome", "unknown").timer()).isNull();
        SpanData span = trace.finishedSpan();
        assertThat(span.getStatus().getStatusCode().name()).isEqualTo("OK");
        assertThat(span.getAttributes().get(
                io.opentelemetry.api.common.AttributeKey.stringKey("media.outcome"))).isNull();
        assertNoProtectedMarker(span, protectedText);
    }

    @Test
    void streamingCancellationEndsSpanWithUnknownOutcome() throws InterruptedException {
        TraceHarness trace = new TraceHarness();
        TtsGrpcService admitted = admittedService(() -> true, () -> true, Duration.ofMillis(250), trace.tracing);
        AtomicReference<Runnable> cancelHandler = new AtomicReference<>();
        AtomicBoolean sessionCancelled = new AtomicBoolean();
        AtomicReference<TtsStreamSink> sinkRef = new AtomicReference<>();
        CompletableFuture<Void> completion = new CompletableFuture<>();
        @SuppressWarnings("unchecked")
        ServerCallStreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer =
                mock(ServerCallStreamObserver.class);
        when(observer.isCancelled()).thenReturn(false);
        doAnswer(invocation -> {
            cancelHandler.set(invocation.getArgument(0));
            return null;
        }).when(observer).setOnCancelHandler(any(Runnable.class));
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            trace.assertCurrentOperationSpan();
            sinkRef.set(invocation.getArgument(2));
            return new TtsStreamingSession() {
                @Override public boolean cancel() { return sessionCancelled.compareAndSet(false, true); }
                @Override public boolean isCancelled() { return sessionCancelled.get(); }
                @Override public CompletableFuture<Void> completion() { return completion; }
            };
        });

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("private stream input 718204").build(), observer);
        cancelHandler.get().run();
        cancelHandler.get().run();
        sinkRef.get().onAudioFormat(monoPcm16Format());
        sinkRef.get().onChunk(new com.ghatana.media.common.AudioChunk(new byte[] {1, 2}, 0, true, 1));
        completion.completeExceptionally(new IllegalStateException("provider-private-error-44019"));
        Thread.sleep(350); // Let late completion and timeout workers observe the already-won terminal gate.

        assertThat(sessionCancelled).isTrue();
        Timer streamingTimer = registry.find("tts.synthesize.streaming").timer();
        assertThat(streamingTimer.count()).isEqualTo(1);
        verify(observer, never()).onNext(any());
        verify(observer, never()).onError(any());
        verify(observer, never()).onCompleted();
        SpanData span = trace.finishedSpan();
        assertThat(span.getAttributes().get(
                io.opentelemetry.api.common.AttributeKey.stringKey("media.outcome"))).isEqualTo("unknown");
        assertNoProtectedMarker(span, "private stream input 718204", "provider-private-error-44019");
    }

    @Test
    void timeoutCancellationRaceFinishesUnknownAndCancelsSession() throws Exception {
        TraceHarness trace = new TraceHarness();
        TtsGrpcService admitted = admittedService(() -> true, () -> true, Duration.ofMillis(250), trace.tracing);
        AtomicReference<Runnable> cancelHandler = new AtomicReference<>();
        AtomicReference<TtsStreamingSession> sessionRef = new AtomicReference<>();
        AtomicBoolean sessionCancelled = new AtomicBoolean();
        CountDownLatch providerStarted = new CountDownLatch(1);
        CountDownLatch sessionCancelledLatch = new CountDownLatch(1);
        AtomicInteger cancellationChecks = new AtomicInteger();
        @SuppressWarnings("unchecked")
        ServerCallStreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer =
                mock(ServerCallStreamObserver.class);
        when(observer.isCancelled()).thenAnswer(invocation -> {
            int check = cancellationChecks.incrementAndGet();
            if (check == 6) {
                // The timeout has already won the terminal CAS; the transport handler loses it.
                cancelHandler.get().run();
                return true;
            }
            return false;
        });
        doAnswer(invocation -> { cancelHandler.set(invocation.getArgument(0)); return null; })
                .when(observer).setOnCancelHandler(any(Runnable.class));
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            trace.assertCurrentOperationSpan();
            providerStarted.countDown();
            TtsStreamingSession session = new TtsStreamingSession() {
                @Override public boolean cancel() {
                    boolean won = sessionCancelled.compareAndSet(false, true);
                    if (won) sessionCancelledLatch.countDown();
                    return won;
                }
                @Override public boolean isCancelled() { return sessionCancelled.get(); }
                @Override public CompletableFuture<Void> completion() { return new CompletableFuture<>(); }
            };
            sessionRef.set(session);
            return session;
        });

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("timeout-race-private-55021").build(), observer);

        assertThat(providerStarted.await(2, TimeUnit.SECONDS)).isTrue();
        assertThat(sessionCancelledLatch.await(3, TimeUnit.SECONDS)).isTrue();
        verify(observer, never()).onNext(any());
        verify(observer, never()).onError(any());
        verify(observer, never()).onCompleted();
        assertThat(sessionRef.get().isCancelled()).isTrue();
        SpanData span = trace.finishedSpan();
        assertThat(span.getAttributes().get(
                io.opentelemetry.api.common.AttributeKey.stringKey("media.outcome"))).isEqualTo("unknown");
        assertNoProtectedMarker(span, "timeout-race-private-55021");
    }

    @Test
    void throwingCompletionCallbackFinishesUnknownAfterCallback() throws Exception {
        TraceHarness trace = new TraceHarness();
        TtsGrpcService admitted = admittedService(() -> true, () -> true, Duration.ofSeconds(2), trace.tracing);
        CountDownLatch callbackEntered = new CountDownLatch(1);
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            TtsStreamSink sink = invocation.getArgument(2);
            sink.onAudioFormat(monoPcm16Format());
            sink.onChunk(new com.ghatana.media.common.AudioChunk(new byte[] {1, 2}, 0, true, 1));
            return TtsStreamingSession.create(new AtomicBoolean(), CompletableFuture.completedFuture(null));
        });
        StreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = new StreamObserver<>() {
            @Override public void onNext(com.ghatana.tts.core.grpc.proto.AudioChunk value) {}
            @Override public void onError(Throwable failure) { throw new AssertionError("unexpected error callback"); }
            @Override public void onCompleted() {
                trace.assertCurrentOperationSpan();
                trace.assertNoFinishedSpans();
                callbackEntered.countDown();
                throw new IllegalStateException("downstream-private-marker-61034");
            }
        };

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("completion-marker-private-61034").build(), observer);

        assertThat(callbackEntered.await(3, TimeUnit.SECONDS)).isTrue();
        SpanData span = trace.finishedSpan();
        assertThat(span.getStatus().getStatusCode().name()).isEqualTo("UNSET");
        assertThat(span.getAttributes().get(
                io.opentelemetry.api.common.AttributeKey.stringKey("media.outcome"))).isEqualTo("unknown");
        assertNoProtectedMarker(span, "completion-marker-private-61034", "downstream-private-marker-61034");
    }

    @Test
    void throwingFinalAudioCallbackFinishesUnknownWithoutReportingSuccess() throws Exception {
        TraceHarness trace = new TraceHarness();
        TtsGrpcService admitted = admittedService(() -> true, () -> true, Duration.ofSeconds(2), trace.tracing);
        CountDownLatch callbackEntered = new CountDownLatch(1);
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            TtsStreamSink sink = invocation.getArgument(2);
            sink.onAudioFormat(monoPcm16Format());
            sink.onChunk(new com.ghatana.media.common.AudioChunk(new byte[] {1, 2}, 0, true, 1));
            return TtsStreamingSession.create(new AtomicBoolean(), CompletableFuture.completedFuture(null));
        });
        StreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = new StreamObserver<>() {
            @Override public void onNext(com.ghatana.tts.core.grpc.proto.AudioChunk value) {
                trace.assertCurrentOperationSpan();
                trace.assertNoFinishedSpans();
                callbackEntered.countDown();
                throw new IllegalStateException("downstream-private-audio-88216");
            }
            @Override public void onError(Throwable failure) { throw new AssertionError("late error callback"); }
            @Override public void onCompleted() { throw new AssertionError("false success callback"); }
        };

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("final-audio-private-88216").build(), observer);

        assertThat(callbackEntered.await(3, TimeUnit.SECONDS)).isTrue();
        SpanData span = trace.finishedSpan();
        assertThat(span.getStatus().getStatusCode().name()).isEqualTo("UNSET");
        assertThat(span.getAttributes().get(
                io.opentelemetry.api.common.AttributeKey.stringKey("media.outcome"))).isEqualTo("unknown");
        assertNoProtectedMarker(span, "final-audio-private-88216", "downstream-private-audio-88216");
    }

    @Test
    void throwingErrorCallbackStillFinishesOriginalErrorSpan() {
        TraceHarness trace = new TraceHarness();
        TtsGrpcService failClosed = new TtsGrpcService(library, registry, () -> false, () -> false,
                null, trace.tracing);
        StreamObserver<SynthesizeResponse> observer = new StreamObserver<>() {
            @Override public void onNext(SynthesizeResponse value) {}
            @Override public void onError(Throwable failure) {
                trace.assertCurrentOperationSpan();
                trace.assertNoFinishedSpans();
                throw new IllegalStateException("downstream-private-error-callback-77192");
            }
            @Override public void onCompleted() {}
        };

        assertThatThrownBy(() -> failClosed.synthesize(SynthesizeRequest.newBuilder()
                .setText("error-callback-private-input-77192").build(), observer))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("downstream-private-error-callback-77192");

        SpanData span = trace.finishedSpan();
        assertThat(span.getStatus().getStatusCode().name()).isEqualTo("ERROR");
        assertThat(span.getStatus().getDescription()).isEqualTo("Media operation failed");
        assertThat(span.getAttributes().get(io.opentelemetry.api.common.AttributeKey.stringKey("error.type")))
                .isEqualTo("StatusRuntimeException");
        assertNoProtectedMarker(span, "error-callback-private-input-77192", "downstream-private-error-callback-77192");
    }

    @Test
    void admittedFakeEngineRunsThroughRequestPathAndExportsPrivateBoundedProviderMetric() {
        TtsGrpcService admitted = admittedService(() -> true, () -> false);
        byte[] pcm = audiblePcmFixture();
        when(engine.synthesize(anyString(), any())).thenReturn(new AudioData(
                pcm, 22_050, 1, 16, Duration.ofMillis(1), AudioFormat.PCM));
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        admitted.synthesize(SynthesizeRequest.newBuilder().setText("private test phrase").build(), observer);

        assertThat(observer.error).isNull();
        assertThat(observer.value).isNotNull();
        assertAdmissionBoundary("success", 2);
        Timer provider = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("service", "tts")
                .tag("boundary", "provider").tag("execution_class", "model")
                .tag("outcome", "success").timer();
        assertThat(provider).isNotNull();
        assertThat(provider.count()).isEqualTo(1);
        assertThat(provider.getId().getTags()).extracting("key")
                .doesNotContain("tenant", "text", "content", "voice", "provider_id");
        Timer response = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("service", "tts")
                .tag("boundary", "response").tag("execution_class", "control")
                .tag("outcome", "success").timer();
        assertThat(response).isNotNull();
        assertThat(response.count()).isEqualTo(1);
        assertThat(response.getId().getTags()).extracting("key")
                .doesNotContain("tenant", "request", "content", "text", "voice", "provider_id");
    }

    @Test
    void deniedVoiceAuthorizationRecordsAdmissionFailureWithoutProviderAccess() {
        TtsRequestAuthorization denied = request -> TtsRequestAuthorization.Decision.DENIED;
        TtsGrpcService serviceWithDeniedVoice = new TtsGrpcService(library, registry,
                () -> true, () -> false, null, denied, (voiceId, language) -> true);
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        serviceWithDeniedVoice.synthesize(SynthesizeRequest.newBuilder()
                .setText("private denied phrase")
                .setVoiceId("protected-voice-1138")
                .build(), observer);

        assertStatus(observer, Status.Code.PERMISSION_DENIED);
        assertAdmissionBoundary("success", 1);
        assertAdmissionBoundary("failure", 1);
        verify(library, never()).getTtsEngine();
        verify(engine, never()).synthesize(anyString(), any());
    }

    @Test
    void throwingAdmissionSupplierFailsClosedAndRecordsUnknownWithoutProviderAccess() {
        TtsGrpcService admissionUnavailable = admittedService(() -> {
            throw new IllegalStateException("admission dependency unavailable");
        }, () -> false);
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        admissionUnavailable.synthesize(SynthesizeRequest.newBuilder()
                .setText("private admission phrase")
                .setVoiceId("protected-voice-2194")
                .build(), observer);

        assertStatus(observer, Status.Code.FAILED_PRECONDITION);
        assertAdmissionBoundary("unknown", 1);
        verify(library, never()).getTtsEngine();
        verify(engine, never()).synthesize(anyString(), any());
    }

    private void assertAdmissionBoundary(String outcome, long expectedCount) {
        Timer admission = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("service", "tts")
                .tag("boundary", "admission").tag("execution_class", "control")
                .tag("outcome", outcome).timer();
        assertThat(admission).isNotNull();
        assertThat(admission.count()).isEqualTo(expectedCount);
        assertThat(admission.getId().getTags()).extracting(io.micrometer.core.instrument.Tag::getKey)
                .containsExactlyInAnyOrder("modality", "service", "boundary",
                        "execution_class", "outcome", "contract_version");
        assertThat(registry.getMeters()).allSatisfy(meter -> {
            assertThat(meter.getId().getTag("tenant")).isNull();
            assertThat(meter.getId().getTag("subject")).isNull();
            assertThat(meter.getId().getTag("request")).isNull();
            assertThat(meter.getId().getTag("voice")).isNull();
            assertThat(meter.getId().getTag("content")).isNull();
        });
    }

    @Test
    void ambiguousProviderExceptionExportsUnknownAndDoesNotReturnAudio() {
        TtsGrpcService admitted = admittedService(() -> true, () -> false);
        when(engine.synthesize(anyString(), any())).thenThrow(new IllegalStateException("provider interrupted"));
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        admitted.synthesize(SynthesizeRequest.newBuilder().setText("private test phrase").build(), observer);

        assertStatus(observer, Status.Code.FAILED_PRECONDITION);
        Timer provider = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("boundary", "provider").tag("outcome", "unknown").timer();
        assertThat(provider).isNotNull();
        assertThat(provider.count()).isEqualTo(1);
        assertThat(registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("boundary", "provider").tag("outcome", "success").timer()).isNull();
    }

    @Test
    void cancellationAfterProviderReturnRecordsUnknownAndDoesNotEmitAudio() {
        TtsGrpcService admitted = admittedService(() -> true, () -> false);
        byte[] pcm = audiblePcmFixture();
        when(engine.synthesize(anyString(), any())).thenReturn(new AudioData(
                pcm, 22_050, 1, 16, Duration.ofMillis(1), AudioFormat.PCM));
        @SuppressWarnings("unchecked")
        ServerCallStreamObserver<SynthesizeResponse> observer = mock(ServerCallStreamObserver.class);
        when(observer.isCancelled()).thenReturn(true);

        admitted.synthesize(SynthesizeRequest.newBuilder().setText("private test phrase").build(), observer);

        Timer provider = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("boundary", "provider").tag("outcome", "unknown").timer();
        assertThat(provider).isNotNull();
        assertThat(provider.count()).isEqualTo(1);
        assertThat(registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("boundary", "provider").tag("outcome", "success").timer()).isNull();
        Timer response = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("boundary", "response").tag("outcome", "unknown").timer();
        assertThat(response).isNotNull();
        assertThat(response.count()).isEqualTo(1);
        verify(observer, never()).onNext(any());
        verify(observer, never()).onCompleted();
    }

    @Test
    void sourceLocaleMatrixFailsWithoutDefaultSubstitution() {
        // Exercise the server's production composition, not only the provider-neutral façade.
        // The injected library stays unused because no exact voice-language-rights profile is
        // source-admitted for this service cut.
        try (ProductionTtsGrpcService production = new ProductionTtsGrpcService(library, registry)) {
            for (String language : List.of("", "en", "ne", "hi", "en-US", "ne-NP", "hi-IN",
                    "es", "fr", "de", "ja", "zh", "es-ES", "fr-FR", "de-DE", "ja-JP", "zh-CN", "bn-BD")) {
                CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();
                production.synthesize(SynthesizeRequest.newBuilder().setText("hello")
                        .setOptions(com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder()
                                .setLanguage(language).build()).build(), observer);

                assertStatus(observer, Status.Code.UNAVAILABLE);
                assertThat(((StatusRuntimeException) observer.error).getStatus().getDescription())
                        .isEqualTo("TTS_NOT_ADMITTED: synthesis provider or capability is unavailable");
                assertThat(observer.value).as("language %s must not produce a substituted result", language).isNull();
                assertThat(observer.completed).as("language %s must not complete successfully", language).isFalse();
            }

            // An omitted BCP-47 option requests the provider default. It is still unadmitted,
            // rather than permission to use the configured default voice/language.
            CapturingObserver<SynthesizeResponse> defaultLanguage = new CapturingObserver<>();
            production.synthesize(SynthesizeRequest.newBuilder().setText("hello").build(), defaultLanguage);
            assertStatus(defaultLanguage, Status.Code.UNAVAILABLE);
            assertThat(defaultLanguage.value).isNull();
            assertThat(defaultLanguage.completed).isFalse();

            CapturingObserver<SynthesizeResponse> explicitVoice = new CapturingObserver<>();
            production.synthesize(SynthesizeRequest.newBuilder().setText("hello")
                    .setVoiceId("provider-default")
                    .setOptions(com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder()
                            .setLanguage("hi-IN").build()).build(), explicitVoice);
            assertStatus(explicitVoice, Status.Code.UNAVAILABLE);
            assertThat(((StatusRuntimeException) explicitVoice.error).getStatus().getDescription())
                    .contains("TTS_NOT_ADMITTED");
            assertThat(explicitVoice.value).isNull();
            assertThat(explicitVoice.completed).isFalse();

            CapturingObserver<SynthesizeResponse> profileDefaultLanguage = new CapturingObserver<>();
            production.synthesize(SynthesizeRequest.newBuilder().setText("hello")
                    .setProfileId("profile-with-ne-default").build(), profileDefaultLanguage);
            assertStatus(profileDefaultLanguage, Status.Code.UNAVAILABLE);
            assertThat(((StatusRuntimeException) profileDefaultLanguage.error).getStatus().getDescription())
                    .contains("TTS_NOT_ADMITTED");
            assertThat(profileDefaultLanguage.value).isNull();
            assertThat(profileDefaultLanguage.completed).isFalse();
        }
        verify(engine, never()).synthesize(anyString(), any());
        verify(library, never()).getTtsEngine();
    }

    @Test
    void unsupportedCodecRequestsFailBeforeCallingProvider() {
        for (com.ghatana.tts.core.grpc.proto.AudioFormat format : List.of(
                com.ghatana.tts.core.grpc.proto.AudioFormat.AUDIO_FORMAT_PCM_F32LE,
                com.ghatana.tts.core.grpc.proto.AudioFormat.AUDIO_FORMAT_WAV,
                com.ghatana.tts.core.grpc.proto.AudioFormat.AUDIO_FORMAT_MP3)) {
            CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();
            service.synthesize(SynthesizeRequest.newBuilder()
                    .setText("Hello")
                    .setOptions(com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder()
                            .setOutputFormat(format)
                            .build())
                    .build(), observer);

            assertStatus(observer, Status.Code.UNIMPLEMENTED);
            assertThat(observer.value).isNull();
        }
        verify(engine, never()).synthesize(anyString(), any());
    }

    @Test
    void loadVoiceIsNotAdmittedBeforeEngineLookupWithoutRightsProfile() {
        CapturingObserver<LoadVoiceResponse> observer = new CapturingObserver<>();

        service.loadVoice(LoadVoiceRequest.newBuilder().setVoiceId("voice-1").build(), observer);

        assertStatus(observer, Status.Code.UNIMPLEMENTED);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getDescription())
                .contains("NOT_ADMITTED", "model", "license", "owner-rights", "consent");
        verify(library, never()).getTtsEngine();
        verify(engine, never()).loadVoice(anyString());
    }

    @Test
    void validStreamRequestFailsNotAdmittedWithoutEmittingPartialOrFinalAudio() {
        TtsGrpcService voiceAdmittedButStreamingUnavailable = admittedService(() -> true, () -> false);
        CapturingObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer =
                new CapturingObserver<>();

        voiceAdmittedButStreamingUnavailable.streamSynthesize(
                SynthesizeRequest.newBuilder().setText("hello").build(), observer);

        assertStatus(observer, Status.Code.UNAVAILABLE);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getDescription())
                .isEqualTo("TTS_NOT_ADMITTED: synthesis provider or capability is unavailable");
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
        verify(library, never()).getTtsEngine();
        verify(engine, never()).synthesize(anyString(), any());
        assertThat(registry.get("tts.synthesize.streaming").timer().count()).isEqualTo(1);
        Timer responseFailure = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("service", "tts")
                .tag("boundary", "response").tag("execution_class", "control")
                .tag("outcome", "failure").timer();
        assertThat(responseFailure).isNotNull();
        assertThat(responseFailure.count()).isEqualTo(1);
        // The voice profile is admitted, then the separate streaming provider gate
        // rejects before rights authorization is evaluated.
        assertAdmissionBoundary("success", 1);
        assertAdmissionBoundary("failure", 1);
    }

    @Test
    void streamObserverErrorCallbackExceptionRecordsResponseUnknown() {
        StreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = new StreamObserver<>() {
            @Override public void onNext(com.ghatana.tts.core.grpc.proto.AudioChunk value) {}
            @Override public void onError(Throwable error) {
                throw new IllegalStateException("ambiguous stream error callback");
            }
            @Override public void onCompleted() {}
        };

        assertThatThrownBy(() -> service.streamSynthesize(
                SynthesizeRequest.newBuilder().setText("hello").build(), observer))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("ambiguous stream error callback");

        Timer responseUnknown = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("service", "tts")
                .tag("boundary", "response").tag("execution_class", "control")
                .tag("outcome", "unknown").timer();
        assertThat(responseUnknown).isNotNull();
        assertThat(responseUnknown.count()).isEqualTo(1);
        assertThat(registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("service", "tts")
                .tag("boundary", "response").tag("execution_class", "control")
                .tag("outcome", "failure").timer()).isNull();
    }

    @Test
    void streamRequestExceedingTextBoundFailsBeforeProviderLookup() {
        CapturingObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer =
                new CapturingObserver<>();

        service.streamSynthesize(
                SynthesizeRequest.newBuilder().setText("x".repeat(5_001)).build(), observer);

        assertStatus(observer, Status.Code.INVALID_ARGUMENT);
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
        verify(library, never()).getTtsEngine();
        verify(engine, never()).synthesize(anyString(), any());
    }

    @Test
    void streamFailsUnavailableBeforeProviderLookupWhenDownstreamIsNotReady() {
        @SuppressWarnings("unchecked")
        ServerCallStreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer =
                mock(ServerCallStreamObserver.class);
        lenient().when(observer.isReady()).thenReturn(false);

        service.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);

        var failure = org.mockito.ArgumentCaptor.forClass(Throwable.class);
        verify(observer).onError(failure.capture());
        assertThat(Status.fromThrowable(failure.getValue()).getCode()).isEqualTo(Status.Code.UNAVAILABLE);
        verify(observer, never()).onNext(any());
        verify(observer, never()).onCompleted();
        verify(observer, never()).isReady();
        verify(library, never()).getTtsEngine();
    }

    @Test
    void streamCancellationCreatesNoProviderSessionOrAudioChunks() {
        @SuppressWarnings("unchecked")
        ServerCallStreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer =
                mock(ServerCallStreamObserver.class);
        AtomicReference<Runnable> cancelHandler = new AtomicReference<>();
        doAnswer(invocation -> {
            cancelHandler.set(invocation.getArgument(0));
            cancelHandler.get().run();
            return null;
        }).when(observer).setOnCancelHandler(any(Runnable.class));

        service.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);

        assertThat(cancelHandler.get()).isNotNull();
        verify(observer, never()).onNext(any());
        verify(observer, never()).onCompleted();
        verify(observer, never()).onError(any());
        verify(library, never()).getTtsEngine();
        Timer responseUnknown = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("service", "tts")
                .tag("boundary", "response").tag("execution_class", "control")
                .tag("outcome", "unknown").timer();
        assertThat(responseUnknown).isNotNull();
        assertThat(responseUnknown.count()).isEqualTo(1);
    }

    @Test
    void streamAlreadyCancelledBeforeHandlerRegistrationSkipsValidationAndDoesNotRespond() {
        @SuppressWarnings("unchecked")
        ServerCallStreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer =
                mock(ServerCallStreamObserver.class);
        lenient().when(observer.isCancelled()).thenReturn(true);

        service.streamSynthesize(SynthesizeRequest.getDefaultInstance(), observer);

        verify(observer).setOnCancelHandler(any(Runnable.class));
        verify(observer, never()).onNext(any());
        verify(observer, never()).onCompleted();
        verify(observer, never()).onError(any());
        verify(observer, never()).isReady();
        verify(library, never()).getTtsEngine();
        assertThat(registry.get("tts.synthesize.streaming").timer().count()).isEqualTo(1);
    }

    @Test
    void streamSuppressesNotAdmittedErrorWhenTransportCancellationWinsBeforeCatch() {
        @SuppressWarnings("unchecked")
        ServerCallStreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer =
                mock(ServerCallStreamObserver.class);
        // Active at entry and after request validation; canceled while the NOT_ADMITTED
        // result is being handled, before the terminal observer callback.
        lenient().when(observer.isCancelled()).thenReturn(false, false, true);

        service.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);

        verify(observer, org.mockito.Mockito.times(3)).isCancelled();
        verify(observer, never()).onNext(any());
        verify(observer, never()).onCompleted();
        verify(observer, never()).onError(any());
        verify(library, never()).getTtsEngine();
    }

    @Test
    void admittedStreamWaitsForObserverReadinessAndPreservesProviderFinalChunk() throws Exception {
        TtsGrpcService admitted = admittedService(() -> true, () -> true);
        @SuppressWarnings("unchecked")
        ServerCallStreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = mock(ServerCallStreamObserver.class);
        AtomicReference<Runnable> readyHandler = new AtomicReference<>();
        AtomicReference<TtsStreamSink> sinkRef = new AtomicReference<>();
        AtomicReference<CompletableFuture<Void>> completionRef = new AtomicReference<>();
        when(observer.isReady()).thenReturn(false, false, true, true);
        doAnswer(invocation -> { readyHandler.set(invocation.getArgument(0)); return null; })
                .when(observer).setOnReadyHandler(any(Runnable.class));
        doAnswer(invocation -> {
            TtsStreamSink sink = invocation.getArgument(2);
            sinkRef.set(sink);
            CompletableFuture<Void> completion = new CompletableFuture<>();
            completionRef.set(completion);
            return TtsStreamingSession.create(new AtomicBoolean(), completion);
        }).when(engine).startStreaming(anyString(), any(), any());

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);
        assertThat(sinkRef.get()).isNotNull();
        sinkRef.get().onAudioFormat(monoPcm16Format());
        Thread producer = Thread.startVirtualThread(() -> {
            sinkRef.get().onChunk(new com.ghatana.media.common.AudioChunk(new byte[] {1, 2}, 0, false, 6));
            sinkRef.get().onChunk(new com.ghatana.media.common.AudioChunk(new byte[] {3, 4}, 1, true, 7));
        });
        Thread.sleep(30);
        verify(observer, never()).onNext(any());
        when(observer.isReady()).thenReturn(true);
        readyHandler.get().run();
        producer.join(1_000);
        assertThat(producer.isAlive()).isFalse();
        verify(observer).onNext(org.mockito.ArgumentMatchers.argThat(chunk ->
                chunk.getAudioData().toByteArray()[0] == 1 && !chunk.getIsFinal()));
        completionRef.get().complete(null);
        org.mockito.InOrder ordered = org.mockito.Mockito.inOrder(observer);
        ordered.verify(observer).onNext(org.mockito.ArgumentMatchers.argThat(chunk ->
                chunk.getAudioData().toByteArray()[0] == 1 && !chunk.getIsFinal()));
        ordered.verify(observer, org.mockito.Mockito.timeout(1_000)).onNext(org.mockito.ArgumentMatchers.argThat(chunk ->
                chunk.getAudioData().toByteArray()[0] == 3
                        && chunk.getTimestampMs() == 7 && chunk.getIsFinal()));
        verify(observer, org.mockito.Mockito.timeout(1_000)).onCompleted();
    }

    @Test
    void admittedStreamCancellationCancelsSessionAndSuppressesFurtherChunks() {
        TtsGrpcService admitted = admittedService(() -> true, () -> true);
        @SuppressWarnings("unchecked")
        ServerCallStreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = mock(ServerCallStreamObserver.class);
        AtomicReference<Runnable> cancelHandler = new AtomicReference<>();
        AtomicReference<TtsStreamSink> sinkRef = new AtomicReference<>();
        AtomicBoolean sessionCancelled = new AtomicBoolean();
        doAnswer(invocation -> { cancelHandler.set(invocation.getArgument(0)); return null; })
                .when(observer).setOnCancelHandler(any(Runnable.class));
        doAnswer(invocation -> {
            sinkRef.set(invocation.getArgument(2));
            CompletableFuture<Void> completion = new CompletableFuture<>();
            TtsStreamingSession session = TtsStreamingSession.create(sessionCancelled, completion);
            return session;
        }).when(engine).startStreaming(anyString(), any(), any());

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);
        cancelHandler.get().run();
        assertThat(sessionCancelled).isTrue();
        sinkRef.get().onChunk(new com.ghatana.media.common.AudioChunk(new byte[] {1}, 0, true, 1));
        verify(observer, never()).onNext(any());
        verify(observer, never()).onCompleted();
        verify(observer, never()).onError(any());
    }

    @Test
    void admittedStreamCancellationAfterPartialChunkKeepsDeliveredPrefixAndSuppressesFinality() {
        TtsGrpcService admitted = admittedService(() -> true, () -> true);
        @SuppressWarnings("unchecked")
        ServerCallStreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = mock(ServerCallStreamObserver.class);
        AtomicReference<Runnable> cancelHandler = new AtomicReference<>();
        AtomicReference<TtsStreamSink> sinkRef = new AtomicReference<>();
        AtomicBoolean sessionCancelled = new AtomicBoolean();
        when(observer.isReady()).thenReturn(true);
        doAnswer(invocation -> { cancelHandler.set(invocation.getArgument(0)); return null; })
                .when(observer).setOnCancelHandler(any(Runnable.class));
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            sinkRef.set(invocation.getArgument(2));
            return TtsStreamingSession.create(sessionCancelled, new CompletableFuture<>());
        });

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);
        sinkRef.get().onAudioFormat(monoPcm16Format());
        sinkRef.get().onChunk(new com.ghatana.media.common.AudioChunk(new byte[] {1, 2}, 0, false, 1));
        verify(observer).onNext(org.mockito.ArgumentMatchers.argThat(chunk -> !chunk.getIsFinal()
                && chunk.getAudioData().equals(ByteString.copyFrom(new byte[] {1, 2}))));

        cancelHandler.get().run();
        sinkRef.get().onChunk(new com.ghatana.media.common.AudioChunk(new byte[] {3, 4}, 1, true, 2));

        assertThat(sessionCancelled).isTrue();
        verify(observer, org.mockito.Mockito.times(1)).onNext(any());
        verify(observer, never()).onCompleted();
        verify(observer, never()).onError(any());
    }

    @Test
    void admittedStreamBoundsCumulativeOutputAndCancelsWhenTheLimitIsExceeded() {
        TtsGrpcService admitted = admittedService(() -> true, () -> true);
        AtomicBoolean sessionCancelled = new AtomicBoolean();
        AtomicInteger deliveredChunks = new AtomicInteger();
        AtomicReference<Throwable> error = new AtomicReference<>();
        byte[] providerBuffer = new byte[64 * 1024];
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            TtsStreamSink sink = invocation.getArgument(2);
            sink.onAudioFormat(monoPcm16Format());
            for (int sequence = 0; sequence < PcmAudioValidator.MAX_AUDIO_BYTES / providerBuffer.length; sequence++) {
                sink.onChunk(new com.ghatana.media.common.AudioChunk(providerBuffer, sequence, false, sequence));
            }
            sink.onChunk(new com.ghatana.media.common.AudioChunk(
                    new byte[] {1, 2}, PcmAudioValidator.MAX_AUDIO_BYTES / providerBuffer.length, false,
                    PcmAudioValidator.MAX_AUDIO_BYTES / providerBuffer.length));
            return TtsStreamingSession.create(sessionCancelled, new CompletableFuture<>());
        });
        StreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = new StreamObserver<>() {
            @Override public void onNext(com.ghatana.tts.core.grpc.proto.AudioChunk value) {
                deliveredChunks.incrementAndGet();
            }
            @Override public void onError(Throwable failure) { error.set(failure); }
            @Override public void onCompleted() {}
        };

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);

        assertThat(deliveredChunks).hasValue(PcmAudioValidator.MAX_AUDIO_BYTES / providerBuffer.length);
        assertThat(error.get()).isNotNull();
        assertThat(Status.fromThrowable(error.get()).getCode()).isEqualTo(Status.Code.FAILED_PRECONDITION);
        assertThat(sessionCancelled).isTrue();
    }

    @Test
    void productionStreamingRemainsNotAdmittedWithoutProviderBytes() {
        try (ProductionTtsGrpcService production = new ProductionTtsGrpcService(library, registry)) {
            CapturingObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = new CapturingObserver<>();
            production.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);
            assertStatus(observer, Status.Code.UNAVAILABLE);
            assertThat(observer.value).isNull();
            assertThat(observer.completed).isFalse();
        }
        verify(library, never()).getTtsEngine();
    }

    @Test
    void admittedStreamStartFailureReturnsTerminalError() {
        TtsGrpcService admitted = admittedService(() -> true, () -> true);
        when(engine.startStreaming(anyString(), any(), any()))
                .thenThrow(new IllegalStateException("controlled start failure"));
        CapturingObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = new CapturingObserver<>();

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);

        assertStatus(observer, Status.Code.FAILED_PRECONDITION);
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
    }

    @Test
    void blockedStartTimesOutAndCancelsSessionWhenFactoryEventuallyReturns() throws Exception {
        TtsGrpcService admitted = admittedService(() -> true, () -> true, Duration.ofMillis(100));
        CountDownLatch startEntered = new CountDownLatch(1);
        CountDownLatch releaseStart = new CountDownLatch(1);
        CountDownLatch errorReceived = new CountDownLatch(1);
        AtomicReference<Throwable> error = new AtomicReference<>();
        AtomicBoolean lateSessionCancelled = new AtomicBoolean();
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            startEntered.countDown();
            if (!releaseStart.await(2, TimeUnit.SECONDS)) {
                throw new IllegalStateException("test did not release blocked start");
            }
            return TtsStreamingSession.create(lateSessionCancelled, new CompletableFuture<>());
        });
        @SuppressWarnings("unchecked")
        StreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = mock(StreamObserver.class);
        doAnswer(invocation -> {
            error.set(invocation.getArgument(0));
            errorReceived.countDown();
            return null;
        }).when(observer).onError(any());

        Thread request = Thread.startVirtualThread(() -> {
            Context previous = testIdentityContext.attach();
            try {
                admitted.streamSynthesize(
                        SynthesizeRequest.newBuilder().setText("hello").build(), observer);
            } finally {
                testIdentityContext.detach(previous);
            }
        });
        assertThat(startEntered.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(errorReceived.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(Status.fromThrowable(error.get()).getCode()).isEqualTo(Status.Code.DEADLINE_EXCEEDED);
        releaseStart.countDown();
        request.join(1_000);
        assertThat(request.isAlive()).isFalse();
        assertThat(lateSessionCancelled).isTrue();
        verify(observer, never()).onNext(any());
        verify(observer, never()).onCompleted();
    }

    @Test
    void successfulSessionCompletionWinsDeadlineAndIsNotTimedOutLater() throws Exception {
        TtsGrpcService admitted = admittedService(() -> true, () -> true, Duration.ofMillis(250));
        AtomicReference<TtsStreamSink> sinkRef = new AtomicReference<>();
        AtomicReference<CompletableFuture<Void>> completionRef = new AtomicReference<>();
        CountDownLatch completed = new CountDownLatch(1);
        @SuppressWarnings("unchecked")
        ServerCallStreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = mock(ServerCallStreamObserver.class);
        when(observer.isReady()).thenReturn(true);
        when(observer.isCancelled()).thenReturn(false);
        doAnswer(invocation -> { ((Runnable) invocation.getArgument(0)).run(); return null; })
                .when(observer).setOnReadyHandler(any(Runnable.class));
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            sinkRef.set(invocation.getArgument(2));
            CompletableFuture<Void> completion = new CompletableFuture<>();
            completionRef.set(completion);
            return TtsStreamingSession.create(new AtomicBoolean(), completion);
        });
        doAnswer(invocation -> { completed.countDown(); return null; }).when(observer).onCompleted();

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);
        sinkRef.get().onAudioFormat(monoPcm16Format());
        byte[] providerBuffer = {1, 2};
        sinkRef.get().onChunk(new com.ghatana.media.common.AudioChunk(providerBuffer, 0, true, 4));
        // Providers may recycle their backing buffer as soon as the callback returns. The
        // gRPC boundary must retain the bytes observed at onChunk, including deferred finals.
        providerBuffer[0] = 9;
        providerBuffer[1] = 9;
        completionRef.get().complete(null);
        assertThat(completed.await(1, TimeUnit.SECONDS)).isTrue();
        Thread.sleep(350);

        verify(observer).onNext(org.mockito.ArgumentMatchers.argThat(chunk -> chunk.getIsFinal()
                && chunk.getAudioData().equals(ByteString.copyFrom(new byte[] {1, 2}))));
        verify(observer).onCompleted();
        verify(observer, never()).onError(any());
        assertThat(registry.get("tts.synthesize.streaming").timer().count()).isEqualTo(1);
    }

    @Test
    void admittedStreamChunkValidationFailureReturnsTerminalErrorAndCancelsSession() {
        TtsGrpcService admitted = admittedService(() -> true, () -> true);
        AtomicBoolean sessionCancelled = new AtomicBoolean();
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            TtsStreamSink sink = invocation.getArgument(2);
            sink.onAudioFormat(monoPcm16Format());
            sink.onChunk(new com.ghatana.media.common.AudioChunk(
                    new byte[64 * 1024 + 1], 0, false, 0));
            return TtsStreamingSession.create(sessionCancelled, new CompletableFuture<>());
        });
        CapturingObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = new CapturingObserver<>();

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);

        assertStatus(observer, Status.Code.FAILED_PRECONDITION);
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
        assertThat(sessionCancelled).isTrue();
    }

    @Test
    void oversizedFinalChunkFailsBeforeItCanBeHeldAsPendingFinalAudio() {
        TtsGrpcService admitted = admittedService(() -> true, () -> true);
        AtomicBoolean sessionCancelled = new AtomicBoolean();
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            TtsStreamSink sink = invocation.getArgument(2);
            sink.onAudioFormat(monoPcm16Format());
            sink.onChunk(new com.ghatana.media.common.AudioChunk(
                    new byte[64 * 1024 + 1], 0, true, 0));
            return TtsStreamingSession.create(sessionCancelled, new CompletableFuture<>());
        });
        CapturingObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = new CapturingObserver<>();

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);

        assertStatus(observer, Status.Code.FAILED_PRECONDITION);
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
        assertThat(sessionCancelled).isTrue();
    }

    @Test
    void admittedStreamRejectsSequenceGapAfterPreservingOnlyPriorPartialChunk() {
        TtsGrpcService admitted = admittedService(() -> true, () -> true);
        AtomicBoolean sessionCancelled = new AtomicBoolean();
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            TtsStreamSink sink = invocation.getArgument(2);
            sink.onAudioFormat(monoPcm16Format());
            sink.onChunk(new com.ghatana.media.common.AudioChunk(new byte[] {1, 2}, 0, false, 0));
            sink.onChunk(new com.ghatana.media.common.AudioChunk(new byte[] {3, 4}, 2, true, 1));
            return TtsStreamingSession.create(sessionCancelled, new CompletableFuture<>());
        });
        @SuppressWarnings("unchecked")
        StreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = mock(StreamObserver.class);
        AtomicReference<Throwable> error = new AtomicReference<>();
        doAnswer(invocation -> { error.set(invocation.getArgument(0)); return null; })
                .when(observer).onError(any());

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);

        verify(observer).onNext(org.mockito.ArgumentMatchers.argThat(chunk -> !chunk.getIsFinal()
                && chunk.getAudioData().toByteArray()[0] == 1));
        verify(observer, org.mockito.Mockito.times(1)).onNext(any());
        verify(observer, never()).onCompleted();
        assertThat(Status.fromThrowable(error.get()).getCode()).isEqualTo(Status.Code.FAILED_PRECONDITION);
        assertThat(sessionCancelled).isTrue();
    }

    @Test
    void admittedStreamRejectsNegativeOrDecreasingChunkTimestamps() {
        for (long invalidTimestamp : List.of(-1L, 4L)) {
            TtsGrpcService admitted = admittedService(() -> true, () -> true);
            AtomicBoolean sessionCancelled = new AtomicBoolean();
            when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
                TtsStreamSink sink = invocation.getArgument(2);
                sink.onAudioFormat(monoPcm16Format());
                sink.onChunk(new com.ghatana.media.common.AudioChunk(new byte[] {1, 2}, 0, false, 5));
                sink.onChunk(new com.ghatana.media.common.AudioChunk(new byte[] {3, 4}, 1, true, invalidTimestamp));
                return TtsStreamingSession.create(sessionCancelled, new CompletableFuture<>());
            });
            @SuppressWarnings("unchecked")
            StreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = mock(StreamObserver.class);
            AtomicReference<Throwable> error = new AtomicReference<>();
            doAnswer(invocation -> { error.set(invocation.getArgument(0)); return null; })
                    .when(observer).onError(any());

            admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);

            verify(observer).onNext(org.mockito.ArgumentMatchers.argThat(chunk -> !chunk.getIsFinal()
                    && chunk.getTimestampMs() == 5));
            verify(observer, org.mockito.Mockito.times(1)).onNext(any());
            verify(observer, never()).onCompleted();
            assertThat(Status.fromThrowable(error.get()).getCode()).isEqualTo(Status.Code.FAILED_PRECONDITION);
            assertThat(sessionCancelled).isTrue();
            org.mockito.Mockito.reset(engine);
        }
    }

    @Test
    void admittedPartialStreamFailureDoesNotEmitFalseFinalChunkOrCompleteSuccessfully() throws Exception {
        TtsGrpcService admitted = admittedService(() -> true, () -> true);
        AtomicReference<TtsStreamSink> sinkRef = new AtomicReference<>();
        AtomicReference<CompletableFuture<Void>> completionRef = new AtomicReference<>();
        CountDownLatch errorReceived = new CountDownLatch(1);
        @SuppressWarnings("unchecked")
        StreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = mock(StreamObserver.class);
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            sinkRef.set(invocation.getArgument(2));
            CompletableFuture<Void> completion = new CompletableFuture<>();
            completionRef.set(completion);
            return TtsStreamingSession.create(new AtomicBoolean(), completion);
        });
        doAnswer(invocation -> { errorReceived.countDown(); return null; }).when(observer).onError(any());

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);
        sinkRef.get().onAudioFormat(monoPcm16Format());
        sinkRef.get().onChunk(new com.ghatana.media.common.AudioChunk(new byte[] {1, 2}, 0, false, 0));
        completionRef.get().completeExceptionally(new IllegalStateException("controlled provider failure"));

        assertThat(errorReceived.await(1, TimeUnit.SECONDS)).isTrue();
        verify(observer).onNext(org.mockito.ArgumentMatchers.argThat(chunk -> !chunk.getIsFinal()
                && chunk.getAudioData().toByteArray()[0] == 1));
        verify(observer, org.mockito.Mockito.times(1)).onNext(any());
        verify(observer, never()).onCompleted();
        verify(observer).onError(any());
    }

    @Test
    void admittedStreamRejectsAudioBeforeFormatDeclaration() {
        TtsGrpcService admitted = admittedService(() -> true, () -> true);
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            TtsStreamSink sink = invocation.getArgument(2);
            sink.onChunk(new com.ghatana.media.common.AudioChunk(new byte[] {1, 2}, 0, true, 0));
            return TtsStreamingSession.create(new AtomicBoolean(), new CompletableFuture<>());
        });
        CapturingObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = new CapturingObserver<>();

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);

        assertStatus(observer, Status.Code.FAILED_PRECONDITION);
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
    }

    @Test
    void admittedStreamRejectsDuplicateAudioFormatDeclarationBeforeBytes() {
        TtsGrpcService admitted = admittedService(() -> true, () -> true);
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            TtsStreamSink sink = invocation.getArgument(2);
            sink.onAudioFormat(monoPcm16Format());
            sink.onAudioFormat(monoPcm16Format());
            return TtsStreamingSession.create(new AtomicBoolean(), new CompletableFuture<>());
        });
        CapturingObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = new CapturingObserver<>();

        admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);

        assertStatus(observer, Status.Code.FAILED_PRECONDITION);
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
    }

    @Test
    void admittedStreamRejectsFormatsThatCannotBeRepresentedByTheGrpcResponse() {
        List<CanonicalAudioFormat> unsupportedFormats = List.of(
                new CanonicalAudioFormat(22_050, 1, 32, AudioFormat.PCM),
                new CanonicalAudioFormat(22_050, 2, 16, AudioFormat.PCM),
                new CanonicalAudioFormat(24_000, 1, 16, AudioFormat.PCM),
                new CanonicalAudioFormat(22_050, 1, 16, AudioFormat.WAV));

        for (CanonicalAudioFormat unsupported : unsupportedFormats) {
            TtsGrpcService admitted = admittedService(() -> true, () -> true);
            when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
                TtsStreamSink sink = invocation.getArgument(2);
                sink.onAudioFormat(unsupported);
                return TtsStreamingSession.create(new AtomicBoolean(), new CompletableFuture<>());
            });
            CapturingObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer = new CapturingObserver<>();

            admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);

            assertStatus(observer, Status.Code.FAILED_PRECONDITION);
            assertThat(observer.value).as("format %s", unsupported).isNull();
            assertThat(observer.completed).as("format %s", unsupported).isFalse();
            org.mockito.Mockito.reset(engine);
        }
    }

    @Test
    void validationFailuresMapToInvalidArgument() {
        CapturingObserver<SynthesizeResponse> empty = new CapturingObserver<>();
        service.synthesize(SynthesizeRequest.getDefaultInstance(), empty);
        assertStatus(empty, Status.Code.INVALID_ARGUMENT);

        CapturingObserver<SynthesizeResponse> providerValidation = new CapturingObserver<>();
        service.synthesize(
                SynthesizeRequest.newBuilder().setText("valid input").build(),
                providerValidation);
        assertStatus(providerValidation, Status.Code.UNAVAILABLE);
        assertThat(((StatusRuntimeException) providerValidation.error).getStatus().getDescription())
                .isEqualTo("TTS_NOT_ADMITTED: synthesis provider or capability is unavailable");
        verify(engine, never()).synthesize(anyString(), any());
        verify(library, never()).getTtsEngine();
    }

    @Test
    void unsupportedCapabilitiesMapToUnimplemented() {
        CapturingObserver<com.ghatana.tts.core.grpc.proto.ProfileResponse> profile =
                new CapturingObserver<>();
        service.createProfile(
                CreateProfileRequest.newBuilder().setDisplayName("Alice").build(),
                profile);
        assertStatus(profile, Status.Code.UNIMPLEMENTED);

        CapturingObserver<CloneVoiceResponse> clone = new CapturingObserver<>();
        service.cloneVoice(
                CloneVoiceRequest.newBuilder()
                        .setVoiceName("Alice")
                        // A complete-looking training payload is still not consent or purpose authority.
                        .addAudioSamples(ByteString.copyFrom(
                                "private voice sample".getBytes(StandardCharsets.UTF_8)))
                        .setOptions(com.ghatana.tts.core.grpc.proto.CloneOptions.newBuilder()
                                .setFineTuneEpochs(1)
                                .setLearningRate(0.001f))
                        .build(),
                clone);
        assertStatus(clone, Status.Code.UNIMPLEMENTED);
        assertThat(clone.value).isNull();
        assertThat(clone.completed).isFalse();
        assertThat(((StatusRuntimeException) clone.error).getStatus().getDescription())
                .contains("NOT_ADMITTED", "owner consent", "biometric purpose", "retention");
        verify(library, never()).getTtsEngine();
        verify(engine, never()).cloneVoice(anyString(), any(), any());
    }

    @Test
    void cloneVoiceRejectsMissingAuthorityAndDoesNotReturnACloneResult() {
        CapturingObserver<CloneVoiceResponse> clone = new CapturingObserver<>();

        service.cloneVoice(CloneVoiceRequest.getDefaultInstance(), clone);

        assertStatus(clone, Status.Code.UNIMPLEMENTED);
        assertThat(clone.value).isNull();
        assertThat(clone.completed).isFalse();
        assertThat(((StatusRuntimeException) clone.error).getStatus().getDescription())
                .contains("NOT_ADMITTED", "owner consent", "biometric purpose", "retention");
        verify(library, never()).getTtsEngine();
        verify(engine, never()).cloneVoice(anyString(), any(), any());
    }

    @Test
    void feedbackDoesNotReturnFabricatedSuccess() {
        CapturingObserver<FeedbackResponse> observer = new CapturingObserver<>();

        service.submitFeedback(FeedbackRequest.getDefaultInstance(), observer);

        assertStatus(observer, Status.Code.UNIMPLEMENTED);
        assertThat(observer.completed).isFalse();
    }

    @Test
    void getVoicesReturnsCatalogMetadataWithoutAuthorizingVoiceUse() {
        VoiceInfo voice = new VoiceInfo(
                "voice-1",
                "Voice One",
                "provider voice",
                Locale.ENGLISH,
                VoiceInfo.Gender.NEUTRAL,
                16_000,
                false,
                1024,
                0.9f);
        when(engine.getAvailableVoices()).thenReturn(List.of(voice));

        CapturingObserver<GetVoicesResponse> voices = new CapturingObserver<>();
        service.getVoices(GetVoicesRequest.getDefaultInstance(), voices);
        assertThat(voices.value.getVoices(0).getVoiceId()).isEqualTo("voice-1");
        assertThat(voices.value.getVoices(0).getDescription()).isEqualTo("provider voice");
        assertThat(voices.value.getVoices(0).getGender()).isEqualTo("NEUTRAL");
        Timer response = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("service", "tts")
                .tag("boundary", "response").tag("execution_class", "control")
                .tag("outcome", "success").timer();
        assertThat(response).isNotNull();
        assertThat(response.count()).isEqualTo(1);
        assertThat(response.getId().getTags()).extracting("key")
                .doesNotContain("tenant", "request", "content", "text");
        verify(library).getTtsEngine();
        verify(engine, never()).loadVoice(anyString());
        verify(engine, never()).synthesize(anyString(), any());
    }

    @Test
    void getVoicesResponseMappingFailureRecordsResponseFailure() {
        VoiceInfo malformedVoice = new VoiceInfo(
                "voice-1", "Voice One", "provider voice", null,
                VoiceInfo.Gender.NEUTRAL, 16_000, false, 1024, 0.9f);
        when(engine.getAvailableVoices()).thenReturn(List.of(malformedVoice));
        CapturingObserver<GetVoicesResponse> observer = new CapturingObserver<>();

        service.getVoices(GetVoicesRequest.getDefaultInstance(), observer);

        assertThat(observer.value).isNull();
        assertThat(observer.error).isNotNull();
        Timer responseFailure = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("boundary", "response")
                .tag("outcome", "failure").timer();
        assertThat(responseFailure).isNotNull();
        assertThat(responseFailure.count()).isEqualTo(1);
    }

    @Test
    void getVoicesObserverExceptionRecordsResponseUnknown() {
        when(engine.getAvailableVoices()).thenReturn(List.of());
        StreamObserver<GetVoicesResponse> observer = new StreamObserver<>() {
            @Override public void onNext(GetVoicesResponse value) {
                throw new IllegalStateException("delivery outcome is ambiguous");
            }
            @Override public void onError(Throwable error) {}
            @Override public void onCompleted() {}
        };

        service.getVoices(GetVoicesRequest.getDefaultInstance(), observer);

        Timer responseUnknown = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("boundary", "response")
                .tag("outcome", "unknown").timer();
        assertThat(responseUnknown).isNotNull();
        assertThat(responseUnknown.count()).isEqualTo(1);
        assertThat(registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("boundary", "response")
                .tag("outcome", "success").timer()).isNull();
    }

    @Test
    void statusAndMetricsAreUnavailableWhenRequiredWireValuesCannotBeRepresentedTruthfully() {
        CapturingObserver<StatusResponse> status = new CapturingObserver<>();
        service.getStatus(StatusRequest.getDefaultInstance(), status);
        assertStatus(status, Status.Code.UNIMPLEMENTED);
        assertThat(((StatusRuntimeException) status.error).getStatus().getDescription())
                .contains("NOT_ADMITTED", "active_sessions", "no source metric", "provider diagnostics are not exposed");

        CapturingObserver<MetricsResponse> metrics = new CapturingObserver<>();
        service.getMetrics(MetricsRequest.getDefaultInstance(), metrics);
        assertStatus(metrics, Status.Code.UNIMPLEMENTED);
        assertThat(((StatusRuntimeException) metrics.error).getStatus().getDescription())
                .contains("NOT_ADMITTED", "real_time_factor", "active_sessions", "requestCount is not a successful synthesis count");
        verify(library, never()).getTtsEngine();
        verify(engine, never()).getStatus();
        verify(engine, never()).getMetrics();
    }

    @Test
    void profileOperationsFailClosedWithoutOwnerScopedConsentStore() {
        CapturingObserver<com.ghatana.tts.core.grpc.proto.ProfileResponse> create = new CapturingObserver<>();
        service.createProfile(
                CreateProfileRequest.newBuilder()
                        .setDisplayName("Alice")
                        // Favorable caller-selected settings cannot substitute for trusted consent/purpose.
                        .setSettings(com.ghatana.tts.core.grpc.proto.ProfileSettings.newBuilder()
                                .setPreferredLanguage("en-US")
                                .setDefaultVoiceId("voice-owner-1")
                                .setAdaptationMode(com.ghatana.tts.core.grpc.proto.AdaptationMode.ADAPTATION_MODE_CONSERVATIVE)
                                .setPrivacyLevel(com.ghatana.tts.core.grpc.proto.PrivacyLevel.PRIVACY_LEVEL_HIGH))
                        .build(),
                create);
        assertStatus(create, Status.Code.UNIMPLEMENTED);
        assertThat(((StatusRuntimeException) create.error).getStatus().getDescription())
                .contains("NOT_ADMITTED", "ownership", "consent", "purpose", "retention");
        assertThat(create.value).isNull();
        assertThat(create.completed).isFalse();

        CapturingObserver<com.ghatana.tts.core.grpc.proto.ProfileResponse> get = new CapturingObserver<>();
        service.getProfile(GetProfileRequest.newBuilder().setProfileId("profile-1").build(), get);
        assertStatus(get, Status.Code.UNIMPLEMENTED);
        assertThat(get.value).isNull();
        assertThat(get.completed).isFalse();

        CapturingObserver<com.ghatana.tts.core.grpc.proto.ProfileResponse> update = new CapturingObserver<>();
        service.updateProfile(UpdateProfileRequest.newBuilder()
                .setProfileId("profile-1")
                .setSettings(com.ghatana.tts.core.grpc.proto.ProfileSettings.newBuilder()
                        .setDefaultVoiceId("voice-owner-1")
                        .setPrivacyLevel(com.ghatana.tts.core.grpc.proto.PrivacyLevel.PRIVACY_LEVEL_HIGH))
                .build(), update);
        assertStatus(update, Status.Code.UNIMPLEMENTED);
        assertThat(update.value).isNull();
        assertThat(update.completed).isFalse();

        verify(library, never()).getTtsEngine();
        verify(engine, never()).createProfile(anyString(), anyString(), any());
        verify(engine, never()).loadProfile(anyString());
        verify(engine, never()).saveProfile(any());
    }

    @Test
    void customVoiceAndProfileSelectionsFailBeforeDispatchWithoutAnAdmittedProviderProfile() {
        CapturingObserver<SynthesizeResponse> voice = new CapturingObserver<>();
        service.synthesize(SynthesizeRequest.newBuilder().setText("hello").setVoiceId("custom-voice").build(), voice);
        assertStatus(voice, Status.Code.UNAVAILABLE);
        assertThat(((StatusRuntimeException) voice.error).getStatus().getDescription())
                .contains("TTS_NOT_ADMITTED");

        CapturingObserver<SynthesizeResponse> profile = new CapturingObserver<>();
        service.synthesize(SynthesizeRequest.newBuilder().setText("hello").setProfileId("profile-1").build(), profile);
        assertStatus(profile, Status.Code.UNAVAILABLE);
        assertThat(((StatusRuntimeException) profile.error).getStatus().getDescription())
                .contains("TTS_NOT_ADMITTED");
        verify(engine, never()).synthesize(anyString(), any());
        verify(library, never()).getTtsEngine();
    }

    @Test
    void prosodyControlsValidateUnitsAndRejectUnqualifiedEffectsBeforeDispatch() {
        for (var invalidOptions : List.of(
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setSpeed(Float.NaN).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setSpeed(Float.POSITIVE_INFINITY).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setSpeed(2.1f).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setPitch(13.0f).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setPitch(Float.NaN).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setEnergy(-0.1f).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setEnergy(2.1f).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setEmotion("mystery").build())) {
            CapturingObserver<SynthesizeResponse> invalid = new CapturingObserver<>();
            service.synthesize(SynthesizeRequest.newBuilder().setText("hello").setOptions(invalidOptions).build(), invalid);
            assertStatus(invalid, Status.Code.INVALID_ARGUMENT);
        }

        for (var unsupportedOptions : List.of(
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setSpeed(0.5f).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setSpeed(1.5f).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setSpeed(2.0f).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setPitch(-12.0f).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setPitch(3.0f).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setPitch(12.0f).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setEnergy(1.5f).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setEnergy(2.0f).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setEmotion("happy").build())) {
            CapturingObserver<SynthesizeResponse> unsupported = new CapturingObserver<>();
            service.synthesize(SynthesizeRequest.newBuilder().setText("hello").setOptions(unsupportedOptions).build(), unsupported);
            assertStatus(unsupported, Status.Code.UNIMPLEMENTED);
            assertThat(((StatusRuntimeException) unsupported.error).getStatus().getDescription())
                    .isEqualTo("TTS_NOT_ADMITTED: requested TTS capability is unsupported");
        }
        CapturingObserver<SynthesizeResponse> ssml = new CapturingObserver<>();
        service.synthesize(SynthesizeRequest.newBuilder().setText("<speak><prosody rate=\"150%\">hello</prosody></speak>").build(), ssml);
        assertStatus(ssml, Status.Code.UNIMPLEMENTED);
        assertThat(((StatusRuntimeException) ssml.error).getStatus().getDescription())
                .isEqualTo("TTS_NOT_ADMITTED: requested TTS capability is unsupported");

        CapturingObserver<SynthesizeResponse> malformedSsml = new CapturingObserver<>();
        service.synthesize(SynthesizeRequest.newBuilder().setText("<speak><prosody>").build(), malformedSsml);
        assertStatus(malformedSsml, Status.Code.INVALID_ARGUMENT);
        verify(engine, never()).synthesize(anyString(), any());
    }

    @Test
    void supportedSsmlSyntaxIsStillNotAdmittedWithoutAProviderMapping() {
        // Parsing proves syntax and units only. No currently configured provider contract
        // declares an observable mapping for these SSML segment kinds.
        for (String markup : List.of(
                "<speak><prosody rate=\"150%\">hello</prosody></speak>",
                "<speak><prosody pitch=\"+3st\" volume=\"-3dB\">hello</prosody></speak>",
                "<speak><break time=\"250ms\"/>hello</speak>",
                "<speak><phoneme alphabet=\"ipa\" ph=\"həˈloʊ\">hello</phoneme></speak>",
                "<speak><sub alias=\"World Wide Web\">WWW</sub></speak>",
                "<speak><emphasis level=\"strong\">hello</emphasis></speak>",
                "<speak><say-as interpret-as=\"characters\">hello</say-as></speak>",
                "<speak><lang xml:lang=\"ne-NP\">नमस्ते</lang></speak>")) {
            CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();
            service.synthesize(SynthesizeRequest.newBuilder().setText(markup).build(), observer);
            assertStatus(observer, Status.Code.UNIMPLEMENTED);
            assertThat(((StatusRuntimeException) observer.error).getStatus().getDescription())
                    .isEqualTo("TTS_NOT_ADMITTED: requested TTS capability is unsupported");
        }

        CapturingObserver<SynthesizeResponse> invalidUnits = new CapturingObserver<>();
        service.synthesize(SynthesizeRequest.newBuilder()
                .setText("<speak><prosody pitch=\"3hz\">hello</prosody></speak>").build(), invalidUnits);
        assertStatus(invalidUnits, Status.Code.INVALID_ARGUMENT);

        for (String malformedControl : List.of(
                "<speak><prosody rate=\"1e309%\">hello</prosody></speak>",
                "<speak><prosody pitch=\"-1e309st\">hello</prosody></speak>",
                "<speak><prosody volume=\"1e309dB\">hello</prosody></speak>",
                "<speak><phoneme alphabet=\"x-sampa\" ph=\"həˈloʊ\">hello</phoneme></speak>",
                "<speak><phoneme alphabet=\"ipa\" ph=\" \">hello</phoneme></speak>",
                "<speak><style name=\"cheerful\">hello</style></speak>")) {
            CapturingObserver<SynthesizeResponse> malformed = new CapturingObserver<>();
            service.synthesize(SynthesizeRequest.newBuilder().setText(malformedControl).build(), malformed);
            assertStatus(malformed, Status.Code.INVALID_ARGUMENT);
        }
        verify(engine, never()).synthesize(anyString(), any());
        verify(library, never()).getTtsEngine();
    }

    @Nested
    class MetricsConfiguration {
        @Test
        void timersPublishConfiguredPercentiles() {
            Timer synthesis = registry.find("tts.synthesize").timer();
            Timer streaming = registry.find("tts.synthesize.streaming").timer();
            assertThat(synthesis).isNotNull();
            assertThat(streaming).isNotNull();

            synthesis.record(80, TimeUnit.MILLISECONDS);
            streaming.record(120, TimeUnit.MILLISECONDS);

            assertThat(synthesis.percentile(0.50, TimeUnit.MILLISECONDS)).isNotNaN();
            assertThat(synthesis.percentile(0.95, TimeUnit.MILLISECONDS)).isNotNaN();
            assertThat(streaming.percentile(0.99, TimeUnit.MILLISECONDS)).isNotNaN();
        }
    }

    private static <T> void assertStatus(
            CapturingObserver<T> observer,
            Status.Code expected) {
        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
                .isEqualTo(expected);
    }

    private static CanonicalAudioFormat monoPcm16Format() {
        return new CanonicalAudioFormat(22_050, 1, 16, AudioFormat.PCM);
    }

    private static byte[] audiblePcmFixture() {
        byte[] pcm = new byte[44];
        for (int frame = 0; frame < pcm.length / 2; frame++) {
            int sample = frame % 2 == 0 ? 1_024 : -1_024;
            pcm[frame * 2] = (byte) sample;
            pcm[frame * 2 + 1] = (byte) (sample >> 8);
        }
        return pcm;
    }

    private static void assertNoProtectedMarker(SpanData span, String... markers) {
        String exported = span.getName() + span.getAttributes().asMap() + span.getEvents();
        for (String marker : markers) assertThat(exported).doesNotContain(marker);
    }

    private static final class TraceHarness {
        private final InMemorySpanExporter exporter = InMemorySpanExporter.create();
        private final SdkTracerProvider provider = SdkTracerProvider.builder()
                .addSpanProcessor(SimpleSpanProcessor.create(exporter)).build();
        private final AudioVideoTracingService tracing = new AudioVideoTracingService(provider.get("tts-test"));
        private final AtomicReference<String> operationTraceId = new AtomicReference<>();

        private void assertCurrentOperationSpan() {
            Span current = Span.current();
            assertThat(current.getSpanContext().isValid()).isTrue();
            String traceId = current.getSpanContext().getTraceId();
            operationTraceId.compareAndSet(null, traceId);
            assertThat(traceId).isEqualTo(operationTraceId.get());
        }

        private SpanData finishedSpan() {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (exporter.getFinishedSpanItems().isEmpty() && System.nanoTime() < deadline) {
                LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1));
            }
            assertThat(exporter.getFinishedSpanItems()).hasSize(1);
            SpanData span = exporter.getFinishedSpanItems().get(0);
            if (operationTraceId.get() != null) {
                assertThat(span.getTraceId()).isEqualTo(operationTraceId.get());
            }
            return span;
        }

        private void assertNoFinishedSpans() {
            assertThat(exporter.getFinishedSpanItems()).isEmpty();
        }
    }

    private static final class CapturingObserver<T> implements StreamObserver<T> {
        private T value;
        private Throwable error;
        private boolean completed;

        @Override
        public void onNext(T value) {
            this.value = value;
        }

        @Override
        public void onError(Throwable error) {
            this.error = error;
        }

        @Override
        public void onCompleted() {
            this.completed = true;
        }
    }
}
