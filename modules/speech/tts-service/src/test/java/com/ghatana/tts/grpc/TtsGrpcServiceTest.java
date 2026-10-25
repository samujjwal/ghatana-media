package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.tts.api.VoiceInfo;
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
import java.util.concurrent.TimeUnit;
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
    }

    @Test
    void sourceLocaleMatrixFailsWithoutDefaultSubstitution() {
        for (String language : List.of("en", "ne", "hi", "es", "fr", "de", "ja", "zh",
                "en-US", "ne-NP", "hi-IN", "es-ES", "fr-FR", "de-DE", "ja-JP", "zh-CN", "bn-BD")) {
            CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();
            service.synthesize(SynthesizeRequest.newBuilder().setText("hello")
                    .setOptions(com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder()
                            .setLanguage(language).build()).build(), observer);
            assertStatus(observer, Status.Code.UNAVAILABLE);
            assertThat(((StatusRuntimeException) observer.error).getStatus().getDescription())
                    .isEqualTo("TTS_NOT_ADMITTED: synthesis provider or capability is unavailable");
        }

        CapturingObserver<SynthesizeResponse> explicit = new CapturingObserver<>();
        service.synthesize(SynthesizeRequest.newBuilder().setText("hello")
                .setVoiceId("provider-default")
                .setOptions(com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder()
                        .setLanguage("hi-IN").build()).build(), explicit);
        assertStatus(explicit, Status.Code.UNIMPLEMENTED);
        assertThat(((StatusRuntimeException) explicit.error).getStatus().getDescription())
                .isEqualTo("TTS_NOT_ADMITTED: requested TTS capability is unsupported");
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
                        .addAudioSamples(ByteString.copyFrom(new byte[256]))
                        .build(),
                clone);
        assertStatus(clone, Status.Code.UNIMPLEMENTED);
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
                CreateProfileRequest.newBuilder().setDisplayName("Alice").build(),
                create);
        assertStatus(create, Status.Code.UNIMPLEMENTED);
        assertThat(((StatusRuntimeException) create.error).getStatus().getDescription())
                .contains("NOT_ADMITTED", "ownership", "consent", "purpose", "retention");

        CapturingObserver<com.ghatana.tts.core.grpc.proto.ProfileResponse> get = new CapturingObserver<>();
        service.getProfile(GetProfileRequest.newBuilder().setProfileId("profile-1").build(), get);
        assertStatus(get, Status.Code.UNIMPLEMENTED);

        CapturingObserver<com.ghatana.tts.core.grpc.proto.ProfileResponse> update = new CapturingObserver<>();
        service.updateProfile(UpdateProfileRequest.newBuilder().setProfileId("profile-1").build(), update);
        assertStatus(update, Status.Code.UNIMPLEMENTED);

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
                "<speak><emphasis level=\"strong\">hello</emphasis></speak>")) {
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
