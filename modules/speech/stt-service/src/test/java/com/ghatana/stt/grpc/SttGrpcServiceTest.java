package com.ghatana.stt.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.EngineMetrics;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.common.InferenceError;
import com.ghatana.media.common.ModelLoadingError;
import com.ghatana.media.common.ValidationError;
import com.ghatana.media.stt.api.ModelInfo;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.media.stt.api.Alternative;
import com.ghatana.media.stt.api.WordTiming;
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
import org.mockito.Mock;
import org.mockito.ArgumentCaptor;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Duration;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
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
    @DisplayName("transcribe maps bounded provider metadata and marks confidence uncalibrated")
    void transcribe_mapsWordsAlternativesAndUncalibratedConfidence() throws Exception {
        byte[] audioBytes = new byte[32_000];
        when(mockEngine.transcribe(any(), any(TranscriptionOptions.class))).thenReturn(new TranscriptionResult(
                "hello world", 0.82,
                List.of(new WordTiming("hello", 0.0, 0.5, 0.8),
                        new WordTiming("world", 0.5, 1.0, 0.84)),
                List.of(new Alternative("hullo world", 0.12)),
                Duration.ofMillis(25), "en-US", "fixture-model"));
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();

        service.transcribe(TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(audioBytes)).setSampleRate(16_000)
                .setLanguage("en-US")
                .setOptions(com.ghatana.stt.core.grpc.proto.TranscriptionOptions.newBuilder()
                        .setEnableWordTimings(true).setMaxAlternatives(2).build())
                .build(), observer);

        assertThat(observer.hasError()).isFalse();
        assertThat(observer.getValue().getWordTimingsCount()).isEqualTo(2);
        assertThat(observer.getValue().getWordTimings(1).getStartMs()).isEqualTo(500L);
        assertThat(observer.getValue().getAlternativesCount()).isEqualTo(1);
        assertThat(observer.getValue().getLanguage()).isEqualTo("en-US");
        assertThat(observer.getValue().getWordTimingTimebase())
                .isEqualTo(TimestampTimebase.TIMESTAMP_TIMEBASE_UNKNOWN);
        assertThat(observer.getValue().getConfidenceCalibration())
                .isEqualTo(ConfidenceCalibration.CONFIDENCE_CALIBRATION_UNCALIBRATED);
        ArgumentCaptor<TranscriptionOptions> options = ArgumentCaptor.forClass(TranscriptionOptions.class);
        verify(mockEngine).transcribe(any(), options.capture());
        assertThat(options.getValue().enableTimestamps()).isTrue();
        assertThat(options.getValue().maxAlternatives()).isEqualTo(2);
        assertThat(options.getValue().language().toLanguageTag()).isEqualTo("en-US");
    }

    @Test
    @DisplayName("transcribe rejects malformed provider word timing with stable internal error")
    void transcribe_rejectsOverlappingProviderTimings() throws Exception {
        when(mockEngine.transcribe(any(), any(TranscriptionOptions.class))).thenReturn(new TranscriptionResult(
                "hello world", 0.82,
                List.of(new WordTiming("hello", 0.0, 0.7, 0.8),
                        new WordTiming("world", 0.5, 1.0, 0.84)),
                List.of(), Duration.ofMillis(25), "en", "fixture-model"));
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();

        service.transcribe(TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[32_000])).setSampleRate(16_000).build(), observer);

        assertThat(observer.hasError()).isTrue();
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INTERNAL.getCode());
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getDescription())
                .isEqualTo("Invalid transcription result");
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
    @DisplayName("transcribe rejects malformed RIFF header before inference")
    void transcribe_badWavHeader_returnsInvalidArgument() {
        byte[] malformed = new byte[] {'R', 'I', 'F', 'F', 0, 0, 0, 0, 'N', 'O', 'P', 'E'};
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        service.transcribe(TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(malformed))
                .setSampleRate(16_000)
                .build(), observer);

        assertThat(observer.hasError()).isTrue();
        StatusRuntimeException error = (StatusRuntimeException) observer.getError();
        assertThat(error.getStatus().getCode()).isEqualTo(Status.INVALID_ARGUMENT.getCode());
        assertThat(error.getStatus().getDescription()).isEqualTo("Invalid audio input");
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("transcribe reports compressed formats as not admitted")
    void transcribe_flac_returnsFailedPrecondition() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        service.transcribe(TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {'f', 'L', 'a', 'C', 0, 0}))
                .setSampleRate(16_000)
                .build(), observer);

        assertThat(observer.hasError()).isTrue();
        StatusRuntimeException error = (StatusRuntimeException) observer.getError();
        assertThat(error.getStatus().getCode()).isEqualTo(Status.FAILED_PRECONDITION.getCode());
        assertThat(error.getStatus().getDescription()).isEqualTo("Audio input format is not admitted");
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("transcribe rejects sample rates outside supported boundaries")
    void transcribe_outOfRangeSampleRate_returnsInvalidArgument() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        service.transcribe(TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {0x01, 0x02}))
                .setSampleRate(48_001)
                .build(), observer);

        assertThat(observer.hasError()).isTrue();
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("transcribe: ValidationError from engine → INVALID_ARGUMENT gRPC error")
    void transcribe_validationError_returnsInvalidArgument() throws Exception { 
        when(mockEngine.transcribe(any(), any(TranscriptionOptions.class))) 
            .thenThrow(new ValidationError("bad audio format"));

        TranscribeRequest request = TranscribeRequest.newBuilder() 
            .setAudioData(ByteString.copyFrom(new byte[]{0x01, 0x02}))
            .setSampleRate(16000) 
            .build(); 
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>(); 

        service.transcribe(request, observer); 

        assertThat(observer.hasError()).isTrue(); 
        StatusRuntimeException ex = (StatusRuntimeException) observer.getError(); 
        assertThat(ex.getStatus().getCode()).isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
        assertThat(ex.getStatus().getDescription()).isEqualTo("Invalid transcription request");
    }

    @Test
    @DisplayName("transcribe: non-retryable InferenceError → INTERNAL gRPC error")
    void transcribe_nonRetryableInferenceError_returnsInternal() throws Exception { 
        when(mockEngine.transcribe(any(), any(TranscriptionOptions.class))) 
            .thenThrow(new InferenceError("model crash", null, false)); 

        TranscribeRequest request = TranscribeRequest.newBuilder() 
            .setAudioData(ByteString.copyFrom(new byte[]{0x01, 0x02}))
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
            .setAudioData(ByteString.copyFrom(new byte[]{0x01, 0x02}))
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
            .setAudioData(ByteString.copyFrom(new byte[]{0x01, 0x02, 0x03, 0x04}))
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
    @DisplayName("unloadModel: registered model is explicitly unavailable when engine has no unload API")
    void unloadModel_registeredModel_returnsUnimplemented() throws Exception {
        ModelInfo info = new ModelInfo("whisper-base", "Whisper Base", "1.0", 
            new Locale[]{Locale.ENGLISH}, 150_000_000L, false);
        when(mockEngine.getAvailableModels()).thenReturn(List.of(info)); 

        CapturingObserver<UnloadModelResponse> observer = new CapturingObserver<>(); 
        service.unloadModel(UnloadModelRequest.newBuilder().setModelId("whisper-base").build(), observer);

        assertThat(observer.hasError()).isTrue();
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
            .isEqualTo(Status.UNIMPLEMENTED.getCode());
        verify(mockEngine, never()).getMetrics();
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
    @DisplayName("adaptModel fails closed without immutable revision and admitted provider")
    void adaptModel_notAdmittedBeforeEngineAccess() {
        AdaptRequest request = AdaptRequest.newBuilder() 
            .setProfileId("p1")
            .addInteractions(Interaction.newBuilder() 
                .setCorrectedTranscript("ghatana platform agent")
                .build()) 
            .build(); 
        CapturingObserver<AdaptResponse> observer = new CapturingObserver<>(); 
        runWithTenantContext(() -> service.adaptModel(request, observer));

        assertThat(observer.hasError()).isTrue();
        StatusRuntimeException failure = (StatusRuntimeException) observer.getError();
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.FAILED_PRECONDITION.getCode());
        assertThat(failure.getStatus().getDescription()).startsWith("STT_ADAPTATION_NOT_ADMITTED:");
        verify(mockLibrary, never()).getSttEngine();
    }

    @Test
    @DisplayName("adaptModel: blank profileId remains unavailable without admission")
    void adaptModel_blankProfileId_notAdmitted() {
        CapturingObserver<AdaptResponse> observer = new CapturingObserver<>(); 
        runWithTenantContext(() -> service.adaptModel(AdaptRequest.getDefaultInstance(), observer));

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.FAILED_PRECONDITION.getCode());
    }

    @Test
    @DisplayName("adaptModel: unknown profile cannot reach mutable legacy state")
    void adaptModel_unknownProfile_notAdmitted() {
        AdaptRequest request = AdaptRequest.newBuilder() 
            .setProfileId("ghost")
            .addInteractions(Interaction.newBuilder().setCorrectedTranscript("word").build())
            .build(); 
        CapturingObserver<AdaptResponse> observer = new CapturingObserver<>(); 
        runWithTenantContext(() -> service.adaptModel(request, observer));

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.FAILED_PRECONDITION.getCode());
        verify(mockLibrary, never()).getSttEngine();
    }

    // ─────────────────────────────────────────────────────────────
    // createProfile (AV-001.5) 
    // ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("createProfile fails closed without trusted rights and consent admission")
    void createProfile_notAdmittedBeforeEngineAccess() {
        CapturingObserver<ProfileResponse> observer = new CapturingObserver<>(); 
        runWithTenantContext(() -> service.createProfile(
                CreateProfileRequest.newBuilder().setDisplayName("Alice").build(), observer));

        assertThat(observer.hasError()).isTrue();
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.FAILED_PRECONDITION.getCode());
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getDescription())
                .startsWith("STT_SPEAKER_PROFILE_NOT_ADMITTED:");
        verify(mockLibrary, never()).getSttEngine();
    }

    @Test
    @DisplayName("createProfile: blank displayName remains blocked without trusted admission")
    void createProfile_blankNameNotAdmitted() {
        CapturingObserver<ProfileResponse> observer = new CapturingObserver<>(); 
        runWithTenantContext(() -> service.createProfile(CreateProfileRequest.getDefaultInstance(), observer));

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.FAILED_PRECONDITION.getCode());
    }

    // ─────────────────────────────────────────────────────────────
    // getProfile (AV-001.6) 
    // ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("getProfile fails closed without tenant-scoped admission")
    void getProfile_notAdmittedBeforeStoreAccess() {
        CapturingObserver<ProfileResponse> observer = new CapturingObserver<>(); 
        runWithTenantContext(() -> service.getProfile(GetProfileRequest.newBuilder().setProfileId("p1").build(), observer));

        assertThat(observer.hasError()).isTrue();
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.FAILED_PRECONDITION.getCode());
        verify(mockLibrary, never()).getSttEngine();
    }

    @Test
    @DisplayName("getProfile: unknown profileId remains blocked without trusted admission")
    void getProfile_unknown_notAdmitted() {
        CapturingObserver<ProfileResponse> observer = new CapturingObserver<>(); 
        runWithTenantContext(() -> service.getProfile(GetProfileRequest.newBuilder().setProfileId("ghost").build(), observer));

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.FAILED_PRECONDITION.getCode());
    }

    @Test
    @DisplayName("getProfile: blank profileId is blocked before store access")
    void getProfile_blankId_notAdmitted() {
        CapturingObserver<ProfileResponse> observer = new CapturingObserver<>(); 
        runWithTenantContext(() -> service.getProfile(GetProfileRequest.getDefaultInstance(), observer));

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.FAILED_PRECONDITION.getCode());
    }

    // ─────────────────────────────────────────────────────────────
    // updateProfile (AV-001.7) 
    // ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("updateProfile fails closed without trusted rights and consent admission")
    void updateProfile_notAdmittedBeforeStoreAccess() {
        UpdateProfileRequest request = UpdateProfileRequest.newBuilder() 
            .setProfileId("p1")
            .setSettings(ProfileSettings.newBuilder().setPreferredLanguage("fr").build())
            .build(); 
        CapturingObserver<ProfileResponse> observer = new CapturingObserver<>(); 
        runWithTenantContext(() -> service.updateProfile(request, observer));

        assertThat(observer.hasError()).isTrue();
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.FAILED_PRECONDITION.getCode());
        verify(mockLibrary, never()).getSttEngine();
    }

    @Test
    @DisplayName("updateProfile: unknown profileId remains blocked without trusted admission")
    void updateProfile_unknown_notAdmitted() {
        CapturingObserver<ProfileResponse> observer = new CapturingObserver<>(); 
        runWithTenantContext(() -> service.updateProfile(UpdateProfileRequest.newBuilder().setProfileId("ghost").build(), observer));

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.FAILED_PRECONDITION.getCode());
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

    @Test
    @DisplayName("getStatus returns INTERNAL when provider status is unavailable")
    void getStatus_providerFailure_returnsInternal() throws Exception {
        when(mockEngine.getStatus()).thenThrow(new IllegalStateException("provider unavailable"));
        CapturingObserver<StatusResponse> observer = new CapturingObserver<>();

        service.getStatus(StatusRequest.getDefaultInstance(), observer);

        assertThat(observer.hasError()).isTrue();
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
            .isEqualTo(Status.INTERNAL.getCode());
    }

    @Test
    @DisplayName("healthCheck remains unhealthy until provider/model readiness checks are composed")
    void healthCheck_doesNotInferReadinessFromEngineState() {
        CapturingObserver<HealthCheckResponse> observer = new CapturingObserver<>();

        service.healthCheck(HealthCheckRequest.getDefaultInstance(), observer);

        assertThat(observer.hasError()).isFalse();
        assertThat(observer.getValue().getStatus()).isEqualTo(HealthStatus.HEALTH_STATUS_UNHEALTHY);
        assertThat(observer.getValue().getMessage())
                .isEqualTo("STT_NOT_SERVING: provider readiness unavailable");
        verify(mockLibrary, never()).getSttEngine();
    }

    // ─────────────────────────────────────────────────────────────
    // submitCorrection
    // ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("submitCorrection fails closed without expected-version CAS")
    void submitCorrection_notAdmittedWithoutVersionCas() {
        CapturingObserver<CorrectionResponse> observer = new CapturingObserver<>(); 
        runWithTenantContext(() -> service.submitCorrection(CorrectionRequest.getDefaultInstance(), observer));

        assertThat(observer.hasError()).isTrue();
        StatusRuntimeException failure = (StatusRuntimeException) observer.getError();
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.FAILED_PRECONDITION.getCode());
        assertThat(failure.getStatus().getDescription()).startsWith("STT_CORRECTION_NOT_ADMITTED:");
        verify(mockLibrary, never()).getSttEngine();
    }

    @Test
    @DisplayName("sensitive write RPCs return UNAUTHENTICATED before admission checks when identity is missing")
    void sensitiveWritesRequireIdentityBeforeCapabilityAdmission() {
        assertSensitiveWriteRpcStatus(Status.UNAUTHENTICATED, this::invokeSensitiveWriteRpcs);
        verify(mockLibrary, never()).getSttEngine();
    }

    @Test
    @DisplayName("sensitive write RPCs reject malformed principals before provider access")
    void sensitiveWritesRejectInvalidPrincipalBeforeProviderAccess() {
        io.grpc.Context.current()
                .withValue(com.ghatana.audio.video.common.security.JwtServerInterceptor.CTX_TENANT, "tenant-test")
                .withValue(com.ghatana.audio.video.common.security.JwtServerInterceptor.CTX_SUBJECT, "not-a-uuid")
                .run(() -> assertSensitiveWriteRpcStatus(Status.UNAUTHENTICATED, this::invokeSensitiveWriteRpcs));
        verify(mockLibrary, never()).getSttEngine();
    }

    private List<CapturingObserver<?>> invokeSensitiveWriteRpcs() {
        var adapt = new CapturingObserver<AdaptResponse>();
        var create = new CapturingObserver<ProfileResponse>();
        var get = new CapturingObserver<ProfileResponse>();
        var update = new CapturingObserver<ProfileResponse>();
        var correction = new CapturingObserver<CorrectionResponse>();
        service.adaptModel(AdaptRequest.getDefaultInstance(), adapt);
        service.createProfile(CreateProfileRequest.getDefaultInstance(), create);
        service.getProfile(GetProfileRequest.getDefaultInstance(), get);
        service.updateProfile(UpdateProfileRequest.getDefaultInstance(), update);
        service.submitCorrection(CorrectionRequest.getDefaultInstance(), correction);
        return List.of(adapt, create, get, update, correction);
    }

    private static void assertSensitiveWriteRpcStatus(
            Status expected,
            java.util.function.Supplier<List<CapturingObserver<?>>> call) {
        for (CapturingObserver<?> observer : call.get()) {
            assertThat(observer.hasError()).isTrue();
            assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                    .isEqualTo(expected.getCode());
        }
    }

    @Test
    @DisplayName("streamTranscribe: unauthenticated caller is rejected before engine access")
    void streamTranscribe_rejectsUnauthenticatedCaller() {
        CapturingObserver<Transcription> observer = new CapturingObserver<>();

        service.streamTranscribe(observer);

        assertThat(observer.hasError()).isTrue();
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
            .isEqualTo(Status.UNAUTHENTICATED.getCode());
        verify(mockLibrary, never()).getSttEngine();
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
    private static void runWithTenantContext(Runnable action) {
        io.grpc.Context.current()
                .withValue(com.ghatana.audio.video.common.security.JwtServerInterceptor.CTX_TENANT, "tenant-test")
                .withValue(com.ghatana.audio.video.common.security.JwtServerInterceptor.CTX_SUBJECT,
                        "00000000-0000-0000-0000-000000000001")
                .run(action);
    }
}
