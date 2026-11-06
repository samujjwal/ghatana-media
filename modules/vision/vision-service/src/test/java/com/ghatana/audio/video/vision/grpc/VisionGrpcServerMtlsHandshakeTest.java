package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.vision.model.VisionModelProfile;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audio.video.vision.yolo.YoloV8Adapter;
import com.ghatana.audiovideo.observability.AudioVideoHealthService;
import io.grpc.ManagedChannel;
import io.grpc.StatusRuntimeException;
import io.grpc.health.v1.HealthCheckRequest;
import io.grpc.health.v1.HealthCheckResponse;
import io.grpc.health.v1.HealthGrpc;
import io.grpc.netty.shaded.io.grpc.netty.GrpcSslContexts;
import io.grpc.netty.shaded.io.grpc.netty.NettyChannelBuilder;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class VisionGrpcServerMtlsHandshakeTest {
    private String previousSecret;

    @BeforeEach
    void configureLocalAuth() {
        previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", "vision-mtls-test-only-secret-not-for-production");
    }

    @AfterEach
    void restoreLocalAuth() {
        if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
        else System.setProperty("AV_JWT_SECRET", previousSecret);
    }

    @Test
    void localVisionListenerRejectsMissingClientCertificateAndAcceptsTrustedTestIdentity() throws Exception {
        Path serverCertificate = tlsFixture("rotation-a-cert.pem");
        Path serverPrivateKey = tlsFixture("rotation-a-key.pem");
        Path clientCertificate = tlsFixture("rotation-b-cert.pem");
        Path clientPrivateKey = tlsFixture("rotation-b-key.pem");
        var security = VisionGrpcServer.transportSecurity(Map.of(
                "VISION_ENVIRONMENT", "production",
                "VISION_GRPC_TLS_CERT_CHAIN_PATH", serverCertificate.toString(),
                "VISION_GRPC_TLS_PRIVATE_KEY_PATH", serverPrivateKey.toString(),
                "VISION_GRPC_TLS_CLIENT_CA_PATH", clientCertificate.toString()));

        YoloV8Adapter detector = mock(YoloV8Adapter.class);
        when(detector.isInitialized()).thenReturn(false);
        VisionModelProfile fixtureProfile = new VisionModelProfile(
                "fixture-model", "fixture-version", Path.of("/fixture"), Path.of("/fixture/model.onnx"),
                "a".repeat(64), "test-only-license-label", java.util.List.of("cat"),
                VisionModelProfile.Device.CPU, 1L);
        ProductionVisionGrpcService service = new ProductionVisionGrpcService(
                new ProductionVisionGrpcService.Composition(
                        detector, new VideoFrameExtractor(), fixtureProfile),
                MediaProcessingMetrics.create());
        AudioVideoHealthService readiness = VisionGrpcServer.createReadinessLifecycle(
                new SimpleMeterRegistry(), service::isProviderReady);
        service.setReadinessProbe(readiness::isServing);
        VisionGrpcServer server = new VisionGrpcServer(0, security, service, readiness);
        ManagedChannel channel = null;
        ManagedChannel unauthenticatedChannel = null;
        try {
            server.start();
            var unauthenticatedTls = GrpcSslContexts.forClient()
                    .trustManager(serverCertificate.toFile())
                    .build();
            unauthenticatedChannel = NettyChannelBuilder.forAddress("localhost", server.getPort())
                    .sslContext(unauthenticatedTls)
                    .overrideAuthority("localhost")
                    .build();
            ManagedChannel noCertificateChannel = unauthenticatedChannel;
            assertThatThrownBy(() -> HealthGrpc.newBlockingStub(noCertificateChannel)
                    .withDeadlineAfter(3, java.util.concurrent.TimeUnit.SECONDS)
                    .check(HealthCheckRequest.getDefaultInstance()))
                    .isInstanceOf(StatusRuntimeException.class);

            var clientTls = GrpcSslContexts.forClient()
                    .trustManager(serverCertificate.toFile())
                    .keyManager(clientCertificate.toFile(), clientPrivateKey.toFile())
                    .build();
            channel = NettyChannelBuilder.forAddress("localhost", server.getPort())
                    .sslContext(clientTls)
                    .overrideAuthority("localhost")
                    .build();
            HealthCheckResponse response = HealthGrpc.newBlockingStub(channel)
                    .withDeadlineAfter(3, java.util.concurrent.TimeUnit.SECONDS)
                    .check(HealthCheckRequest.getDefaultInstance());
            assertThat(response.getStatus()).isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
        } finally {
            if (unauthenticatedChannel != null) {
                unauthenticatedChannel.shutdownNow();
                unauthenticatedChannel.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS);
            }
            if (channel != null) {
                channel.shutdownNow();
                channel.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS);
            }
            server.close();
        }
    }

    private static Path tlsFixture(String name) throws Exception {
        return Path.of(VisionGrpcServerMtlsHandshakeTest.class.getResource("/tls/" + name).toURI());
    }
}
