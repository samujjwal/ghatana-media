package com.ghatana.stt.grpc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.google.protobuf.ByteString;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
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
import java.util.UUID;
import java.util.concurrent.TimeoutException;

@DisplayName("PersistentSttGrpcService")
@ExtendWith(MockitoExtension.class)
class PersistentSttGrpcServiceTest {

    @Mock
    private PersistentSttService persistentSttService;

    private PersistentSttGrpcService service;

    private static final ByteString AUDIO = ByteString.copyFrom(new byte[]{1, 2, 3, 4, 5});
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
    }

    @Test
    @DisplayName("transcribe uses generated userId when no subject context is present")
    void transcribeUsesGeneratedUserIdWhenNoSubject() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        TranscriptionResult mockResult = mock(TranscriptionResult.class);
        when(mockResult.text()).thenReturn("Hi");
        when(mockResult.confidence()).thenReturn(0.9);
        when(mockResult.processingTime()).thenReturn(Duration.ofMillis(100));
        when(mockResult.modelId()).thenReturn("base");
        when(persistentSttService.transcribeAndPersist(
                anyString(), any(UUID.class), any(byte[].class),
                anyString(), any(), anyString(), anyInt()))
            .thenReturn(Promise.of(mockResult));

        Context ctx = Context.current().withValue(JwtServerInterceptor.CTX_TENANT, "tenant-xyz");
        ctx.run(() ->
            service.transcribe(
                TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(16000).build(),
                observer));

        assertThat(observer.error).isNull();
        assertThat(observer.completed).isTrue();
    }

    private static void runWithTenantContext(String tenantId, String userId, Runnable action) {
        Context ctx = Context.current()
            .withValue(JwtServerInterceptor.CTX_TENANT, tenantId)
            .withValue(JwtServerInterceptor.CTX_SUBJECT, userId);
        ctx.run(action);
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