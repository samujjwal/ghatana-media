package com.ghatana.stt.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.common.ModelLoadingError;
import com.ghatana.media.stt.api.ModelInfo;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.AdaptRequest;
import com.ghatana.stt.core.grpc.proto.AudioChunk;
import com.ghatana.stt.core.grpc.proto.CorrectionRequest;
import com.ghatana.stt.core.grpc.proto.CreateProfileRequest;
import com.ghatana.stt.core.grpc.proto.GetProfileRequest;
import com.ghatana.stt.core.grpc.proto.HealthCheckRequest;
import com.ghatana.stt.core.grpc.proto.ListModelsRequest;
import com.ghatana.stt.core.grpc.proto.LoadModelRequest;
import com.ghatana.stt.core.grpc.proto.HealthStatus;
import com.ghatana.stt.core.grpc.proto.StatusRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.ghatana.stt.core.grpc.proto.UnloadModelRequest;
import com.ghatana.stt.core.grpc.proto.UpdateProfileRequest;
import com.ghatana.stt.service.SttAudioInputDecoder;
import com.google.protobuf.ByteString;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.ServerBuilder;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.stub.MetadataUtils;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * @doc.type class
 * @doc.purpose In-process gRPC integration coverage for STT service contract
 * @doc.layer product
 * @doc.pattern Integration Test
 */
@DisplayName("SttGrpcService In-Process Integration")
class SttGrpcServiceInProcessIntegrationTest {

    private Server server;
    private ManagedChannel channel;
    private String previousJwtSecret;
    private Metadata authenticatedHeaders;
    private AudioVideoLibrary library;
    private SttEngine engine;
    private ProductionSttGrpcService productionService;
    private java.util.concurrent.atomic.AtomicReference<SttRequestAuthorization.Decision> authorizationDecision;

    @AfterEach
    void tearDown() {
        if (channel != null) {
            channel.shutdownNow();
        }
        if (server != null) {
            server.shutdownNow();
        }
        if (productionService != null) productionService.close();
        if (previousJwtSecret == null) System.clearProperty("AV_JWT_SECRET");
        else System.setProperty("AV_JWT_SECRET", previousJwtSecret);
    }

