package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audiovideo.observability.AudioVideoHealthService;
import com.ghatana.audio.video.multimodal.engine.AudioResult;
import com.ghatana.audio.video.multimodal.engine.MultimodalAnalysisEngine;
import com.ghatana.audio.video.multimodal.engine.MultimodalResult;
import com.ghatana.audio.video.multimodal.engine.PlatformMultimodalAdapter;
import com.ghatana.audio.video.multimodal.engine.VideoAudioResult;
import com.ghatana.audio.video.multimodal.engine.VisualResult;
import com.ghatana.audio.video.multimodal.grpc.proto.*;
import com.google.protobuf.ByteString;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.CallOptions;
import io.grpc.ClientCall;
import io.grpc.ClientInterceptors;
import io.grpc.Channel;
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
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/** Transport matrix using the actual JWT interceptor and a signed test token. */
class MultimodalGrpcProductionWrapperMatrixTest {
    private static final String SECRET = "multimodal-production-wrapper-test-secret";
    private static final String TENANT = "tenant-mm-rpc-matrix";
    private static final UUID SUBJECT = UUID.fromString("2f3b6bd3-4bf7-4f06-9f9a-45ea8b8f11cc");

    private String previousSecret;
    private Server server;
    private ManagedChannel channel;
    private MultimodalAnalysisEngine engine;
    private PlatformMultimodalAdapter adapter;
    private AudioVideoHealthService readiness;
    private MultimodalServiceGrpc.MultimodalServiceBlockingStub authenticated;
    private MultimodalServiceGrpc.MultimodalServiceBlockingStub unauthenticated;

