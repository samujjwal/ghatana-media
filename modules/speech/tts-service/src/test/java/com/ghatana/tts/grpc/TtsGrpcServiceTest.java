package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.tts.api.TtsStreamSink;
import com.ghatana.media.tts.api.TtsStreamingSession;
import com.ghatana.media.tts.api.VoiceInfo;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
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
import io.grpc.stub.ServerCallStreamObserver;
import io.grpc.stub.StreamObserver;
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
import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
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

    @Mock
    private AudioVideoLibrary library;

    @Mock
    private TtsEngine engine;

    private SimpleMeterRegistry registry;
    private TtsGrpcService service;

    @BeforeEach
    void setUp() {
        registry = new SimpleMeterRegistry();
        service = new TtsGrpcService(library, registry);
        lenient().when(library.getTtsEngine()).thenReturn(engine);
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
    void admittedFakeEngineRunsThroughRequestPathAndExportsPrivateBoundedProviderMetric() {
        TtsGrpcService admitted = new TtsGrpcService(library, registry, () -> true);
        byte[] pcm = new byte[44];
        when(engine.synthesize(anyString(), any())).thenReturn(new AudioData(
                pcm, 22_050, 1, 16, Duration.ofMillis(1), AudioFormat.PCM));
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        admitted.synthesize(SynthesizeRequest.newBuilder().setText("private test phrase").build(), observer);

        assertThat(observer.error).isNull();
        assertThat(observer.value).isNotNull();
        Timer provider = registry.find("media.modality.boundary.duration")
                .tag("modality", "tts").tag("service", "tts")
                .tag("boundary", "provider").tag("execution_class", "model")
                .tag("outcome", "success").timer();
        assertThat(provider).isNotNull();
        assertThat(provider.count()).isEqualTo(1);
        assertThat(provider.getId().getTags()).extracting("key")
                .doesNotContain("tenant", "text", "content", "voice", "provider_id");
    }

    @Test
    void ambiguousProviderExceptionExportsUnknownAndDoesNotReturnAudio() {
        TtsGrpcService admitted = new TtsGrpcService(library, registry, () -> true);
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
        TtsGrpcService admitted = new TtsGrpcService(library, registry, () -> true);
        byte[] pcm = new byte[44];
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
            assertStatus(explicitVoice, Status.Code.UNIMPLEMENTED);
            assertThat(((StatusRuntimeException) explicitVoice.error).getStatus().getDescription())
                    .isEqualTo("TTS_NOT_ADMITTED: requested TTS capability is unsupported");
            assertThat(explicitVoice.value).isNull();
            assertThat(explicitVoice.completed).isFalse();

            CapturingObserver<SynthesizeResponse> profileDefaultLanguage = new CapturingObserver<>();
            production.synthesize(SynthesizeRequest.newBuilder().setText("hello")
                    .setProfileId("profile-with-ne-default").build(), profileDefaultLanguage);
            assertStatus(profileDefaultLanguage, Status.Code.UNIMPLEMENTED);
            assertThat(((StatusRuntimeException) profileDefaultLanguage.error).getStatus().getDescription())
                    .isEqualTo("TTS_NOT_ADMITTED: requested TTS capability is unsupported");
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
        CapturingObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer =
                new CapturingObserver<>();

        service.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);

        assertStatus(observer, Status.Code.UNAVAILABLE);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getDescription())
                .isEqualTo("TTS_NOT_ADMITTED: synthesis provider or capability is unavailable");
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
        verify(library, never()).getTtsEngine();
        verify(engine, never()).synthesize(anyString(), any());
        assertThat(registry.get("tts.synthesize.streaming").timer().count()).isEqualTo(1);
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
        TtsGrpcService admitted = new TtsGrpcService(library, registry, () -> true, () -> true);
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
        TtsGrpcService admitted = new TtsGrpcService(library, registry, () -> true, () -> true);
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
        TtsGrpcService admitted = new TtsGrpcService(library, registry, () -> true, () -> true);
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
        TtsGrpcService admitted = new TtsGrpcService(
                library, registry, () -> true, () -> true, Duration.ofMillis(100));
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

        Thread request = Thread.startVirtualThread(() ->
                admitted.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer));
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
        TtsGrpcService admitted = new TtsGrpcService(
                library, registry, () -> true, () -> true, Duration.ofMillis(250));
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
        sinkRef.get().onChunk(new com.ghatana.media.common.AudioChunk(new byte[] {1, 2}, 0, true, 4));
        completionRef.get().complete(null);
        assertThat(completed.await(1, TimeUnit.SECONDS)).isTrue();
        Thread.sleep(350);

        verify(observer).onNext(org.mockito.ArgumentMatchers.argThat(chunk -> chunk.getIsFinal()));
        verify(observer).onCompleted();
        verify(observer, never()).onError(any());
        assertThat(registry.get("tts.synthesize.streaming").timer().count()).isEqualTo(1);
    }

    @Test
    void admittedStreamChunkValidationFailureReturnsTerminalErrorAndCancelsSession() {
        TtsGrpcService admitted = new TtsGrpcService(library, registry, () -> true, () -> true);
        AtomicBoolean sessionCancelled = new AtomicBoolean();
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            TtsStreamSink sink = invocation.getArgument(2);
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
    void admittedStreamRejectsSequenceGapAfterPreservingOnlyPriorPartialChunk() {
        TtsGrpcService admitted = new TtsGrpcService(library, registry, () -> true, () -> true);
        AtomicBoolean sessionCancelled = new AtomicBoolean();
        when(engine.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            TtsStreamSink sink = invocation.getArgument(2);
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
    void admittedPartialStreamFailureDoesNotEmitFalseFinalChunkOrCompleteSuccessfully() throws Exception {
        TtsGrpcService admitted = new TtsGrpcService(library, registry, () -> true, () -> true);
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
        verify(library).getTtsEngine();
        verify(engine, never()).loadVoice(anyString());
        verify(engine, never()).synthesize(anyString(), any());
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
    void customVoiceAndProfileSelectionsFailBeforeProviderDispatch() {
        CapturingObserver<SynthesizeResponse> voice = new CapturingObserver<>();
        service.synthesize(SynthesizeRequest.newBuilder().setText("hello").setVoiceId("custom-voice").build(), voice);
        assertStatus(voice, Status.Code.UNIMPLEMENTED);
        assertThat(((StatusRuntimeException) voice.error).getStatus().getDescription())
                .isEqualTo("TTS_NOT_ADMITTED: requested TTS capability is unsupported");

        CapturingObserver<SynthesizeResponse> profile = new CapturingObserver<>();
        service.synthesize(SynthesizeRequest.newBuilder().setText("hello").setProfileId("profile-1").build(), profile);
        assertStatus(profile, Status.Code.UNIMPLEMENTED);
        verify(engine, never()).synthesize(anyString(), any());
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
