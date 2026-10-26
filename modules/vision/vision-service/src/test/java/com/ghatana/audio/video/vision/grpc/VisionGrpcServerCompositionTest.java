package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.AudioVideoGrpcServerBase;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.observability.MetricsServerInterceptor;
import com.ghatana.audio.video.vision.model.VisionModelProfile;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audio.video.vision.yolo.YoloV8Adapter;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.audio.video.vision.grpc.proto.DetectRequest;
import com.ghatana.audio.video.vision.grpc.proto.VisionServiceGrpc;
import com.google.protobuf.ByteString;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import io.grpc.Metadata;
import io.grpc.stub.MetadataUtils;
import io.grpc.health.v1.HealthCheckRequest;
import io.grpc.health.v1.HealthCheckResponse;
import io.grpc.health.v1.HealthGrpc;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;

import java.net.ServerSocket;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

class VisionGrpcServerCompositionTest {
    private String previousSecret;

    @BeforeEach void configureLocalAuth() {
        previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", "composition-test-only-secret-for-root-tests");
    }

    @AfterEach void restoreLocalAuth() {
        if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
        else System.setProperty("AV_JWT_SECRET", previousSecret);
    }

    @Test
    void productionRootStartsNotServingAndRecordsBoundedHealthRpcThenDrains() throws Exception {
        var metrics = new SimpleMeterRegistry();
        YoloV8Adapter detector = mock(YoloV8Adapter.class);
        MediaProcessingRuntimePort mediaRuntimePort = mock(MediaProcessingRuntimePort.class);
        when(detector.isInitialized()).thenReturn(false);
        var profile = new VisionModelProfile("fixture", "test", Path.of("/unused"), Path.of("/unused/model.onnx"),
                "a".repeat(64), "test-only", List.of("object"), VisionModelProfile.Device.CPU, 1L);
        var service = new ProductionVisionGrpcService(
                new ProductionVisionGrpcService.Composition(detector, new VideoFrameExtractor(), profile),
                MediaProcessingMetrics.create(), metrics, mediaRuntimePort);
        assertThat(service.mediaRuntimePort()).isSameAs(mediaRuntimePort);
        var readiness = VisionGrpcServer.createReadinessLifecycle(metrics, service::isProviderReady);
        service.setReadinessProbe(readiness::isServing);
        int port = freePort();
        var server = new VisionGrpcServer(port, AudioVideoGrpcServerBase.TransportSecurity.plaintext(), service, readiness);
        ManagedChannel channel = null;
        try {
            server.start();
            assertThat(server.isShutdown()).isFalse();
            assertThat(server.isReady()).isFalse();
            channel = ManagedChannelBuilder.forAddress("127.0.0.1", server.getPort()).usePlaintext().build();
            AtomicReference<Metadata> responseHeaders = new AtomicReference<>();
            var result = HealthGrpc.newBlockingStub(channel)
                    .withInterceptors(MetadataUtils.newCaptureMetadataInterceptor(responseHeaders, new AtomicReference<>()))
                    .check(HealthCheckRequest.getDefaultInstance());
            assertThat(result.getStatus()).isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
            assertTraceHeaders(responseHeaders.get());
            String scrape = MetricsServerInterceptor.getInstance().scrape();
            assertThat(scrape).contains("av_service_readiness{service=\"vision\"} 0")
                    .contains("grpc_server_handled_total{grpc_method=\"grpc.health.v1.Health/Check\",grpc_code=\"OK\"}");
            String method = "com.ghatana.audio.video.vision.grpc.VisionService/DetectObjects";
            long before = handledCount(scrape, method, "UNAVAILABLE");
            var stub = VisionServiceGrpc.newBlockingStub(channel)
                    .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(authenticatedHeaders()));
            assertThatThrownBy(() -> stub.detectObjects(DetectRequest.newBuilder()
                            .setImageData(ByteString.copyFrom(new byte[] {1})).build()))
                    .isInstanceOf(io.grpc.StatusRuntimeException.class)
                    .hasMessageContaining("PROVIDER_NOT_ADMITTED");
            verify(detector, never()).detectObjects(org.mockito.ArgumentMatchers.any(byte[].class),
                    org.mockito.ArgumentMatchers.any());
            verifyNoInteractions(mediaRuntimePort);
            assertThat(handledCount(MetricsServerInterceptor.getInstance().scrape(), method, "UNAVAILABLE"))
                    .isEqualTo(before + 1);
        } finally {
            if (channel != null) channel.shutdownNow().awaitTermination(5, TimeUnit.SECONDS);
            server.close();
        }
        assertThat(server.isShutdown()).isTrue();
        assertThat(server.isReady()).isFalse();

