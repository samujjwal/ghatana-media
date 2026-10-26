package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.common.AudioVideoGrpcServerBase;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.observability.MetricsServerInterceptor;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.audio.video.multimodal.engine.MultimodalAnalysisEngine;
import com.ghatana.audio.video.multimodal.engine.AudioResult;
import com.ghatana.audio.video.multimodal.engine.MultimodalMediaGateway;
import com.ghatana.audio.video.multimodal.engine.VisualResult;
import com.ghatana.audio.video.multimodal.engine.PlatformMultimodalAdapter;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalRequest;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceGrpc;
import com.google.protobuf.ByteString;
import com.ghatana.audiovideo.observability.MediaWorkflowMetrics;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import io.grpc.Metadata;
import io.grpc.stub.MetadataUtils;
import io.grpc.health.v1.HealthCheckRequest;
import io.grpc.health.v1.HealthCheckResponse;
import io.grpc.health.v1.HealthGrpc;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;

import java.net.ServerSocket;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

class MultimodalGrpcServerCompositionTest {
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
        var engine = mock(MultimodalAnalysisEngine.class);
        var platformAdapter = mock(PlatformMultimodalAdapter.class);
        var mediaRuntimePort = mock(MediaProcessingRuntimePort.class);
        var service = new MultimodalGrpcService(
                engine, platformAdapter, MediaProcessingMetrics.create(), mediaRuntimePort);
        assertThat(service.mediaRuntimePort()).isSameAs(mediaRuntimePort);
        var readiness = MultimodalGrpcServer.readinessService(service);
        int port = freePort();
        var server = new MultimodalGrpcServer(
                port, AudioVideoGrpcServerBase.TransportSecurity.plaintext(), service, readiness);
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
            assertThat(scrape).contains("av_service_readiness{service=\"multimodal\"} 0")
                    .contains("grpc_server_handled_total{grpc_method=\"grpc.health.v1.Health/Check\",grpc_code=\"OK\"}");
            String method = "com.ghatana.audio.video.multimodal.grpc.MultimodalService/ProcessMultimodal";
            long before = handledCount(scrape, method, "UNAVAILABLE");
            var stub = MultimodalServiceGrpc.newBlockingStub(channel)
                    .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(authenticatedHeaders()));
            assertThatThrownBy(() -> stub.processMultimodal(MultimodalRequest.newBuilder()
                            .setAudioData(ByteString.copyFrom(new byte[] {1}))
                            .setOperationBinding(com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding
                                    .newBuilder().setOperationVersion(1)
                                    .setCapabilityRef("media.multimodal.observe.source-grounded")
                                    .setOperationRef("media.operation.capability.media-multimodal-observe-source-grounded")
                                    .setRequestId("composition-request")
                                    .setSourceArtifactId("composition-artifact")
                                    .setSourceVersionId("composition-version")
                                    .setPurpose("composition fixture").build())
                            .build()))
                    .isInstanceOf(io.grpc.StatusRuntimeException.class)
                    .hasMessageContaining("Trusted artifact rights, purpose, and consent authority is not configured");
            verifyNoInteractions(engine, platformAdapter, mediaRuntimePort);
            assertThat(handledCount(MetricsServerInterceptor.getInstance().scrape(), method, "UNAVAILABLE"))
                    .isEqualTo(before + 1);
        } finally {
            if (channel != null) channel.shutdownNow().awaitTermination(5, TimeUnit.SECONDS);
            server.close();
        }
        assertThat(server.isShutdown()).isTrue();
        assertThat(server.isReady()).isFalse();

        var replacementService = new MultimodalGrpcService(
                mock(MultimodalAnalysisEngine.class), mock(PlatformMultimodalAdapter.class),
                MediaProcessingMetrics.create());
        var replacementReadiness = MultimodalGrpcServer.readinessService(replacementService);
        var replacement = new MultimodalGrpcServer(port, AudioVideoGrpcServerBase.TransportSecurity.plaintext(),
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
            var service = new MultimodalGrpcService(MediaProcessingMetrics.create());
            var readiness = MultimodalGrpcServer.readinessService(service);
            var server = new MultimodalGrpcServer(occupied.getLocalPort(),
                    AudioVideoGrpcServerBase.TransportSecurity.plaintext(), service, readiness);
            assertThatThrownBy(server::start).isInstanceOf(java.io.IOException.class);
            assertThat(server.isShutdown()).isTrue();
            assertThat(server.isReady()).isFalse();
            server.close();
        }
    }

    @Test
    void authenticatedFixtureChildErrorIsReportedUnavailableWithoutRetryOrSuccessOutput() throws Exception {
        String tenant = "tenant-multimodal-child-fixture";
        UUID principal = UUID.fromString("00000000-0000-0000-0000-000000000001");
        AtomicInteger childAttempts = new AtomicInteger();
        MultimodalMediaGateway gateway = new MultimodalMediaGateway() {
            @Override public AudioResult transcribe(byte[] audioData) {
                childAttempts.incrementAndGet();
                return AudioResult.error("fixture-only child provider unavailable");
            }
            @Override public VisualResult analyseImage(byte[] imageData) {
                throw new AssertionError("image child must not be dispatched for audio-only input");
            }
            @Override public VisualResult analyseVideo(byte[] videoData, int sampleFps, int maxFrames) {
                throw new AssertionError("video child must not be dispatched for audio-only input");
            }
            @Override public String backendName() { return "fixture-only"; }
            @Override public boolean metricsEnabled() { return false; }
            @Override public void close() { }
        };
        var engineMetrics = new SimpleMeterRegistry();
        var engine = new MultimodalAnalysisEngine(gateway,
                new MediaWorkflowMetrics(engineMetrics, "multimodal-fixture"));
        var fixtureAuthorization = (SourceAuthorization) request ->
                request.tenantId().equals(tenant)
                        && request.principalId().equals(principal)
                        && request.modalities().equals(Set.of(SourceAuthorization.Modality.AUDIO))
                        && request.purpose().equals("multimodal.analyse")
                        && request.contentBytes() == 1
                        ? SourceAuthorization.Decision.ADMITTED
                        : SourceAuthorization.Decision.NOT_ADMITTED;
        var service = new MultimodalGrpcService(engine, mock(PlatformMultimodalAdapter.class),
                MediaProcessingMetrics.create(), fixtureAuthorization, fixtureExecutor());
        var readiness = MultimodalGrpcServer.readinessService(service);
        int port = freePort();
        var server = new MultimodalGrpcServer(port, AudioVideoGrpcServerBase.TransportSecurity.plaintext(),
                service, readiness);
        ManagedChannel channel = null;
        try {
            server.start();
            channel = ManagedChannelBuilder.forAddress("127.0.0.1", server.getPort()).usePlaintext().build();
            AtomicReference<Metadata> healthHeaders = new AtomicReference<>();
            var health = HealthGrpc.newBlockingStub(channel)
                    .withInterceptors(MetadataUtils.newCaptureMetadataInterceptor(
                            healthHeaders, new AtomicReference<>()))
                    .check(HealthCheckRequest.getDefaultInstance());
            assertThat(health.getStatus()).isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
            assertTraceHeaders(healthHeaders.get());
            var stub = MultimodalServiceGrpc.newBlockingStub(channel)
                    .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(authenticatedHeaders(tenant)));
            String method = "com.ghatana.audio.video.multimodal.grpc.MultimodalService/ProcessMultimodal";
            String initialScrape = MetricsServerInterceptor.getInstance().scrape();
            long before = handledCount(initialScrape, method, "UNAVAILABLE");
            assertThatThrownBy(() -> stub.processMultimodal(MultimodalRequest.newBuilder()
                            .setAudioData(ByteString.copyFrom(new byte[] {7}))
                            .setOperationBinding(com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding
                                    .newBuilder().setOperationVersion(1)
                                    .setCapabilityRef("media.multimodal.observe.source-grounded")
                                    .setOperationRef("media.operation.capability.media-multimodal-observe-source-grounded")
                                    .setRequestId("composition-child-request")
                                    .setSourceArtifactId("composition-child-artifact")
                                    .setSourceVersionId("composition-child-version")
                                    .setPurpose("multimodal.analyse").build())
                            .build()))
                    .isInstanceOf(io.grpc.StatusRuntimeException.class)
                    .satisfies(error -> {
                        var status = io.grpc.Status.fromThrowable(error);
                        assertThat(status.getCode()).isEqualTo(io.grpc.Status.Code.UNAVAILABLE);
                        assertThat(status.getDescription()).isEqualTo(
                                "A requested multimodal provider did not produce a result");
                    });
            assertThat(childAttempts).hasValue(1);
            assertThat(handledCount(MetricsServerInterceptor.getInstance().scrape(), method, "UNAVAILABLE"))
                    .isEqualTo(before + 1);
            assertThat(engineMetrics.find("media.modality.boundary.duration")
                    .tag("modality", "stt").tag("boundary", "provider").tag("outcome", "failure")
                    .timer().count()).isEqualTo(1);
            assertThat(server.isReady()).isFalse();
        } finally {
            if (channel != null) channel.shutdownNow().awaitTermination(5, TimeUnit.SECONDS);
            server.close();
            engine.close();
        }
        assertThat(server.isShutdown()).isTrue();
    }

    private static int freePort() throws Exception {
        try (ServerSocket socket = new ServerSocket(0)) { return socket.getLocalPort(); }
    }

    private static CanonicalOperationExecutor fixtureExecutor() {
        return new CanonicalOperationExecutor() {
            @Override
            public <T> T execute(com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding binding,
                                 String operationRef, java.util.concurrent.Callable<T> action) throws Exception {
                return action.call();
            }
        };
    }

    private static Metadata authenticatedHeaders() throws Exception {
        return authenticatedHeaders("tenant-multimodal-root");
    }

    private static Metadata authenticatedHeaders(String tenantId) throws Exception {
        String secret = "composition-test-only-secret-for-root-tests";
        String header = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String payload = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("{\"sub\":\"00000000-0000-0000-0000-000000000001\",\"tenantId\":\"" + tenantId + "\",\"exp\":"
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
