package com.ghatana.stt.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.google.protobuf.ByteString;
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
import java.util.Collections;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
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
        SttEngine engine = mock(SttEngine.class);

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

        SttGrpcService service = new SttGrpcService(library, new SimpleMeterRegistry());

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
    @DisplayName("transcribe returns expected response over gRPC transport")
    void transcribeOverGrpc() {
        STTServiceGrpc.STTServiceBlockingStub stub = STTServiceGrpc.newBlockingStub(channel);

        TranscribeResponse response = stub.transcribe(
            TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[]{0x01, 0x02, 0x03}))
                .setSampleRate(16000)
                .build()
        );

        assertThat(response.getText()).isEqualTo("hello in-process");
        assertThat(response.getConfidence()).isEqualTo(0.93f);
        assertThat(response.getModelUsed()).isEqualTo("whisper-base");
    }

    @Test
    @DisplayName("transcribe validates empty audio and returns INVALID_ARGUMENT")
    void transcribeEmptyAudioReturnsInvalidArgument() {
        STTServiceGrpc.STTServiceBlockingStub stub = STTServiceGrpc.newBlockingStub(channel);

        assertThatThrownBy(() -> stub.transcribe(
            TranscribeRequest.newBuilder().setAudioData(ByteString.EMPTY).build()
        ))
            .isInstanceOf(StatusRuntimeException.class)
            .matches(ex -> ((StatusRuntimeException) ex).getStatus().getCode() == Status.INVALID_ARGUMENT.getCode());
    }
}
