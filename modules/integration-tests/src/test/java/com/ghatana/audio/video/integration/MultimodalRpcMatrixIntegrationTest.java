package com.ghatana.audio.video.integration;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.multimodal.grpc.MultimodalGrpcService;
import com.ghatana.audio.video.multimodal.grpc.proto.*;
import com.google.protobuf.ByteString;
import com.google.protobuf.Descriptors;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.stub.MetadataUtils;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Authenticated transport dispositions for all ten registered Multimodal RPCs.
 * The default service composition is explicitly NOT_ADMITTED; these tests verify
 * truthful responses without model fixtures or provider effects.
 */
class MultimodalRpcMatrixIntegrationTest {

    private static final String TEST_SECRET = "multimodal-rpc-matrix-test-secret";
    private static final String TENANT = "tenant-multimodal-rpc-matrix";
    private static final String SUBJECT = "00000000-0000-0000-0000-000000000001";

    private String previousSecret;
    private String previousAuthGatewayUrl;
    private Server server;
    private ManagedChannel channel;
    private MultimodalServiceGrpc.MultimodalServiceBlockingStub authenticated;
    private MultimodalServiceGrpc.MultimodalServiceBlockingStub unauthenticated;

    @BeforeEach
    void setUp() throws Exception {
        previousSecret = System.getProperty("AV_JWT_SECRET");
        previousAuthGatewayUrl = System.getProperty("AUTH_GATEWAY_URL");
        System.setProperty("AV_JWT_SECRET", TEST_SECRET);
        System.setProperty("AUTH_GATEWAY_URL", "");

        MultimodalGrpcService service = new MultimodalGrpcService();
        String name = InProcessServerBuilder.generateName();
        server = InProcessServerBuilder.forName(name)
                .directExecutor()
                .addService(service)
                .intercept(new JwtServerInterceptor())
                .build()
                .start();
        channel = InProcessChannelBuilder.forName(name).directExecutor().build();

        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                "Bearer " + signedJwt());
        authenticated = MultimodalServiceGrpc.newBlockingStub(channel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));
        unauthenticated = MultimodalServiceGrpc.newBlockingStub(channel);
    }

    @AfterEach
    void tearDown() {
        if (channel != null) channel.shutdownNow();
        if (server != null) server.shutdownNow();
        restoreProperty("AV_JWT_SECRET", previousSecret);
        restoreProperty("AUTH_GATEWAY_URL", previousAuthGatewayUrl);
    }

    @Test
    void authenticatedAllTenRpcsReturnOnlyNotAdmittedOrReadinessResponses() {
        ByteString payload = ByteString.copyFrom(new byte[] {1});

        // A request without a valid canonical operation binding fails closed before
        // any rights, provider or persistence effect.
        assertRpcError(() -> authenticated.processMultimodal(MultimodalRequest.newBuilder()
                        .setAudioData(payload).build()), Status.Code.FAILED_PRECONDITION,
                "MULTIMODAL_FAMILY_NOT_ADMITTED");
        assertRpcError(() -> authenticated.analyzeVideoWithAudio(VideoAudioRequest.newBuilder()
                        .setVideoData(payload).setExtractAudio(true).setAnalyzeFrames(true).build()),
                Status.Code.FAILED_PRECONDITION, "MULTIMODAL_FAMILY_NOT_ADMITTED");
        assertRpcError(() -> authenticated.generateDescription(DescriptionRequest.newBuilder()
                        .setAudioData(payload).build()), Status.Code.FAILED_PRECONDITION,
                "MULTIMODAL_FAMILY_NOT_ADMITTED");
        assertRpcError(() -> authenticated.analyzeCrossModal(CrossModalRequest.newBuilder()
                        .setAudioData(payload).setVideoData(payload).build()),
                Status.Code.FAILED_PRECONDITION, "MULTIMODAL_FAMILY_NOT_ADMITTED");
        assertRpcError(() -> authenticated.getInsights(InsightsRequest.newBuilder()
                        .setAudioData(payload).build()), Status.Code.FAILED_PRECONDITION,
                "MULTIMODAL_FAMILY_NOT_ADMITTED");

        // A well-formed canonical binding reaches the trusted source-rights authority,
        // which is not configured in this composition and must fail closed.
        assertRpcError(() -> authenticated.processMultimodal(MultimodalRequest.newBuilder()
                        .setAudioData(payload)
                        .setOperationBinding(binding("media.multimodal.observe.source-grounded",
                                "media.operation.capability.media-multimodal-observe-source-grounded"))
                        .build()), Status.Code.UNAVAILABLE,
                "Trusted artifact rights, purpose, and consent authority is not configured");
        assertRpcError(() -> authenticated.analyzeVideoWithAudio(VideoAudioRequest.newBuilder()
                        .setVideoData(payload).setExtractAudio(true).setAnalyzeFrames(true)
                        .setOperationBinding(binding("media.multimodal.relate.scene-audio",
                                "media.operation.capability.media-multimodal-relate-scene-audio"))
                        .build()), Status.Code.UNAVAILABLE,
                "Trusted artifact rights, purpose, and consent authority is not configured");
        assertRpcError(() -> authenticated.generateDescription(DescriptionRequest.newBuilder()
                        .setAudioData(payload)
                        .setOperationBinding(binding("media.multimodal.describe",
                                "media.operation.capability.media-multimodal-describe"))
                        .build()), Status.Code.UNAVAILABLE,
                "Trusted artifact rights, purpose, and consent authority is not configured");
        assertRpcError(() -> authenticated.analyzeCrossModal(CrossModalRequest.newBuilder()
                        .setAudioData(payload).setVideoData(payload)
                        .setOperationBinding(binding("media.multimodal.analyze.cross-modal",
                                "media.operation.capability.media-multimodal-analyze-cross-modal"))
                        .build()), Status.Code.UNAVAILABLE,
                "Trusted artifact rights, purpose, and consent authority is not configured");
        assertRpcError(() -> authenticated.getInsights(InsightsRequest.newBuilder()
                        .setAudioData(payload)
                        .setOperationBinding(binding("media.multimodal.summarize",
                                "media.operation.capability.media-multimodal-summarize"))
                        .build()), Status.Code.UNAVAILABLE,
                "Trusted artifact rights, purpose, and consent authority is not configured");

        assertRpcError(() -> authenticated.loadModel(LoadModelRequest.newBuilder()
                        .setModelId("unadmitted-model").build()), Status.Code.UNAVAILABLE,
                "Qualified multimodal model provider is unavailable");
        assertRpcError(() -> authenticated.unloadModel(UnloadModelRequest.newBuilder()
                        .setModelId("unadmitted-model").build()), Status.Code.UNAVAILABLE,
                "Qualified multimodal model provider is unavailable");
        assertRpcError(() -> authenticated.listModels(ListModelsRequest.getDefaultInstance()),
                Status.Code.UNAVAILABLE, "Qualified multimodal model provider is unavailable");

        StatusResponse status = authenticated.getStatus(StatusRequest.getDefaultInstance());
        assertThat(status.getStatus()).isEqualTo("NOT_ADMITTED");
        HealthCheckResponse health = authenticated.healthCheck(HealthCheckRequest.getDefaultInstance());
        assertThat(health.getHealthy()).isFalse();
        assertThat(health.getMessage()).isEqualTo(
                "MULTIMODAL_NOT_SERVING: qualified child provider readiness unavailable");
    }

    private static CanonicalOperationBinding binding(String capabilityRef, String operationRef) {
        return CanonicalOperationBinding.newBuilder()
                .setCapabilityRef(capabilityRef)
                .setOperationRef(operationRef)
                .setOperationVersion(1)
                .setRequestId("rpc-matrix-request")
                .setSourceArtifactId("rpc-matrix-artifact")
                .setSourceVersionId("v1")
                .setPurpose("authenticated-rpc-matrix-test")
                .build();
    }

    @Test
    void missingBearerIsRejectedForAllTenRegisteredRpcs() {
        ByteString payload = ByteString.copyFrom(new byte[] {1});

        assertUnauthenticated(() -> unauthenticated.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(payload).build()));
        assertUnauthenticated(() -> unauthenticated.analyzeVideoWithAudio(VideoAudioRequest.newBuilder()
                .setVideoData(payload).setExtractAudio(true).setAnalyzeFrames(true).build()));
        assertUnauthenticated(() -> unauthenticated.generateDescription(DescriptionRequest.newBuilder()
                .setAudioData(payload).build()));
        assertUnauthenticated(() -> unauthenticated.analyzeCrossModal(CrossModalRequest.newBuilder()
                .setAudioData(payload).setVideoData(payload).build()));
        assertUnauthenticated(() -> unauthenticated.getInsights(InsightsRequest.newBuilder()
                .setAudioData(payload).build()));
        assertUnauthenticated(() -> unauthenticated.loadModel(LoadModelRequest.newBuilder()
                .setModelId("model").build()));
        assertUnauthenticated(() -> unauthenticated.unloadModel(UnloadModelRequest.newBuilder()
                .setModelId("model").build()));
        assertUnauthenticated(() -> unauthenticated.listModels(ListModelsRequest.getDefaultInstance()));
        assertUnauthenticated(() -> unauthenticated.getStatus(StatusRequest.getDefaultInstance()));
        assertUnauthenticated(() -> unauthenticated.healthCheck(HealthCheckRequest.getDefaultInstance()));
    }

    @Test
    void malformedRequestsFailBeforeProviderDispositionAndVersionIsNotARequestField() {
        assertRpcCode(() -> authenticated.processMultimodal(MultimodalRequest.getDefaultInstance()),
                Status.Code.INVALID_ARGUMENT);
        assertRpcCode(() -> authenticated.analyzeVideoWithAudio(VideoAudioRequest.getDefaultInstance()),
                Status.Code.INVALID_ARGUMENT);
        assertRpcCode(() -> authenticated.generateDescription(DescriptionRequest.getDefaultInstance()),
                Status.Code.INVALID_ARGUMENT);
        assertRpcCode(() -> authenticated.analyzeCrossModal(CrossModalRequest.getDefaultInstance()),
                Status.Code.INVALID_ARGUMENT);
        assertRpcCode(() -> authenticated.getInsights(InsightsRequest.getDefaultInstance()),
                Status.Code.INVALID_ARGUMENT);
        assertRpcCode(() -> authenticated.loadModel(LoadModelRequest.getDefaultInstance()),
                Status.Code.INVALID_ARGUMENT);
        assertRpcCode(() -> authenticated.unloadModel(UnloadModelRequest.getDefaultInstance()),
                Status.Code.INVALID_ARGUMENT);

        List<Descriptors.Descriptor> requestTypes = List.of(
                MultimodalRequest.getDescriptor(), VideoAudioRequest.getDescriptor(),
                DescriptionRequest.getDescriptor(), CrossModalRequest.getDescriptor(),
                InsightsRequest.getDescriptor(), LoadModelRequest.getDescriptor(),
                UnloadModelRequest.getDescriptor(), ListModelsRequest.getDescriptor(),
                StatusRequest.getDescriptor(), HealthCheckRequest.getDescriptor());
        assertThat(MultimodalServiceGrpc.getServiceDescriptor().getMethods()).hasSize(10);
        Set<String> rpcNames = MultimodalServiceGrpc.getServiceDescriptor().getMethods().stream()
                .map(io.grpc.MethodDescriptor::getBareMethodName)
                .collect(Collectors.toSet());
        assertThat(rpcNames).containsExactlyInAnyOrder("ProcessMultimodal", "AnalyzeVideoWithAudio",
                "GenerateDescription", "AnalyzeCrossModal", "GetInsights", "LoadModel", "UnloadModel",
                "ListModels", "GetStatus", "HealthCheck");

        // The Multimodal request protos have no protocol version field, so a request-version case is N/A.
        for (Descriptors.Descriptor requestType : requestTypes) {
            assertThat(requestType.findFieldByName("api_version")).as(requestType.getFullName()).isNull();
            assertThat(requestType.findFieldByName("version")).as(requestType.getFullName()).isNull();
        }
    }

    private static void assertRpcError(
            org.assertj.core.api.ThrowableAssert.ThrowingCallable call,
            Status.Code expectedCode,
            String description) {
        assertThatThrownBy(call)
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(failure -> {
                    StatusRuntimeException rpcFailure = (StatusRuntimeException) failure;
                    assertThat(rpcFailure.getStatus().getCode()).isEqualTo(expectedCode);
                    assertThat(rpcFailure.getStatus().getDescription()).contains(description);
                });
    }

    private static void assertRpcCode(
            org.assertj.core.api.ThrowableAssert.ThrowingCallable call,
            Status.Code expectedCode) {
        assertThatThrownBy(call)
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(failure -> assertThat(((StatusRuntimeException) failure).getStatus().getCode())
                        .isEqualTo(expectedCode));
    }

    private static void assertUnauthenticated(
            org.assertj.core.api.ThrowableAssert.ThrowingCallable call) {
        assertRpcCode(call, Status.Code.UNAUTHENTICATED);
    }

    private static String signedJwt() throws Exception {
        String header = Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        String payload = Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("{\"sub\":\"" + SUBJECT + "\",\"tenantId\":\"" + TENANT + "\",\"exp\":"
                        + (System.currentTimeMillis() / 1000 + 3600) + "}")
                        .getBytes(StandardCharsets.UTF_8));
        String unsigned = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(TEST_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String signature = Base64.getUrlEncoder().withoutPadding().encodeToString(
                mac.doFinal(unsigned.getBytes(StandardCharsets.UTF_8)));
        return unsigned + "." + signature;
    }

    private static void restoreProperty(String key, String value) {
        if (value == null) System.clearProperty(key);
        else System.setProperty(key, value);
    }
}
