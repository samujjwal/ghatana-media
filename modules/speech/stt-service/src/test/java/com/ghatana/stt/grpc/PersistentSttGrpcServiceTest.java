package com.ghatana.stt.grpc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.google.protobuf.ByteString;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.ghatana.stt.core.grpc.proto.Transcription;
import com.ghatana.stt.core.grpc.proto.CreateProfileRequest;
import com.ghatana.stt.core.grpc.proto.GetProfileRequest;
import com.ghatana.stt.core.grpc.proto.ProfileResponse;
import com.ghatana.stt.core.grpc.proto.UpdateProfileRequest;
import com.ghatana.stt.service.PersistentSttService;
import io.activej.promise.Promise;
import io.grpc.Context;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.slf4j.MDC;

import java.time.Duration;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.TimeoutException;

@DisplayName("PersistentSttGrpcService")
@ExtendWith(MockitoExtension.class)
class PersistentSttGrpcServiceTest {

    @Mock
    private PersistentSttService persistentSttService;

    private PersistentSttGrpcService service;

    private static final ByteString AUDIO = ByteString.copyFrom(validPcmWav());
    private static final String USER_ID = "00000000-0000-0000-0000-000000000001";

    @BeforeEach
    void setUp() {
        service = new PersistentSttGrpcService(persistentSttService);
        MDC.clear();
    }

