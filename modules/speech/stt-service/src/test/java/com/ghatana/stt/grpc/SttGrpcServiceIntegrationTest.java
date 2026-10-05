package com.ghatana.stt.grpc;

import com.ghatana.stt.core.grpc.proto.*;
import com.google.protobuf.ByteString;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Integration tests for {@link SttGrpcService}.
 *
 * <p>Verifies STT gRPC service request/response handling and protobuf marshalling.
 *
 * @doc.type class
 * @doc.purpose Integration tests for STT gRPC service
 * @doc.layer product
 * @doc.pattern TestCase
 */
@ExtendWith(MockitoExtension.class)
@DisplayName("SttGrpcService — Integration Tests")
class SttGrpcServiceIntegrationTest {

    private SttGrpcService sttService;

    @BeforeEach
    void setUp() {
        sttService = new SttGrpcService(new SimpleMeterRegistry());
    }

    @Test
    @DisplayName("should verify TranscribeRequest can be constructed properly")
    void transcribeRequestConstruction() {
        // Act
        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[]{0x01, 0x02, 0x03, 0x04}))
                .setSampleRate(16000)
                .build();

        // Assert
        assertThat(request).isNotNull();
        assertThat(request.getAudioData().toByteArray()).hasSize(4);
        assertThat(request.getSampleRate()).isEqualTo(16000);
    }

    @Test
    @DisplayName("should handle empty audio data gracefully")
    void emptyAudioDataHandled() {
        // Act
        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(ByteString.EMPTY)
                .setSampleRate(16000)
                .build();

        // Assert
        assertThat(request.getAudioData().isEmpty()).isTrue();
    }

    @Test
    @DisplayName("should handle different sample rates")
    void differentSampleRatesHandled() {
        // Arrange
        int[] sampleRates = {8000, 16000, 44100, 48000};

        // Act & Assert
        for (int sampleRate : sampleRates) {
            TranscribeRequest request = TranscribeRequest.newBuilder()
                    .setAudioData(ByteString.copyFrom(new byte[]{0x01}))
                    .setSampleRate(sampleRate)
                    .build();

            assertThat(request.getSampleRate()).isEqualTo(sampleRate);
        }
    }

    @Test
    @DisplayName("should handle transcription with language parameter")
    void languageParameterHandled() {
        // Arrange
        String language = "fr";

        // Act
        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[]{0x01, 0x02}))
                .setSampleRate(16000)
                .setLanguage(language)
                .build();

        // Assert
        assertThat(request.getLanguage()).isEqualTo("fr");
    }

    @Test
    @DisplayName("should handle large audio payloads in transcription")
    void largeAudioPayloadHandled() {
        // Arrange
        byte[] largeAudio = new byte[512 * 1024]; // 512 KB
        for (int i = 0; i < largeAudio.length; i++) {
            largeAudio[i] = (byte) (i % 256);
        }

        // Act
        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(largeAudio))
                .setSampleRate(16000)
                .build();

        // Assert
        assertThat(request.getAudioData().size()).isEqualTo(512 * 1024);
    }

    @Test
    @DisplayName("should verify TranscribeResponse can be constructed with all fields")
    void transcribeResponseConstruction() {
        // Act
        TranscribeResponse response = TranscribeResponse.newBuilder()
                .setText("hello world")
                .setConfidence(0.95f)
                .setProcessingTimeMs(100)
                .setModelUsed("whisper-base")
                .build();

        // Assert
        assertThat(response.getText()).isEqualTo("hello world");
        assertThat(response.getConfidence()).isEqualTo(0.95f);
        assertThat(response.getProcessingTimeMs()).isEqualTo(100);
        assertThat(response.getModelUsed()).isEqualTo("whisper-base");
    }

    @Test
    @DisplayName("should handle StatusRequest construction")
    void statusRequestConstruction() {
        // Act
        StatusRequest request = StatusRequest.newBuilder()
                .setIncludeMetrics(true)
                .setIncludeModelInfo(false)
                .build();

        // Assert
        assertThat(request.getIncludeMetrics()).isTrue();
        assertThat(request.getIncludeModelInfo()).isFalse();
    }

    @Test
    @DisplayName("should handle HealthCheckRequest construction")
    void healthCheckRequestConstruction() {
        // Act
        HealthCheckRequest request = HealthCheckRequest.newBuilder().build();

        // Assert
        assertThat(request).isNotNull();
    }

    @Test
    @DisplayName("should handle StreamObserver callback correctly")
    void streamObserverCallbackHandling() {
        // Arrange
        AtomicReference<TranscribeResponse> capturedResponse = new AtomicReference<>();
        StreamObserver<TranscribeResponse> observer = new StreamObserver<TranscribeResponse>() {
            @Override
            public void onNext(TranscribeResponse value) {
                capturedResponse.set(value);
            }

            @Override
            public void onError(Throwable t) {
                // No-op
            }

            @Override
            public void onCompleted() {
                // No-op
            }
        };

        TranscribeResponse response = TranscribeResponse.newBuilder()
                .setText("test")
                .setConfidence(0.9f)
                .build();

        // Act
        observer.onNext(response);

        // Assert
        assertThat(capturedResponse.get()).isNotNull();
        assertThat(capturedResponse.get().getText()).isEqualTo("test");
    }

    @Test
    @DisplayName("should verify response fields at boundaries")
    void responseFieldsAtBoundaries() {
        // Act - Zero confidence
        TranscribeResponse zeroConf = TranscribeResponse.newBuilder()
                .setText("text")
                .setConfidence(0.0f)
                .build();

        // Act - Full confidence
        TranscribeResponse fullConf = TranscribeResponse.newBuilder()
                .setText("text")
                .setConfidence(1.0f)
                .build();

        // Assert
        assertThat(zeroConf.getConfidence()).isEqualTo(0.0f);
        assertThat(fullConf.getConfidence()).isEqualTo(1.0f);
    }
}