        var replacementMetrics = new SimpleMeterRegistry();
        YoloV8Adapter replacementDetector = mock(YoloV8Adapter.class);
        when(replacementDetector.isInitialized()).thenReturn(false);
        var replacementProfile = new VisionModelProfile("fixture", "test", Path.of("/unused"),
                Path.of("/unused/model.onnx"), "a".repeat(64), "test-only", List.of("object"),
                VisionModelProfile.Device.CPU, 1L);
        var replacementService = new ProductionVisionGrpcService(
                new ProductionVisionGrpcService.Composition(replacementDetector, new VideoFrameExtractor(), replacementProfile),
                MediaProcessingMetrics.create(), replacementMetrics);
        var replacementReadiness = VisionGrpcServer.createReadinessLifecycle(
                replacementMetrics, replacementService::isProviderReady);
        replacementService.setReadinessProbe(replacementReadiness::isServing);
        var replacement = new VisionGrpcServer(port, AudioVideoGrpcServerBase.TransportSecurity.plaintext(),
                replacementService, replacementReadiness);
        replacement.start();
        assertThat(replacement.isShutdown()).isFalse();
        assertThat(replacement.isReady()).isFalse();
        replacement.close();
        assertThat(replacement.isShutdown()).isTrue();
    }

    @Test
    void failedGrpcBindLeavesProductionRootDownAndClosed() throws Exception {
        try (ServerSocket occupied = new ServerSocket(0)) {
            var metrics = new SimpleMeterRegistry();
            YoloV8Adapter detector = mock(YoloV8Adapter.class);
            when(detector.isInitialized()).thenReturn(false);
            var profile = new VisionModelProfile("fixture", "test", Path.of("/unused"), Path.of("/unused/model.onnx"),
                    "a".repeat(64), "test-only", List.of("object"), VisionModelProfile.Device.CPU, 1L);
            var service = new ProductionVisionGrpcService(
                    new ProductionVisionGrpcService.Composition(detector, new VideoFrameExtractor(), profile),
                    MediaProcessingMetrics.create(), metrics);
            var readiness = VisionGrpcServer.createReadinessLifecycle(metrics, service::isProviderReady);
            service.setReadinessProbe(readiness::isServing);
            var server = new VisionGrpcServer(occupied.getLocalPort(),
                    AudioVideoGrpcServerBase.TransportSecurity.plaintext(), service, readiness);
            assertThatThrownBy(server::start).isInstanceOf(java.io.IOException.class);
            assertThat(server.isShutdown()).isTrue();
            assertThat(server.isReady()).isFalse();
            server.close();
        }
    }

    private static int freePort() throws Exception {
        try (ServerSocket socket = new ServerSocket(0)) { return socket.getLocalPort(); }
    }

    private static Metadata authenticatedHeaders() throws Exception {
        String secret = "composition-test-only-secret-for-root-tests";
        String header = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String payload = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("{\"sub\":\"00000000-0000-0000-0000-000000000001\",\"tenantId\":\"tenant-vision-root\",\"exp\":"
                        + (System.currentTimeMillis() / 1000 + 3600) + "}")
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String unsigned = header + "." + payload;
        javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
        mac.init(new javax.crypto.spec.SecretKeySpec(secret.getBytes(java.nio.charset.StandardCharsets.UTF_8), "HmacSHA256"));
        String token = unsigned + "." + java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(unsigned.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        Metadata auth = new Metadata();
        auth.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + token);
        auth.put(Metadata.Key.of("x-roles", Metadata.ASCII_STRING_MARSHALLER), "av:user");
        return auth;
    }

    private static long handledCount(String scrape, String method, String code) {
        String prefix = "grpc_server_handled_total{grpc_method=\"" + method + "\",grpc_code=\"" + code + "\"} ";
        return scrape.lines().filter(line -> line.startsWith(prefix)).map(line -> line.substring(prefix.length()))
                .mapToLong(Long::parseLong).findFirst().orElse(0L);
    }

    private static void assertTraceHeaders(Metadata headers) {
        assertThat(headers.get(Metadata.Key.of("x-trace-id", Metadata.ASCII_STRING_MARSHALLER)))
                .matches("[0-9a-f]{32}");
        assertThat(headers.get(Metadata.Key.of("x-span-id", Metadata.ASCII_STRING_MARSHALLER)))
                .matches("[0-9a-f]{16}");
    }
}