    @BeforeEach
    void setUp() throws Exception {
        previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", SECRET);
        engine = mock(MultimodalAnalysisEngine.class);
        adapter = mock(PlatformMultimodalAdapter.class);
        lenient().when(adapter.backendName()).thenReturn("test-fixture-backend");
        lenient().when(adapter.metricsEnabled()).thenReturn(false);
        MultimodalGrpcService service = new MultimodalGrpcService(engine, adapter,
                MediaProcessingMetrics.noop(), request -> SourceAuthorization.Decision.ADMITTED);
        readiness = MultimodalGrpcServer.readinessService(service);
        String name = InProcessServerBuilder.generateName();
        server = InProcessServerBuilder.forName(name).directExecutor()
                .addService(service)
                .addService(readiness)
                .intercept(new JwtServerInterceptor())
                .build().start();
        channel = InProcessChannelBuilder.forName(name).directExecutor().build();

        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                "Bearer " + signedJwt());
        authenticated = MultimodalServiceGrpc.newBlockingStub(channel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));
        unauthenticated = MultimodalServiceGrpc.newBlockingStub(channel);

        when(engine.analyse(any())).thenReturn(MultimodalResult.builder()
                .audioResult(AudioResult.builder().transcription("fixture transcript").confidence(0.75).build())
                .visualResult(VisualResult.builder().sceneDescription("fixture visual observation").build())
                .combinedAnalysis("ABSTAIN: SOURCE_REFERENCES_INCOMPLETE")
                .processingTimeMs(3L).build());
        when(engine.analyseVideoWithAudio(any(), anyBoolean(), anyBoolean(), anyInt()))
                .thenReturn(VideoAudioResult.builder()
                        .audioResult(AudioResult.builder().transcription("fixture transcript").build())
                        .videoResult(VisualResult.builder().sceneDescription("fixture visual observation").build())
                        .combinedNarrative("ABSTAIN: SOURCE_REFERENCES_INCOMPLETE")
                        .build());
    }

    @AfterEach
    void tearDown() {
        if (channel != null) channel.shutdownNow();
        if (server != null) server.shutdownNow();
        if (readiness != null) readiness.close();
        if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
        else System.setProperty("AV_JWT_SECRET", previousSecret);
    }

    @Test
    void authenticatedTenRpcMatrixPreservesDeclaredOutcomesAndFieldIdentity() {
        MultimodalResponse process = authenticated.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1})).build());
        assertThat(process.getCombinedAnalysis()).isEqualTo("ABSTAIN: SOURCE_REFERENCES_INCOMPLETE");
        assertThat(process.getAudioAnalysis().getTranscription()).isEqualTo("fixture transcript");

        VideoAudioResponse video = authenticated.analyzeVideoWithAudio(VideoAudioRequest.newBuilder()
                .setVideoData(ByteString.copyFrom(new byte[] {2})).setExtractAudio(true).setAnalyzeFrames(true).build());
        assertThat(video.getAudioTranscription()).isEqualTo("fixture transcript");
        assertThat(video.getCombinedNarrative()).isEqualTo("ABSTAIN: SOURCE_REFERENCES_INCOMPLETE");

        DescriptionResponse description = authenticated.generateDescription(DescriptionRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {3})).build());
        assertThat(description.getDescription()).isEqualTo("ABSTAIN: SOURCE_REFERENCES_INCOMPLETE");
        assertThat(description.getConfidence()).isZero();

        CrossModalResponse crossModal = authenticated.analyzeCrossModal(CrossModalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {4}))
                .setVideoData(ByteString.copyFrom(new byte[] {5})).build());
        assertThat(crossModal.getSynchronizationStatus())
                .isEqualTo(CrossModalResponse.SynchronizationStatus.SYNC_UNDETERMINED);
        assertThat(crossModal.getEventsList()).isEmpty();

        assertUnavailable(() -> authenticated.getInsights(InsightsRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {6})).build()));

        assertUnavailable(() -> authenticated.loadModel(LoadModelRequest.newBuilder()
                .setModelId("unknown-model").build()));
        assertUnavailable(() -> authenticated.unloadModel(UnloadModelRequest.newBuilder()
                .setModelId("unknown-model").build()));
        assertUnavailable(() -> authenticated.listModels(ListModelsRequest.getDefaultInstance()));

        assertThat(authenticated.getStatus(StatusRequest.getDefaultInstance()).getStatus())
                .isEqualTo("NOT_ADMITTED");
        assertThat(authenticated.healthCheck(HealthCheckRequest.getDefaultInstance()).getHealthy()).isFalse();
    }

    @Test
    void allTenRpcMethodsRejectMissingTransportJwtBeforeDispatch() {
        assertUnauthenticated(() -> unauthenticated.processMultimodal(MultimodalRequest.getDefaultInstance()));
        assertUnauthenticated(() -> unauthenticated.analyzeVideoWithAudio(VideoAudioRequest.getDefaultInstance()));
        assertUnauthenticated(() -> unauthenticated.generateDescription(DescriptionRequest.getDefaultInstance()));
        assertUnauthenticated(() -> unauthenticated.analyzeCrossModal(CrossModalRequest.getDefaultInstance()));
        assertUnauthenticated(() -> unauthenticated.getInsights(InsightsRequest.getDefaultInstance()));
        assertUnauthenticated(() -> unauthenticated.loadModel(LoadModelRequest.getDefaultInstance()));
        assertUnauthenticated(() -> unauthenticated.unloadModel(UnloadModelRequest.getDefaultInstance()));
        assertUnauthenticated(() -> unauthenticated.listModels(ListModelsRequest.getDefaultInstance()));
        assertUnauthenticated(() -> unauthenticated.getStatus(StatusRequest.getDefaultInstance()));
        assertUnauthenticated(() -> unauthenticated.healthCheck(HealthCheckRequest.getDefaultInstance()));
        verifyNoInteractions(engine, adapter);
    }

    @Test
    void invalidInputsAndUnadmittedManagementDoNotDispatchProviders() {
        assertCode(() -> authenticated.processMultimodal(MultimodalRequest.getDefaultInstance()),
                Status.Code.INVALID_ARGUMENT);
        assertCode(() -> authenticated.analyzeVideoWithAudio(VideoAudioRequest.newBuilder()
                .setVideoData(ByteString.copyFrom(new byte[] {1})).build()), Status.Code.INVALID_ARGUMENT);
        assertCode(() -> authenticated.generateDescription(DescriptionRequest.getDefaultInstance()),
                Status.Code.INVALID_ARGUMENT);
        assertCode(() -> authenticated.analyzeCrossModal(CrossModalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1})).build()), Status.Code.INVALID_ARGUMENT);
        assertCode(() -> authenticated.getInsights(InsightsRequest.getDefaultInstance()),
                Status.Code.INVALID_ARGUMENT);

        ByteString oversizedModality = ByteString.copyFrom(new byte[32 * 1024 * 1024 + 1]);
        assertCode(() -> authenticated.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(oversizedModality).build()), Status.Code.INVALID_ARGUMENT);
        assertCode(() -> authenticated.analyzeVideoWithAudio(VideoAudioRequest.newBuilder()
                .setVideoData(oversizedModality).setAnalyzeFrames(true).build()), Status.Code.INVALID_ARGUMENT);
        assertCode(() -> authenticated.generateDescription(DescriptionRequest.newBuilder()
                .setImageData(oversizedModality).build()), Status.Code.INVALID_ARGUMENT);
        assertCode(() -> authenticated.analyzeCrossModal(CrossModalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1})).setVideoData(oversizedModality).build()),
                Status.Code.INVALID_ARGUMENT);
        assertCode(() -> authenticated.getInsights(InsightsRequest.newBuilder()
                .setAudioData(oversizedModality).build()), Status.Code.INVALID_ARGUMENT);
        assertCode(() -> authenticated.analyzeVideoWithAudio(VideoAudioRequest.newBuilder()
                .setVideoData(ByteString.copyFrom(new byte[] {1})).setAnalyzeFrames(true)
                .setFrameSampleRate(61).build()), Status.Code.INVALID_ARGUMENT);
        String oversizedText = "x".repeat(64 * 1024 + 1);
        assertCode(() -> authenticated.processMultimodal(MultimodalRequest.newBuilder()
                .setText(oversizedText).build()), Status.Code.INVALID_ARGUMENT);
        assertCode(() -> authenticated.generateDescription(DescriptionRequest.newBuilder()
                .setContext(oversizedText).build()), Status.Code.INVALID_ARGUMENT);
        assertCode(() -> authenticated.getInsights(InsightsRequest.newBuilder()
                .setText(oversizedText).build()), Status.Code.INVALID_ARGUMENT);
        ByteString oversizedAggregate = ByteString.copyFrom(new byte[22 * 1024 * 1024 + 1]);
        assertCode(() -> authenticated.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(oversizedAggregate).setImageData(oversizedAggregate)
                .setVideoData(oversizedAggregate).build()), Status.Code.INVALID_ARGUMENT);
        assertCode(() -> authenticated.getInsights(InsightsRequest.newBuilder()
                .setAudioData(oversizedAggregate).setImageData(oversizedAggregate)
                .setVideoData(oversizedAggregate).build()), Status.Code.INVALID_ARGUMENT);

        assertUnavailable(() -> authenticated.loadModel(LoadModelRequest.newBuilder()
                .setModelId("unknown-model").build()));
        assertUnavailable(() -> authenticated.unloadModel(UnloadModelRequest.newBuilder()
                .setModelId("unknown-model").build()));
        assertUnavailable(() -> authenticated.listModels(ListModelsRequest.getDefaultInstance()));
        verifyNoInteractions(engine, adapter);
    }

    @Test
    void requestedProviderFailuresReturnUnavailableWithoutPartialSuccess() {
        when(engine.analyse(any())).thenReturn(MultimodalResult.builder()
                .audioResult(AudioResult.builder().transcription("fixture transcript").build())
                .build());
        when(engine.analyseVideoWithAudio(any(), anyBoolean(), anyBoolean(), anyInt()))
                .thenReturn(VideoAudioResult.builder()
                        .audioResult(AudioResult.builder().transcription("fixture transcript").build())
                        .combinedNarrative("ABSTAIN: SOURCE_REFERENCES_INCOMPLETE")
                        .build());

        assertUnavailable(() -> authenticated.processMultimodal(MultimodalRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[] {1})).build()));
        assertUnavailable(() -> authenticated.analyzeVideoWithAudio(VideoAudioRequest.newBuilder()
                .setVideoData(ByteString.copyFrom(new byte[] {2}))
                .setExtractAudio(true).setAnalyzeFrames(true).build()));
        assertUnavailable(() -> authenticated.generateDescription(DescriptionRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[] {3})).build()));
        assertUnavailable(() -> authenticated.analyzeCrossModal(CrossModalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {4}))
                .setVideoData(ByteString.copyFrom(new byte[] {5})).build()));

        verify(engine, org.mockito.Mockito.times(3)).analyse(any());
        verify(engine).analyseVideoWithAudio(any(), anyBoolean(), anyBoolean(), anyInt());
        verifyNoInteractions(adapter);
    }

    @Test
    void modelManagementRejectsBlankIdsBeforeUnavailableProviderFallback() {
        assertCode(() -> authenticated.loadModel(LoadModelRequest.newBuilder().setModelId(" ").build()),
                Status.Code.INVALID_ARGUMENT);
        assertCode(() -> authenticated.unloadModel(UnloadModelRequest.newBuilder().setModelId("").build()),
                Status.Code.INVALID_ARGUMENT);
        verifyNoInteractions(engine, adapter);
    }

    @Test
    void standardGrpcHealthRemainsPublicAndReportsNotServing() {
        var response = io.grpc.health.v1.HealthGrpc.newBlockingStub(channel)
                .check(io.grpc.health.v1.HealthCheckRequest.getDefaultInstance());
        assertThat(response.getStatus()).isEqualTo(io.grpc.health.v1.HealthCheckResponse.ServingStatus.NOT_SERVING);
    }

    @Test
    void clientCancellationDoesNotDeliverLateResponseBody() throws Exception {
        CountDownLatch engineStarted = new CountDownLatch(1);
        CountDownLatch releaseEngine = new CountDownLatch(1);
        CountDownLatch callClosed = new CountDownLatch(1);
        AtomicInteger bodyCount = new AtomicInteger();
        when(engine.analyse(any())).thenAnswer(invocation -> {
            engineStarted.countDown();
            if (!releaseEngine.await(2, TimeUnit.SECONDS)) {
                throw new IllegalStateException("test engine release deadline");
            }
            return MultimodalResult.builder()
                    .audioResult(AudioResult.builder().transcription("fixture transcript").build())
                    .combinedAnalysis("ABSTAIN: SOURCE_REFERENCES_INCOMPLETE").build();
        });

        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                "Bearer " + signedJwt());
        Channel authorizedChannel = ClientInterceptors.intercept(channel,
                MetadataUtils.newAttachHeadersInterceptor(headers));
        ClientCall<MultimodalRequest, MultimodalResponse> call = authorizedChannel.newCall(
                MultimodalServiceGrpc.getProcessMultimodalMethod(), CallOptions.DEFAULT);
        FutureTask<Void> sender = new FutureTask<>(() -> {
            call.start(new ClientCall.Listener<>() {
                @Override public void onMessage(MultimodalResponse response) { bodyCount.incrementAndGet(); }
                @Override public void onClose(Status status, Metadata trailers) { callClosed.countDown(); }
            }, new Metadata());
            call.request(1);
            call.sendMessage(MultimodalRequest.newBuilder()
                    .setAudioData(ByteString.copyFrom(new byte[] {9})).build());
            call.halfClose();
            return null;
        });
        Thread senderThread = new Thread(sender, "multimodal-grpc-cancel-test-client");
        senderThread.start();
        try {
            assertThat(engineStarted.await(1, TimeUnit.SECONDS)).isTrue();
            call.cancel("test client cancelled", null);
            assertThat(callClosed.await(1, TimeUnit.SECONDS)).isTrue();
        } finally {
            releaseEngine.countDown();
        }
        sender.get(1, TimeUnit.SECONDS);
        assertThat(bodyCount.get()).isZero();
    }

    private static void assertUnavailable(org.assertj.core.api.ThrowableAssert.ThrowingCallable rpc) {
        assertCode(rpc, Status.Code.UNAVAILABLE);
    }

    private static void assertUnauthenticated(org.assertj.core.api.ThrowableAssert.ThrowingCallable rpc) {
        assertCode(rpc, Status.Code.UNAUTHENTICATED);
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
