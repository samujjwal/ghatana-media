package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeResponse;
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

import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

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
        TtsEngine engine = mock(TtsEngine.class);

        when(library.getTtsEngine()).thenReturn(engine);
        when(engine.synthesize(anyString(), any())).thenReturn(
            new AudioData(new byte[]{0x01, 0x02, 0x03, 0x04}, 22050, 1, 16, Duration.ofMillis(100), AudioFormat.PCM)
        );

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
    @DisplayName("synthesize returns audio payload over gRPC transport")
    void synthesizeOverGrpc() {
        TTSServiceGrpc.TTSServiceBlockingStub stub = TTSServiceGrpc.newBlockingStub(channel);

        SynthesizeResponse response = stub.synthesize(
            SynthesizeRequest.newBuilder().setText("hello world").build()
        );

        assertThat(response.getAudioData().size()).isGreaterThan(0);
        assertThat(response.getSampleRate()).isEqualTo(22050);
        assertThat(response.getProcessingTimeMs()).isGreaterThanOrEqualTo(0);
    }

    @Test
    @DisplayName("synthesize validates blank text and returns INVALID_ARGUMENT")
    void synthesizeBlankTextReturnsInvalidArgument() {
        TTSServiceGrpc.TTSServiceBlockingStub stub = TTSServiceGrpc.newBlockingStub(channel);

        assertThatThrownBy(() -> stub.synthesize(SynthesizeRequest.newBuilder().setText("").build()))
            .isInstanceOf(StatusRuntimeException.class)
            .matches(ex -> ((StatusRuntimeException) ex).getStatus().getCode() == Status.INVALID_ARGUMENT.getCode());
    }
}
