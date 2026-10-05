package com.ghatana.audio.video.integration;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.audio.video.infrastructure.persistence.service.TranscriptionService;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.testing.activej.EventloopTestBase;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.ghatana.stt.grpc.PersistentSttGrpcService;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.StatusRuntimeException;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.*;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * E2E integration tests for the STT persistence path.
 *
 * <p>Tests exercise the full stack from gRPC request through
 * {@link PersistentSttGrpcService} → persistence → response. All stubs
 * return real domain objects — no object-literal assertions.
 *
 * @doc.type class
 * @doc.purpose E2E behavioral tests for STT with persistence — audio data flow, validation,
 *              and audit path verification
 * @doc.layer integration
 * @doc.pattern Integration Test
 */
@DisplayName("STT Persistence E2E Tests")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class SttPersistenceE2ETest extends EventloopTestBase {

    private static final String TENANT_ID = "tenant-stt-e2e";
    private static final String USER_ID   = UUID.randomUUID().toString();

    @Mock private AudioVideoLibrary   library;
    @Mock private AudioFileService    audioFileService;
    @Mock private TranscriptionService transcriptionService;
    @Mock private SttEngine           sttEngine;

    private SimpleMeterRegistry meterRegistry;
    private Server server;
    private ManagedChannel channel;
    private STTServiceGrpc.STTServiceBlockingStub blockingStub;

    @BeforeEach
    void setUp() throws Exception {
        MockitoAnnotations.openMocks(this);
        meterRegistry = new SimpleMeterRegistry();
        lenient().when(library.getSttEngine()).thenReturn(sttEngine);

        String serverName = InProcessServerBuilder.generateName();
        PersistentSttGrpcService service = new PersistentSttGrpcService(
                library, audioFileService, transcriptionService, meterRegistry);

        server = InProcessServerBuilder.forName(serverName)
                .directExecutor()
                .addService(service)
                .intercept(new TestJwtServerInterceptor())
                .build()
                .start();

        channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();
        blockingStub = STTServiceGrpc.newBlockingStub(channel);
    }

    @AfterEach
    void tearDown() throws Exception {
        if (channel != null) { channel.shutdownNow(); channel.awaitTermination(5, TimeUnit.SECONDS); }
        if (server  != null) { server.shutdownNow();  server.awaitTermination(5, TimeUnit.SECONDS); }
    }

    // -------------------------------------------------------------------------
    // Happy path: audio bytes flow through persistence and return transcription
    // -------------------------------------------------------------------------

    @Test
    @Order(1)
    @DisplayName("GIVEN valid audio and JWT WHEN transcribe THEN text and confidence returned and both persistence calls made")
    void validAudio_transcribesPersistsAndReturnsResult() {
        // Given
        UUID audioFileId     = UUID.randomUUID();
        UUID transcriptionId = UUID.randomUUID();
        byte[] audioBytes    = buildMinimalWavBytes();

        AudioFileEntity audioFile = audioFileEntity(audioFileId, TENANT_ID, USER_ID);
        TranscriptionEntity transcription = transcriptionEntity(transcriptionId, audioFileId, TENANT_ID, "hello world");

        when(audioFileService.save(eq(TENANT_ID), any(AudioFileEntity.class)))
                .thenReturn(io.activej.promise.Promise.of(audioFile));
        lenient().when(audioFileService.updateStatus(
                eq(TENANT_ID), any(UUID.class), any(AudioFileEntity.ProcessingStatus.class), any()))
                .thenReturn(io.activej.promise.Promise.of(true));
        when(transcriptionService.save(eq(TENANT_ID), any(TranscriptionEntity.class)))
                .thenReturn(io.activej.promise.Promise.of(transcription));
        when(sttEngine.transcribe(any(AudioData.class), any()))
                .thenReturn(new TranscriptionResult(
                        "hello world", 0.93, List.of(), List.of(),
                        Duration.ofMillis(80), "en", "whisper-v3"));

        // When
        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(com.google.protobuf.ByteString.copyFrom(audioBytes))
                .setSampleRate(16000)
                .setLanguage("en")
                .build();

        TranscribeResponse response = blockingStub
                .withInterceptors(jwtHeaders(TENANT_ID, USER_ID))
                .transcribe(request);

        // Then
        assertThat(response.getText()).isEqualTo("hello world");
        assertThat(response.getConfidence()).isEqualTo(0.93f);
        assertThat(response.getModelUsed()).isEqualTo("whisper-v3");

        verify(audioFileService).save(eq(TENANT_ID), argThat(e ->
                e.getTenantId().equals(TENANT_ID) &&
                e.getUserId().toString().equals(USER_ID)));
        verify(transcriptionService).save(eq(TENANT_ID), argThat(e ->
                e.getTenantId().equals(TENANT_ID) &&
                e.getText().equals("hello world")));
    }

    // -------------------------------------------------------------------------
    // AV-P1-004: Validation — missing tenant → UNAUTHENTICATED
    // -------------------------------------------------------------------------

    @Test
    @Order(2)
    @DisplayName("GIVEN JWT without tenant claim WHEN transcribe THEN UNAUTHENTICATED and no persistence call")
    void missingTenantInJwt_returnsUnauthenticated() {
        byte[] audioBytes = buildMinimalWavBytes();
        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(com.google.protobuf.ByteString.copyFrom(audioBytes))
                .setSampleRate(16000)
                .build();

        assertThatThrownBy(() -> blockingStub
                .withInterceptors(jwtHeaders(null, USER_ID))
                .transcribe(request))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(ex -> assertThat(((StatusRuntimeException) ex).getStatus().getCode())
                        .isEqualTo(io.grpc.Status.Code.UNAUTHENTICATED));

        verify(audioFileService, never()).save(anyString(), any(AudioFileEntity.class));
    }

    // -------------------------------------------------------------------------
    // AV-P1-004: Validation — empty audio → INVALID_ARGUMENT
    // -------------------------------------------------------------------------

    @Test
    @Order(3)
    @DisplayName("GIVEN empty audio bytes WHEN transcribe THEN INVALID_ARGUMENT and no persistence call")
    void emptyAudioBytes_returnsInvalidArgument() {
        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(com.google.protobuf.ByteString.EMPTY)
                .setSampleRate(16000)
                .build();

        assertThatThrownBy(() -> blockingStub
                .withInterceptors(jwtHeaders(TENANT_ID, USER_ID))
                .transcribe(request))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(ex -> assertThat(((StatusRuntimeException) ex).getStatus().getCode())
                        .isEqualTo(io.grpc.Status.Code.INVALID_ARGUMENT));

        verify(audioFileService, never()).save(anyString(), any(AudioFileEntity.class));
    }

    // -------------------------------------------------------------------------
    // AV-P1-004: Validation — unsupported language → INVALID_ARGUMENT
    // -------------------------------------------------------------------------

    @Test
    @Order(4)
    @DisplayName("GIVEN unsupported language WHEN transcribe THEN INVALID_ARGUMENT and no persistence call")
    void unsupportedLanguage_returnsInvalidArgument() {
        byte[] audioBytes = buildMinimalWavBytes();
        // "xx" is not in the supported language list
        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(com.google.protobuf.ByteString.copyFrom(audioBytes))
                .setSampleRate(16000)
                .setLanguage("xx")
                .build();

        assertThatThrownBy(() -> blockingStub
                .withInterceptors(jwtHeaders(TENANT_ID, USER_ID))
                .transcribe(request))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(ex -> assertThat(((StatusRuntimeException) ex).getStatus().getCode())
                        .isEqualTo(io.grpc.Status.Code.INVALID_ARGUMENT));

        verify(audioFileService, never()).save(anyString(), any(AudioFileEntity.class));
    }

    // -------------------------------------------------------------------------
    // AV-P1-004: Validation — out-of-range sample rate → INVALID_ARGUMENT
    // -------------------------------------------------------------------------

    @Test
    @Order(5)
    @DisplayName("GIVEN sample rate below minimum WHEN transcribe THEN INVALID_ARGUMENT and no persistence call")
    void outOfRangeSampleRate_returnsInvalidArgument() {
        byte[] audioBytes = buildMinimalWavBytes();
        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(com.google.protobuf.ByteString.copyFrom(audioBytes))
                .setSampleRate(100) // below 8000 minimum
                .build();

        assertThatThrownBy(() -> blockingStub
                .withInterceptors(jwtHeaders(TENANT_ID, USER_ID))
                .transcribe(request))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(ex -> assertThat(((StatusRuntimeException) ex).getStatus().getCode())
                        .isEqualTo(io.grpc.Status.Code.INVALID_ARGUMENT));

        verify(audioFileService, never()).save(anyString(), any(AudioFileEntity.class));
    }

    // -------------------------------------------------------------------------
    // AV-P1-003: Inference failure → persistence is notified and INTERNAL returned
    // -------------------------------------------------------------------------

    @Test
    @Order(6)
    @DisplayName("GIVEN persisted audio WHEN inference fails THEN FAILED status is recorded and INTERNAL returned")
    void inferenceFailure_marksAudioFailedAndReturnsInternal() {
        UUID audioFileId = UUID.randomUUID();
        byte[] audioBytes = buildMinimalWavBytes();
        AudioFileEntity audioFile = audioFileEntity(audioFileId, TENANT_ID, USER_ID);

        when(audioFileService.save(eq(TENANT_ID), any(AudioFileEntity.class)))
                .thenReturn(io.activej.promise.Promise.of(audioFile));
        when(audioFileService.updateStatus(
                eq(TENANT_ID),
                eq(audioFileId),
                eq(AudioFileEntity.ProcessingStatus.FAILED),
                contains("STT_RUNTIMEEXCEPTION")))
                .thenReturn(io.activej.promise.Promise.of(true));
        when(sttEngine.transcribe(any(AudioData.class), any()))
                .thenThrow(new RuntimeException("engine unavailable"));

        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(com.google.protobuf.ByteString.copyFrom(audioBytes))
                .setSampleRate(16000)
                .setLanguage("en")
                .build();

        assertThatThrownBy(() -> blockingStub
                .withInterceptors(jwtHeaders(TENANT_ID, USER_ID))
                .transcribe(request))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(ex -> assertThat(((StatusRuntimeException) ex).getStatus().getCode())
                        .isEqualTo(io.grpc.Status.Code.INTERNAL));

        verify(audioFileService).save(eq(TENANT_ID), any(AudioFileEntity.class));
        verify(audioFileService, timeout(1000)).updateStatus(
                eq(TENANT_ID),
                eq(audioFileId),
                eq(AudioFileEntity.ProcessingStatus.FAILED),
                contains("STT_RUNTIMEEXCEPTION"));
        verify(transcriptionService, never()).save(anyString(), any(TranscriptionEntity.class));
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Build a minimal valid WAV header with a few bytes of silent audio so the
     * persistence path executes a real data flow without needing a native library.
     */
    private static byte[] buildMinimalWavBytes() {
        // 44-byte WAV header for PCM 16-bit mono 16000 Hz + 64 bytes of silence
        byte[] data = new byte[108];
        // RIFF header
        data[0]  = 'R'; data[1]  = 'I'; data[2]  = 'F'; data[3]  = 'F';
        // File size - 8 (little-endian)
        data[4]  = 100; data[5]  = 0; data[6]  = 0; data[7]  = 0;
        // WAVE marker
        data[8]  = 'W'; data[9]  = 'A'; data[10] = 'V'; data[11] = 'E';
        // fmt sub-chunk
        data[12] = 'f'; data[13] = 'm'; data[14] = 't'; data[15] = ' ';
        data[16] = 16; // sub-chunk size = 16 (PCM)
        data[20] = 1;  // AudioFormat = PCM
        data[22] = 1;  // NumChannels = 1 (mono)
        data[24] = (byte) 0x80; data[25] = 0x3E; // SampleRate = 16000 LE
        data[28] = (byte) 0x00; data[29] = 0x7D; // ByteRate = 32000 LE
        data[32] = 2;  // BlockAlign = 2
        data[34] = 16; // BitsPerSample = 16
        // data sub-chunk
        data[36] = 'd'; data[37] = 'a'; data[38] = 't'; data[39] = 'a';
        data[40] = 64; // data size = 64 bytes
        // remaining 64 bytes are zero (silence)
        return data;
    }

    private AudioFileEntity audioFileEntity(UUID id, String tenantId, String userId) {
        AudioFileEntity e = new AudioFileEntity(
                id, tenantId, UUID.fromString(userId), "audio.wav", "/storage/audio.wav", "wav");
        e.setFileSizeBytes(108L);
        e.setSampleRate(16000);
        e.setStatus(AudioFileEntity.ProcessingStatus.PROCESSING);
        return e;
    }

    private TranscriptionEntity transcriptionEntity(UUID id, UUID audioFileId,
                                                    String tenantId, String text) {
        TranscriptionEntity e = new TranscriptionEntity(
                id, tenantId, audioFileId, UUID.fromString(USER_ID), text, "en");
        e.setConfidence(0.93f);
        e.setStatus(TranscriptionEntity.TranscriptionStatus.COMPLETED);
        e.setModelUsed("whisper-v3");
        e.setProcessingTimeMs(80L);
        return e;
    }

    /** Create a client interceptor that injects a test JWT for the given tenant and userId. */
    private io.grpc.ClientInterceptor jwtHeaders(String tenantId, String userId) {
        String jwt = generateTestJwt(tenantId, userId);
        Metadata meta = new Metadata();
        meta.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + jwt);
        return new io.grpc.ClientInterceptor() {
            @Override
            public <ReqT, RespT> io.grpc.ClientCall<ReqT, RespT> interceptCall(
                    io.grpc.MethodDescriptor<ReqT, RespT> method,
                    io.grpc.CallOptions callOptions,
                    io.grpc.Channel next) {
                io.grpc.ClientCall<ReqT, RespT> call = next.newCall(method, callOptions);
                return new io.grpc.ForwardingClientCall.SimpleForwardingClientCall<ReqT, RespT>(call) {
                    @Override
                    public void start(Listener<RespT> responseListener, Metadata headers) {
                        headers.merge(meta);
                        super.start(responseListener, headers);
                    }
                };
            }
        };
    }

    private static String generateTestJwt(String tenantId, String userId) {
        try {
            java.util.Base64.Encoder enc = java.util.Base64.getUrlEncoder().withoutPadding();
            String header  = enc.encodeToString("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
            String payload = enc.encodeToString(
                    String.format("{\"sub\":\"%s\",\"tenantId\":\"%s\",\"exp\":%d}",
                            userId,
                            tenantId != null ? tenantId : "",
                            System.currentTimeMillis() / 1000 + 3600)
                    .getBytes(StandardCharsets.UTF_8));
            javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
            mac.init(new javax.crypto.spec.SecretKeySpec(
                    "test-secret-key-for-integration-tests".getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            String sig = enc.encodeToString(mac.doFinal((header + "." + payload).getBytes(StandardCharsets.UTF_8)));
            return header + "." + payload + "." + sig;
        } catch (Exception e) {
            throw new RuntimeException("Test JWT generation failed", e);
        }
    }
}