    @BeforeEach
    void setUp() throws Exception {
        previousJwtSecret = System.getProperty("AV_JWT_SECRET");
        String secret = "stt-inprocess-service-test-secret";
        System.setProperty("AV_JWT_SECRET", secret);
        library = mock(AudioVideoLibrary.class);
        engine = mock(SttEngine.class);

        when(library.getSttEngine()).thenReturn(engine);
        when(engine.transcribe(any(AudioData.class), any())).thenReturn(
            new TranscriptionResult(
                "hello in-process",
                0.93,
                Collections.emptyList(),
                Collections.emptyList(),
                Duration.ofMillis(40),
                "en",
                "whisper-base"
            )
        );

        authorizationDecision = new java.util.concurrent.atomic.AtomicReference<>(SttRequestAuthorization.Decision.ADMITTED);
        SttRequestAuthorization fixtureAuthorization = request -> {
            boolean exactOwner = request.identity().tenantId().equals("tenant-stt-matrix")
                    && request.identity().subject().equals("00000000-0000-0000-0000-000000000001");
            boolean exactResource = request.resourceId() == null
                    || request.resourceId().equals("artifact-owned-by-fixture");
            return exactOwner && exactResource
                    ? authorizationDecision.get() : SttRequestAuthorization.Decision.DENIED;
        };
        productionService = new ProductionSttGrpcService(library, new SimpleMeterRegistry(), fixtureAuthorization);

        server = ServerBuilder.forPort(0)
            .maxInboundMessageSize(SttGrpcServer.MAX_INBOUND_MESSAGE_SIZE)
            .directExecutor()
            .addService(productionService)
            .intercept(new JwtServerInterceptor())
            .build()
            .start();

        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort())
            .usePlaintext()
            .directExecutor()
            .build();
        authenticatedHeaders = new Metadata();
        authenticatedHeaders.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                "Bearer " + testJwt(secret));
    }

    @Test
    @DisplayName("transcribe returns expected response over gRPC transport")
    void transcribeOverGrpc() {
        STTServiceGrpc.STTServiceBlockingStub stub = authenticatedBlockingStub();

        TranscribeResponse response = stub.transcribe(
            TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[]{0x01, 0x02, 0x03, 0x04}))
                .setSampleRate(16000)
                .setArtifactId("artifact-owned-by-fixture")
                .build()
        );

        assertThat(response.getText()).isEqualTo("hello in-process");
        assertThat(response.getConfidence()).isEqualTo(0.93f);
        assertThat(response.getModelUsed()).isEqualTo("whisper-base");
    }

    @Test
    @DisplayName("trusted STT authorization denies, revokes and admits only the verified owner before provider dispatch")
    void trustedAuthorizationFencesProviderDispatch() throws Exception {
        STTServiceGrpc.STTServiceBlockingStub stub = authenticatedBlockingStub();
        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1, 2, 3, 4}))
                .setSampleRate(16_000)
                .setArtifactId("artifact-owned-by-fixture")
                // These legacy caller fields must never establish authority.
                .setTenantId("attacker-tenant")
                .setConsentStatus("APPROVED")
                .build();

        authorizationDecision.set(SttRequestAuthorization.Decision.DENIED);
        assertThatThrownBy(() -> stub.transcribe(request))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(error -> assertThat(((StatusRuntimeException) error).getStatus().getCode())
                        .isEqualTo(Status.Code.PERMISSION_DENIED));
        verify(library, never()).getSttEngine();

        authorizationDecision.set(SttRequestAuthorization.Decision.REVOKED);
        assertThatThrownBy(() -> stub.transcribe(request))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(error -> assertThat(((StatusRuntimeException) error).getStatus().getDescription())
                        .contains("STT_RIGHTS_REVOKED"));
        verify(library, never()).getSttEngine();

        authorizationDecision.set(SttRequestAuthorization.Decision.ADMITTED);
        TranscribeResponse result = stub.transcribe(request);
        assertThat(result.getText()).isEqualTo("hello in-process");
        verify(library).getSttEngine();
    }

    @Test
    @DisplayName("cross-tenant verified identity is denied before provider dispatch")
    void crossTenantIdentityIsDeniedBeforeProviderDispatch() throws Exception {
        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                "Bearer " + testJwt(System.getProperty("AV_JWT_SECRET"), "other-tenant"));
        var stub = STTServiceGrpc.newBlockingStub(channel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));
        assertThatThrownBy(() -> stub.transcribe(TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1, 2, 3, 4}))
                .setSampleRate(16_000).setArtifactId("artifact-owned-by-fixture").build()))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(error -> assertThat(((StatusRuntimeException) error).getStatus().getCode())
                        .isEqualTo(Status.Code.PERMISSION_DENIED));
        verify(library, never()).getSttEngine();
    }

    @Test
    @DisplayName("stream authorization denial is returned before accepting chunks or creating a provider session")
    void streamAuthorizationDenialPrecedesProviderSession() throws Exception {
        authorizationDecision.set(SttRequestAuthorization.Decision.REVOKED);
        java.util.concurrent.CountDownLatch terminal = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicReference<Throwable> error = new java.util.concurrent.atomic.AtomicReference<>();
        authenticatedAsyncStub().streamTranscribe(new io.grpc.stub.StreamObserver<>() {
            @Override public void onNext(com.ghatana.stt.core.grpc.proto.Transcription value) { }
            @Override public void onError(Throwable failure) { error.set(failure); terminal.countDown(); }
            @Override public void onCompleted() { terminal.countDown(); }
        });
        assertThat(terminal.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(error.get()).isInstanceOf(StatusRuntimeException.class)
                .matches(failure -> Status.fromThrowable(failure).getCode() == Status.Code.PERMISSION_DENIED)
                .hasMessageContaining("STT_RIGHTS_REVOKED");
        verify(library, never()).getSttEngine();
    }

    @Test
    @DisplayName("authenticated oversized transcribe request is rejected before engine access")
    void oversizedTranscribeIsRejectedBeforeEngineAccess() {
        STTServiceGrpc.STTServiceBlockingStub stub = authenticatedBlockingStub();
        byte[] oversizedAudio = new byte[SttGrpcServer.MAX_INBOUND_MESSAGE_SIZE + 1];
        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(oversizedAudio))
                .setSampleRate(16000)
                .build();

        assertThatThrownBy(() -> stub.transcribe(request))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(failure -> assertThat(((StatusRuntimeException) failure).getStatus().getCode())
                        .isEqualTo(Status.Code.RESOURCE_EXHAUSTED));

        verify(library, never()).getSttEngine();
    }

    @Test
    @DisplayName("audio content above 4 MiB is rejected inside the bounded protobuf envelope")
    void audioPayloadAboveDecoderLimitIsRejectedBeforeEngineAccess() {
        byte[] oversizedAudio = new byte[Math.toIntExact(SttAudioInputDecoder.MAX_INPUT_BYTES + 1)];
        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(oversizedAudio))
                .setSampleRate(16_000)
                .build();

        assertThatThrownBy(() -> authenticatedBlockingStub().transcribe(request))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(failure -> assertThat(((StatusRuntimeException) failure).getStatus().getCode())
                        .isEqualTo(Status.Code.RESOURCE_EXHAUSTED));
        verify(library, never()).getSttEngine();
    }

    @Test
    @DisplayName("4 MiB audio payload fits within the bounded protobuf envelope")
    void maximumAudioPayloadFitsTransportEnvelope() {
        byte[] maxAudioPayload = new byte[Math.toIntExact(SttAudioInputDecoder.MAX_INPUT_BYTES)];
        TranscribeResponse response = authenticatedBlockingStub().transcribe(TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(maxAudioPayload))
                .setSampleRate(16_000)
                .build());

        assertThat(response.getText()).isEqualTo("hello in-process");
        verify(library).getSttEngine();
    }

    @Test
    @DisplayName("transcribe validates empty audio and returns INVALID_ARGUMENT")
    void transcribeEmptyAudioReturnsInvalidArgument() {
        STTServiceGrpc.STTServiceBlockingStub stub = authenticatedBlockingStub();

        assertThatThrownBy(() -> stub.transcribe(
            TranscribeRequest.newBuilder().setAudioData(ByteString.EMPTY).build()
        ))
            .isInstanceOf(StatusRuntimeException.class)
            .matches(ex -> ((StatusRuntimeException) ex).getStatus().getCode() == Status.INVALID_ARGUMENT.getCode());
    }

    @Test
    @DisplayName("unloadModel does not report success when engine has no unload operation")
    void unloadModelReturnsUnimplementedOverGrpc() throws Exception {
        SttEngine engine = mock(SttEngine.class);
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        when(library.getSttEngine()).thenReturn(engine);
        when(engine.getAvailableModels()).thenReturn(List.of(new ModelInfo(
            "whisper-base", "Whisper Base", "1.0", new Locale[]{Locale.ENGLISH}, 10L, false)));

        // Authorization is a test fixture; no provider effect is admitted.
        Server replacement = ServerBuilder.forPort(0)
            .directExecutor()
            .addService(new SttGrpcService(library, new SimpleMeterRegistry(),
                    (SttRequestAuthorization) (request -> SttRequestAuthorization.Decision.ADMITTED)))
            .intercept(new JwtServerInterceptor())
            .build()
            .start();
        ManagedChannel replacementChannel = ManagedChannelBuilder.forAddress("localhost", replacement.getPort())
            .usePlaintext()
            .directExecutor()
            .build();
        try {
            Metadata headers = new Metadata();
            headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                    "Bearer " + testJwt(System.getProperty("AV_JWT_SECRET")));
            STTServiceGrpc.newBlockingStub(replacementChannel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers)).unloadModel(
                UnloadModelRequest.newBuilder().setModelId("whisper-base").build());
        } catch (StatusRuntimeException failure) {
            assertThat(failure.getStatus().getCode()).isEqualTo(Status.UNIMPLEMENTED.getCode());
            return;
        } finally {
            replacementChannel.shutdownNow();
            replacement.shutdownNow();
        }
        throw new AssertionError("unloadModel must not report success without an engine unload operation");
    }

    @Test
    @DisplayName("healthCheck stays unhealthy over gRPC until composition supplies readiness checks")
    void healthCheckDoesNotReportStubEngineReadyOverGrpc() {
        var response = authenticatedBlockingStub()
            .healthCheck(HealthCheckRequest.getDefaultInstance());

        assertThat(response.getStatus()).isEqualTo(HealthStatus.HEALTH_STATUS_UNHEALTHY);
        assertThat(response.getMessage()).isEqualTo("STT_NOT_SERVING: provider readiness unavailable");
    }

    @Test
    @DisplayName("authentication interceptor rejects all twelve STT RPCs when bearer identity is missing")
    void missingBearerTokenIsRejectedForEveryRpc() throws Exception {
        String previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", "stt-test-only-secret-not-used-to-sign-tokens");
        AudioVideoLibrary guardedLibrary = mock(AudioVideoLibrary.class);
        ProductionSttGrpcService productionService = new ProductionSttGrpcService(
                guardedLibrary, new SimpleMeterRegistry());
        Server securedServer;
        try {
            securedServer = ServerBuilder.forPort(0)
                .directExecutor()
                .addService(productionService)
                .intercept(new JwtServerInterceptor())
                .build()
                .start();
        } finally {
            if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
            else System.setProperty("AV_JWT_SECRET", previousSecret);
        }
        ManagedChannel securedChannel = ManagedChannelBuilder.forAddress("localhost", securedServer.getPort())
            .usePlaintext()
            .directExecutor()
            .build();
        try {
            STTServiceGrpc.STTServiceBlockingStub stub = STTServiceGrpc.newBlockingStub(securedChannel);
            assertUnauthenticated(() -> stub.transcribe(TranscribeRequest.getDefaultInstance()));
            assertUnauthenticated(() -> stub.loadModel(LoadModelRequest.getDefaultInstance()));
            assertUnauthenticated(() -> stub.unloadModel(UnloadModelRequest.getDefaultInstance()));
            assertUnauthenticated(() -> stub.listModels(ListModelsRequest.getDefaultInstance()));
            assertUnauthenticated(() -> stub.adaptModel(AdaptRequest.getDefaultInstance()));
            assertUnauthenticated(() -> stub.getStatus(StatusRequest.getDefaultInstance()));
            assertUnauthenticated(() -> stub.healthCheck(HealthCheckRequest.getDefaultInstance()));
            assertUnauthenticated(() -> stub.createProfile(CreateProfileRequest.getDefaultInstance()));
            assertUnauthenticated(() -> stub.getProfile(GetProfileRequest.getDefaultInstance()));
            assertUnauthenticated(() -> stub.updateProfile(UpdateProfileRequest.getDefaultInstance()));
            assertUnauthenticated(() -> stub.submitCorrection(CorrectionRequest.getDefaultInstance()));

            CountDownLatch streamDone = new CountDownLatch(1);
            AtomicReference<Throwable> streamFailure = new AtomicReference<>();
            var requestObserver = STTServiceGrpc.newStub(securedChannel).streamTranscribe(new io.grpc.stub.StreamObserver<>() {
                @Override public void onNext(com.ghatana.stt.core.grpc.proto.Transcription value) { }
                @Override public void onError(Throwable failure) { streamFailure.set(failure); streamDone.countDown(); }
                @Override public void onCompleted() { streamDone.countDown(); }
            });
            requestObserver.onNext(AudioChunk.getDefaultInstance());
            requestObserver.onCompleted();
            assertThat(streamDone.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(streamFailure.get()).isInstanceOf(StatusRuntimeException.class);
            assertThat(((StatusRuntimeException) streamFailure.get()).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
            verifyNoInteractions(guardedLibrary);
        } finally {
            securedChannel.shutdownNow();
            securedServer.shutdownNow();
            productionService.close();
        }
    }

    @Test
    @DisplayName("authenticated production composition covers all twelve RPC outcomes without fabricated effects")
    void authenticatedProductionCompositionCoversTwelveRpcOutcomes() throws Exception {
        String secret = "stt-inprocess-production-matrix-test-secret";
        String previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", secret);

        AudioVideoLibrary guardedLibrary = mock(AudioVideoLibrary.class);
        SttEngine statusFixture = mock(SttEngine.class);
        when(guardedLibrary.getSttEngine()).thenReturn(statusFixture);
        when(statusFixture.getStatus()).thenReturn(
                new EngineStatus(EngineStatus.State.ERROR, null, null, 0L, "fixture-only unavailable status"));
        when(statusFixture.getAvailableModels()).thenReturn(List.of());
        when(statusFixture.getActiveModel()).thenReturn(null);
        org.mockito.Mockito.doThrow(new ModelLoadingError("model marker missing", null))
                .when(statusFixture).loadModel("unknown-model");

        ProductionSttGrpcService productionService = new ProductionSttGrpcService(
                guardedLibrary, new SimpleMeterRegistry(),
                (SttRequestAuthorization) (request -> SttRequestAuthorization.Decision.ADMITTED));
        Server securedServer = null;
        ManagedChannel securedChannel = null;
        try {
            String serverName = InProcessServerBuilder.generateName();
            securedServer = InProcessServerBuilder.forName(serverName)
                    .directExecutor()
                    .addService(productionService)
                    .intercept(new JwtServerInterceptor())
                    .build()
                    .start();
            securedChannel = InProcessChannelBuilder.forName(serverName).directExecutor().build();

            Metadata headers = new Metadata();
            headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                    "Bearer " + testJwt(secret));
            STTServiceGrpc.STTServiceBlockingStub stub = STTServiceGrpc.newBlockingStub(securedChannel)
                    .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));

            assertRpcError(() -> stub.transcribe(TranscribeRequest.getDefaultInstance()),
                    Status.Code.INVALID_ARGUMENT, "Invalid audio input");
            assertRpcError(() -> stub.loadModel(LoadModelRequest.newBuilder()
                            .setModelId("unknown-model").build()),
                    Status.Code.NOT_FOUND, "Model not found or cannot be loaded");
            assertRpcError(() -> stub.unloadModel(UnloadModelRequest.getDefaultInstance()),
                    Status.Code.UNIMPLEMENTED, "Model unload is not supported");

            var models = stub.listModels(ListModelsRequest.getDefaultInstance());
            assertThat(models.getModelsCount()).isZero();
            assertThat(models.getTotalCount()).isZero();
            assertThat(stub.getStatus(StatusRequest.getDefaultInstance()).getActiveModel()).isEmpty();
            assertThat(stub.healthCheck(HealthCheckRequest.getDefaultInstance()).getStatus())
                    .isEqualTo(HealthStatus.HEALTH_STATUS_UNHEALTHY);

            assertRpcError(() -> stub.adaptModel(AdaptRequest.getDefaultInstance()),
                    Status.Code.FAILED_PRECONDITION, "STT_ADAPTATION_NOT_ADMITTED:");
            assertRpcError(() -> stub.createProfile(CreateProfileRequest.getDefaultInstance()),
                    Status.Code.FAILED_PRECONDITION, "STT_SPEAKER_PROFILE_NOT_ADMITTED:");
            assertRpcError(() -> stub.getProfile(GetProfileRequest.getDefaultInstance()),
                    Status.Code.FAILED_PRECONDITION, "STT_SPEAKER_PROFILE_NOT_ADMITTED:");
            assertRpcError(() -> stub.updateProfile(UpdateProfileRequest.getDefaultInstance()),
                    Status.Code.FAILED_PRECONDITION, "STT_SPEAKER_PROFILE_NOT_ADMITTED:");
            assertRpcError(() -> stub.submitCorrection(CorrectionRequest.getDefaultInstance()),
                    Status.Code.FAILED_PRECONDITION, "STT_CORRECTION_NOT_ADMITTED:");

            assertStreamError(securedChannel, headers, Status.Code.FAILED_PRECONDITION,
                    "STT_STREAM_SESSION_NOT_ADMITTED:");

            verify(statusFixture, never()).transcribe(any(AudioData.class), any());
            verify(statusFixture, never()).createProfile(any(), any());
            verify(statusFixture, never()).saveProfile(any());
            verify(statusFixture, never()).deleteProfile(any());
            verify(statusFixture, never()).createStreamingSession();
        } finally {
            if (securedChannel != null) securedChannel.shutdownNow();
            if (securedServer != null) securedServer.shutdownNow();
            productionService.close();
            if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
            else System.setProperty("AV_JWT_SECRET", previousSecret);
        }
    }

    private static void assertStreamError(
            ManagedChannel channel,
            Metadata headers,
            Status.Code expectedCode,
            String description) throws Exception {
        STTServiceGrpc.STTServiceStub stub = STTServiceGrpc.newStub(channel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));
        CountDownLatch terminal = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        AtomicReference<Integer> emitted = new AtomicReference<>(0);
        var requestObserver = stub.streamTranscribe(new io.grpc.stub.StreamObserver<>() {
            @Override public void onNext(com.ghatana.stt.core.grpc.proto.Transcription value) {
                emitted.updateAndGet(count -> count + 1);
            }
            @Override public void onError(Throwable error) { failure.set(error); terminal.countDown(); }
            @Override public void onCompleted() { terminal.countDown(); }
        });
        requestObserver.onNext(AudioChunk.getDefaultInstance());
        requestObserver.onCompleted();
        assertThat(terminal.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(emitted.get()).isZero();
        assertThat(failure.get()).isInstanceOf(StatusRuntimeException.class);
        assertThat(Status.fromThrowable(failure.get()).getCode()).isEqualTo(expectedCode);
        assertThat(Status.fromThrowable(failure.get()).getDescription()).contains(description);
    }

    private STTServiceGrpc.STTServiceBlockingStub authenticatedBlockingStub() {
        return STTServiceGrpc.newBlockingStub(channel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(authenticatedHeaders));
    }

    private STTServiceGrpc.STTServiceStub authenticatedAsyncStub() {
        return STTServiceGrpc.newStub(channel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(authenticatedHeaders));
    }

    private static void assertRpcError(
            org.assertj.core.api.ThrowableAssert.ThrowingCallable rpc,
            Status.Code expectedCode,
            String description) {
        assertThatThrownBy(rpc)
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(error -> {
                    StatusRuntimeException statusError = (StatusRuntimeException) error;
                    assertThat(statusError.getStatus().getCode()).isEqualTo(expectedCode);
                    assertThat(statusError.getStatus().getDescription()).contains(description);
                });
    }

    private static String testJwt(String secret) throws Exception {
        return testJwt(secret, "tenant-stt-matrix");
    }

    private static String testJwt(String secret, String tenant) throws Exception {
        String header = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String payload = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("{\"sub\":\"00000000-0000-0000-0000-000000000001\",\"tenantId\":\"" + tenant + "\",\"exp\":"
                        + (System.currentTimeMillis() / 1000 + 3600) + "}")
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String unsigned = header + "." + payload;
        javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
        mac.init(new javax.crypto.spec.SecretKeySpec(secret.getBytes(java.nio.charset.StandardCharsets.UTF_8), "HmacSHA256"));
        return unsigned + "." + java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(unsigned.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    private static void assertUnauthenticated(org.assertj.core.api.ThrowableAssert.ThrowingCallable call) {
        assertThatThrownBy(call)
            .isInstanceOf(StatusRuntimeException.class)
            .matches(failure -> ((StatusRuntimeException) failure).getStatus().getCode()
                == Status.UNAUTHENTICATED.getCode());
    }
}
