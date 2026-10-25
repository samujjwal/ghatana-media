package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.TTSServiceGrpc;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import io.grpc.Server;
import io.grpc.ServerBuilder;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

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
}
