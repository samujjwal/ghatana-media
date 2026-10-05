package com.ghatana.audio.video.integration;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.audio.video.infrastructure.persistence.service.TranscriptionService;
import com.ghatana.testing.activej.EventloopTestBase;
import com.ghatana.stt.grpc.PersistentSttGrpcService;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.media.common.AudioData;
import io.grpc.Context;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.*;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * Authenticated integration tests for STT service with JWT interceptor.
 * Verifies tenant/user context propagation from JWT through gRPC to persistence.
 *
 * @doc.type class
 * @doc.purpose Authenticated integration tests for STT with JWT tenant/user context propagation
 * @doc.layer integration
 * @doc.pattern Integration Test
 */
@DisplayName("STT Authenticated Integration Tests")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class SttAuthenticatedIntegrationTest extends EventloopTestBase {

    private static final String TEST_TENANT_ID = "test-tenant-123";
    private static final String TEST_USER_ID = UUID.randomUUID().toString();
    private static final String TEST_JWT_SECRET = "test-secret-key-for-integration-tests";
    private static final String OTHER_TENANT_ID = "other-tenant-789";

    @Mock
    private AudioVideoLibrary library;

    @Mock
    private AudioFileService audioFileService;

    @Mock
    private TranscriptionService transcriptionService;

    @Mock
    private SttEngine sttEngine;

    private SimpleMeterRegistry meterRegistry;
    private Server server;
    private ManagedChannel channel;
    private STTServiceGrpc.STTServiceBlockingStub blockingStub;

    @BeforeEach
    void setUp() throws Exception {
        // Initialize mocks
        MockitoAnnotations.openMocks(this);

        // Set JWT secret for test
        System.setProperty("AV_JWT_SECRET", TEST_JWT_SECRET);
        // Disable AuthGatewayClient fallback for testing
        System.setProperty("AUTH_GATEWAY_URL", "");

        meterRegistry = new SimpleMeterRegistry();

        // Mock AudioVideoLibrary to return SttEngine
        when(library.getSttEngine()).thenReturn(sttEngine);

        // Create and start gRPC server with JWT interceptor
        String serverName = InProcessServerBuilder.generateName();
        PersistentSttGrpcService service = new PersistentSttGrpcService(
            library, audioFileService, transcriptionService, meterRegistry);

        server = InProcessServerBuilder
            .forName(serverName)
            .directExecutor()
            .addService(service)
            .intercept(new TestJwtServerInterceptor())
            .build()
            .start();

        // Create client channel
        channel = InProcessChannelBuilder
            .forName(serverName)
            .directExecutor()
            .build();

        blockingStub = STTServiceGrpc.newBlockingStub(channel);
    }

    @AfterEach
    void tearDown() throws Exception {
        if (channel != null) {
            channel.shutdownNow();
            channel.awaitTermination(5, TimeUnit.SECONDS);
        }
        if (server != null) {
            server.shutdownNow();
            server.awaitTermination(5, TimeUnit.SECONDS);
        }
        System.clearProperty("AV_JWT_SECRET");
    }

    @Test
    @Order(1)
    @DisplayName("GIVEN valid JWT with tenant claim WHEN transcribe THEN tenant/user context propagates to persistence")
    void validJwtWithTenant_propagatesToPersistence() {
        // Given
        String jwt = generateTestJwt(TEST_TENANT_ID, TEST_USER_ID);
        byte[] audioData = "test audio data".getBytes(StandardCharsets.UTF_8);
        UUID audioFileId = UUID.randomUUID();
        UUID transcriptionId = UUID.randomUUID();

        AudioFileEntity audioFile = createMockAudioFile(audioFileId, TEST_TENANT_ID, TEST_USER_ID);
        TranscriptionEntity transcription = createMockTranscription(transcriptionId, audioFileId, TEST_TENANT_ID, "test transcription");

        when(audioFileService.save(eq(TEST_TENANT_ID), any(AudioFileEntity.class)))
            .thenReturn(io.activej.promise.Promise.of(audioFile));
        when(audioFileService.updateStatus(eq(TEST_TENANT_ID), any(UUID.class), any(AudioFileEntity.ProcessingStatus.class), any()))
            .thenReturn(io.activej.promise.Promise.of(true));
        when(transcriptionService.save(eq(TEST_TENANT_ID), any(TranscriptionEntity.class)))
            .thenReturn(io.activej.promise.Promise.of(transcription));
        when(sttEngine.transcribe(any(AudioData.class), any()))
            .thenReturn(new TranscriptionResult("test transcription", 0.95, java.util.List.of(), java.util.List.of(), Duration.ofMillis(100), "en", "whisper-v3"));

        // When
        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + jwt);

        TranscribeRequest request = TranscribeRequest.newBuilder()
            .setAudioData(com.google.protobuf.ByteString.copyFrom(audioData))
            .setSampleRate(16000)
            .setLanguage("en")
            .build();

        TranscribeResponse response = blockingStub.withInterceptors(new TestClientInterceptor(headers))
            .transcribe(request);

        // Then
        assertThat(response).isNotNull();
        assertThat(response.getText()).isEqualTo("test transcription");
        assertThat(response.getConfidence()).isEqualTo(0.95f);

        // Verify tenant/user context was propagated to persistence
        verify(audioFileService).save(eq(TEST_TENANT_ID), argThat(entity ->
            entity.getTenantId().equals(TEST_TENANT_ID) &&
            entity.getUserId().toString().equals(TEST_USER_ID)
        ));
        verify(transcriptionService).save(eq(TEST_TENANT_ID), argThat(entity ->
            entity.getTenantId().equals(TEST_TENANT_ID) &&
            entity.getUserId().toString().equals(TEST_USER_ID)
        ));
    }

    @Test
    @Order(2)
    @DisplayName("GIVEN JWT missing tenant claim WHEN transcribe THEN request fails with UNAUTHENTICATED")
    void jwtMissingTenant_failsUnauthenticated() {
        // Given
        String jwt = generateTestJwt(null, TEST_USER_ID); // Missing tenant
        byte[] audioData = "test audio data".getBytes(StandardCharsets.UTF_8);

        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + jwt);

        TranscribeRequest request = TranscribeRequest.newBuilder()
            .setAudioData(com.google.protobuf.ByteString.copyFrom(audioData))
            .setSampleRate(16000)
            .build();

        // When/Then
        io.grpc.StatusRuntimeException exception = org.junit.jupiter.api.Assertions.assertThrows(
            io.grpc.StatusRuntimeException.class,
            () -> blockingStub.withInterceptors(new TestClientInterceptor(headers)).transcribe(request)
        );

        assertThat(exception.getStatus().getCode()).isEqualTo(io.grpc.Status.Code.UNAUTHENTICATED);
        assertThat(exception.getStatus().getDescription()).contains("Missing tenant claim");

        // Verify persistence was never called
        verify(audioFileService, never()).save(anyString(), any(AudioFileEntity.class));
    }

    @Test
    @Order(3)
    @DisplayName("GIVEN no JWT token WHEN transcribe THEN request fails with UNAUTHENTICATED")
    void noJwtToken_failsUnauthenticated() {
        // Given
        byte[] audioData = "test audio data".getBytes(StandardCharsets.UTF_8);

        TranscribeRequest request = TranscribeRequest.newBuilder()
            .setAudioData(com.google.protobuf.ByteString.copyFrom(audioData))
            .setSampleRate(16000)
            .build();

        // When/Then
        io.grpc.StatusRuntimeException exception = org.junit.jupiter.api.Assertions.assertThrows(
            io.grpc.StatusRuntimeException.class,
            () -> blockingStub.transcribe(request)
        );

        assertThat(exception.getStatus().getCode()).isEqualTo(io.grpc.Status.Code.UNAUTHENTICATED);
        assertThat(exception.getStatus().getDescription()).contains("Missing Bearer token");

        // Verify persistence was never called
        verify(audioFileService, never()).save(anyString(), any(AudioFileEntity.class));
    }

    @Test
    @Order(4)
    @DisplayName("GIVEN JWT with tenant A WHEN transcribe THEN cannot access tenant B data")
    void crossTenantAccess_denied() {
        // Given
        String jwt = generateTestJwt(TEST_TENANT_ID, TEST_USER_ID);
        byte[] audioData = "test audio data".getBytes(StandardCharsets.UTF_8);
        UUID audioFileId = UUID.randomUUID();

        AudioFileEntity audioFile = createMockAudioFile(audioFileId, OTHER_TENANT_ID, TEST_USER_ID);
        TranscriptionEntity transcription = createMockTranscription(UUID.randomUUID(), audioFileId, TEST_TENANT_ID, "test transcription");

        when(audioFileService.save(eq(TEST_TENANT_ID), any(AudioFileEntity.class)))
            .thenReturn(io.activej.promise.Promise.of(audioFile));
        when(audioFileService.updateStatus(eq(TEST_TENANT_ID), any(UUID.class), any(AudioFileEntity.ProcessingStatus.class), any()))
            .thenReturn(io.activej.promise.Promise.of(true));
        when(transcriptionService.save(eq(TEST_TENANT_ID), any(TranscriptionEntity.class)))
            .thenReturn(io.activej.promise.Promise.of(transcription));
        when(sttEngine.transcribe(any(AudioData.class), any()))
            .thenReturn(new TranscriptionResult("test transcription", 0.95, java.util.List.of(), java.util.List.of(), Duration.ofMillis(100), "en", "whisper-v3"));

        // When
        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + jwt);

        TranscribeRequest request = TranscribeRequest.newBuilder()
            .setAudioData(com.google.protobuf.ByteString.copyFrom(audioData))
            .setSampleRate(16000)
            .build();

        TranscribeResponse response = blockingStub.withInterceptors(new TestClientInterceptor(headers))
            .transcribe(request);

        // Then - verify save was called with JWT tenant, not other tenant
        verify(audioFileService).save(eq(TEST_TENANT_ID), argThat(entity ->
            entity.getTenantId().equals(TEST_TENANT_ID) &&
            !entity.getTenantId().equals(OTHER_TENANT_ID)
        ));
    }

    // Helper methods

    private String generateTestJwt(String tenantId, String userId) {
        // Generate a proper HS256 JWT for testing
        try {
            String header = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
            
            String payload = String.format("{\"sub\":\"%s\",\"tenantId\":\"%s\",\"exp\":%d}",
                userId,
                tenantId != null ? tenantId : "",
                System.currentTimeMillis() / 1000 + 3600);
            String encodedPayload = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(payload.getBytes(StandardCharsets.UTF_8));
            
            // Sign with HMAC-SHA256 using the test secret
            javax.crypto.spec.SecretKeySpec keySpec = new javax.crypto.spec.SecretKeySpec(
                TEST_JWT_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
            javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
            mac.init(keySpec);
            byte[] signatureBytes = mac.doFinal((header + "." + encodedPayload).getBytes(StandardCharsets.UTF_8));
            String signature = Base64.getUrlEncoder().withoutPadding().encodeToString(signatureBytes);
            
            return header + "." + encodedPayload + "." + signature;
        } catch (Exception e) {
            throw new RuntimeException("Failed to generate test JWT", e);
        }
    }

    private AudioFileEntity createMockAudioFile(UUID id, String tenantId, String userId) {
        AudioFileEntity entity = new AudioFileEntity(
            id, tenantId, UUID.randomUUID(), "test.wav", "/storage/test.wav", "wav");
        entity.setFileSizeBytes(1000L);
        entity.setSampleRate(16000);
        entity.setStatus(AudioFileEntity.ProcessingStatus.PROCESSING);
        return entity;
    }

    private TranscriptionEntity createMockTranscription(UUID id, UUID audioFileId, String tenantId, String text) {
        TranscriptionEntity entity = new TranscriptionEntity(
            id, tenantId, audioFileId, UUID.randomUUID(), text, "en");
        entity.setConfidence(0.95f);
        entity.setStatus(TranscriptionEntity.TranscriptionStatus.COMPLETED);
        entity.setModelUsed("whisper-v3");
        entity.setProcessingTimeMs(100L);
        return entity;
    }

    /**
     * Client interceptor to inject headers for testing.
     */
    private static class TestClientInterceptor implements io.grpc.ClientInterceptor {
        private final Metadata headers;

        TestClientInterceptor(Metadata headers) {
            this.headers = headers;
        }

        @Override
        public <ReqT, RespT> io.grpc.ClientCall<ReqT, RespT> interceptCall(
                io.grpc.MethodDescriptor<ReqT, RespT> method,
                io.grpc.CallOptions callOptions,
                io.grpc.Channel next) {
            return new io.grpc.ForwardingClientCall.SimpleForwardingClientCall<ReqT, RespT>(
                next.newCall(method, callOptions)) {
                @Override
                public void start(Listener<RespT> responseListener, Metadata headers) {
                    headers.merge(TestClientInterceptor.this.headers);
                    super.start(responseListener, headers);
                }
            };
        }
    }
}
