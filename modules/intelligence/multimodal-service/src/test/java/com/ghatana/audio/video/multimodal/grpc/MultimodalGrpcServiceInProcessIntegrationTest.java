package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audiovideo.observability.AudioVideoHealthService;
import com.ghatana.audio.video.multimodal.engine.MultimodalAnalysisEngine;
import com.ghatana.audio.video.multimodal.engine.PlatformMultimodalAdapter;

import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalRequest;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceGrpc;
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
import io.grpc.health.v1.HealthCheckResponse;
import io.grpc.health.v1.HealthGrpc;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * @doc.type class
 * @doc.purpose In-process gRPC integration coverage for multimodal service contract
 * @doc.layer product
 * @doc.pattern Integration Test
 */
@DisplayName("MultimodalGrpcService In-Process Integration")
class MultimodalGrpcServiceInProcessIntegrationTest {

    private static final String TEST_TENANT = "tenant-integration-test";

    private Server server;
    private ManagedChannel channel;
    private MultimodalGrpcService service;
    private MultimodalAnalysisEngine engine;
    private PlatformMultimodalAdapter adapter;
    private AudioVideoHealthService readiness;
    private AtomicBoolean sttProviderReady;
    private AtomicBoolean visionProviderReady;
    private AtomicInteger authorizationCalls;

    @AfterEach
    void tearDown() {
        if (readiness != null) {
            readiness.setNotServing();
            readiness.close();
        }
        if (channel != null) {
            channel.shutdownNow();
        }
        if (server != null) {
            server.shutdownNow();
        }
    }

