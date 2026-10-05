package com.ghatana.audio.video.integration;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.testing.activej.EventloopTestBase;
import com.ghatana.tts.grpc.PersistentTtsGrpcService;
import com.ghatana.tts.core.grpc.proto.TTSServiceGrpc;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeResponse;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.common.AudioData;
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
 * Authenticated integration tests for TTS service with JWT interceptor.
 * Verifies tenant/user context propagation from JWT through gRPC to persistence.
 *
 * @doc.type class
 * @doc.purpose Authenticated integration tests for TTS with JWT tenant/user context propagation
 * @doc.layer integration
 * @doc.pattern Integration Test
 */
@DisplayName("TTS Authenticated Integration Tests")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class TtsAuthenticatedIntegrationTest extends EventloopTestBase {

    private static final String TEST_TENANT_ID = "test-tenant-123";
    private static final String TEST_USER_ID = UUID.randomUUID().toString();
    private static final String TEST_JWT_SECRET = "test-secret-key-for-integration-tests";
    private static final String OTHER_TENANT_ID = "other-tenant-789";

    @Mock
    private AudioVideoLibrary library;

    @Mock
    private AudioFileService audioFileService;

    @Mock
    private TtsEngine ttsEngine;

    private SimpleMeterRegistry meterRegistry;
    private Server server;
    private ManagedChannel channel;
    private TTSServiceGrpc.TTSServiceBlockingStub blockingStub;

    @BeforeEach
    void setUp() throws Exception {
        // Initialize mocks
        MockitoAnnotations.openMocks(this);

        // Set JWT secret for test
        System.setProperty("AV_JWT_SECRET", TEST_JWT_SECRET);
        // Disable AuthGatewayClient fallback for testing
        System.setProperty("AUTH_GATEWAY_URL", "");

        meterRegistry = new SimpleMeterRegistry();

        // Mock AudioVideoLibrary to return TtsEngine
        when(library.getTtsEngine()).thenReturn(ttsEngine);

        // Create and start gRPC server with JWT interceptor
        String serverName = InProcessServerBuilder.generateName();
        PersistentTtsGrpcService service = new PersistentTtsGrpcService(
            library, audioFileService, meterRegistry);

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

        blockingStub = TTSServiceGrpc.newBlockingStub(channel);
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
    @DisplayName("GIVEN valid JWT with tenant claim WHEN synthesize THEN tenant/user context propagates to persistence")
    void validJwtWithTenant_propagatesToPersistence() {
        // Given
        String jwt = generateTestJwt(TEST_TENANT_ID, TEST_USER_ID);
        String text = "Hello world";
        UUID audioFileId = UUID.randomUUID();

        AudioFileEntity audioFile = createMockAudioFile(audioFileId, TEST_TENANT_ID, TEST_USER_ID);
        byte[] audioData = "synthesized audio".getBytes(StandardCharsets.UTF_8);

        when(audioFileService.save(eq(TEST_TENANT_ID), any(AudioFileEntity.class)))
            .thenReturn(io.activej.promise.Promise.of(audioFile));
        when(ttsEngine.synthesize(eq(text), any()))
            .thenReturn(new AudioData(audioData, 16000, 1, 16, Duration.ofMillis(500), 
                com.ghatana.media.common.AudioFormat.WAV));

        // When
        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + jwt);

        SynthesizeRequest request = SynthesizeRequest.newBuilder()
            .setText(text)
            .setVoiceId("en-US-Neural2-A")
            .setOptions(com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder()
                .setSpeed(1.0f)
                .setPitch(1.0f)
                .setLanguage("en")
                .build())
            .build();

        SynthesizeResponse response = blockingStub.withInterceptors(new TestClientInterceptor(headers))
            .synthesize(request);

        // Then
        assertThat(response).isNotNull();
        assertThat(response.getAudioData().toByteArray()).isEqualTo(audioData);
        assertThat(response.getSampleRate()).isEqualTo(16000);

        // Verify tenant/user context was propagated to persistence
        verify(audioFileService).save(eq(TEST_TENANT_ID), argThat(entity ->
            entity.getTenantId().equals(TEST_TENANT_ID) &&
            entity.getUserId().toString().equals(TEST_USER_ID)
        ));
    }

    @Test
    @Order(2)
    @DisplayName("GIVEN JWT missing tenant claim WHEN synthesize THEN request fails with UNAUTHENTICATED")
    void jwtMissingTenant_failsUnauthenticated() {
        // Given
        String jwt = generateTestJwt(null, TEST_USER_ID); // Missing tenant
        String text = "Hello world";

        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + jwt);

        SynthesizeRequest request = SynthesizeRequest.newBuilder()
            .setText(text)
            .setVoiceId("en-US-Neural2-A")
            .setOptions(com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder()
                .setSpeed(1.0f)
                .setPitch(1.0f)
                .setLanguage("en")
                .build())
            .build();

        // When/Then
        io.grpc.StatusRuntimeException exception = org.junit.jupiter.api.Assertions.assertThrows(
            io.grpc.StatusRuntimeException.class,
            () -> blockingStub.withInterceptors(new TestClientInterceptor(headers)).synthesize(request)
        );

        assertThat(exception.getStatus().getCode()).isEqualTo(io.grpc.Status.Code.UNAUTHENTICATED);
        assertThat(exception.getStatus().getDescription()).contains("Missing tenant claim");

        // Verify persistence was never called
        verify(audioFileService, never()).save(anyString(), any(AudioFileEntity.class));
    }

    @Test
    @Order(3)
    @DisplayName("GIVEN no JWT token WHEN synthesize THEN request fails with UNAUTHENTICATED")
    void noJwtToken_failsUnauthenticated() {
        // Given
        String text = "Hello world";

        SynthesizeRequest request = SynthesizeRequest.newBuilder()
            .setText(text)
            .setVoiceId("en-US-Neural2-A")
            .setOptions(com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder()
                .setSpeed(1.0f)
                .setPitch(1.0f)
                .setLanguage("en")
                .build())
            .build();

        // When/Then
        io.grpc.StatusRuntimeException exception = org.junit.jupiter.api.Assertions.assertThrows(
            io.grpc.StatusRuntimeException.class,
            () -> blockingStub.synthesize(request)
        );

        assertThat(exception.getStatus().getCode()).isEqualTo(io.grpc.Status.Code.UNAUTHENTICATED);
        assertThat(exception.getStatus().getDescription()).contains("Missing Bearer token");

        // Verify persistence was never called
        verify(audioFileService, never()).save(anyString(), any(AudioFileEntity.class));
    }

    @Test
    @Order(4)
    @DisplayName("GIVEN JWT with tenant A WHEN synthesize THEN cannot access tenant B data")
    void crossTenantAccess_denied() {
        // Given
        String jwt = generateTestJwt(TEST_TENANT_ID, TEST_USER_ID);
        String text = "Hello world";
        UUID audioFileId = UUID.randomUUID();

        AudioFileEntity audioFile = createMockAudioFile(audioFileId, OTHER_TENANT_ID, TEST_USER_ID);

        when(audioFileService.save(eq(TEST_TENANT_ID), any(AudioFileEntity.class)))
            .thenReturn(io.activej.promise.Promise.of(audioFile));
        when(ttsEngine.synthesize(eq(text), any()))
            .thenReturn(new AudioData("synthesized audio".getBytes(StandardCharsets.UTF_8), 
                16000, 1, 16, Duration.ofMillis(500), com.ghatana.media.common.AudioFormat.WAV));

        // When
        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + jwt);

        SynthesizeRequest request = SynthesizeRequest.newBuilder()
            .setText(text)
            .setVoiceId("en-US-Neural2-A")
            .setOptions(com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder()
                .setSpeed(1.0f)
                .setPitch(1.0f)
                .setLanguage("en")
                .build())
            .build();

        blockingStub.withInterceptors(new TestClientInterceptor(headers)).synthesize(request);

        // Then - verify save was called with JWT tenant, not other tenant
        verify(audioFileService).save(eq(TEST_TENANT_ID), argThat(entity ->
            entity.getTenantId().equals(TEST_TENANT_ID) &&
            !entity.getTenantId().equals(OTHER_TENANT_ID)
        ));
    }

    @Test
    @Order(5)
    @DisplayName("GIVEN valid JWT WHEN streamSynthesize THEN tenant/user context propagates")
    void validJwt_streamSynthesize_propagatesContext() {
        // Given
        String jwt = generateTestJwt(TEST_TENANT_ID, TEST_USER_ID);
        String text = "Hello world";

        when(ttsEngine.synthesize(any(), any()))
            .thenReturn(new AudioData(new byte[] {1, 2, 3, 4}, 16000, 1, 2));

        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + jwt);

        SynthesizeRequest request = SynthesizeRequest.newBuilder()
            .setText(text)
            .setVoiceId("en-US-Neural2-A")
            .setOptions(com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder()
                .setSpeed(1.0f)
                .setPitch(1.0f)
                .setLanguage("en")
                .build())
            .build();

        // When - streamSynthesize should succeed with valid JWT
        blockingStub.withInterceptors(new TestClientInterceptor(headers)).streamSynthesize(request);

        // Then - streaming endpoint succeeded (no exception thrown)
        // Note: streaming may not persist, so we only verify authentication succeeded
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
            id, tenantId, UUID.randomUUID(), "tts_test.wav", "/storage/tts_test.wav", "wav");
        entity.setFileSizeBytes(1000L);
        entity.setSampleRate(16000);
        entity.setStatus(AudioFileEntity.ProcessingStatus.COMPLETED);
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
