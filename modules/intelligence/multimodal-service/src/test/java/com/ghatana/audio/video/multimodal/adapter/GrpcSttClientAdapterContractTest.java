package com.ghatana.audio.video.multimodal.adapter;

import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.google.protobuf.ByteString;
import io.grpc.StatusRuntimeException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Contract tests for {@link GrpcSttClientAdapter}.
 *
 * <p>Verifies the typed gRPC request/response contract and the adapter's grounded provider mode.
 *
 * @doc.type class
 * @doc.purpose Contract tests for STT gRPC client-server interaction
 * @doc.layer product
 * @doc.pattern TestCase
 */
@DisplayName("GrpcSttClientAdapter — Contract Tests")
class GrpcSttClientAdapterContractTest {

    private GrpcSttClientAdapter adapter;

    @BeforeEach
    void setUp() {
        adapter = new GrpcSttClientAdapter(
                "localhost", 50051, GrpcSttClientAdapter.SttMode.GRPC);
    }

    @AfterEach
    void tearDown() {
        adapter.close();
    }

    @Test
    @DisplayName("should verify TranscribeRequest can be properly constructed with audio bytes")
    void transcribeRequestProperlyConstructed() {
        byte[] audioData = new byte[]{1, 2, 3, 4};

        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(audioData))
                .setSampleRate(16000)
                .setLanguage("")
                .build();

        assertThat(request).isNotNull();
        assertThat(request.getAudioData().toByteArray()).isEqualTo(audioData);
        assertThat(request.getSampleRate()).isEqualTo(16000);
        assertThat(request.getLanguage()).isEmpty();
    }

    @Test
    @DisplayName("should verify TranscribeResponse can be properly unmarshalled")
    void transcribeResponseProperlyUnmarshalled() {
        TranscribeResponse response = TranscribeResponse.newBuilder()
                .setText("hello world")
                .setConfidence(0.95f)
                .setProcessingTimeMs(100)
                .setModelUsed("whisper-base")
                .build();

        assertThat(response).isNotNull();
        assertThat(response.getText()).isEqualTo("hello world");
        assertThat(response.getConfidence()).isEqualTo(0.95f);
        assertThat(response.getProcessingTimeMs()).isEqualTo(100);
        assertThat(response.getModelUsed()).isEqualTo("whisper-base");
    }

    @Test
    @DisplayName("should handle empty audio data in request")
    void emptyAudioInRequest() {
        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(ByteString.EMPTY)
                .setSampleRate(16000)
                .build();

        assertThat(request.getAudioData().isEmpty()).isTrue();
    }

    @Test
    @DisplayName("should handle large audio payload in request")
    void largeAudioInRequest() {
        byte[] largeAudio = new byte[512 * 1024];
        for (int i = 0; i < largeAudio.length; i++) {
            largeAudio[i] = (byte) (i % 256);
        }

        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(largeAudio))
                .setSampleRate(16000)
                .build();

        assertThat(request.getAudioData().size()).isEqualTo(512 * 1024);
    }

    @Test
    @DisplayName("should verify response contains required fields")
    void responseContainsRequiredFields() {
        TranscribeResponse response = TranscribeResponse.newBuilder()
                .setText("test")
                .setConfidence(0.9f)
                .setProcessingTimeMs(50)
                .setModelUsed("model-v1")
                .build();

        assertThat(response.getText()).isNotEmpty();
        assertThat(response.getConfidence()).isGreaterThanOrEqualTo(0.0f);
        assertThat(response.getProcessingTimeMs()).isGreaterThan(0);
        assertThat(response.getModelUsed()).isNotEmpty();
    }

    @Test
    @DisplayName("should handle confidence at boundaries")
    void confidenceAtBoundaries() {
        TranscribeResponse lowConfidence = TranscribeResponse.newBuilder()
                .setText("text")
                .setConfidence(0.0f)
                .build();
        TranscribeResponse highConfidence = TranscribeResponse.newBuilder()
                .setText("text")
                .setConfidence(1.0f)
                .build();

        assertThat(lowConfidence.getConfidence()).isEqualTo(0.0f);
        assertThat(highConfidence.getConfidence()).isEqualTo(1.0f);
    }

    @Test
    @DisplayName("should verify StatusRuntimeException handling pattern")
    void statusRuntimeExceptionPattern() {
        StatusRuntimeException exception = new StatusRuntimeException(io.grpc.Status.UNAVAILABLE);

        assertThat(exception).isNotNull();
        assertThat(exception.getStatus()).isNotNull();
        assertThat(exception.getStatus().getCode()).isEqualTo(io.grpc.Status.Code.UNAVAILABLE);
    }

    @Test
    @DisplayName("should handle different language codes in request")
    void differentLanguageCodesInRequest() {
        String[] languageCodes = {"", "en", "fr", "es", "de", "zh", "ja"};

        for (String langCode : languageCodes) {
            TranscribeRequest request = TranscribeRequest.newBuilder()
                    .setAudioData(ByteString.copyFrom(new byte[]{1}))
                    .setLanguage(langCode)
                    .build();

            assertThat(request.getLanguage()).isEqualTo(langCode);
        }
    }

    @Test
    @DisplayName("adapter mode is grounded GRPC")
    void adapterModeTrackingWorks() {
        assertThat(adapter.getCurrentMode()).isEqualTo(GrpcSttClientAdapter.SttMode.GRPC);
    }
}
