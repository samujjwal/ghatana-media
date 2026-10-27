package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.tts.core.grpc.proto.AudioChunk;
import com.ghatana.tts.core.grpc.proto.CloneVoiceRequest;
import com.ghatana.tts.core.grpc.proto.CreateProfileRequest;
import com.ghatana.tts.core.grpc.proto.FeedbackRequest;
import com.ghatana.tts.core.grpc.proto.GetProfileRequest;
import com.ghatana.tts.core.grpc.proto.GetVoicesRequest;
import com.ghatana.tts.core.grpc.proto.LoadVoiceRequest;
import com.ghatana.tts.core.grpc.proto.MetricsRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.TTSServiceGrpc;
import com.ghatana.tts.core.grpc.proto.UpdateProfileRequest;
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

import java.util.List;
import java.util.Map;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;

/**
 * @doc.type class
 * @doc.purpose In-process gRPC integration coverage for TTS service contract
 * @doc.layer product
 * @doc.pattern Integration Test
 */
@DisplayName("TtsGrpcService In-Process Integration")
class TtsGrpcServiceInProcessIntegrationTest {

    private Server server;
    private ManagedChannel channel;

    @AfterEach
    void tearDown() {
        if (channel != null) {
            channel.shutdownNow();
        }
        if (server != null) {
            server.shutdownNow();
        }
    }

    @BeforeEach
    void setUp() throws Exception {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);

        TtsGrpcService service = new TtsGrpcService(library, new SimpleMeterRegistry());

