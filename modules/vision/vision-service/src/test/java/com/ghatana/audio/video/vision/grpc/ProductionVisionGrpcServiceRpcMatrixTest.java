package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.vision.grpc.proto.*;
import com.ghatana.audio.video.vision.model.VisionModelProfile;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audio.video.vision.yolo.YoloV8Adapter;
import com.google.protobuf.ByteString;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.health.v1.HealthGrpc;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.protobuf.services.HealthStatusManager;
import io.grpc.stub.MetadataUtils;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Base64;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Production wrapper transport matrix with an intentionally unadmitted model provider. */
class ProductionVisionGrpcServiceRpcMatrixTest {
    private static final String SECRET = "vision-production-wrapper-test-secret";
    private static final String TENANT = "tenant-vision-rpc-matrix";
    private static final String SUBJECT = "8a328ec0-c319-4caf-b393-f4c81386aa22";

    private String previousSecret;
    private Server server;
    private ManagedChannel channel;
    private YoloV8Adapter detector;
    private VideoFrameExtractor frameExtractor;
    private ProductionVisionGrpcService service;
    private HealthStatusManager publicHealth;
    private VisionServiceGrpc.VisionServiceBlockingStub authenticated;
    private VisionServiceGrpc.VisionServiceBlockingStub unauthenticated;

