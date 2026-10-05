package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.grpc.proto.DetectRequest;
import com.ghatana.audio.video.vision.grpc.proto.DetectResponse;
import com.ghatana.audio.video.vision.grpc.proto.VisionServiceGrpc;
import com.ghatana.audio.video.vision.model.BoundingBox;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.Contexts;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.ServerBuilder;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * @doc.type class
 * @doc.purpose In-process gRPC integration coverage for vision service contract
 * @doc.layer product
 * @doc.pattern Integration Test
 */
@DisplayName("VisionGrpcService In-Process Integration")
class VisionGrpcServiceInProcessIntegrationTest {

    private static final String TEST_TENANT = "tenant-integration-test";

    /** Server interceptor that injects a test tenant into the gRPC context. */
    private static final class TenantInjector implements ServerInterceptor {
        @Override
        public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
                ServerCall<ReqT, RespT> call,
                Metadata headers,
                ServerCallHandler<ReqT, RespT> next) {
            Context ctx = Context.current().withValue(JwtServerInterceptor.CTX_TENANT, TEST_TENANT);
            return Contexts.interceptCall(ctx, call, headers, next);
        }
    }

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
        VisionDetector detector = mock(VisionDetector.class);
        VideoFrameExtractor frameExtractor = mock(VideoFrameExtractor.class);

        when(detector.detectObjects(any(byte[].class), any(DetectionOptions.class))).thenReturn(List.of(
            DetectedObject.builder()
                .className("person")
                .confidence(0.91)
                .boundingBox(BoundingBox.builder().x(10).y(20).width(100).height(200).build())
                .timestamp(Instant.now())
                .build()
        ));

        VisionGrpcService service = new VisionGrpcService(detector, frameExtractor);

        server = ServerBuilder.forPort(0)
            .directExecutor()
            .intercept(new TenantInjector())
            .addService(service)
            .build()
            .start();

        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort())
            .usePlaintext()
            .directExecutor()
            .build();
    }

    @Test
    @DisplayName("detectObjects returns mapped detections over gRPC transport")
    void detectObjectsOverGrpc() {
        VisionServiceGrpc.VisionServiceBlockingStub stub = VisionServiceGrpc.newBlockingStub(channel);

        DetectResponse response = stub.detectObjects(
            DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[]{0x01, 0x02}))
                .build()
        );

        assertThat(response.getDetectionsCount()).isEqualTo(1);
        assertThat(response.getDetections(0).getClassName()).isEqualTo("person");
        assertThat(response.getDetections(0).getConfidence()).isEqualTo(0.91);
    }

    @Test
    @DisplayName("detectObjects validates empty image and returns INVALID_ARGUMENT")
    void detectObjectsEmptyImageReturnsInvalidArgument() {
        VisionServiceGrpc.VisionServiceBlockingStub stub = VisionServiceGrpc.newBlockingStub(channel);

        assertThatThrownBy(() -> stub.detectObjects(DetectRequest.newBuilder().build()))
            .isInstanceOf(StatusRuntimeException.class)
            .matches(ex -> ((StatusRuntimeException) ex).getStatus().getCode() == Status.INVALID_ARGUMENT.getCode());
    }
}
