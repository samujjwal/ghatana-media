package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audiovideo.observability.AudioVideoHealthService;
import com.ghatana.audio.video.multimodal.engine.AudioResult;
import com.ghatana.audio.video.multimodal.engine.MultimodalAnalysisEngine;
import com.ghatana.audio.video.multimodal.engine.MultimodalResult;
import com.ghatana.audio.video.multimodal.engine.PlatformMultimodalAdapter;

import java.util.List;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalRequest;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalResponse;
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

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

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
    private AudioVideoHealthService readiness;
    private AtomicBoolean sttProviderReady;
    private AtomicBoolean visionProviderReady;

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
        MultimodalAnalysisEngine engine = mock(MultimodalAnalysisEngine.class);
        PlatformMultimodalAdapter adapter = mock(PlatformMultimodalAdapter.class);

        when(engine.analyse(any())).thenReturn(
            MultimodalResult.builder()
                .audioResult(AudioResult.builder().transcription("hello").confidence(0.9).build())
                .combinedAnalysis("audio analysis ready")
                .processingTimeMs(25L)
                .build()
        );
        lenient().when(adapter.backendName()).thenReturn("test-backend");
        lenient().when(adapter.metricsEnabled()).thenReturn(false);

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
    @DisplayName("processMultimodal returns fused response over gRPC transport")
    void processMultimodalOverGrpc() {
        MultimodalServiceGrpc.MultimodalServiceBlockingStub stub = MultimodalServiceGrpc.newBlockingStub(channel);

        MultimodalResponse response = stub.processMultimodal(
            MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[]{0x01}))
                .build()
        );

        assertThat(response.getCombinedAnalysis()).contains("audio analysis");
        assertThat(response.getAudioAnalysis().getTranscription()).isEqualTo("hello");
        assertThat(response.getProcessingTimeMs()).isEqualTo(25L);
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
    @DisplayName("processMultimodal engine failure is mapped to INTERNAL")
    void processMultimodalEngineFailureReturnsInternal() throws Exception {
        MultimodalAnalysisEngine failingEngine = mock(MultimodalAnalysisEngine.class);
        PlatformMultimodalAdapter adapter = mock(PlatformMultimodalAdapter.class);
        when(failingEngine.analyse(any())).thenThrow(new RuntimeException("boom"));
        lenient().when(adapter.backendName()).thenReturn("test-backend");
        lenient().when(adapter.metricsEnabled()).thenReturn(false);

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

        assertThatThrownBy(() -> stub.processMultimodal(
            MultimodalRequest.newBuilder().setAudioData(ByteString.copyFrom(new byte[]{0x01})).build()
        ))
            .isInstanceOf(StatusRuntimeException.class)
            .matches(ex -> ((StatusRuntimeException) ex).getStatus().getCode() == Status.INTERNAL.getCode());
    }

    // AV-P1-015: E2E test for multimodal orchestration

    @Test
    @DisplayName("AV-P1-015: analyzeVideoWithAudio orchestrates STT and Vision fusion")
    void analyzeVideoWithAudioOrchestratesFusion() throws Exception {
        MultimodalAnalysisEngine engine = mock(MultimodalAnalysisEngine.class);
        PlatformMultimodalAdapter adapter = mock(PlatformMultimodalAdapter.class);

        com.ghatana.audio.video.multimodal.engine.VideoAudioResult videoAudioResult =
            com.ghatana.audio.video.multimodal.engine.VideoAudioResult.builder()
                .combinedNarrative("Person walking while speaking")
                .audioResult(AudioResult.builder()
                    .transcription("Hello world")
                    .confidence(0.9)
                    .build())
                .videoResult(com.ghatana.audio.video.multimodal.engine.VisualResult.builder()
                    .sceneDescription("A person walking")
                    .confidence(0.85)
                    .frameResults(List.of(
                        new com.ghatana.audio.video.multimodal.engine.FrameResult(
                            1, com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.fromSource(
                                    com.ghatana.audio.video.vision.video.SourceMediaTimestamp.fromPts("3003", "1/90000")),
                            List.of(
                                new com.ghatana.audio.video.multimodal.engine.DetectionResult(
                                    "person", 0.95, 0.0, 0.0, 0.0, 0.0)
                            ))
                    ))
                    .build())
                .build();

        when(engine.analyseVideoWithAudio(any(), anyBoolean(), anyBoolean(), anyInt()))
            .thenReturn(videoAudioResult);
        lenient().when(adapter.backendName()).thenReturn("test-backend");
        lenient().when(adapter.metricsEnabled()).thenReturn(false);

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

        com.ghatana.audio.video.multimodal.grpc.proto.VideoAudioResponse response =
            stub.analyzeVideoWithAudio(
                com.ghatana.audio.video.multimodal.grpc.proto.VideoAudioRequest.newBuilder()
                    .setVideoData(ByteString.copyFrom(new byte[]{0x01, 0x02, 0x03}))
                    .setExtractAudio(true)
                    .setAnalyzeFrames(true)
                    .setFrameSampleRate(1)
                    .build()
            );

        assertThat(response.getCombinedNarrative()).contains("Person walking");
        assertThat(response.getAudioTranscription()).isEqualTo("Hello world");
        assertThat(response.getFrameAnalysesCount()).isEqualTo(1);
        assertThat(response.getFrameAnalyses(0).hasTimestampMs()).isTrue();
        assertThat(response.getFrameAnalyses(0).getTimestampMs()).isEqualTo(33L);
        assertThat(response.getFrameAnalyses(0).getTimestampStatus())
            .isEqualTo(com.ghatana.audio.video.multimodal.grpc.proto.FrameAnalysis.TimestampStatus
                .TIMESTAMP_STATUS_KNOWN);
        assertThat(response.getFrameAnalyses(0).hasSourcePts()).isTrue();
        assertThat(response.getFrameAnalyses(0).getSourcePts()).isEqualTo(3003L);
        assertThat(response.getFrameAnalyses(0).getTimeBaseNumerator()).isEqualTo(1L);
        assertThat(response.getFrameAnalyses(0).getTimeBaseDenominator()).isEqualTo(90000L);
        assertThat(response.getFrameAnalyses(0).getClockDomain())
            .isEqualTo(com.ghatana.audio.video.multimodal.grpc.proto.FrameAnalysis.ClockDomain.SOURCE);
        assertThat(response.getSynchronizationStatus())
            .isEqualTo(com.ghatana.audio.video.multimodal.grpc.proto.VideoAudioResponse
                .SynchronizationStatus.SYNC_UNDETERMINED);
        assertThat(response.getFrameAnalyses(0).getObjectsCount()).isEqualTo(1);
        assertThat(response.getFrameAnalyses(0).getObjects(0).getClassName()).isEqualTo("person");
    }

    @Test
    @DisplayName("AV-P1-015: analyzeCrossModal leaves unqualified synchronization undetermined")
    void analyzeCrossModalLeavesSynchronizationUndetermined() throws Exception {
        MultimodalAnalysisEngine engine = mock(MultimodalAnalysisEngine.class);
        PlatformMultimodalAdapter adapter = mock(PlatformMultimodalAdapter.class);

        MultimodalResult result = MultimodalResult.builder()
            .audioResult(AudioResult.builder()
                .transcription("A person is walking")
                .confidence(0.9)
                .build())
            .visualResult(com.ghatana.audio.video.multimodal.engine.VisualResult.builder()
                .sceneDescription("A person walking in the park")
                .confidence(0.85)
                .build())
            .combinedAnalysis("Cross-modal analysis complete")
            .processingTimeMs(50L)
            .build();

        when(engine.analyse(any())).thenReturn(result);
        lenient().when(adapter.backendName()).thenReturn("test-backend");
        lenient().when(adapter.metricsEnabled()).thenReturn(false);

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

        com.ghatana.audio.video.multimodal.grpc.proto.CrossModalResponse response =
            stub.analyzeCrossModal(
                com.ghatana.audio.video.multimodal.grpc.proto.CrossModalRequest.newBuilder()
                    .setAudioData(ByteString.copyFrom(new byte[]{0x01}))
                    .setVideoData(ByteString.copyFrom(new byte[]{0x02}))
                    .build()
            );

        assertThat(response.hasAlignmentScore()).isFalse();
        assertThat(response.getSynchronizationStatus())
            .isEqualTo(com.ghatana.audio.video.multimodal.grpc.proto.CrossModalResponse.SynchronizationStatus
                .SYNC_UNDETERMINED);
        assertThat(response.getEventsCount()).isZero();
        assertThat(response.getSummary()).contains("synchronization undetermined");
        assertThat(response.getSummary()).contains("audio=present");
        assertThat(response.getSummary()).contains("visual=present");
    }

    @Test
    @DisplayName("AV-P1-015: getInsights extracts topics and entities")
    void getInsightsExtractsTopicsAndEntities() throws Exception {
        MultimodalAnalysisEngine engine = mock(MultimodalAnalysisEngine.class);
        PlatformMultimodalAdapter adapter = mock(PlatformMultimodalAdapter.class);

        MultimodalResult result = MultimodalResult.builder()
            .audioResult(AudioResult.builder()
                .transcription("John went to New York")
                .confidence(0.9)
                .build())
            .visualResult(com.ghatana.audio.video.multimodal.engine.VisualResult.builder()
                .sceneDescription("A person walking")
                .confidence(0.85)
                .build())
            .combinedAnalysis("Insights extraction complete")
            .processingTimeMs(30L)
            .build();

        when(engine.analyse(any())).thenReturn(result);
        lenient().when(adapter.backendName()).thenReturn("test-backend");
        lenient().when(adapter.metricsEnabled()).thenReturn(false);

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

        com.ghatana.audio.video.multimodal.grpc.proto.InsightsResponse response =
            stub.getInsights(
                com.ghatana.audio.video.multimodal.grpc.proto.InsightsRequest.newBuilder()
                    .setAudioData(ByteString.copyFrom(new byte[]{0x01}))
                    .setText("Context text")
                    .build()
            );

        assertThat(response.getTopicsList()).contains("speech");
        assertThat(response.getTopicsList()).contains("visual");
        assertThat(response.getEntitiesList()).isNotEmpty();
        assertThat(response.getOverallSentiment()).isNotBlank();
        assertThat(response.getProcessingTimeMs()).isGreaterThan(0);
    }

    // ── TenantInjector: injects tenant into gRPC context server-side ──────────

    /** Explicit local fixture admission; never used by production construction. */
    private static SourceAuthorization admitTestFixtureOnly() {
        return request -> SourceAuthorization.Decision.ADMITTED;
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