    @BeforeEach
    void setUp() throws Exception {
        previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", SECRET);
        detector = mock(YoloV8Adapter.class);
        when(detector.isInitialized()).thenReturn(false);
        frameExtractor = mock(VideoFrameExtractor.class);
        Path modelDirectory = Path.of("/test-only/vision-models");
        VisionModelProfile profile = new VisionModelProfile(
                "fixture-model", "fixture-version", modelDirectory,
                modelDirectory.resolve("fixture-model.onnx"), "a".repeat(64), "TEST_ONLY",
                YoloV8Adapter.supportedClassLabels(), VisionModelProfile.Device.CPU, 1);
        service = new ProductionVisionGrpcService(new ProductionVisionGrpcService.Composition(
                detector, frameExtractor, profile), MediaProcessingMetrics.noop());
        service.setReadinessProbe(service::isProviderReady);
        publicHealth = new HealthStatusManager();
        publicHealth.setStatus("", io.grpc.health.v1.HealthCheckResponse.ServingStatus.NOT_SERVING);

        String name = InProcessServerBuilder.generateName();
        server = InProcessServerBuilder.forName(name).directExecutor()
                .addService(service)
                .addService(publicHealth.getHealthService())
                .intercept(new JwtServerInterceptor())
                .build().start();
        channel = InProcessChannelBuilder.forName(name).directExecutor().build();
        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                "Bearer " + signedJwt());
        authenticated = VisionServiceGrpc.newBlockingStub(channel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));
        unauthenticated = VisionServiceGrpc.newBlockingStub(channel);
    }

    @AfterEach
    void tearDown() {
        if (channel != null) channel.shutdownNow();
        if (server != null) server.shutdownNow();
        if (service != null) service.close();
        if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
        else System.setProperty("AV_JWT_SECRET", previousSecret);
    }

    @Test
    void authenticatedTenRpcMatrixReturnsOnlyDeclaredFailClosedDispositions() throws Exception {
        assertStatus(Status.Code.UNAVAILABLE, "PROVIDER_NOT_ADMITTED", () -> authenticated.detectObjects(
                DetectRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[] {1})).build()));

        assertStatus(Status.Code.UNIMPLEMENTED, "media.vision.estimate.depth is NOT_ADMITTED",
                () -> authenticated.analyzeImage(AnalyzeRequest.newBuilder()
                        .setImageData(ByteString.copyFrom(new byte[] {2}))
                        .addAnalysisTypes("media.vision.estimate.depth").build()));
        assertStatus(Status.Code.UNIMPLEMENTED, "not admitted by the active Vision provider",
                () -> authenticated.classifyImage(ClassifyRequest.newBuilder()
                        .setImageData(ByteString.copyFrom(new byte[] {3})).build()));

        assertStatus(Status.Code.UNAVAILABLE, "PROVIDER_NOT_ADMITTED", () -> authenticated.analyzeVideoFile(
                VideoFileRequest.newBuilder().setVideoData(ByteString.copyFrom(new byte[] {4})).build()));
        assertProcessVideoFailure(authenticatedAsync(), VideoFrameRequest.newBuilder()
                .setFrameData(ByteString.copyFrom(new byte[] {5})).build(),
                Status.Code.UNAVAILABLE, "PROVIDER_NOT_ADMITTED");

        assertStatus(Status.Code.UNAVAILABLE, "requires an admitted Vision provider profile",
                () -> authenticated.loadModel(LoadModelRequest.newBuilder().setModelId("model").build()));
        assertStatus(Status.Code.UNAVAILABLE, "requires an admitted Vision provider profile",
                () -> authenticated.unloadModel(UnloadModelRequest.newBuilder().setModelId("model").build()));
        assertStatus(Status.Code.UNAVAILABLE, "requires an admitted Vision provider profile",
                () -> authenticated.listModels(ListModelsRequest.getDefaultInstance()));

        StatusResponse status = authenticated.getStatus(StatusRequest.getDefaultInstance());
        assertThat(status.getStatus()).isEqualTo("not_admitted");
        assertThat(status.getModelName()).isEqualTo("UNAVAILABLE");
        assertThat(status.getDegradedReason()).isEqualTo("PROVIDER_NOT_ADMITTED");
        com.ghatana.audio.video.vision.grpc.proto.HealthCheckResponse health = authenticated.healthCheck(
                com.ghatana.audio.video.vision.grpc.proto.HealthCheckRequest.getDefaultInstance());
        assertThat(health.getHealthy()).isFalse();
        assertThat(health.getMessage()).isEqualTo("VISION_NOT_SERVING: provider readiness unavailable");

        verify(detector, never()).detectObjects(org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any());
        verify(frameExtractor, never()).getVideoMetadata(org.mockito.ArgumentMatchers.any());
        verify(frameExtractor, never()).extractFrames(org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
    }

    @Test
    void invalidAndBoundedInputsFailBeforeProviderOrVideoDispatch() throws Exception {
        assertStatus(Status.Code.INVALID_ARGUMENT, "Image data cannot be empty",
                () -> authenticated.detectObjects(DetectRequest.getDefaultInstance()));
        assertStatus(Status.Code.INVALID_ARGUMENT, "maxDetections cannot exceed 100",
                () -> authenticated.detectObjects(DetectRequest.newBuilder()
                        .setImageData(ByteString.copyFrom(new byte[] {1})).setMaxDetections(101).build()));
        assertStatus(Status.Code.INVALID_ARGUMENT, "Image data cannot be empty",
                () -> authenticated.analyzeImage(AnalyzeRequest.getDefaultInstance()));
        assertStatus(Status.Code.INVALID_ARGUMENT, "Image data cannot be empty",
                () -> authenticated.classifyImage(ClassifyRequest.getDefaultInstance()));
        assertStatus(Status.Code.INVALID_ARGUMENT, "Video data cannot be empty",
                () -> authenticated.analyzeVideoFile(VideoFileRequest.getDefaultInstance()));
        assertProcessVideoFailure(authenticatedAsync(), VideoFrameRequest.getDefaultInstance(),
                Status.Code.INVALID_ARGUMENT, "Frame data cannot be empty");
        assertStatus(Status.Code.INVALID_ARGUMENT, "modelId must not be blank",
                () -> authenticated.loadModel(LoadModelRequest.getDefaultInstance()));
        assertStatus(Status.Code.INVALID_ARGUMENT, "modelId must not be blank",
                () -> authenticated.unloadModel(UnloadModelRequest.getDefaultInstance()));

        verify(detector, never()).detectObjects(org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any());
        verify(frameExtractor, never()).getVideoMetadata(org.mockito.ArgumentMatchers.any());
        verify(frameExtractor, never()).extractFrames(org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
    }

    @Test
    void missingJwtRejectsEveryProtectedVisionRpcBeforeProviderDispatch() throws Exception {
        assertCode(() -> unauthenticated.detectObjects(DetectRequest.getDefaultInstance()), Status.Code.UNAUTHENTICATED);
        assertCode(() -> unauthenticated.analyzeImage(AnalyzeRequest.getDefaultInstance()), Status.Code.UNAUTHENTICATED);
        assertCode(() -> unauthenticated.classifyImage(ClassifyRequest.getDefaultInstance()), Status.Code.UNAUTHENTICATED);
        assertCode(() -> unauthenticated.analyzeVideoFile(VideoFileRequest.getDefaultInstance()), Status.Code.UNAUTHENTICATED);
        assertProcessVideoFailure(VisionServiceGrpc.newStub(channel), VideoFrameRequest.getDefaultInstance(),
                Status.Code.UNAUTHENTICATED, "Missing Bearer token");
        assertCode(() -> unauthenticated.loadModel(LoadModelRequest.getDefaultInstance()), Status.Code.UNAUTHENTICATED);
        assertCode(() -> unauthenticated.unloadModel(UnloadModelRequest.getDefaultInstance()), Status.Code.UNAUTHENTICATED);
        assertCode(() -> unauthenticated.listModels(ListModelsRequest.getDefaultInstance()), Status.Code.UNAUTHENTICATED);
        assertCode(() -> unauthenticated.getStatus(StatusRequest.getDefaultInstance()), Status.Code.UNAUTHENTICATED);
        assertCode(() -> unauthenticated.healthCheck(
                com.ghatana.audio.video.vision.grpc.proto.HealthCheckRequest.getDefaultInstance()),
                Status.Code.UNAUTHENTICATED);

        verify(detector, never()).detectObjects(org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any());
        verify(detector, never()).isInitialized();
        verify(frameExtractor, never()).getVideoMetadata(org.mockito.ArgumentMatchers.any());
        verify(frameExtractor, never()).extractFrames(org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());

        io.grpc.health.v1.HealthCheckResponse publicHealthResponse = HealthGrpc.newBlockingStub(channel)
                .check(io.grpc.health.v1.HealthCheckRequest.getDefaultInstance());
        assertThat(publicHealthResponse.getStatus())
                .isEqualTo(io.grpc.health.v1.HealthCheckResponse.ServingStatus.NOT_SERVING);
    }

    private VisionServiceGrpc.VisionServiceStub authenticatedAsync() {
        return VisionServiceGrpc.newStub(channel).withInterceptors(
                MetadataUtils.newAttachHeadersInterceptor(authHeaders()));
    }

    private static Metadata authHeaders() {
        Metadata headers = new Metadata();
        try {
            headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                    "Bearer " + signedJwt());
        } catch (Exception failure) {
            throw new IllegalStateException("Could not sign test JWT", failure);
        }
        return headers;
    }

    private static void assertProcessVideoFailure(VisionServiceGrpc.VisionServiceStub stub,
            VideoFrameRequest request, Status.Code expectedCode, String description) throws Exception {
        CountDownLatch terminal = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        AtomicReference<VideoFrameResponse> response = new AtomicReference<>();
        StreamObserver<VideoFrameRequest> requests = stub.processVideo(new StreamObserver<>() {
            @Override public void onNext(VideoFrameResponse value) { response.set(value); }
            @Override public void onError(Throwable error) { failure.set(error); terminal.countDown(); }
            @Override public void onCompleted() { terminal.countDown(); }
        });
        requests.onNext(request);
        requests.onCompleted();
        assertThat(terminal.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(response.get()).isNull();
        assertThat(failure.get()).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException rpcFailure = (StatusRuntimeException) failure.get();
        assertThat(rpcFailure.getStatus().getCode()).isEqualTo(expectedCode);
        if (description != null) assertThat(rpcFailure.getStatus().getDescription()).contains(description);
    }

    private static void assertStatus(Status.Code code, String description,
            org.assertj.core.api.ThrowableAssert.ThrowingCallable rpc) {
        assertThatThrownBy(rpc).isInstanceOf(StatusRuntimeException.class).satisfies(failure -> {
            StatusRuntimeException statusFailure = (StatusRuntimeException) failure;
            assertThat(statusFailure.getStatus().getCode()).isEqualTo(code);
            assertThat(statusFailure.getStatus().getDescription()).contains(description);
        });
    }

    private static void assertCode(org.assertj.core.api.ThrowableAssert.ThrowingCallable rpc, Status.Code code) {
        assertThatThrownBy(rpc).isInstanceOf(StatusRuntimeException.class)
                .satisfies(failure -> assertThat(((StatusRuntimeException) failure).getStatus().getCode())
                        .isEqualTo(code));
    }

    private static String signedJwt() throws Exception {
        String header = base64("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String payload = base64("{\"sub\":\"" + SUBJECT + "\",\"tenantId\":\"" + TENANT
                + "\",\"exp\":" + (System.currentTimeMillis() / 1000 + 600) + "}");
        String content = header + "." + payload;
        Mac hmac = Mac.getInstance("HmacSHA256");
        hmac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return content + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(hmac.doFinal(content.getBytes(StandardCharsets.UTF_8)));
    }

    private static String base64(String value) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }
}
