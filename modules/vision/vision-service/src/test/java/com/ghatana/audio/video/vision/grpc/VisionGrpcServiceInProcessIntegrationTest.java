package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.grpc.proto.DetectRequest;
import com.ghatana.audio.video.vision.grpc.proto.DetectResponse;
import com.ghatana.audio.video.vision.grpc.proto.AnalyzeRequest;
import com.ghatana.audio.video.vision.grpc.proto.ClassifyRequest;
import com.ghatana.audio.video.vision.grpc.proto.StatusRequest;
import com.ghatana.audio.video.vision.grpc.proto.HealthCheckRequest;
import com.ghatana.audio.video.vision.grpc.proto.SceneTextRecognizeRequest;
import com.ghatana.audio.video.vision.grpc.proto.VisionServiceGrpc;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService;
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
import java.util.Map;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
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
            Context ctx = Context.current()
                    .withValue(JwtServerInterceptor.CTX_TENANT, TEST_TENANT)
                    .withValue(JwtServerInterceptor.CTX_SUBJECT, "principal-integration-test");
            return Contexts.interceptCall(ctx, call, headers, next);
        }
    }

    private Server server;
    private ManagedChannel channel;
    private VisionDetector detector;

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
        detector = mock(VisionDetector.class);
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
    @DisplayName("maps detector test-double output over transport without model qualification")
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

    @Test
    @DisplayName("initialized test double never establishes admitted service readiness over gRPC")
    void readinessRemainsNotAdmittedOverGrpc() {
        VisionServiceGrpc.VisionServiceBlockingStub stub = VisionServiceGrpc.newBlockingStub(channel);

        var status = stub.getStatus(StatusRequest.getDefaultInstance());
        assertThat(status.getStatus()).isEqualTo("not_admitted");
        assertThat(status.getModelName()).isEqualTo("UNAVAILABLE");
        assertThat(status.getDegradedReason()).isEqualTo("PROVIDER_NOT_ADMITTED");

        var health = stub.healthCheck(HealthCheckRequest.getDefaultInstance());
        assertThat(health.getHealthy()).isFalse();
        assertThat(health.getMessage()).contains("NOT_SERVING");
        verify(detector, never()).isInitialized();
    }

    @Test
    @DisplayName("scene analysis and classification stay unavailable over gRPC without detector dispatch")
    void sceneAnalysisAndClassificationRemainUnavailableOverGrpc() {
        VisionServiceGrpc.VisionServiceBlockingStub stub = VisionServiceGrpc.newBlockingStub(channel);
        ByteString validTestPayload = ByteString.copyFrom(new byte[]{0x01, 0x02});

        assertThatThrownBy(() -> stub.analyzeImage(AnalyzeRequest.newBuilder()
                .setImageData(validTestPayload).build()))
                .isInstanceOf(StatusRuntimeException.class)
                .matches(failure -> ((StatusRuntimeException) failure).getStatus().getCode()
                        == Status.UNIMPLEMENTED.getCode());
        assertThatThrownBy(() -> stub.classifyImage(ClassifyRequest.newBuilder()
                .setImageData(validTestPayload).build()))
                .isInstanceOf(StatusRuntimeException.class)
                .matches(failure -> ((StatusRuntimeException) failure).getStatus().getCode()
                        == Status.UNIMPLEMENTED.getCode());

        verify(detector, never()).detectObjects(any(byte[].class), any(DetectionOptions.class));
    }

    @Test
    @DisplayName("scene text accepts omitted crop declaration and sends only resolver pixels to DI")
    void recognizeSceneTextOverGrpcWithoutCallerCrop() throws Exception {
        byte[] trustedCrop = new byte[] {0x11, 0x22, 0x33};
        byte[] sourceDigest = new byte[32];
        String sourceSha = java.util.HexFormat.of().formatHex(sourceDigest);
        AtomicReference<DocumentIntelligenceV1.ParseRequest> parseRequest = new AtomicReference<>();
        AtomicReference<SceneTextRecognitionService.SourceCheck> sourceCheck = new AtomicReference<>();
        AtomicReference<SceneTextRecognitionService.CropRequest> cropRequest = new AtomicReference<>();
        AtomicInteger providerCalls = new AtomicInteger();
        DocumentIntelligenceV1 di = new DocumentIntelligenceV1() {
            @Override
            public ProviderCatalog providers(Cancellation cancellation) {
                providerCalls.incrementAndGet();
                return new ProviderCatalog(PROTOCOL_VERSION, WORKER_CAPABILITY_VERSION, List.of(
                        new ProviderEntry("di.ocr.en", "2.4.1", Optional.of("model.scene-text.en"),
                                Optional.of("2026.09.2"), List.of("image/png"), List.of("en"),
                                "ACCEPTED", true, true)));
            }

            @Override
            public ParsedDocument parse(ParseRequest request, Cancellation cancellation) {
                parseRequest.set(request);
                return new ParsedDocument(PROTOCOL_VERSION, request.operationId(), request.providerRef(),
                        new Provenance("di.ocr.en", "2.4.1", Optional.of("model.scene-text.en"),
                                Optional.of("2026.09.2")),
                        List.of(new Page(1, List.of(new Block("block-1", "text", new Box(0.5, 0.5, 0.25, 0.25),
                                List.of(new Line("line-1", "SAFE TEXT", new Box(0.5, 0.5, 0.25, 0.25),
                                        Optional.of(0.98), Optional.of("en"))))), 0)));
            }

            @Override
            public boolean cancel(String operationId, String operationGeneration) {
                return false;
            }
        };
        SceneTextRecognitionService.Policy policy = new SceneTextRecognitionService.Policy(
                "di.ocr.en", "2.4.1", "model.scene-text.en", "2026.09.2",
                Set.of("image/png"), Set.of("en"), 5_000, Map.of());
        SceneTextRecognitionService sceneText = new SceneTextRecognitionService(Optional.of(di), check -> {
            sourceCheck.set(check);
            return new SceneTextRecognitionService.Decision(SceneTextRecognitionService.SourceStatus.ADMITTED,
                    check.sourceVersion(), sourceSha, "rights-decision-1");
        }, policy, Optional.of(request -> {
            cropRequest.set(request);
            return new SceneTextRecognitionService.ResolvedCrop(trustedCrop, "image/png", sourceSha,
                    request.ptsUs(), request.frameWidth(), request.frameHeight());
        }), Optional.of(request -> SceneTextRecognitionService.ReservationDecision.reserved(
                new SceneTextRecognitionService.DiOperationIdentity(
                        request.candidateDiOperationId(), request.candidateGeneration()))));

        VisionGrpcService grpcService = new VisionGrpcService(detector, mock(VideoFrameExtractor.class));
        grpcService.bindSceneTextService(sceneText);
        server.shutdownNow();
        server = ServerBuilder.forPort(0)
                .directExecutor()
                .intercept(new TenantInjector())
                .addService(grpcService)
                .build()
                .start();
        channel.shutdownNow();
        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort())
                .usePlaintext()
                .directExecutor()
                .build();

        var response = VisionServiceGrpc.newBlockingStub(channel).recognizeSceneText(
                SceneTextRecognizeRequest.newBuilder()
                        .setOperationId("media-operation-1")
                        .setPurposeRef("captioning")
                        .setSourceArtifactId("artifact-1")
                        .setSourceVersion("sha256:" + sourceSha)
                        .setFrameId("frame-1")
                        .setPtsUs(0)
                        .setFrameWidth(100)
                        .setFrameHeight(80)
                        .setRoi(com.ghatana.audio.video.vision.grpc.proto.SceneTextRoi.newBuilder()
                                .setX(10).setY(20).setWidth(40).setHeight(30))
                        .setMediaType("image/png")
                        .setOriginalFrameSha256(sourceSha)
                        // Proto3 defaults to empty bytes/string. No caller pixels are supplied.
                        .build());

        assertThat(response.hasRecognized()).isTrue();
        assertThat(response.getRecognized().getOperationId()).isEqualTo("media-operation-1");
        assertThat(response.getRecognized().getRightsDecisionRef()).isEqualTo("rights-decision-1");
        assertThat(response.getRecognized().getObservationsList())
                .extracting(observation -> observation.getText()).containsExactly("SAFE TEXT");
        assertThat(sourceCheck.get()).satisfies(check -> {
            assertThat(check.tenantId()).isEqualTo(TEST_TENANT);
            assertThat(check.principalId()).isEqualTo("principal-integration-test");
            assertThat(check.sourceVersion()).isEqualTo("sha256:" + sourceSha);
            assertThat(check.dispatchProviderRef()).isEqualTo("di.ocr.en");
        });
        assertThat(cropRequest.get()).satisfies(request -> {
            assertThat(request.sourceArtifactId()).isEqualTo("artifact-1");
            assertThat(request.frameId()).isEqualTo("frame-1");
            assertThat(request.ptsUs()).isZero();
        });
        assertThat(parseRequest.get().bytes()).containsExactly(trustedCrop);
        assertThat(providerCalls).hasValue(1);
    }

    @Test
    @DisplayName("scene text rejects a partial crop declaration before source or DI access")
    void recognizeSceneTextOverGrpcRejectsPartialCropDeclaration() throws Exception {
        AtomicInteger sourceChecks = new AtomicInteger();
        AtomicInteger providerCalls = new AtomicInteger();
        DocumentIntelligenceV1 di = new DocumentIntelligenceV1() {
            @Override
            public ProviderCatalog providers(Cancellation cancellation) {
                providerCalls.incrementAndGet();
                throw new AssertionError("invalid crop declaration must not reach DI");
            }

            @Override public ParsedDocument parse(ParseRequest request, Cancellation cancellation) {
                throw new AssertionError("invalid crop declaration must not reach DI");
            }
            @Override public boolean cancel(String operationId, String operationGeneration) { return false; }
        };
        String sourceSha = "a".repeat(64);
        SceneTextRecognitionService sceneText = new SceneTextRecognitionService(Optional.of(di), check -> {
            sourceChecks.incrementAndGet();
            return new SceneTextRecognitionService.Decision(SceneTextRecognitionService.SourceStatus.ADMITTED,
                    check.sourceVersion(), sourceSha, "rights-decision-1");
        }, new SceneTextRecognitionService.Policy("di.ocr.en", "2.4.1", "model.scene-text.en", "2026.09.2",
                Set.of("image/png"), Set.of("en"), 5_000, Map.of()),
                Optional.of(request -> new SceneTextRecognitionService.ResolvedCrop(
                        new byte[] {1}, "image/png", sourceSha, request.ptsUs(), request.frameWidth(), request.frameHeight())),
                Optional.of(request -> SceneTextRecognitionService.ReservationDecision.reserved(
                        new SceneTextRecognitionService.DiOperationIdentity(
                                request.candidateDiOperationId(), request.candidateGeneration()))));
        VisionGrpcService grpcService = new VisionGrpcService(detector, mock(VideoFrameExtractor.class));
        grpcService.bindSceneTextService(sceneText);
        server.shutdownNow();
        server = ServerBuilder.forPort(0).directExecutor().intercept(new TenantInjector())
                .addService(grpcService).build().start();
        channel.shutdownNow();
        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort()).usePlaintext().directExecutor().build();

        var response = VisionServiceGrpc.newBlockingStub(channel).recognizeSceneText(
                SceneTextRecognizeRequest.newBuilder()
                        .setOperationId("media-operation-1").setPurposeRef("captioning")
                        .setSourceArtifactId("artifact-1").setSourceVersion("sha256:" + sourceSha)
                        .setFrameId("frame-1").setFrameWidth(100).setFrameHeight(80)
                        .setRoi(com.ghatana.audio.video.vision.grpc.proto.SceneTextRoi.newBuilder()
                                .setWidth(40).setHeight(30))
                        .setMediaType("image/png")
                        .setCroppedFrameSha256("b".repeat(64))
                        .build());
        var missingDigestResponse = VisionServiceGrpc.newBlockingStub(channel).recognizeSceneText(
                SceneTextRecognizeRequest.newBuilder()
                        .setOperationId("media-operation-2").setPurposeRef("captioning")
                        .setSourceArtifactId("artifact-1").setSourceVersion("sha256:" + sourceSha)
                        .setFrameId("frame-1").setFrameWidth(100).setFrameHeight(80)
                        .setRoi(com.ghatana.audio.video.vision.grpc.proto.SceneTextRoi.newBuilder()
                                .setWidth(40).setHeight(30))
                        .setMediaType("image/png")
                        .setOriginalFrameSha256(sourceSha)
                        .setCroppedBytes(ByteString.copyFrom(new byte[] {9, 8, 7}))
                        .build());

        assertThat(response.hasRejected()).isTrue();
        assertThat(response.getRejected().getCode()).isEqualTo("INVALID_REQUEST");
        assertThat(missingDigestResponse.hasRejected()).isTrue();
        assertThat(missingDigestResponse.getRejected().getCode()).isEqualTo("INVALID_REQUEST");
        assertThat(sourceChecks).hasValue(0);
        assertThat(providerCalls).hasValue(0);
    }
}