    @Test
    @DisplayName("transcribe rejects requests without tenant context - UNAUTHENTICATED")
    void transcribeRejectsRequestsWithoutTenantContext() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        service.transcribe(TranscribeRequest.newBuilder().build(), observer);
        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
            .isEqualTo(Status.UNAUTHENTICATED.getCode());
        verifyNoInteractions(persistentSttService);
        assertThat(MDC.get("tenantId")).isNull();
        assertThat(MDC.get("userId")).isNull();
    }

    @Test
    @DisplayName("streamTranscribe remains unimplemented until authenticated runtime admission exists")
    void streamTranscribeDoesNotExposeUnauthenticatedProviderEffect() {
        CapturingObserver<Transcription> observer = new CapturingObserver<>();

        service.streamTranscribe(observer);

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
                .isEqualTo(Status.UNIMPLEMENTED.getCode());
        verifyNoInteractions(persistentSttService);
    }

    @Test
    @DisplayName("speaker profile operations fail closed before persistence access")
    void speakerProfileOperationsRequireTrustedAdmission() {
        CapturingObserver<ProfileResponse> create = new CapturingObserver<>();
        CapturingObserver<ProfileResponse> get = new CapturingObserver<>();
        CapturingObserver<ProfileResponse> update = new CapturingObserver<>();

        service.createProfile(CreateProfileRequest.newBuilder().addEnrollmentAudio(AUDIO).build(), create);
        service.getProfile(GetProfileRequest.newBuilder().setProfileId("profile").build(), get);
        service.updateProfile(UpdateProfileRequest.newBuilder().setProfileId("profile").build(), update);

        for (CapturingObserver<ProfileResponse> observer : java.util.List.of(create, get, update)) {
            assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
            StatusRuntimeException failure = (StatusRuntimeException) observer.error;
            assertThat(failure.getStatus().getCode()).isEqualTo(Status.FAILED_PRECONDITION.getCode());
            assertThat(failure.getStatus().getDescription()).startsWith("STT_SPEAKER_PROFILE_NOT_ADMITTED:");
        }
        verifyNoInteractions(persistentSttService);
    }

    @Test
    @DisplayName("transcribe maps synchronous IllegalArgumentException to INVALID_ARGUMENT")
    void transcribeMapsSynchronousValidationErrorToInvalidArgument() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        when(persistentSttService.transcribeAndPersist(
                anyString(), any(UUID.class), any(byte[].class),
                anyString(), any(), anyString(), anyInt()))
            .thenThrow(new IllegalArgumentException("Unsupported audio format: xyz"));

        runWithTenantContext("tenant-abc", USER_ID, () ->
            service.transcribe(
                TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(16000).build(),
                observer));

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException sre = (StatusRuntimeException) observer.error;
        assertThat(sre.getStatus().getCode()).isEqualTo(Status.INVALID_ARGUMENT.getCode());
        assertThat(sre.getStatus().getDescription()).contains("Unsupported audio format");
    }

    @Test
    @DisplayName("transcribe maps async IllegalArgumentException to INVALID_ARGUMENT")
    void transcribeMapsAsyncValidationErrorToInvalidArgument() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        when(persistentSttService.transcribeAndPersist(
                anyString(), any(UUID.class), any(byte[].class),
                anyString(), any(), anyString(), anyInt()))
            .thenReturn(Promise.ofException(new IllegalArgumentException("Unsupported audio format: avi")));

        runWithTenantContext("tenant-abc", USER_ID, () ->
            service.transcribe(
                TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(16000).build(),
                observer));

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
            .isEqualTo(Status.INVALID_ARGUMENT.getCode());
    }

    @Test
    @DisplayName("transcribe maps TimeoutException to DEADLINE_EXCEEDED")
    void transcribeMapsTimeoutToDeadlineExceeded() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        when(persistentSttService.transcribeAndPersist(
                anyString(), any(UUID.class), any(byte[].class),
                anyString(), any(), anyString(), anyInt()))
            .thenReturn(Promise.ofException(new TimeoutException("STT transcription timed out after 30000 ms")));

        runWithTenantContext("tenant-abc", USER_ID, () ->
            service.transcribe(
                TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(16000).build(),
                observer));

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
            .isEqualTo(Status.DEADLINE_EXCEEDED.getCode());
    }

    @Test
    @DisplayName("transcribe maps RuntimeException to INTERNAL")
    void transcribeMapsRuntimeExceptionToInternal() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        when(persistentSttService.transcribeAndPersist(
                anyString(), any(UUID.class), any(byte[].class),
                anyString(), any(), anyString(), anyInt()))
            .thenReturn(Promise.ofException(new RuntimeException("Database unavailable")));

        runWithTenantContext("tenant-abc", USER_ID, () ->
            service.transcribe(
                TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(16000).build(),
                observer));

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
            .isEqualTo(Status.INTERNAL.getCode());
    }

    @Test
    @DisplayName("transcribe on success returns TranscribeResponse with text and confidence")
    void transcribeOnSuccessReturnsResponse() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        TranscriptionResult mockResult = mock(TranscriptionResult.class);
        when(mockResult.text()).thenReturn("Hello world");
        when(mockResult.confidence()).thenReturn(0.97);
        when(mockResult.processingTime()).thenReturn(Duration.ofMillis(350));
        when(mockResult.modelId()).thenReturn("whisper-medium");
        when(persistentSttService.transcribeAndPersist(
                anyString(), any(UUID.class), any(byte[].class),
                anyString(), any(), anyString(), anyInt()))
            .thenReturn(Promise.of(mockResult));

        runWithTenantContext("tenant-abc", USER_ID, () ->
            service.transcribe(
                TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(16000).build(),
                observer));

        assertThat(observer.error).isNull();
        assertThat(observer.completed).isTrue();
        assertThat(observer.value).isNotNull();
        assertThat(observer.value.getText()).isEqualTo("Hello world");
        assertThat(observer.value.getConfidence()).isCloseTo(0.97f, org.assertj.core.data.Offset.offset(0.001f));
        assertThat(observer.value.getProcessingTimeMs()).isEqualTo(350L);
        assertThat(observer.value.getModelUsed()).isEqualTo("whisper-medium");
        assertThat(observer.value.getWordTimingsList()).isEmpty();
        assertThat(observer.value.getWordTimingTimebase())
                .isEqualTo(com.ghatana.stt.core.grpc.proto.TimestampTimebase.TIMESTAMP_TIMEBASE_UNKNOWN);
        assertThat(observer.value.getConfidenceCalibration())
                .isEqualTo(com.ghatana.stt.core.grpc.proto.ConfidenceCalibration.CONFIDENCE_CALIBRATION_UNCALIBRATED);
    }

    @Test
    @DisplayName("transcribe rejects missing authenticated subject before any service work")
    void transcribeRejectsMissingSubjectWithoutServiceWork() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();

        Context ctx = Context.current().withValue(JwtServerInterceptor.CTX_TENANT, "tenant-xyz");
        ctx.run(() ->
            service.transcribe(
                TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(16000).build(),
                observer));

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
        verifyNoInteractions(persistentSttService);
        assertThat(MDC.get("tenantId")).isNull();
        assertThat(MDC.get("userId")).isNull();
    }

    @Test
    @DisplayName("transcribe rejects unsupported subject identifiers before any service work")
    void transcribeRejectsInvalidSubjectWithoutServiceWork() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();

        runWithTenantContext("tenant-xyz", "authenticated-user-42", () ->
            service.transcribe(
                TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(16000).build(),
                observer));

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
        verifyNoInteractions(persistentSttService);
        assertThat(MDC.get("tenantId")).isNull();
        assertThat(MDC.get("userId")).isNull();
    }

    private static void runWithTenantContext(String tenantId, String userId, Runnable action) {
        Context ctx = Context.current()
            .withValue(JwtServerInterceptor.CTX_TENANT, tenantId)
            .withValue(JwtServerInterceptor.CTX_SUBJECT, userId);
        ctx.run(action);
    }

    private static byte[] validPcmWav() {
        byte[] wav = new byte[48];
        ByteBuffer bytes = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        putAscii(bytes, 0, "RIFF");
        bytes.putInt(4, 40);
        putAscii(bytes, 8, "WAVE");
        putAscii(bytes, 12, "fmt ");
        bytes.putInt(16, 16).putShort(20, (short) 1).putShort(22, (short) 1);
        bytes.putInt(24, 16_000).putInt(28, 32_000).putShort(32, (short) 2).putShort(34, (short) 16);
        putAscii(bytes, 36, "data");
        bytes.putInt(40, 4).putShort(44, (short) 10).putShort(46, (short) -10);
        return wav;
    }

    private static void putAscii(ByteBuffer bytes, int offset, String value) {
        byte[] encoded = value.getBytes(StandardCharsets.US_ASCII);
        for (int index = 0; index < encoded.length; index++) bytes.put(offset + index, encoded[index]);
    }

    private static final class CapturingObserver<T> implements StreamObserver<T> {
        T value;
        Throwable error;
        boolean completed;

        @Override public void onNext(T v) { this.value = v; }
        @Override public void onError(Throwable t) { this.error = t; }
        @Override public void onCompleted() { this.completed = true; }
    }
}
