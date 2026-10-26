package com.ghatana.stt.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.InferenceError;
import com.ghatana.media.common.ModelLoadingError;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.stt.core.grpc.proto.LoadModelRequest;
import com.ghatana.stt.core.grpc.proto.LoadModelResponse;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.ghatana.stt.testutil.LogCapture;
import com.ghatana.stt.testutil.VerifiedJwtContext;
import com.google.protobuf.ByteString;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.doThrow;

class SttGrpcServiceLogPrivacyTest {
    private static final String TRANSCRIPT_MARKER = "stt-transcript-private-marker";
    private static final String MODEL_MARKER = "stt-model-private-marker";
    private static final String PROVIDER_MARKER = "stt-provider-private-marker";
    private static final String CAUSE_MARKER = "stt-cause-private-marker";

    @Test
    void transcriptionSuccessDoesNotLogTranscriptOrModelMarkers() {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine engine = mock(SttEngine.class);
        when(library.getSttEngine()).thenReturn(engine);
        when(engine.transcribe(any(), any(TranscriptionOptions.class))).thenReturn(
                new TranscriptionResult(TRANSCRIPT_MARKER, 0.9, List.of(), List.of(),
                        Duration.ofMillis(7), "en", MODEL_MARKER));
        SttGrpcService service = SttGrpcServiceTestFixture.create(library, new SimpleMeterRegistry());
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();

        try (LogCapture logs = LogCapture.capture(SttGrpcService.class)) {
            VerifiedJwtContext.create("tenant-test", "00000000-0000-0000-0000-000000000001").run(() -> service.transcribe(TranscribeRequest.newBuilder()
                    .setAudioData(ByteString.copyFrom(new byte[32_000]))
                    .setSampleRate(16_000)
                    .build(), observer));

            assertThat(observer.error).isNull();
            assertThat(observer.value.getText()).isEqualTo(TRANSCRIPT_MARKER);
            assertThat(observer.value.getModelUsed()).isEqualTo(MODEL_MARKER);
            assertNoMarkers(logs.output(), TRANSCRIPT_MARKER, MODEL_MARKER);
        }
    }

    @Test
    void providerFailureLogsOnlyFailureTypeAndReturnsFixedDescription() {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine engine = mock(SttEngine.class);
        when(library.getSttEngine()).thenReturn(engine);
        doThrow(new InferenceError(PROVIDER_MARKER, new RuntimeException(CAUSE_MARKER), false))
                .when(engine).transcribe(any(), any(TranscriptionOptions.class));
        SttGrpcService service = SttGrpcServiceTestFixture.create(library, new SimpleMeterRegistry());
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();

        try (LogCapture logs = LogCapture.capture(SttGrpcService.class)) {
            VerifiedJwtContext.create("tenant-test", "00000000-0000-0000-0000-000000000001").run(() -> service.transcribe(TranscribeRequest.newBuilder()
                    .setAudioData(ByteString.copyFrom(new byte[32_000]))
                    .setSampleRate(16_000)
                    .build(), observer));

            assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
            assertThat(Status.fromThrowable(observer.error).getCode()).isEqualTo(Status.Code.INTERNAL);
            assertThat(Status.fromThrowable(observer.error).getDescription()).isEqualTo("Transcription failed");
            assertNoMarkers(logs.output(), PROVIDER_MARKER, CAUSE_MARKER);
        }
    }

    @Test
    void modelLoadFailureDoesNotLogOrReturnModelOrProviderDetails() throws Exception {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine engine = mock(SttEngine.class);
        when(library.getSttEngine()).thenReturn(engine);
        doThrow(new ModelLoadingError(PROVIDER_MARKER, new RuntimeException(CAUSE_MARKER)))
                .when(engine).loadModel(MODEL_MARKER);
        SttGrpcService service = SttGrpcServiceTestFixture.create(library, new SimpleMeterRegistry());
        CapturingObserver<LoadModelResponse> observer = new CapturingObserver<>();

        try (LogCapture logs = LogCapture.capture(SttGrpcService.class)) {
            VerifiedJwtContext.create("tenant-test", "00000000-0000-0000-0000-000000000001").run(() ->
                    service.loadModel(LoadModelRequest.newBuilder().setModelId(MODEL_MARKER).build(), observer));

            assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
            assertThat(Status.fromThrowable(observer.error).getCode()).isEqualTo(Status.Code.NOT_FOUND);
            assertThat(Status.fromThrowable(observer.error).getDescription())
                    .isEqualTo("Model not found or cannot be loaded");
            assertNoMarkers(logs.output(), MODEL_MARKER, PROVIDER_MARKER, CAUSE_MARKER);
        }
    }

    private static void assertNoMarkers(String output, String... markers) {
        for (String marker : markers) assertThat(output).doesNotContain(marker);
    }

    private static final class CapturingObserver<T> implements StreamObserver<T> {
        private T value;
        private Throwable error;
        @Override public void onNext(T response) { value = response; }
        @Override public void onError(Throwable failure) { error = failure; }
        @Override public void onCompleted() { }
    }
}
