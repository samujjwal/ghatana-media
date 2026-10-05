package com.ghatana.stt.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.EngineMetrics;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.common.InferenceError;
import com.ghatana.media.common.ModelLoadingError;
import com.ghatana.media.common.ValidationError;
import com.ghatana.media.stt.api.ModelInfo;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.StreamingSession;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.media.stt.api.UserProfile;
import com.ghatana.stt.core.grpc.proto.*;
import com.google.protobuf.ByteString;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Duration;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Nested;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

/**
 * Unit tests for {@link SttGrpcService}.
 *
 * <p>Mocks {@link AudioVideoLibrary} (final class — supported by Mockito 5 inline mock-maker) 
 * and {@link SttEngine} to avoid ONNX / native-library dependencies.
 *
 * @doc.type class
 * @doc.purpose Unit tests for the STT gRPC service layer
 * @doc.layer product
 * @doc.pattern TestCase
 */
@ExtendWith(MockitoExtension.class) 
@DisplayName("SttGrpcService")
class SttGrpcServiceTest {

    @Mock
    private AudioVideoLibrary mockLibrary;

    @Mock
    private SttEngine mockEngine;

    private SttGrpcService service;
    private SimpleMeterRegistry meterRegistry;

    @BeforeEach
    void setUp() { 
        meterRegistry = new SimpleMeterRegistry(); 
        service = new SttGrpcService(mockLibrary, meterRegistry); 
        // Lenient: getSttEngine is not needed in every test
        lenient().when(mockLibrary.getSttEngine()).thenReturn(mockEngine); 
    }

