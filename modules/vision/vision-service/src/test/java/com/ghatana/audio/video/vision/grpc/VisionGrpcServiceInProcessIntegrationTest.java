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
import com.ghatana.audio.video.vision.video.VideoFrameExtractor.ExtractedFrame;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor.ExtractionConfig;
import com.ghatana.audio.video.vision.video.SourceMediaTimestamp;
import com.ghatana.audio.video.vision.scenetext.MediaRuntimeSceneTextSource;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactContentReadReceipt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Evidence;
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
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.doAnswer;

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

    @Test
    @DisplayName("source frame readback returns authenticated exact metadata without pixels or DI")
    void resolveSourceFrameOverGrpcReturnsMetadataAndFailsClosedOnRightsDenial() throws Exception {
        byte[] source = "immutable-video-source".getBytes(StandardCharsets.UTF_8);
        String sourceSha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(source));
        ByteArrayOutputStream bmp = new ByteArrayOutputStream();
        javax.imageio.ImageIO.write(new java.awt.image.BufferedImage(8, 8,
                java.awt.image.BufferedImage.TYPE_INT_RGB), "bmp", bmp);
        final byte[] frame = bmp.toByteArray();
        VideoFrameExtractor extractor = new VideoFrameExtractor() {
            @Override public List<ExtractedFrame> extractFrames(Path input, Path output, ExtractionConfig config)
                    throws IOException {
                assertThat(Files.readAllBytes(input)).containsExactly(source);
                Files.createDirectories(output);
                Path decoded = output.resolve("frame_0001.bmp");
                Files.write(decoded, frame);
                return List.of(new ExtractedFrame(decoded,
                        new SourceMediaTimestamp(SourceMediaTimestamp.Status.KNOWN, 1_500L, 1L, 30_000L,
                                50L, null), config.getSourceFrameNumber()));
            }
        };
        MediaProcessingRuntimePort runtime = mock(MediaProcessingRuntimePort.class);
        AtomicInteger readbacks = new AtomicInteger();
        ArtifactVersion version = ArtifactVersion.fromSha256(sourceSha);
        when(runtime.artifact(any(), any(), any())).thenReturn(Optional.of(new MediaArtifact(
                TEST_TENANT, "principal-integration-test", "artifact-video", "source.mp4", "video/mp4",
                source.length, sourceSha, "private-ref", "restricted", Instant.now(),
                Instant.now().plusSeconds(300), Map.of())));
        doAnswer(invocation -> {
            readbacks.incrementAndGet();
            ((OutputStream) invocation.getArgument(4)).write(source);
            return Optional.of(new ArtifactContentReadReceipt(version, sourceSha, source.length));
        }).when(runtime).copyArtifactContent(any(), any(), any(), any(), any(), anyLong());
        AtomicReference<Boolean> allow = new AtomicReference<>(true);
        doAnswer(invocation -> {
            String tenant = invocation.getArgument(0);
            String principal = invocation.getArgument(1);
            String artifact = invocation.getArgument(2);
            ArtifactVersion requestedVersion = invocation.getArgument(3);
            JobType job = invocation.getArgument(4);
            String purpose = invocation.getArgument(5);
            AuthenticatedPrincipal authenticated = invocation.getArgument(6);
            assertThat(authenticated.tenantId()).isEqualTo(tenant);
            assertThat(authenticated.principalId()).isEqualTo(principal);
            if (!allow.get()) {
                return new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                        com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.REVOKED, null);
            }
            Evidence evidence = new Evidence("fixture-authority", "fixture-decision", tenant, principal,
                    principal, artifact, requestedVersion, sourceSha, job.name(), purpose,
                    "vision-local-frame-reader", "1",
                    com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary.LOCAL, "local",
                    com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE,
                    Set.of(job.name()), Set.of("*"), Set.of(
                            com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE),
                    "fixture-rights", "fixture-policy", "fixture-policy-v1",
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.HumanConsentDisposition
                            .NOT_APPLICABLE_HUMAN_CONSENT,
                    "", "artifact-local-clock", 0, Instant.now().minusSeconds(1), Instant.now().plusSeconds(300));
            return new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED, evidence);
        }).when(runtime).resolveSourceAuthorization(any(), any(), any(), any(), any(), any(), any());

        VisionGrpcService grpcService = new VisionGrpcService(detector, mock(VideoFrameExtractor.class));
        grpcService.bindMediaRuntimeSceneTextSource(new MediaRuntimeSceneTextSource(runtime, extractor));
        server.shutdownNow();
        server = ServerBuilder.forPort(0).directExecutor().intercept(new TenantInjector())
                .addService(grpcService).build().start();
        channel.shutdownNow();
        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort()).usePlaintext().directExecutor().build();
        var stub = VisionServiceGrpc.newBlockingStub(channel);
        var request = com.ghatana.audio.video.vision.grpc.proto.SourceFrameResolveRequest.newBuilder()
                .setSourceArtifactId("artifact-video").setSourceVersion(version.value())
                .setFrameId("0").setPtsUs(50_000).setFrameWidth(8).setFrameHeight(8)
                .setRoi(com.ghatana.audio.video.vision.grpc.proto.SceneTextRoi.newBuilder()
                        .setX(1).setY(1).setWidth(4).setHeight(4))
                .setPurposeRef("captioning").build();

        var outOfBounds = stub.resolveSourceFrame(request.toBuilder()
                .setRoi(request.getRoi().toBuilder().setX(7).setWidth(2)).build());
        assertThat(outOfBounds.hasRejected()).isTrue();
        assertThat(outOfBounds.getRejected().getCode()).isEqualTo("INVALID_REQUEST");
        assertThat(readbacks).hasValue(0);

        var resolved = stub.resolveSourceFrame(request);
        assertThat(resolved.hasResolved()).isTrue();
        assertThat(resolved.getResolved().getTenantId()).isEqualTo(TEST_TENANT);
        assertThat(resolved.getResolved().getPrincipalId()).isEqualTo("principal-integration-test");
        assertThat(resolved.getResolved().getSourceSha256()).isEqualTo(sourceSha);
        assertThat(resolved.getResolved().getFrameNumber()).isZero();
        assertThat(resolved.getResolved().getSourcePts()).isEqualTo(1_500);
        assertThat(resolved.getResolved().getTimeBaseNumerator()).isEqualTo(1);
        assertThat(resolved.getResolved().getTimeBaseDenominator()).isEqualTo(30_000);
        assertThat(resolved.getResolved().getSourceStreamSelector()).isEqualTo("0:v:0");
        assertThat(resolved.getResolved().getArtifactLocalEpoch()).startsWith("artifact-local:");
        assertThat(resolved.getResolved().getFrameSha256()).hasSize(64);
        assertThat(resolved.getResolved().getCropSha256()).hasSize(64);
        assertThat(resolved.getDescriptorForType().findFieldByName("resolved").getMessageType()
                .findFieldByName("pixels")).isNull();
        assertThat(readbacks).hasValue(1);
        allow.set(false);
        var denied = stub.resolveSourceFrame(request);
        assertThat(denied.hasRejected()).isTrue();
        assertThat(denied.getRejected().getCode()).isEqualTo("NOT_ADMITTED");
        assertThat(readbacks).hasValue(1);
    }
}
