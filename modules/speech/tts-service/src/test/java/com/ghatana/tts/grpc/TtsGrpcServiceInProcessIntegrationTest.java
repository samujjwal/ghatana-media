package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.tts.core.grpc.proto.AudioChunk;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.TTSServiceGrpc;
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

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

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
                .hasMessageContaining("NOT_ADMITTED");
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
            assertThat(Status.fromThrowable(failure.get()).getDescription()).contains("NOT_ADMITTED");

            verifyNoInteractions(guardedLibrary);
        } finally {
            if (guardedChannel != null) guardedChannel.shutdownNow();
            if (guardedServer != null) guardedServer.shutdownNow();
            if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
            else System.setProperty("AV_JWT_SECRET", previousSecret);
        }
    }

    private static String testJwt(String secret) throws Exception {
        String header = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String payload = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("{\"sub\":\"00000000-0000-0000-0000-000000000001\",\"tenantId\":\"tenant-test\",\"exp\":"
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