        server = ServerBuilder.forPort(0)
            .directExecutor()
            .addService(service)
            .build()
            .start();

        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort())
            .usePlaintext()
            .directExecutor()
            .build();
    }

    @Test
    @DisplayName("synthesize reports NOT_ADMITTED over gRPC without an exact voice-rights profile")
    void synthesizeNotAdmittedOverGrpc() {
        TTSServiceGrpc.TTSServiceBlockingStub stub = TTSServiceGrpc.newBlockingStub(channel);

        assertThatThrownBy(() -> stub.synthesize(SynthesizeRequest.newBuilder().setText("hello world").build()))
                .isInstanceOf(StatusRuntimeException.class)
                .matches(ex -> ((StatusRuntimeException) ex).getStatus().getCode() == Status.UNAVAILABLE.getCode())
                .hasMessageContaining("TTS_NOT_ADMITTED");
    }

    @Test
    @DisplayName("synthesize validates blank text and returns INVALID_ARGUMENT")
    void synthesizeBlankTextReturnsInvalidArgument() {
        TTSServiceGrpc.TTSServiceBlockingStub stub = TTSServiceGrpc.newBlockingStub(channel);

        assertThatThrownBy(() -> stub.synthesize(SynthesizeRequest.newBuilder().setText("").build()))
            .isInstanceOf(StatusRuntimeException.class)
            .matches(ex -> ((StatusRuntimeException) ex).getStatus().getCode() == Status.INVALID_ARGUMENT.getCode());
    }

    @Test
    @DisplayName("server JWT interceptor rejects missing credentials before TTS dispatch")
    void missingBearerCredentialIsRejectedBeforeServiceDispatch() throws Exception {
        String previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", "tts-test-secret-for-unsigned-request-check");
        AudioVideoLibrary guardedLibrary = mock(AudioVideoLibrary.class);
        TtsGrpcService guardedService = new TtsGrpcService(guardedLibrary, new SimpleMeterRegistry());
        Server guardedServer = null;
        ManagedChannel guardedChannel = null;
        try {
            guardedServer = ServerBuilder.forPort(0)
                    .directExecutor()
                    .intercept(new JwtServerInterceptor())
                    .addService(guardedService)
                    .build()
                    .start();
            guardedChannel = ManagedChannelBuilder.forAddress("localhost", guardedServer.getPort())
                    .usePlaintext()
                    .directExecutor()
                    .build();
            ManagedChannel requestChannel = guardedChannel;

            assertThatThrownBy(() -> TTSServiceGrpc.newBlockingStub(requestChannel)
                    .getVoices(com.ghatana.tts.core.grpc.proto.GetVoicesRequest.getDefaultInstance()))
                    .isInstanceOf(StatusRuntimeException.class)
                    .matches(ex -> ((StatusRuntimeException) ex).getStatus().getCode()
                            == Status.UNAUTHENTICATED.getCode());
            verifyNoInteractions(guardedLibrary);
        } finally {
            if (guardedChannel != null) guardedChannel.shutdownNow();
            if (guardedServer != null) guardedServer.shutdownNow();
            if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
            else System.setProperty("AV_JWT_SECRET", previousSecret);
        }
    }

    @Test
    @DisplayName("authenticated stream fails closed over gRPC without emitting chunks or looking up provider")
    void authenticatedStreamingNotAdmittedEmitsNoChunksOverGrpc() throws Exception {
        String secret = "tts-inprocess-stream-test-secret";
        String previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", secret);
        AudioVideoLibrary guardedLibrary = mock(AudioVideoLibrary.class);
        Server guardedServer = null;
        ManagedChannel guardedChannel = null;
        try {
            String serverName = InProcessServerBuilder.generateName();
            PersistentTtsGrpcService persistentService = new PersistentTtsGrpcService(
                    guardedLibrary, mock(AudioFileService.class), new SimpleMeterRegistry());
            guardedServer = InProcessServerBuilder.forName(serverName)
                    .directExecutor()
                    .addService(persistentService)
                    .intercept(new JwtServerInterceptor())
                    .build()
                    .start();
            guardedChannel = InProcessChannelBuilder.forName(serverName).directExecutor().build();

            Metadata headers = new Metadata();
            headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                    "Bearer " + testJwt(secret));
            var stub = TTSServiceGrpc.newStub(guardedChannel).withInterceptors(
                    MetadataUtils.newAttachHeadersInterceptor(headers));
            java.util.List<AudioChunk> chunks = new java.util.ArrayList<>();
            java.util.concurrent.CountDownLatch terminal = new java.util.concurrent.CountDownLatch(1);
            java.util.concurrent.atomic.AtomicReference<Throwable> failure =
                    new java.util.concurrent.atomic.AtomicReference<>();

            stub.streamSynthesize(com.ghatana.tts.core.grpc.proto.SynthesizeRequest.newBuilder()
                    .setText("hello")
                    .build(), new io.grpc.stub.StreamObserver<>() {
                @Override public void onNext(AudioChunk value) { chunks.add(value); }
                @Override public void onError(Throwable error) {
                    failure.set(error);
                    terminal.countDown();
                }
                @Override public void onCompleted() { terminal.countDown(); }
            });

            assertThat(terminal.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            assertThat(chunks).isEmpty();
            assertThat(failure.get()).isInstanceOf(StatusRuntimeException.class);
            assertThat(Status.fromThrowable(failure.get()).getCode()).isEqualTo(Status.Code.UNAVAILABLE);
            assertThat(Status.fromThrowable(failure.get()).getDescription()).contains("TTS_NOT_ADMITTED");

            verifyNoInteractions(guardedLibrary);
        } finally {
            if (guardedChannel != null) guardedChannel.shutdownNow();
            if (guardedServer != null) guardedServer.shutdownNow();
            if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
            else System.setProperty("AV_JWT_SECRET", previousSecret);
        }
    }

    @Test
    @DisplayName("injected request authorization denies and revokes before provider lookup")
    void injectedProductionAuthorizationBlocksUnaryAndStreamingEffects() throws Exception {
        String secret = "tts-injected-authorization-test-secret";
        String previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", secret);
        Path model = Files.createTempFile(Path.of(".").toAbsolutePath().normalize(), "tts-auth-fixture", ".onnx");
        AudioVideoLibrary guardedLibrary = mock(AudioVideoLibrary.class);
        TtsEngine engine = mock(TtsEngine.class);
        when(guardedLibrary.getTtsEngine()).thenReturn(engine);
        Server guardedServer = null;
        ManagedChannel guardedChannel = null;
        ProductionTtsGrpcService service = null;
        try {
            Files.writeString(model, "local authorization fixture model bytes");
            Files.writeString(Path.of(model.toString() + ".json"),
                    "{\"phoneme_id_map\":{\"^\":[1],\"$\":[2],\"_\":[0]}}\n");
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(Files.readAllBytes(model)));
            Map<String, String> environment = Map.ofEntries(
                    Map.entry("TTS_PROVIDER_MODE", "LOCAL_ONNX"),
                    Map.entry("TTS_MODEL_ID", "fixture-model"),
                    Map.entry("TTS_MODEL_VERSION", "fixture-version"),
                    Map.entry("TTS_MODEL_SHA256", digest),
                    Map.entry("TTS_MODEL_LICENSE", "test-fixture-placeholder"),
                    Map.entry("TTS_MODEL_LANGUAGE", "en-US"),
                    Map.entry("TTS_MODEL_REGION", "test-fixture-region"),
                    Map.entry("TTS_MODEL_RETENTION", "test-fixture-placeholder"),
                    Map.entry("TTS_MODEL_HARDWARE", "test-fixture-hardware"),
                    Map.entry("TTS_MODEL_PATH", model.toString()),
                    Map.entry("TTS_DEFAULT_VOICE", "voice-selected-by-request"));
            TtsProviderAdmission providerFixture = candidate -> new TtsProviderAdmission.Decision(
                    java.util.Set.of(TtsProviderAdmission.Capability.SYNTHESIS,
                            TtsProviderAdmission.Capability.PCM_STREAMING),
                    "local-fixture-resolver:test-only", "controlled test fixture");
            java.util.List<TtsRequestAuthorization.Request> requests = new java.util.concurrent.CopyOnWriteArrayList<>();
            TtsRequestAuthorization requestResolver = request -> {
                requests.add(request);
                if ("piper-en".equals(request.voiceId())) {
                    return TtsRequestAuthorization.Decision.UNAVAILABLE;
                }
                return request.operation() == TtsRequestAuthorization.Operation.SYNTHESIZE
                        ? TtsRequestAuthorization.Decision.REVOKED
                        : TtsRequestAuthorization.Decision.DENIED;
            };
            service = new ProductionTtsGrpcService(environment, new SimpleMeterRegistry(),
                    providerFixture, requestResolver, (TtsConfig ignored) -> guardedLibrary);
            org.mockito.Mockito.clearInvocations(guardedLibrary, engine);

            String serverName = InProcessServerBuilder.generateName();
            guardedServer = InProcessServerBuilder.forName(serverName)
                    .directExecutor()
                    .addService(service)
                    .intercept(new JwtServerInterceptor())
                    .build()
                    .start();
            guardedChannel = InProcessChannelBuilder.forName(serverName).directExecutor().build();
            Metadata headers = new Metadata();
            headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                    "Bearer " + testJwt(secret));
            TTSServiceGrpc.TTSServiceBlockingStub blockingStub = TTSServiceGrpc.newBlockingStub(guardedChannel)
                    .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));
            SynthesizeRequest request = SynthesizeRequest.newBuilder().setText("authorization fixture")
                    .setVoiceId("voice-selected-by-request").build();

            assertRpcError(() -> blockingStub.synthesize(request), Status.Code.PERMISSION_DENIED,
                    "TTS_VOICE_AUTH_REVOKED");
            assertStreamErrorWithoutChunks(TTSServiceGrpc.newStub(guardedChannel)
                    .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers)), request,
                    Status.Code.PERMISSION_DENIED, "TTS_VOICE_AUTH_DENIED");
            assertRpcError(() -> blockingStub.synthesize(SynthesizeRequest.newBuilder()
                            .setText("default voice authorization fixture").build()),
                    Status.Code.PERMISSION_DENIED, "TTS_VOICE_AUTH_REVOKED");

            assertThat(requests).extracting(TtsRequestAuthorization.Request::operation)
                    .containsExactly(TtsRequestAuthorization.Operation.SYNTHESIZE,
                            TtsRequestAuthorization.Operation.STREAM_SYNTHESIZE,
                            TtsRequestAuthorization.Operation.SYNTHESIZE);
            assertThat(requests).extracting(TtsRequestAuthorization.Request::voiceId)
                    .containsExactly("voice-selected-by-request", "voice-selected-by-request",
                            "voice-selected-by-request");
            assertThat(requests).allSatisfy(observed -> {
                assertThat(observed.identity().tenantId()).isEqualTo("tenant-test");
            });
            verifyNoInteractions(guardedLibrary, engine);
        } finally {
            if (guardedChannel != null) guardedChannel.shutdownNow();
            if (guardedServer != null) guardedServer.shutdownNow();
            if (service != null) service.close();
            Files.deleteIfExists(Path.of(model.toString() + ".json"));
            Files.deleteIfExists(model);
            if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
            else System.setProperty("AV_JWT_SECRET", previousSecret);
        }
    }

    @Test
    @DisplayName("authenticated credential tenant remains authoritative over conflicting request tenant metadata")
    void credentialTenantMismatchCannotReachProviderOrPersistence() throws Exception {
        String secret = "tts-inprocess-tenant-mismatch-secret";
        String previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", secret);
        AudioVideoLibrary guardedLibrary = mock(AudioVideoLibrary.class);
        AudioFileService guardedAudioFiles = mock(AudioFileService.class);
        Server guardedServer = null;
        ManagedChannel guardedChannel = null;
        try {
            String serverName = InProcessServerBuilder.generateName();
            PersistentTtsGrpcService persistentService = new PersistentTtsGrpcService(
                    guardedLibrary, guardedAudioFiles, new SimpleMeterRegistry());
            guardedServer = InProcessServerBuilder.forName(serverName)
                    .directExecutor()
                    .addService(persistentService)
                    .intercept(new JwtServerInterceptor())
                    .build()
                    .start();
            guardedChannel = InProcessChannelBuilder.forName(serverName).directExecutor().build();

            Metadata headers = new Metadata();
            headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                    "Bearer " + testJwt(secret, "tenant-from-credential"));
            TTSServiceGrpc.TTSServiceBlockingStub stub = TTSServiceGrpc.newBlockingStub(guardedChannel)
                    .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));

            assertRpcError(() -> stub.synthesize(SynthesizeRequest.newBuilder()
                            .setText("hello")
                            .setTenantId("tenant-claimed-by-request")
                            .build()),
                    Status.Code.UNAVAILABLE, "TTS_NOT_ADMITTED");

            verifyNoInteractions(guardedLibrary, guardedAudioFiles);
        } finally {
            if (guardedChannel != null) guardedChannel.shutdownNow();
            if (guardedServer != null) guardedServer.shutdownNow();
            if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
            else System.setProperty("AV_JWT_SECRET", previousSecret);
        }
    }

    @Test
    @DisplayName("authenticated transport covers all eleven RPC dispositions without unsupported effects")
    void authenticatedTransportCoversAllRpcDispositions() throws Exception {
        String secret = "tts-inprocess-rpc-matrix-test-secret";
        String previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", secret);
        AudioVideoLibrary guardedLibrary = mock(AudioVideoLibrary.class);
        TtsEngine engine = mock(TtsEngine.class);
        when(guardedLibrary.getTtsEngine()).thenReturn(engine);
        when(engine.getAvailableVoices()).thenReturn(List.of());
        Server guardedServer = null;
        ManagedChannel guardedChannel = null;
        try {
            String serverName = InProcessServerBuilder.generateName();
            guardedServer = InProcessServerBuilder.forName(serverName)
                    .directExecutor()
                    .addService(new TtsGrpcService(guardedLibrary, new SimpleMeterRegistry()))
                    .intercept(new JwtServerInterceptor())
                    .build()
                    .start();
            guardedChannel = InProcessChannelBuilder.forName(serverName).directExecutor().build();

            Metadata headers = new Metadata();
            headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                    "Bearer " + testJwt(secret));
            TTSServiceGrpc.TTSServiceBlockingStub stub = TTSServiceGrpc.newBlockingStub(guardedChannel)
                    .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));

            assertRpcError(() -> stub.synthesize(SynthesizeRequest.newBuilder().setText("hello").build()),
                    Status.Code.UNAVAILABLE, "TTS_NOT_ADMITTED");
            assertRpcError(() -> stub.getStatus(com.ghatana.tts.core.grpc.proto.StatusRequest.getDefaultInstance()),
                    Status.Code.UNIMPLEMENTED, "GetStatus is NOT_ADMITTED");
            assertRpcError(() -> stub.getMetrics(MetricsRequest.getDefaultInstance()),
                    Status.Code.UNIMPLEMENTED, "GetMetrics is NOT_ADMITTED");

            assertThat(stub.getVoices(GetVoicesRequest.getDefaultInstance()).getVoicesList()).isEmpty();

            assertRpcError(() -> stub.loadVoice(LoadVoiceRequest.newBuilder().setVoiceId("voice-marker").build()),
                    Status.Code.UNIMPLEMENTED, "Voice loading is NOT_ADMITTED");
            assertRpcError(() -> stub.createProfile(CreateProfileRequest.getDefaultInstance()),
                    Status.Code.UNIMPLEMENTED, "TTS profile access is NOT_ADMITTED");
            assertRpcError(() -> stub.getProfile(GetProfileRequest.getDefaultInstance()),
                    Status.Code.UNIMPLEMENTED, "TTS profile access is NOT_ADMITTED");
            assertRpcError(() -> stub.updateProfile(UpdateProfileRequest.getDefaultInstance()),
                    Status.Code.UNIMPLEMENTED, "TTS profile access is NOT_ADMITTED");
            assertRpcError(() -> stub.cloneVoice(CloneVoiceRequest.getDefaultInstance()),
                    Status.Code.UNIMPLEMENTED, "Voice cloning is NOT_ADMITTED");
            assertRpcError(() -> stub.submitFeedback(FeedbackRequest.getDefaultInstance()),
                    Status.Code.UNIMPLEMENTED, "TTS feedback requires");

            assertStreamErrorWithoutChunks(TTSServiceGrpc.newStub(guardedChannel).withInterceptors(
                    MetadataUtils.newAttachHeadersInterceptor(headers)), Status.Code.UNAVAILABLE,
                    "TTS_NOT_ADMITTED");

            verify(guardedLibrary).getTtsEngine();
            verifyNoMoreInteractions(guardedLibrary);
            verify(engine).getAvailableVoices();
            verifyNoMoreInteractions(engine);
        } finally {
            if (guardedChannel != null) guardedChannel.shutdownNow();
            if (guardedServer != null) guardedServer.shutdownNow();
            if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
            else System.setProperty("AV_JWT_SECRET", previousSecret);
        }
    }

    @Test
    @DisplayName("unauthenticated effectful RPCs are rejected before provider access")
    void unauthenticatedEffectfulRpcsAreRejectedBeforeProviderAccess() throws Exception {
        String secret = "tts-inprocess-unauthenticated-rpc-test-secret";
        String previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", secret);
        AudioVideoLibrary guardedLibrary = mock(AudioVideoLibrary.class);
        Server guardedServer = null;
        ManagedChannel guardedChannel = null;
        try {
            String serverName = InProcessServerBuilder.generateName();
            guardedServer = InProcessServerBuilder.forName(serverName)
                    .directExecutor()
                    .addService(new TtsGrpcService(guardedLibrary, new SimpleMeterRegistry()))
                    .intercept(new JwtServerInterceptor())
                    .build()
                    .start();
            guardedChannel = InProcessChannelBuilder.forName(serverName).directExecutor().build();
            TTSServiceGrpc.TTSServiceBlockingStub stub = TTSServiceGrpc.newBlockingStub(guardedChannel);

            assertRpcError(() -> stub.synthesize(SynthesizeRequest.newBuilder().setText("hello").build()),
                    Status.Code.UNAUTHENTICATED, null);
            assertRpcError(() -> stub.getStatus(com.ghatana.tts.core.grpc.proto.StatusRequest.getDefaultInstance()),
                    Status.Code.UNAUTHENTICATED, null);
            assertRpcError(() -> stub.getMetrics(MetricsRequest.getDefaultInstance()),
                    Status.Code.UNAUTHENTICATED, null);
            assertRpcError(() -> stub.getVoices(GetVoicesRequest.getDefaultInstance()),
                    Status.Code.UNAUTHENTICATED, null);
            assertRpcError(() -> stub.loadVoice(LoadVoiceRequest.getDefaultInstance()),
                    Status.Code.UNAUTHENTICATED, null);
            assertRpcError(() -> stub.createProfile(CreateProfileRequest.getDefaultInstance()),
                    Status.Code.UNAUTHENTICATED, null);
            assertRpcError(() -> stub.getProfile(GetProfileRequest.getDefaultInstance()),
                    Status.Code.UNAUTHENTICATED, null);
            assertRpcError(() -> stub.updateProfile(UpdateProfileRequest.getDefaultInstance()),
                    Status.Code.UNAUTHENTICATED, null);
            assertRpcError(() -> stub.cloneVoice(CloneVoiceRequest.getDefaultInstance()),
                    Status.Code.UNAUTHENTICATED, null);
            assertRpcError(() -> stub.submitFeedback(FeedbackRequest.getDefaultInstance()),
                    Status.Code.UNAUTHENTICATED, null);

            assertStreamErrorWithoutChunks(TTSServiceGrpc.newStub(guardedChannel),
                    Status.Code.UNAUTHENTICATED, null);
            verifyNoInteractions(guardedLibrary);
        } finally {
            if (guardedChannel != null) guardedChannel.shutdownNow();
            if (guardedServer != null) guardedServer.shutdownNow();
            if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
            else System.setProperty("AV_JWT_SECRET", previousSecret);
        }
    }

    private static void assertStreamErrorWithoutChunks(
            TTSServiceGrpc.TTSServiceStub stub,
            Status.Code expectedCode,
            String descriptionFragment) throws Exception {
        assertStreamErrorWithoutChunks(stub, SynthesizeRequest.newBuilder().setText("hello").build(),
                expectedCode, descriptionFragment);
    }

    private static void assertStreamErrorWithoutChunks(
            TTSServiceGrpc.TTSServiceStub stub,
            SynthesizeRequest request,
            Status.Code expectedCode,
            String descriptionFragment) throws Exception {
        java.util.List<AudioChunk> chunks = new java.util.ArrayList<>();
        CountDownLatch terminal = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        stub.streamSynthesize(request, new io.grpc.stub.StreamObserver<>() {
            @Override public void onNext(AudioChunk value) { chunks.add(value); }
            @Override public void onError(Throwable error) { failure.set(error); terminal.countDown(); }
            @Override public void onCompleted() { terminal.countDown(); }
        });
        assertThat(terminal.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(chunks).isEmpty();
        assertThat(failure.get()).isInstanceOf(StatusRuntimeException.class);
        assertThat(Status.fromThrowable(failure.get()).getCode()).isEqualTo(expectedCode);
        if (descriptionFragment != null) {
            assertThat(Status.fromThrowable(failure.get()).getDescription()).contains(descriptionFragment);
        }
    }

    private static void assertRpcError(Runnable rpc, Status.Code expectedCode, String descriptionFragment) {
        assertThatThrownBy(rpc::run)
                .isInstanceOf(StatusRuntimeException.class)
                .matches(error -> ((StatusRuntimeException) error).getStatus().getCode() == expectedCode)
                .satisfies(error -> {
                    if (descriptionFragment != null) {
                        assertThat(((StatusRuntimeException) error).getStatus().getDescription())
                                .contains(descriptionFragment);
                    }
                });
    }

    private static String testJwt(String secret) throws Exception {
        return testJwt(secret, "tenant-test");
    }

    private static String testJwt(String secret, String tenantId) throws Exception {
        String header = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String payload = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("{\"sub\":\"00000000-0000-0000-0000-000000000001\",\"tenantId\":\"" + tenantId + "\",\"exp\":"
                        + (System.currentTimeMillis() / 1000 + 3600) + "}")
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String unsigned = header + "." + payload;
        javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
        mac.init(new javax.crypto.spec.SecretKeySpec(secret.getBytes(java.nio.charset.StandardCharsets.UTF_8), "HmacSHA256"));
        String signature = java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(unsigned.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        return unsigned + "." + signature;
    }
}
