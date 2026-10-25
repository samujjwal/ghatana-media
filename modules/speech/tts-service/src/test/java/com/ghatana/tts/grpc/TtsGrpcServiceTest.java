package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.common.EngineMetrics;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.common.ValidationError;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.tts.api.SynthesisOptions;
import com.ghatana.media.tts.api.VoiceInfo;
import com.ghatana.tts.core.grpc.proto.CloneVoiceRequest;
import com.ghatana.tts.core.grpc.proto.CloneVoiceResponse;
import com.ghatana.tts.core.grpc.proto.CreateProfileRequest;
import com.ghatana.tts.core.grpc.proto.FeedbackRequest;
import com.ghatana.tts.core.grpc.proto.FeedbackResponse;
import com.ghatana.tts.core.grpc.proto.GetVoicesRequest;
import com.ghatana.tts.core.grpc.proto.GetVoicesResponse;
import com.ghatana.tts.core.grpc.proto.GetProfileRequest;
import com.ghatana.tts.core.grpc.proto.MetricsRequest;
import com.ghatana.tts.core.grpc.proto.MetricsResponse;
import com.ghatana.tts.core.grpc.proto.StatusRequest;
import com.ghatana.tts.core.grpc.proto.StatusResponse;
import com.ghatana.tts.core.grpc.proto.UpdateProfileRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeResponse;
import com.ghatana.tts.engine.TtsSynthesisEngine;
import com.google.protobuf.ByteString;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentCaptor.forClass;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
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
    void synthesizeReturnsAudioWithoutClosingBorrowedEngine() {
        AudioData audio = new AudioData(
                new byte[44_100],
                22_050,
                1,
                16,
                Duration.ofSeconds(1),
                AudioFormat.PCM);
        when(engine.synthesize(anyString(), any())).thenReturn(audio);
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        service.synthesize(
                SynthesizeRequest.newBuilder().setText("Hello world").build(),
                observer);

        assertThat(observer.error).isNull();
        assertThat(observer.completed).isTrue();
        assertThat(observer.value.getSampleRate()).isEqualTo(22_050);
        assertThat(observer.value.getAudioData()).hasSize(44_100);
        var controls = forClass(SynthesisOptions.class);
        verify(engine).synthesize(anyString(), controls.capture());
        assertThat(controls.getValue().speed()).isEqualTo(1.0);
        assertThat(controls.getValue().pitch()).isEqualTo(1.0);
        assertThat(controls.getValue().volume()).isEqualTo(1.0);
        verify(engine, never()).close();
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
    void providerFormatMismatchDoesNotReturnAudio() {
        when(engine.synthesize(anyString(), any())).thenReturn(new AudioData(
                new byte[44],
                22_050,
                1,
                16,
                Duration.ofMillis(1),
                AudioFormat.MP3));
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        service.synthesize(SynthesizeRequest.newBuilder().setText("Hello").build(), observer);

        assertStatus(observer, Status.Code.FAILED_PRECONDITION);
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
    }

    @Test
    void providerSampleWidthMismatchDoesNotReturnAudio() {
        when(engine.synthesize(anyString(), any())).thenReturn(new AudioData(
                new byte[44], 22_050, 1, 32, Duration.ofMillis(1), AudioFormat.PCM));
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        service.synthesize(SynthesizeRequest.newBuilder().setText("Hello").build(), observer);

        assertStatus(observer, Status.Code.FAILED_PRECONDITION);
        assertThat(observer.value).isNull();
    }

    @Test
    void oddBytePcmProviderOutputDoesNotReturnAudio() {
        when(engine.synthesize(anyString(), any())).thenReturn(new AudioData(
                new byte[3], 22_050, 1, 16, Duration.ofMillis(1), AudioFormat.PCM));
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        service.synthesize(SynthesizeRequest.newBuilder().setText("Hello").build(), observer);

        assertStatus(observer, Status.Code.FAILED_PRECONDITION);
        assertThat(observer.value).isNull();
    }

    @Test
    void notAdmittedEngineFailureIsVisibleAsUnavailable() {
        when(engine.synthesize(anyString(), any())).thenThrow(new TtsSynthesisEngine.SynthesisException(
                "TTS synthesis is NOT_ADMITTED: no real provider",
                TtsSynthesisEngine.FailureReason.NOT_ADMITTED));
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        service.synthesize(SynthesizeRequest.newBuilder().setText("Hello").build(), observer);

        assertStatus(observer, Status.Code.UNAVAILABLE);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getDescription())
                .contains("NOT_ADMITTED");
        assertThat(observer.value).isNull();
    }

    @Test
    void validationFailuresMapToInvalidArgument() {
        CapturingObserver<SynthesizeResponse> empty = new CapturingObserver<>();
        service.synthesize(SynthesizeRequest.getDefaultInstance(), empty);
        assertStatus(empty, Status.Code.INVALID_ARGUMENT);

        when(engine.synthesize(anyString(), any()))
                .thenThrow(new ValidationError("unsupported text"));
        CapturingObserver<SynthesizeResponse> providerValidation = new CapturingObserver<>();
        service.synthesize(
                SynthesizeRequest.newBuilder().setText("valid input").build(),
                providerValidation);
        assertStatus(providerValidation, Status.Code.INVALID_ARGUMENT);
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
    void voiceStatusAndMetricsUseProviderValuesWithoutClosingEngine() {
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
        when(engine.getStatus()).thenReturn(new EngineStatus(
                EngineStatus.State.READY,
                "voice-1",
                "v1",
                1000,
                "ready"));
        when(engine.getMetrics()).thenReturn(new EngineMetrics(12, 1, 5.5, 0, 2048));

        CapturingObserver<GetVoicesResponse> voices = new CapturingObserver<>();
        service.getVoices(GetVoicesRequest.getDefaultInstance(), voices);
        assertThat(voices.value.getVoices(0).getVoiceId()).isEqualTo("voice-1");

        CapturingObserver<StatusResponse> status = new CapturingObserver<>();
        service.getStatus(StatusRequest.getDefaultInstance(), status);
        assertThat(status.value.getActiveVoice()).isEqualTo("voice-1");

        CapturingObserver<MetricsResponse> metrics = new CapturingObserver<>();
        service.getMetrics(MetricsRequest.getDefaultInstance(), metrics);
        assertThat(metrics.value.getTotalSyntheses()).isEqualTo(12);
        assertThat(metrics.value.getMemoryUsageBytes()).isEqualTo(2048);
        verify(engine, never()).close();
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
                .contains("NOT_ADMITTED", "owner", "consent");

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
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setSpeed(1.5f).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setPitch(3.0f).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setEnergy(1.5f).build(),
                com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder().setEmotion("happy").build())) {
            CapturingObserver<SynthesizeResponse> unsupported = new CapturingObserver<>();
            service.synthesize(SynthesizeRequest.newBuilder().setText("hello").setOptions(unsupportedOptions).build(), unsupported);
            assertStatus(unsupported, Status.Code.UNIMPLEMENTED);
            assertThat(((StatusRuntimeException) unsupported.error).getStatus().getDescription())
                    .contains("NOT_ADMITTED");
        }
        CapturingObserver<SynthesizeResponse> ssml = new CapturingObserver<>();
        service.synthesize(SynthesizeRequest.newBuilder().setText("<speak><prosody rate=\"150%\">hello</prosody></speak>").build(), ssml);
        assertStatus(ssml, Status.Code.UNIMPLEMENTED);
        assertThat(((StatusRuntimeException) ssml.error).getStatus().getDescription())
                .contains("SSML", "NOT_ADMITTED");

        CapturingObserver<SynthesizeResponse> malformedSsml = new CapturingObserver<>();
        service.synthesize(SynthesizeRequest.newBuilder().setText("<speak><prosody>").build(), malformedSsml);
        assertStatus(malformedSsml, Status.Code.INVALID_ARGUMENT);
        verify(engine, never()).synthesize(anyString(), any());
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
