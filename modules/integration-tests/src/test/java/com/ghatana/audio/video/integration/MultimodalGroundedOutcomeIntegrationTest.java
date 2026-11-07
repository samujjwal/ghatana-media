package com.ghatana.audio.video.integration;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.multimodal.grpc.MultimodalGrpcService;
import com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding;
import com.ghatana.audio.video.multimodal.grpc.proto.CrossModalRequest;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceGrpc;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.google.protobuf.ByteString;
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

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * Source-free J-06 journey guard: a bound cross-modal request cannot produce a
 * completed parent response when trusted source rights are unavailable.
 * The request contains opaque bytes only; no fixture output is treated as a real child result.
 */
class MultimodalGroundedOutcomeIntegrationTest {
    private static final String JWT_SECRET = "j06-grounded-outcome-test-secret";
    private static final String TENANT = "tenant-j06-grounded-outcome";
    private static final String SUBJECT = "00000000-0000-0000-0000-000000000006";

    private String previousSecret;
    private String previousAuthGatewayUrl;
    private Server server;
    private ManagedChannel channel;
    private MultimodalServiceGrpc.MultimodalServiceBlockingStub client;
    private MultimodalGrpcService service;
    private MediaProcessingRuntimePort runtimePort;

    @BeforeEach
    void setUp() throws Exception {
        previousSecret = System.getProperty("AV_JWT_SECRET");
        previousAuthGatewayUrl = System.getProperty("AUTH_GATEWAY_URL");
        System.setProperty("AV_JWT_SECRET", JWT_SECRET);
        System.setProperty("AUTH_GATEWAY_URL", "");

        runtimePort = mock(MediaProcessingRuntimePort.class);
        service = new MultimodalGrpcService(MediaProcessingMetrics.noop(), runtimePort);
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
        client = MultimodalServiceGrpc.newBlockingStub(channel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));
    }

    @AfterEach
    void tearDown() {
        if (channel != null) channel.shutdownNow();
        if (server != null) server.shutdownNow();
        if (service != null) service.close();
        restoreProperty("AV_JWT_SECRET", previousSecret);
        restoreProperty("AUTH_GATEWAY_URL", previousAuthGatewayUrl);
    }

    @Test
    void unavailableTrustedRightsCannotReturnACompletedGroundedCrossModalParent() {
        ByteString opaqueAudio = ByteString.copyFrom(new byte[] {0x11, 0x22});
        ByteString opaqueVideo = ByteString.copyFrom(new byte[] {0x33, 0x44});
        CrossModalRequest request = CrossModalRequest.newBuilder()
                .setAudioData(opaqueAudio)
                .setVideoData(opaqueVideo)
                .setOperationBinding(CanonicalOperationBinding.newBuilder()
                        .setCapabilityRef("media.multimodal.analyze.cross-modal")
                        .setOperationRef("media.operation.capability.media-multimodal-analyze-cross-modal")
                        .setOperationVersion(1)
                        .setRequestId("j06-cross-modal-request")
                        .setSourceArtifactId("j06-source-artifact")
                        .setSourceVersionId("v1")
                        .setPurpose("j06-grounded-outcome-integration-test")
                        .setCorrelationId("j06-correlation")
                        .build())
                .build();

        assertThatThrownBy(() -> client.analyzeCrossModal(request))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(failure -> {
                    StatusRuntimeException rpcFailure = (StatusRuntimeException) failure;
                    assertThat(rpcFailure.getStatus().getCode()).isEqualTo(Status.Code.UNAVAILABLE);
                    assertThat(rpcFailure.getStatus().getDescription())
                            .contains("Trusted artifact rights, purpose, and consent authority is not configured");
                });
        verifyNoInteractions(runtimePort);
    }

    @Test
    void unknownSourceClockAndRightsCannotCompleteParentOrDispatchChildren() {
        CrossModalRequest request = CrossModalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {0x15, 0x26}))
                .setVideoData(ByteString.copyFrom(new byte[] {0x37, 0x48}))
                // The public request has a window but no source clock/PTS binding, so its
                // temporal coordinates remain unknown; caller-declared version is not authority.
                .setAnalysisWindowMs(1_000)
                .setOperationBinding(CanonicalOperationBinding.newBuilder()
                        .setCapabilityRef("media.multimodal.analyze.cross-modal")
                        .setOperationRef("media.operation.capability.media-multimodal-analyze-cross-modal")
                        .setOperationVersion(1)
                        .setRequestId("j06-unknown-clock-request")
                        .setSourceArtifactId("j06-source-artifact")
                        .setSourceVersionId("v1")
                        .setPurpose("j06-unknown-clock-integration-test")
                        .setCorrelationId("j06-unknown-clock-correlation")
                        .build())
                .build();

        assertThatThrownBy(() -> client.analyzeCrossModal(request))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(failure -> {
                    StatusRuntimeException rpcFailure = (StatusRuntimeException) failure;
                    assertThat(rpcFailure.getStatus().getCode()).isEqualTo(Status.Code.UNAVAILABLE);
                    assertThat(rpcFailure.getStatus().getDescription())
                            .contains("Trusted artifact rights, purpose, and consent authority is not configured");
                });
        verifyNoInteractions(runtimePort);
    }

    private static String signedJwt() throws Exception {
        String header = Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        String payload = Base64.getUrlEncoder().withoutPadding().encodeToString((
                "{\"sub\":\"" + SUBJECT + "\",\"tenantId\":\"" + TENANT + "\",\"exp\":"
                        + (System.currentTimeMillis() / 1000 + 3600) + "}")
                .getBytes(StandardCharsets.UTF_8));
        String unsigned = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(JWT_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String signature = Base64.getUrlEncoder().withoutPadding().encodeToString(
                mac.doFinal(unsigned.getBytes(StandardCharsets.UTF_8)));
        return unsigned + "." + signature;
    }

    private static void restoreProperty(String key, String value) {
        if (value == null) System.clearProperty(key);
        else System.setProperty(key, value);
    }
}
