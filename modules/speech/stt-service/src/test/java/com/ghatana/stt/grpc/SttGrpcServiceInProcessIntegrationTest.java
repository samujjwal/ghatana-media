package com.ghatana.stt.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
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
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

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
                .setAudioData(ByteString.copyFrom(new byte[]{0x01, 0x02, 0x03, 0x04}))
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

    @Test
    @DisplayName("unloadModel does not report success when engine has no unload operation")
    void unloadModelReturnsUnimplementedOverGrpc() throws Exception {
        SttEngine engine = mock(SttEngine.class);
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        when(library.getSttEngine()).thenReturn(engine);
        when(engine.getAvailableModels()).thenReturn(List.of(new ModelInfo(
            "whisper-base", "Whisper Base", "1.0", new Locale[]{Locale.ENGLISH}, 10L, false)));

        Server replacement = ServerBuilder.forPort(0)
            .directExecutor()
            .addService(new SttGrpcService(library, new SimpleMeterRegistry()))
            .build()
            .start();
        ManagedChannel replacementChannel = ManagedChannelBuilder.forAddress("localhost", replacement.getPort())
            .usePlaintext()
            .directExecutor()
            .build();
        try {
            STTServiceGrpc.newBlockingStub(replacementChannel).unloadModel(
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
        var response = STTServiceGrpc.newBlockingStub(channel)
            .healthCheck(HealthCheckRequest.getDefaultInstance());

        assertThat(response.getStatus()).isEqualTo(HealthStatus.HEALTH_STATUS_UNHEALTHY);
        assertThat(response.getMessage()).contains("STT_READINESS_NOT_ADMITTED");
    }

    @Test
    @DisplayName("authentication interceptor rejects all twelve STT RPCs when bearer identity is missing")
    void missingBearerTokenIsRejectedForEveryRpc() throws Exception {
        String previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", "stt-test-only-secret-not-used-to-sign-tokens");
        Server securedServer;
        try {
            securedServer = ServerBuilder.forPort(0)
                .directExecutor()
                .addService(new SttGrpcService(mock(AudioVideoLibrary.class), new SimpleMeterRegistry()))
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
        } finally {
            securedChannel.shutdownNow();
            securedServer.shutdownNow();
        }
    }

    private static void assertUnauthenticated(org.assertj.core.api.ThrowableAssert.ThrowingCallable call) {
        assertThatThrownBy(call)
            .isInstanceOf(StatusRuntimeException.class)
            .matches(failure -> ((StatusRuntimeException) failure).getStatus().getCode()
                == Status.UNAUTHENTICATED.getCode());
    }
}