    @BeforeEach
    void setUp() throws Exception {
        engine = mock(MultimodalAnalysisEngine.class);
        adapter = mock(PlatformMultimodalAdapter.class);
        authorizationCalls = new AtomicInteger();

        service = new MultimodalGrpcService(engine, adapter, MediaProcessingMetrics.noop(),
                admitTestFixtureOnly());
        sttProviderReady = new AtomicBoolean(false);
        visionProviderReady = new AtomicBoolean(false);
        readiness = MultimodalGrpcServer.readinessService(
                service, sttProviderReady::get, visionProviderReady::get);

        server = ServerBuilder.forPort(0)
            .directExecutor()
            .intercept(new TenantInjector())
            .addService(service)
            .addService(readiness)
            .build()
            .start();
        assertThat(readiness.markReady()).isTrue();

        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort())
            .usePlaintext()
            .directExecutor()
            .build();
    }

    @Test
    @DisplayName("processMultimodal fails closed before engine dispatch without canonical operation binding")
    void processMultimodalWithoutOperationBindingFailsClosed() {
        MultimodalServiceGrpc.MultimodalServiceBlockingStub stub = MultimodalServiceGrpc.newBlockingStub(channel);

        assertFamilyOperationNotAdmitted(() -> stub.processMultimodal(
                MultimodalRequest.newBuilder()
                        .setAudioData(ByteString.copyFrom(new byte[] {0x01}))
                        .build()));
        verifyNoInteractions(engine, adapter);
    }

    @Test
    @DisplayName("standard and application health stay down without qualified child providers")
    void healthChecksRemainNotServingWithoutChildProviders() {
        HealthCheckResponse standard = HealthGrpc.newBlockingStub(channel)
                .check(io.grpc.health.v1.HealthCheckRequest.getDefaultInstance());
        com.ghatana.audio.video.multimodal.grpc.proto.HealthCheckResponse application =
                MultimodalServiceGrpc.newBlockingStub(channel)
                        .healthCheck(com.ghatana.audio.video.multimodal.grpc.proto.HealthCheckRequest
                                .getDefaultInstance());
        var status = MultimodalServiceGrpc.newBlockingStub(channel)
                .getStatus(com.ghatana.audio.video.multimodal.grpc.proto.StatusRequest.getDefaultInstance());

        assertThat(standard.getStatus()).isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
        assertThat(application.getHealthy()).isFalse();
        assertThat(application.getMessage()).contains("qualified child provider readiness unavailable");
        assertThat(status.getStatus()).isEqualTo("NOT_ADMITTED");
        assertThat(status.getStatus()).doesNotContain("healthy", "test-backend");
    }

    @Test
    @DisplayName("standard and application health follow child failure and drain")
    void healthChecksFollowChildFailureAndDrain() {
        // Mutable readiness signals are test fixtures only; they do not dispatch either modality.
        sttProviderReady.set(true);
        visionProviderReady.set(true);
        assertThat(HealthGrpc.newBlockingStub(channel)
                .check(io.grpc.health.v1.HealthCheckRequest.getDefaultInstance()).getStatus())
                .isEqualTo(HealthCheckResponse.ServingStatus.SERVING);
        assertThat(MultimodalServiceGrpc.newBlockingStub(channel)
                .healthCheck(com.ghatana.audio.video.multimodal.grpc.proto.HealthCheckRequest
                        .getDefaultInstance()).getHealthy()).isTrue();

        visionProviderReady.set(false);
        assertThat(HealthGrpc.newBlockingStub(channel)
                .check(io.grpc.health.v1.HealthCheckRequest.getDefaultInstance()).getStatus())
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
        assertThat(MultimodalServiceGrpc.newBlockingStub(channel)
                .healthCheck(com.ghatana.audio.video.multimodal.grpc.proto.HealthCheckRequest
                        .getDefaultInstance()).getHealthy()).isFalse();

        visionProviderReady.set(true);
        readiness.setNotServing();
        assertThat(HealthGrpc.newBlockingStub(channel)
                .check(io.grpc.health.v1.HealthCheckRequest.getDefaultInstance()).getStatus())
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
        assertThat(MultimodalServiceGrpc.newBlockingStub(channel)
                .healthCheck(com.ghatana.audio.video.multimodal.grpc.proto.HealthCheckRequest
                        .getDefaultInstance()).getHealthy()).isFalse();
    }

    @Test
    @DisplayName("processMultimodal does not expose provider failure before operation admission")
    void processMultimodalAdmissionPrecedesEngineDispatch() throws Exception {
        MultimodalAnalysisEngine failingEngine = mock(MultimodalAnalysisEngine.class);
        PlatformMultimodalAdapter adapter = mock(PlatformMultimodalAdapter.class);

        if (channel != null) {
            channel.shutdownNow();
        }
        if (server != null) {
            server.shutdownNow();
        }

        server = ServerBuilder.forPort(0)
            .directExecutor()
            .intercept(new TenantInjector())
            .addService(new MultimodalGrpcService(failingEngine, adapter, MediaProcessingMetrics.noop(),
                    admitTestFixtureOnly()))
            .build()
            .start();
        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort())
            .usePlaintext()
            .directExecutor()
            .build();

        MultimodalServiceGrpc.MultimodalServiceBlockingStub stub = MultimodalServiceGrpc.newBlockingStub(channel);

        assertFamilyOperationNotAdmitted(() -> stub.processMultimodal(
                MultimodalRequest.newBuilder().setAudioData(ByteString.copyFrom(new byte[] {0x01})).build()));
        verifyNoInteractions(failingEngine, adapter);
    }

    // AV-P1-015: E2E test for multimodal orchestration

    @Test
    @DisplayName("analyzeVideoWithAudio fails closed before unbound child-provider dispatch")
    void analyzeVideoWithAudioWithoutOperationBindingFailsClosed() throws Exception {
        MultimodalAnalysisEngine engine = mock(MultimodalAnalysisEngine.class);
        PlatformMultimodalAdapter adapter = mock(PlatformMultimodalAdapter.class);

        if (channel != null) {
            channel.shutdownNow();
        }
        if (server != null) {
            server.shutdownNow();
        }

        server = ServerBuilder.forPort(0)
            .directExecutor()
            .intercept(new TenantInjector())
            .addService(new MultimodalGrpcService(engine, adapter, MediaProcessingMetrics.noop(),
                    admitTestFixtureOnly()))
            .build()
            .start();
        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort())
            .usePlaintext()
            .directExecutor()
            .build();

        MultimodalServiceGrpc.MultimodalServiceBlockingStub stub = MultimodalServiceGrpc.newBlockingStub(channel);

        assertFamilyOperationNotAdmitted(() -> stub.analyzeVideoWithAudio(
                com.ghatana.audio.video.multimodal.grpc.proto.VideoAudioRequest.newBuilder()
                        .setVideoData(ByteString.copyFrom(new byte[] {0x01, 0x02, 0x03}))
                        .setExtractAudio(true)
                        .setAnalyzeFrames(true)
                        .setFrameSampleRate(1)
                        .build()));
        verifyNoInteractions(engine, adapter);
    }

    @Test
    @DisplayName("analyzeCrossModal fails closed before unbound synchronization analysis")
    void analyzeCrossModalWithoutOperationBindingFailsClosed() throws Exception {
        MultimodalAnalysisEngine engine = mock(MultimodalAnalysisEngine.class);
        PlatformMultimodalAdapter adapter = mock(PlatformMultimodalAdapter.class);

        if (channel != null) {
            channel.shutdownNow();
        }
        if (server != null) {
            server.shutdownNow();
        }

        server = ServerBuilder.forPort(0)
            .directExecutor()
            .intercept(new TenantInjector())
            .addService(new MultimodalGrpcService(engine, adapter, MediaProcessingMetrics.noop(),
                    admitTestFixtureOnly()))
            .build()
            .start();
        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort())
            .usePlaintext()
            .directExecutor()
            .build();

        MultimodalServiceGrpc.MultimodalServiceBlockingStub stub = MultimodalServiceGrpc.newBlockingStub(channel);

        assertFamilyOperationNotAdmitted(() -> stub.analyzeCrossModal(
                com.ghatana.audio.video.multimodal.grpc.proto.CrossModalRequest.newBuilder()
                        .setAudioData(ByteString.copyFrom(new byte[] {0x01}))
                        .setVideoData(ByteString.copyFrom(new byte[] {0x02}))
                        .build()));
        verifyNoInteractions(engine, adapter);
    }

    @Test
    @DisplayName("generateDescription fails closed before unbound semantic provider dispatch")
    void generateDescriptionWithoutOperationBindingFailsClosed() throws Exception {
        MultimodalAnalysisEngine engine = mock(MultimodalAnalysisEngine.class);
        PlatformMultimodalAdapter adapter = mock(PlatformMultimodalAdapter.class);

        if (channel != null) channel.shutdownNow();
        if (server != null) server.shutdownNow();
        server = ServerBuilder.forPort(0)
                .directExecutor()
                .intercept(new TenantInjector())
                .addService(new MultimodalGrpcService(engine, adapter, MediaProcessingMetrics.noop(),
                        admitTestFixtureOnly()))
                .build()
                .start();
        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort())
                .usePlaintext()
                .directExecutor()
                .build();

        assertFamilyOperationNotAdmitted(() -> MultimodalServiceGrpc.newBlockingStub(channel).generateDescription(
                com.ghatana.audio.video.multimodal.grpc.proto.DescriptionRequest.newBuilder()
                        .setImageData(ByteString.copyFrom(new byte[] {0x01}))
                        .build()));
        verifyNoInteractions(engine, adapter);
    }

    @Test
    @DisplayName("AV-P1-015: getInsights is unavailable without a qualified semantic provider")
    void getInsightsIsUnavailableWithoutQualifiedSemanticProvider() throws Exception {
        MultimodalAnalysisEngine engine = mock(MultimodalAnalysisEngine.class);
        PlatformMultimodalAdapter adapter = mock(PlatformMultimodalAdapter.class);

        if (channel != null) {
            channel.shutdownNow();
        }
        if (server != null) {
            server.shutdownNow();
        }

        server = ServerBuilder.forPort(0)
            .directExecutor()
            .intercept(new TenantInjector())
            .addService(new MultimodalGrpcService(engine, adapter, MediaProcessingMetrics.noop(),
                    admitTestFixtureOnly()))
            .build()
            .start();
        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort())
            .usePlaintext()
            .directExecutor()
            .build();

        MultimodalServiceGrpc.MultimodalServiceBlockingStub stub = MultimodalServiceGrpc.newBlockingStub(channel);

        assertThatThrownBy(() -> stub.getInsights(
                com.ghatana.audio.video.multimodal.grpc.proto.InsightsRequest.newBuilder()
                        .setAudioData(ByteString.copyFrom(new byte[]{0x01}))
                        .setText("Context text")
                        .setOperationBinding(CanonicalOperationBinding.newBuilder()
                                .setCapabilityRef("media.multimodal.summarize")
                                .setOperationRef("media.operation.capability.media-multimodal-summarize")
                                .setOperationVersion(1)
                                .setRequestId("insights-request-1")
                                .setSourceArtifactId("insights-artifact-1")
                                .setSourceVersionId("v1")
                                .setPurpose("summarize source")
                                .build())
                        .build()))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(error -> {
                    StatusRuntimeException status = (StatusRuntimeException) error;
                    assertThat(status.getStatus().getCode()).isEqualTo(Status.Code.UNAVAILABLE);
                    assertThat(status.getStatus().getDescription())
                            .contains("No qualified source-grounded semantic provider");
                });
        assertThat(authorizationCalls).hasValue(1);
        verifyNoInteractions(engine, adapter);
    }

    // ── TenantInjector: injects tenant into gRPC context server-side ──────────

    /** Explicit local fixture admission; never used by production construction. */
    private SourceAuthorization admitTestFixtureOnly() {
        return request -> {
            authorizationCalls.incrementAndGet();
            return SourceAuthorization.Decision.ADMITTED;
        };
    }

    private void assertFamilyOperationNotAdmitted(Runnable rpc) {
        int callsBefore = authorizationCalls.get();
        assertThatThrownBy(rpc::run)
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(error -> {
                    StatusRuntimeException status = (StatusRuntimeException) error;
                    assertThat(status.getStatus().getCode()).isEqualTo(Status.Code.FAILED_PRECONDITION);
                    assertThat(status.getStatus().getDescription())
                            .startsWith("MULTIMODAL_FAMILY_NOT_ADMITTED:");
                });
        assertThat(authorizationCalls).hasValue(callsBefore);
    }

    private static final class TenantInjector implements ServerInterceptor {
        @Override
        public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
                ServerCall<ReqT, RespT> call,
                Metadata headers,
                ServerCallHandler<ReqT, RespT> next) {
            Context ctx = Context.current().withValue(JwtServerInterceptor.CTX_TENANT, TEST_TENANT)
                    .withValue(JwtServerInterceptor.CTX_SUBJECT, "d7fe98ce-75d3-4a2a-8a04-bb54e23a2f15");
            return Contexts.interceptCall(ctx, call, headers, next);
        }
    }
}