    // ─────────────────────────────────────────────────────────────
    // transcribe
    // ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("transcribe: valid audio → text returned in response")
    void transcribe_validAudio_returnsTranscription() throws Exception { 
        byte[] audioBytes = new byte[]{0x01, 0x02, 0x03, 0x04};
        TranscriptionResult result = new TranscriptionResult( 
            "hello world", 0.95, Collections.emptyList(), Collections.emptyList(), 
            Duration.ofMillis(120), "en", "whisper-base" 
        );
        when(mockEngine.transcribe(any(), any(TranscriptionOptions.class))).thenReturn(result); 

        TranscribeRequest request = TranscribeRequest.newBuilder() 
            .setAudioData(ByteString.copyFrom(audioBytes)) 
            .setSampleRate(16000) 
            .build(); 
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>(); 

        service.transcribe(request, observer); 

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getText()).isEqualTo("hello world");
        assertThat(observer.getValue().getConfidence()).isEqualTo(0.95f); 
        assertThat(observer.getValue().getProcessingTimeMs()).isEqualTo(120L); 
        assertThat(observer.getValue().getModelUsed()).isEqualTo("whisper-base");
    }

    @Test
    @DisplayName("transcribe: empty audio bytes → INVALID_ARGUMENT gRPC error")
    void transcribe_emptyAudio_returnsInvalidArgument() { 
        TranscribeRequest request = TranscribeRequest.newBuilder() 
            .setAudioData(ByteString.EMPTY) 
            .setSampleRate(16000) 
            .build(); 
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>(); 

        service.transcribe(request, observer); 

        assertThat(observer.hasError()).isTrue(); 
        StatusRuntimeException ex = (StatusRuntimeException) observer.getError(); 
        assertThat(ex.getStatus().getCode()).isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    @Test
    @DisplayName("transcribe: ValidationError from engine → INVALID_ARGUMENT gRPC error")
    void transcribe_validationError_returnsInvalidArgument() throws Exception { 
        when(mockEngine.transcribe(any(), any(TranscriptionOptions.class))) 
            .thenThrow(new ValidationError("bad audio format"));

        TranscribeRequest request = TranscribeRequest.newBuilder() 
            .setAudioData(ByteString.copyFrom(new byte[]{0x01})) 
            .setSampleRate(16000) 
            .build(); 
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>(); 

        service.transcribe(request, observer); 

        assertThat(observer.hasError()).isTrue(); 
        StatusRuntimeException ex = (StatusRuntimeException) observer.getError(); 
        assertThat(ex.getStatus().getCode()).isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
        assertThat(ex.getStatus().getDescription()).contains("bad audio format");
    }

    @Test
    @DisplayName("transcribe: non-retryable InferenceError → INTERNAL gRPC error")
    void transcribe_nonRetryableInferenceError_returnsInternal() throws Exception { 
        when(mockEngine.transcribe(any(), any(TranscriptionOptions.class))) 
            .thenThrow(new InferenceError("model crash", null, false)); 

        TranscribeRequest request = TranscribeRequest.newBuilder() 
            .setAudioData(ByteString.copyFrom(new byte[]{0x01})) 
            .setSampleRate(16000) 
            .build(); 
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>(); 

        service.transcribe(request, observer); 

        assertThat(observer.hasError()).isTrue(); 
        StatusRuntimeException ex = (StatusRuntimeException) observer.getError(); 
        assertThat(ex.getStatus().getCode()).isEqualTo(Status.INTERNAL.getCode()); 
    }

    @Test
    @DisplayName("transcribe: retryable InferenceError → UNAVAILABLE gRPC error")
    void transcribe_retryableInferenceError_returnsUnavailable() throws Exception { 
        when(mockEngine.transcribe(any(), any(TranscriptionOptions.class))) 
            .thenThrow(new InferenceError("backend overloaded", null, true)); 

        TranscribeRequest request = TranscribeRequest.newBuilder() 
            .setAudioData(ByteString.copyFrom(new byte[]{0x01})) 
            .setSampleRate(16000) 
            .build(); 
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>(); 

        service.transcribe(request, observer); 

        assertThat(observer.hasError()).isTrue(); 
        StatusRuntimeException ex = (StatusRuntimeException) observer.getError(); 
        assertThat(ex.getStatus().getCode()).isEqualTo(Status.UNAVAILABLE.getCode()); 
    }

    @Test
    @DisplayName("transcribe: default sample rate applied when not set in request")
    void transcribe_defaultSampleRate_noNullPointer() throws Exception { 
        TranscriptionResult result = new TranscriptionResult( 
            "test", 1.0, Collections.emptyList(), Collections.emptyList(), 
            Duration.ofMillis(10), "en", "whisper-base" 
        );
        when(mockEngine.transcribe(any(), any(TranscriptionOptions.class))).thenReturn(result); 

        TranscribeRequest request = TranscribeRequest.newBuilder() 
            .setAudioData(ByteString.copyFrom(new byte[]{0x01, 0x02})) 
            .build(); 
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>(); 

        service.transcribe(request, observer); 

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getText()).isEqualTo("test");
    }

    @Test
    @DisplayName("transcribe: records stt.transcribe timer on success")
    void transcribe_recordsTimerOnSuccess() throws Exception { 
        when(mockEngine.transcribe(any(), any(TranscriptionOptions.class))) 
            .thenReturn(new TranscriptionResult( 
                "metrics", 0.9, Collections.emptyList(), Collections.emptyList(),
                Duration.ofMillis(15), "en", "whisper-base"));

        TranscribeRequest request = TranscribeRequest.newBuilder() 
            .setAudioData(ByteString.copyFrom(new byte[]{0x01, 0x02, 0x03})) 
            .setSampleRate(16000) 
            .build(); 
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>(); 

        service.transcribe(request, observer); 

        assertThat(observer.hasError()).isFalse(); 
        assertThat(meterRegistry.find("stt.transcribe").timer()).isNotNull();
        assertThat(meterRegistry.find("stt.transcribe").timer().count()).isEqualTo(1L);
    }

    @Test
    @DisplayName("transcribe: records stt.transcribe timer on validation error")
    void transcribe_recordsTimerOnValidationError() { 
        TranscribeRequest request = TranscribeRequest.newBuilder() 
            .setAudioData(ByteString.EMPTY) 
            .setSampleRate(16000) 
            .build(); 
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>(); 

        service.transcribe(request, observer); 

        assertThat(observer.hasError()).isTrue(); 
        assertThat(meterRegistry.find("stt.transcribe").timer()).isNotNull();
        assertThat(meterRegistry.find("stt.transcribe").timer().count()).isEqualTo(1L);
    }

    // ─────────────────────────────────────────────────────────────
    // loadModel (AV-001.1) 
    // ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("loadModel: valid modelId → success response with timing")
    void loadModel_validId_succeeds() throws Exception { 
        doNothing().when(mockEngine).loadModel("whisper-base");
        when(mockEngine.getMetrics()).thenReturn(new EngineMetrics(1L, 0L, 0.0, 0L, 150_000_000L)); 

        CapturingObserver<LoadModelResponse> observer = new CapturingObserver<>(); 
        service.loadModel( 
            LoadModelRequest.newBuilder().setModelId("whisper-base").build(),
            observer);

        assertThat(observer.hasError()).isFalse(); 
        LoadModelResponse response = observer.getValue(); 
        assertThat(response.getSuccess()).isTrue(); 
        assertThat(response.getModelId()).isEqualTo("whisper-base");
        assertThat(response.getLoadTimeMs()).isGreaterThanOrEqualTo(0L); 
    }

    @Test
    @DisplayName("loadModel: blank modelId → INVALID_ARGUMENT")
    void loadModel_blankId_returnsInvalidArgument() { 
        CapturingObserver<LoadModelResponse> observer = new CapturingObserver<>(); 
        service.loadModel(LoadModelRequest.newBuilder().setModelId("").build(), observer);

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    @Test
    @DisplayName("loadModel: ModelLoadingError from engine → NOT_FOUND")
    void loadModel_modelNotFound_returnsNotFound() throws Exception { 
        doThrow(new ModelLoadingError("Model not found: whisper-xl", null)) 
            .when(mockEngine).loadModel("whisper-xl");

        CapturingObserver<LoadModelResponse> observer = new CapturingObserver<>(); 
        service.loadModel(LoadModelRequest.newBuilder().setModelId("whisper-xl").build(), observer);

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.NOT_FOUND.getCode()); 
    }

    // ─────────────────────────────────────────────────────────────
    // unloadModel (AV-001.2) 
    // ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("unloadModel: model exists → success response")
    void unloadModel_modelExists_succeeds() throws Exception { 
        ModelInfo info = new ModelInfo("whisper-base", "Whisper Base", "1.0", 
            new Locale[]{Locale.ENGLISH}, 150_000_000L, false);
        when(mockEngine.getAvailableModels()).thenReturn(List.of(info)); 
        when(mockEngine.getMetrics()).thenReturn(new EngineMetrics(1L, 0L, 0.0, 0L, 150_000_000L)); 

        CapturingObserver<UnloadModelResponse> observer = new CapturingObserver<>(); 
        service.unloadModel(UnloadModelRequest.newBuilder().setModelId("whisper-base").build(), observer);

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getSuccess()).isTrue(); 
    }

    @Test
    @DisplayName("unloadModel: model not in list → NOT_FOUND")
    void unloadModel_unknownModel_returnsNotFound() throws Exception { 
        when(mockEngine.getAvailableModels()).thenReturn(List.of()); 

        CapturingObserver<UnloadModelResponse> observer = new CapturingObserver<>(); 
        service.unloadModel(UnloadModelRequest.newBuilder().setModelId("ghost").build(), observer);

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.NOT_FOUND.getCode()); 
    }

    // ─────────────────────────────────────────────────────────────
    // listModels (AV-001.3) 
    // ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("listModels: returns all registered models")
    void listModels_returnsAll() throws Exception { 
        ModelInfo m1 = new ModelInfo("whisper-base", "Whisper Base", "1.0", 
            new Locale[]{Locale.ENGLISH}, 100_000_000L, false);
        ModelInfo m2 = new ModelInfo("whisper-large", "Whisper Large", "2.0", 
            new Locale[]{Locale.ENGLISH, Locale.FRENCH}, 200_000_000L, true);
        when(mockEngine.getAvailableModels()).thenReturn(List.of(m1, m2)); 
        when(mockEngine.getActiveModel()).thenReturn(m1); 

        CapturingObserver<ListModelsResponse> observer = new CapturingObserver<>(); 
        service.listModels(ListModelsRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isFalse(); 
        ListModelsResponse response = observer.getValue(); 
        assertThat(response.getTotalCount()).isEqualTo(2); 
        assertThat(response.getLoadedCount()).isEqualTo(1); 
    }

    @Test
    @DisplayName("listModels: loadedOnly=true returns only active model")
    void listModels_loadedOnlyFilter() throws Exception { 
        ModelInfo m1 = new ModelInfo("whisper-base", "Whisper Base", "1.0", 
            new Locale[]{Locale.ENGLISH}, 100_000_000L, false);
        ModelInfo m2 = new ModelInfo("whisper-large", "Whisper Large", "2.0", 
            new Locale[]{Locale.ENGLISH}, 200_000_000L, true);
        when(mockEngine.getAvailableModels()).thenReturn(List.of(m1, m2)); 
        when(mockEngine.getActiveModel()).thenReturn(m1); 

        CapturingObserver<ListModelsResponse> observer = new CapturingObserver<>(); 
        service.listModels(ListModelsRequest.newBuilder().setIncludeLoadedOnly(true).build(), observer); 

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getTotalCount()).isEqualTo(1); 
        assertThat(observer.getValue().getModels(0).getModelId()).isEqualTo("whisper-base");
    }

    // ─────────────────────────────────────────────────────────────
    // adaptModel (AV-001.4) 
    // ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("adaptModel: valid profile + interactions → success with vocab count")
    void adaptModel_validRequest_succeeds() throws Exception { 
        UserProfile profile = new UserProfile("p1", "Alice", Locale.ENGLISH, 
            List.of("existing"), new byte[0]);
        when(mockEngine.loadProfile("p1")).thenReturn(Optional.of(profile));
        doNothing().when(mockEngine).saveProfile(any()); 

        AdaptRequest request = AdaptRequest.newBuilder() 
            .setProfileId("p1")
            .addInteractions(Interaction.newBuilder() 
                .setCorrectedTranscript("ghatana platform agent")
                .build()) 
            .build(); 
        CapturingObserver<AdaptResponse> observer = new CapturingObserver<>(); 
        service.adaptModel(request, observer); 

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getSuccess()).isTrue(); 
        assertThat(observer.getValue().getStats().getInteractionsProcessed()).isEqualTo(1); 
        assertThat(observer.getValue().getStats().getNewVocabularyTerms()).isGreaterThan(0); 
    }

    @Test
    @DisplayName("adaptModel: blank profileId → INVALID_ARGUMENT")
    void adaptModel_blankProfileId_returnsInvalidArgument() { 
        CapturingObserver<AdaptResponse> observer = new CapturingObserver<>(); 
        service.adaptModel(AdaptRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    @Test
    @DisplayName("adaptModel: profile not found → NOT_FOUND")
    void adaptModel_profileNotFound_returnsNotFound() throws Exception { 
        when(mockEngine.loadProfile("ghost")).thenReturn(Optional.empty());

        AdaptRequest request = AdaptRequest.newBuilder() 
            .setProfileId("ghost")
            .addInteractions(Interaction.newBuilder().setCorrectedTranscript("word").build())
            .build(); 
        CapturingObserver<AdaptResponse> observer = new CapturingObserver<>(); 
        service.adaptModel(request, observer); 

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.NOT_FOUND.getCode()); 
    }

    // ─────────────────────────────────────────────────────────────
    // createProfile (AV-001.5) 
    // ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("createProfile: valid name → profile created and returned")
    void createProfile_validName_returnsProfile() throws Exception { 
        UserProfile created = new UserProfile("uuid-1", "Alice", Locale.ENGLISH, 
            List.of(), new byte[0]); 
        when(mockEngine.createProfile(anyString(), any())).thenReturn(created); 

        CapturingObserver<ProfileResponse> observer = new CapturingObserver<>(); 
        service.createProfile( 
            CreateProfileRequest.newBuilder().setDisplayName("Alice").build(),
            observer);

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getDisplayName()).isEqualTo("Alice");
        assertThat(observer.getValue().getProfileId()).isNotBlank(); 
    }

    @Test
    @DisplayName("createProfile: blank displayName → INVALID_ARGUMENT")
    void createProfile_blankName_returnsInvalidArgument() { 
        CapturingObserver<ProfileResponse> observer = new CapturingObserver<>(); 
        service.createProfile(CreateProfileRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    // ─────────────────────────────────────────────────────────────
    // getProfile (AV-001.6) 
    // ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("getProfile: existing profile → profile returned")
    void getProfile_existing_returnsProfile() throws Exception { 
        UserProfile profile = new UserProfile("p1", "Bob", Locale.ENGLISH, List.of("word"), new byte[0]);
        when(mockEngine.loadProfile("p1")).thenReturn(Optional.of(profile));

        CapturingObserver<ProfileResponse> observer = new CapturingObserver<>(); 
        service.getProfile(GetProfileRequest.newBuilder().setProfileId("p1").build(), observer);

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getProfileId()).isEqualTo("p1");
        assertThat(observer.getValue().getDisplayName()).isEqualTo("Bob");
        assertThat(observer.getValue().getStats().getVocabularySize()).isEqualTo(1); 
    }

    @Test
    @DisplayName("getProfile: unknown profileId → NOT_FOUND")
    void getProfile_unknown_returnsNotFound() throws Exception { 
        when(mockEngine.loadProfile("ghost")).thenReturn(Optional.empty());

        CapturingObserver<ProfileResponse> observer = new CapturingObserver<>(); 
        service.getProfile(GetProfileRequest.newBuilder().setProfileId("ghost").build(), observer);

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.NOT_FOUND.getCode()); 
    }

    @Test
    @DisplayName("getProfile: blank profileId → INVALID_ARGUMENT")
    void getProfile_blankId_returnsInvalidArgument() { 
        CapturingObserver<ProfileResponse> observer = new CapturingObserver<>(); 
        service.getProfile(GetProfileRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    // ─────────────────────────────────────────────────────────────
    // updateProfile (AV-001.7) 
    // ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("updateProfile: existing profile → updated and returned")
    void updateProfile_existing_updatesProfile() throws Exception { 
        UserProfile existing = new UserProfile("p1", "Carol", Locale.ENGLISH, List.of(), new byte[0]); 
        when(mockEngine.loadProfile("p1")).thenReturn(Optional.of(existing));
        doNothing().when(mockEngine).saveProfile(any()); 

        UpdateProfileRequest request = UpdateProfileRequest.newBuilder() 
            .setProfileId("p1")
            .setSettings(ProfileSettings.newBuilder().setPreferredLanguage("fr").build())
            .build(); 
        CapturingObserver<ProfileResponse> observer = new CapturingObserver<>(); 
        service.updateProfile(request, observer); 

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getProfileId()).isEqualTo("p1");
        verify(mockEngine).saveProfile(any()); 
    }

    @Test
    @DisplayName("updateProfile: unknown profileId → NOT_FOUND")
    void updateProfile_unknown_returnsNotFound() throws Exception { 
        when(mockEngine.loadProfile("ghost")).thenReturn(Optional.empty());

        CapturingObserver<ProfileResponse> observer = new CapturingObserver<>(); 
        service.updateProfile(UpdateProfileRequest.newBuilder().setProfileId("ghost").build(), observer);

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.NOT_FOUND.getCode()); 
    }

    // ─────────────────────────────────────────────────────────────
    // getStatus
    // ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("getStatus: engine READY → active model name returned")
    void getStatus_engineReady_returnsModel() throws Exception { 
        EngineStatus engineStatus = new EngineStatus( 
            EngineStatus.State.READY, "whisper-base", "1.0", 5000L, null
        );
        when(mockEngine.getStatus()).thenReturn(engineStatus); 

        CapturingObserver<StatusResponse> observer = new CapturingObserver<>(); 
        service.getStatus(StatusRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getActiveModel()).isEqualTo("whisper-base");
    }

    // ─────────────────────────────────────────────────────────────
    // submitCorrection
    // ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("submitCorrection: always accepted")
    void submitCorrection_alwaysAccepted() { 
        CapturingObserver<CorrectionResponse> observer = new CapturingObserver<>(); 
        service.submitCorrection(CorrectionRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getAccepted()).isTrue(); 
    }

    @Test
    @DisplayName("streamAudio: completion ends stream before closing session")
    void streamAudio_completionEndsStreamBeforeClosingSession() throws Exception { 
        StreamingSession streamingSession = mock(StreamingSession.class); 
        when(mockEngine.createStreamingSession()).thenReturn(streamingSession); 

        AtomicBoolean completed = new AtomicBoolean(false); 
        StreamObserver<Transcription> responseObserver = new StreamObserver<>() { 
            @Override
            public void onNext(Transcription value) { 
            }

            @Override
            public void onError(Throwable t) { 
            }

            @Override
            public void onCompleted() { 
                completed.set(true); 
            }
        };

        StreamObserver<AudioChunk> requestObserver = service.streamTranscribe(responseObserver); 

        requestObserver.onCompleted(); 

        assertThat(completed.get()).isTrue(); 
        InOrder inOrder = inOrder(streamingSession); 
        inOrder.verify(streamingSession).endStream(); 
        inOrder.verify(streamingSession).close(); 
    }

    // ─────────────────────────────────────────────────────────────
    // Test infrastructure
    // ─────────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────────
    // P50/P95/P99 histogram configuration tests (AV-M1)
    // ─────────────────────────────────────────────────────────────

    @Nested
    @DisplayName("STT transcribe timer — P50/P95/P99 histogram configuration")
    class StreamingLatencyHistogramTests {

        private SimpleMeterRegistry histogramRegistry;
        private Timer transcribeTimer;

        @BeforeEach
        void setUp() { 
            histogramRegistry = new SimpleMeterRegistry(); 
            // Constructing the real SttGrpcService wires the timer with publishPercentiles()
            SttGrpcService.forTesting(mockLibrary, histogramRegistry); 
            transcribeTimer = histogramRegistry.find("stt.transcribe").timer(); 
        }

        @Test
        @DisplayName("transcribe timer registered in registry after service construction")
        void transcribeTimer_registeredInRegistry() { 
            assertThat(transcribeTimer).isNotNull(); 
        }

        @Test
        @DisplayName("transcribe timer P50 percentile is tracked (not NaN) after recording")
        void transcribeTimer_p50PercentileTracked_afterRecording() { 
            transcribeTimer.record(100, TimeUnit.MILLISECONDS); 

            assertThat(transcribeTimer.percentile(0.50, TimeUnit.MILLISECONDS))
                .isNotNaN(); 
        }

        @Test
        @DisplayName("transcribe timer P95 percentile is tracked (not NaN) after recording")
        void transcribeTimer_p95PercentileTracked_afterRecording() { 
            transcribeTimer.record(100, TimeUnit.MILLISECONDS); 

            assertThat(transcribeTimer.percentile(0.95, TimeUnit.MILLISECONDS))
                .isNotNaN(); 
        }

        @Test
        @DisplayName("transcribe timer P99 percentile is tracked (not NaN) after recording")
        void transcribeTimer_p99PercentileTracked_afterRecording() { 
            transcribeTimer.record(200, TimeUnit.MILLISECONDS); 

            assertThat(transcribeTimer.percentile(0.99, TimeUnit.MILLISECONDS))
                .isNotNaN(); 
        }
    }

    static class CapturingObserver<T> implements StreamObserver<T> {
        private T value;
        private Throwable error;

        @Override public void onNext(T value) { this.value = value; } 
        @Override public void onError(Throwable t) { this.error = t; } 
        @Override public void onCompleted() {} 

        T getValue() { return value; } 
        boolean hasError() { return error != null; } 
        Throwable getError() { return error; } 
    }
}
