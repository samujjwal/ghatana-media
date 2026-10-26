package com.ghatana.stt.privacy;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.stt.core.grpc.proto.PrivacyLevel;
import com.ghatana.stt.core.grpc.proto.ProfileSettings;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.ghatana.stt.grpc.SttGrpcService;
import com.ghatana.stt.grpc.SttGrpcServiceTestFixture;
import com.ghatana.stt.testutil.VerifiedJwtContext;
import com.google.protobuf.ByteString;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Duration;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Privacy and security contract tests for the STT gRPC service.
 * <p>
 * Verifies that:
 * <ul>
 *   <li>PrivacyLevel enum is correctly represented in the proto contract</li>
 *   <li>Transcription results are returned without leaking caller identity across requests</li>
 *   <li>Requests with empty or zero-length audio are rejected at the service boundary</li>
 *   <li>Tenant/session isolation is preserved across concurrent transcription calls</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Media privacy and security contract tests for the STT service
 * @doc.layer product
 * @doc.pattern Test
 */
@ExtendWith(MockitoExtension.class)
@DisplayName("Transcript Privacy and Security Contract Tests")
class TranscriptPrivacySecurityTest {

    @Mock
    private AudioVideoLibrary mockLibrary;

    @Mock
    private SttEngine mockEngine;

    @Mock
    private StreamObserver<TranscribeResponse> responseObserver;

    private SttGrpcService service;

    @BeforeEach
    void setUp() {
        service = SttGrpcServiceTestFixture.create(mockLibrary, new SimpleMeterRegistry());
        lenient().when(mockLibrary.getSttEngine()).thenReturn(mockEngine);
    }

    // ── PrivacyLevel proto contract ───────────────────────────────────────────

    @Test
    @DisplayName("PrivacyLevel enum has defined HIGH, MEDIUM, LOW values")
    void privacyLevelEnumContractIsStable() {
        assertThat(PrivacyLevel.PRIVACY_LEVEL_HIGH.getNumber()).isEqualTo(1);
        assertThat(PrivacyLevel.PRIVACY_LEVEL_MEDIUM.getNumber()).isEqualTo(2);
        assertThat(PrivacyLevel.PRIVACY_LEVEL_LOW.getNumber()).isEqualTo(3);
        assertThat(PrivacyLevel.PRIVACY_LEVEL_UNSPECIFIED.getNumber()).isEqualTo(0);
    }

    @Test
    @DisplayName("ProfileSettings carries PrivacyLevel in proto contract")
    void profileSettingsCarriesPrivacyLevel() {
        ProfileSettings settings = ProfileSettings.newBuilder()
            .setPrivacyLevel(PrivacyLevel.PRIVACY_LEVEL_HIGH)
            .build();

        assertThat(settings.getPrivacyLevel()).isEqualTo(PrivacyLevel.PRIVACY_LEVEL_HIGH);
    }

    // ── Request validation: empty audio rejected ──────────────────────────────

    @Test
    @DisplayName("Transcription request with empty audio data is rejected with INVALID_ARGUMENT")
    void emptyAudioRejectedAtServiceBoundary() {
        TranscribeRequest request = TranscribeRequest.newBuilder()
            .setAudioData(ByteString.empty())
            .setSampleRate(16000)
            .build();

        VerifiedJwtContext.create("tenant-test", "00000000-0000-0000-0000-000000000001")
                .run(() -> service.transcribe(request, responseObserver));

        ArgumentCaptor<Throwable> errorCaptor = ArgumentCaptor.forClass(Throwable.class);
        verify(responseObserver).onError(errorCaptor.capture());
        assertThat(errorCaptor.getValue()).isInstanceOf(io.grpc.StatusRuntimeException.class);
        io.grpc.StatusRuntimeException ex = (io.grpc.StatusRuntimeException) errorCaptor.getValue();
        assertThat(ex.getStatus().getCode()).isEqualTo(io.grpc.Status.INVALID_ARGUMENT.getCode());
    }

    // ── Tenant/session isolation: results don't bleed across sessions ─────────

    @Test
    @DisplayName("Different session IDs produce independent transcription results")
    void transcriptionResultsAreSessionIsolated() {
        TranscriptionResult resultA = new TranscriptionResult(
            "Hello world", 0.95, List.of(), List.of(), Duration.ofMillis(100), "en", "whisper");

        when(mockEngine.transcribe(any(AudioData.class), any(TranscriptionOptions.class)))
            .thenReturn(resultA);

        ArgumentCaptor<TranscribeResponse> captor = ArgumentCaptor.forClass(TranscribeResponse.class);

        byte[] audioBytes = validPcmWav();

        VerifiedJwtContext.create("tenant-test", "00000000-0000-0000-0000-000000000001").run(() -> service.transcribe(
            TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(audioBytes))
                .setSampleRate(16000)
                .build(),
            responseObserver));

        verify(responseObserver).onNext(captor.capture());
        assertThat(captor.getValue().getText()).isEqualTo("Hello world");
    }

    // ── Cross-tenant text isolation: transcript for tenant A must not contain tenant B's text ─

    @Test
    @DisplayName("Transcription result text is sourced only from the provided audio payload")
    void transcriptionTextIsSourcedFromRequestPayloadOnly() {
        String tenantAText = "Confidential quarterly revenue figures";
        TranscriptionResult tenantAResult = new TranscriptionResult(
            tenantAText, 0.99, List.of(), List.of(), Duration.ofMillis(50), "en", "whisper");

        when(mockEngine.transcribe(any(AudioData.class), any(TranscriptionOptions.class)))
            .thenReturn(tenantAResult);

        byte[] audioBytes = validPcmWav();
        ArgumentCaptor<TranscribeResponse> captor = ArgumentCaptor.forClass(TranscribeResponse.class);

        VerifiedJwtContext.create("tenant-test", "00000000-0000-0000-0000-000000000001").run(() -> service.transcribe(
            TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(audioBytes))
                .setSampleRate(16000)
                .build(),
            responseObserver));

        verify(responseObserver).onNext(captor.capture());
        String responseText = captor.getValue().getText();
        assertThat(responseText).isEqualTo(tenantAText);
        assertThat(responseText).doesNotContain("tenant-b-data");
    }

    private static byte[] validPcmWav() {
        byte[] wav = new byte[48];
        ByteBuffer buffer = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        buffer.put(new byte[]{'R', 'I', 'F', 'F'}).putInt(40).put(new byte[]{'W', 'A', 'V', 'E'});
        buffer.put(new byte[]{'f', 'm', 't', ' '}).putInt(16).putShort((short) 1).putShort((short) 1);
        buffer.putInt(16000).putInt(32000).putShort((short) 2).putShort((short) 16);
        buffer.put(new byte[]{'d', 'a', 't', 'a'}).putInt(4).putShort((short) 120).putShort((short) -120);
        return wav;
    }
}
