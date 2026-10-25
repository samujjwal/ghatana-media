package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.multimodal.engine.AudioResult;
import com.ghatana.audio.video.multimodal.engine.MultimodalAnalysisEngine;
import com.ghatana.audio.video.multimodal.engine.MultimodalResult;
import com.ghatana.audio.video.multimodal.engine.PlatformMultimodalAdapter;
import com.ghatana.audio.video.multimodal.engine.VideoAudioResult;
import com.ghatana.audio.video.multimodal.engine.VisualResult;
import com.ghatana.audio.video.multimodal.grpc.proto.*;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * Unit tests for {@link MultimodalGrpcService}.
 *
 * <p>Uses Mockito to avoid native-library and file-system dependencies.
 *
 * @doc.type class
 * @doc.purpose Unit tests for the multimodal gRPC service layer — covers AV-004 methods
 * @doc.layer product
 * @doc.pattern TestCase
 */
@ExtendWith(MockitoExtension.class) 
@DisplayName("MultimodalGrpcService")
class MultimodalGrpcServiceTest {

    private static final String TENANT_ID = "tenant-multimodal-test";
    private static final String SUBJECT_ID = "d7fe98ce-75d3-4a2a-8a04-bb54e23a2f15";

    @Mock
    private MultimodalAnalysisEngine mockEngine;

    @Mock
    private PlatformMultimodalAdapter mockAdapter;

    private MultimodalGrpcService service;

    @BeforeEach
    void setUp() { 
        service = new MultimodalGrpcService(mockEngine, mockAdapter, MediaProcessingMetrics.noop(),
                // Test fixture only: production constructors retain unavailable authorization.
                request -> SourceAuthorization.Decision.ADMITTED);
        lenient().when(mockAdapter.backendName()).thenReturn("test-backend");
        lenient().when(mockAdapter.metricsEnabled()).thenReturn(false); 
    }

    // ─────────────────────────────────────────────────────────────────────────
    // processMultimodal (AV-004) 
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("processMultimodal: no tenant context → UNAUTHENTICATED")
    void processMultimodal_noTenantContext_returnsUnauthenticated() {
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        service.processMultimodal(
            MultimodalRequest.newBuilder().setAudioData(ByteString.copyFrom(new byte[]{1})).build(),
            observer);

        assertThat(observer.hasError()).isTrue();
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
            .isEqualTo(Status.UNAUTHENTICATED.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: missing principal is rejected before dispatch")
    void processMultimodal_missingPrincipal_returnsUnauthenticatedWithoutDispatch() {
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        Context.current().withValue(JwtServerInterceptor.CTX_TENANT, TENANT_ID)
                .run(() -> service.processMultimodal(MultimodalRequest.newBuilder()
                        .setAudioData(ByteString.copyFrom(new byte[] {1})).build(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: malformed principal is rejected before dispatch")
    void processMultimodal_malformedPrincipal_returnsUnauthenticatedWithoutDispatch() {
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        Context.current().withValue(JwtServerInterceptor.CTX_TENANT, TENANT_ID)
                .withValue(JwtServerInterceptor.CTX_SUBJECT, "not-a-uuid")
                .run(() -> service.processMultimodal(MultimodalRequest.newBuilder()
                        .setAudioData(ByteString.copyFrom(new byte[] {1})).build(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: empty modality set is invalid even when authority admits")
    void processMultimodal_emptyInputIsRejectedBeforeDispatch() {
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.processMultimodal(MultimodalRequest.getDefaultInstance(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: missing source authority is unavailable before dispatch")
    void processMultimodal_missingSourceAuthority_returnsUnavailableWithoutDispatch() {
        MultimodalGrpcService unavailable = new MultimodalGrpcService(
                mockEngine, mockAdapter, MediaProcessingMetrics.noop(),
                request -> SourceAuthorization.Decision.NOT_ADMITTED);
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> unavailable.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1}))
                .setTenantId("caller-controlled-tenant")
                .setConsentStatus("GRANTED").build(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAVAILABLE.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: production constructor remains unavailable without source authority")
    void processMultimodal_defaultAuthorityIsUnavailable() {
        MultimodalGrpcService noAuthority = new MultimodalGrpcService(
                mockEngine, mockAdapter, MediaProcessingMetrics.noop());
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> noAuthority.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1})).build(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAVAILABLE.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: authorization binds trusted identity, modalities, source, purpose and UTF-8 size")
    void processMultimodal_authorizationReceivesExactRequestBoundary() {
        AtomicReference<SourceAuthorization.AuthorizationRequest> captured = new AtomicReference<>();
        MultimodalGrpcService capturing = new MultimodalGrpcService(mockEngine, mockAdapter,
                MediaProcessingMetrics.noop(), request -> {
                    captured.set(request);
                    return SourceAuthorization.Decision.ADMITTED; // Test fixture only.
                });
        MultimodalRequest request = MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1, 2}))
                .setImageData(ByteString.copyFrom(new byte[] {3}))
                .setText("é")
                .setTenantId("caller-controlled-tenant")
                .setArtifactId("caller-source-ref")
                .setConsentStatus("GRANTED")
                .build();
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> capturing.processMultimodal(request, observer));

        assertThat(captured.get().tenantId()).isEqualTo(TENANT_ID);
        assertThat(captured.get().principalId()).isEqualTo(java.util.UUID.fromString(SUBJECT_ID));
        assertThat(captured.get().modalities()).isEqualTo(Set.of(
                SourceAuthorization.Modality.AUDIO, SourceAuthorization.Modality.IMAGE,
                SourceAuthorization.Modality.TEXT));
        assertThat(captured.get().artifactId()).isEqualTo("caller-source-ref");
        assertThat(captured.get().purpose()).isEqualTo("multimodal.analyse");
        assertThat(captured.get().contentBytes()).isEqualTo(2 + 1 + 2);
    }

    @Test
    @DisplayName("processMultimodal: revoked or unavailable source authority denies before engine dispatch")
    void processMultimodal_revokedAndUnavailableAuthorityDenyBeforeDispatch() {
        for (SourceAuthorization authorization : List.<SourceAuthorization>of(
                request -> SourceAuthorization.Decision.NOT_ADMITTED,
                request -> { throw new IllegalStateException("authority unavailable"); })) {
            MultimodalGrpcService denied = new MultimodalGrpcService(mockEngine, mockAdapter,
                    MediaProcessingMetrics.noop(), authorization);
            CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
            withContext(TENANT_ID, () -> denied.processMultimodal(MultimodalRequest.newBuilder()
                    .setVideoData(ByteString.copyFrom(new byte[] {1}))
                    .build(), observer));

            assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                    .isEqualTo(Status.UNAVAILABLE.getCode());
        }
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("analyzeVideoWithAudio: authorization includes video source and requested audio extraction")
    void analyzeVideoWithAudio_authorizationBindsVideoAndAudioExtraction() {
        AtomicReference<SourceAuthorization.AuthorizationRequest> captured = new AtomicReference<>();
        MultimodalGrpcService capturing = new MultimodalGrpcService(mockEngine, mockAdapter,
                MediaProcessingMetrics.noop(), request -> {
                    captured.set(request);
                    return SourceAuthorization.Decision.ADMITTED; // Test fixture only.
                });
        byte[] video = {1, 2, 3, 4};
        CapturingObserver<VideoAudioResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> capturing.analyzeVideoWithAudio(VideoAudioRequest.newBuilder()
                .setVideoData(ByteString.copyFrom(video))
                .setExtractAudio(true)
                .setAnalyzeFrames(false)
                .build(), observer));

        assertThat(captured.get().modalities()).isEqualTo(Set.of(
                SourceAuthorization.Modality.AUDIO, SourceAuthorization.Modality.VIDEO));
        assertThat(captured.get().contentBytes()).isEqualTo(video.length);
        assertThat(captured.get().purpose()).isEqualTo("multimodal.video-audio-analysis");
    }

    @Test
    @DisplayName("processMultimodal: audio + image → fused response returned")
    void processMultimodal_withAudioAndImage_returnsFusedResponse() { 
        MultimodalResult result = MultimodalResult.builder() 
            .audioResult(AudioResult.builder().transcription("hello world").confidence(0.9).build())
            .visualResult(VisualResult.builder().sceneDescription("A sunny park").confidence(0.8).build())
            .combinedAnalysis("Speech: hello world; Visual: A sunny park")
            .processingTimeMs(50L) 
            .build(); 
        when(mockEngine.analyse(any())).thenReturn(result); 

        MultimodalRequest request = MultimodalRequest.newBuilder() 
            .setAudioData(ByteString.copyFrom(new byte[]{1, 2, 3})) 
            .setImageData(ByteString.copyFrom(new byte[]{4, 5, 6})) 
            .build(); 
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.processMultimodal(request, observer)); 

        assertThat(observer.hasError()).isFalse(); 
        MultimodalResponse response = observer.getValue(); 
        assertThat(response.getCombinedAnalysis()).contains("Speech: hello world");
        assertThat(response.getAudioAnalysis().getTranscription()).isEqualTo("hello world");
        assertThat(response.getVisualAnalysis().getSceneDescription()).isEqualTo("A sunny park");
        assertThat(response.getProcessingTimeMs()).isGreaterThanOrEqualTo(0); 
    }

    @Test
    @DisplayName("processMultimodal: engine throws → INTERNAL returned")
    void processMultimodal_engineThrows_returnsInternal() { 
        when(mockEngine.analyse(any())).thenThrow(new RuntimeException("engine failure"));

        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.processMultimodal( 
            MultimodalRequest.newBuilder() 
                .setAudioData(ByteString.copyFrom(new byte[]{1})) 
                .build(), 
            observer));

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INTERNAL.getCode()); 
    }

    @Test
    @DisplayName("processMultimodal: audio-only request → no visual analysis in response")
    void processMultimodal_audioOnly_hasNoVisualAnalysis() { 
        MultimodalResult result = MultimodalResult.builder() 
            .audioResult(AudioResult.builder().transcription("test").confidence(0.9).build())
            .combinedAnalysis("Speech: test")
            .processingTimeMs(10L) 
            .build(); 
        when(mockEngine.analyse(any())).thenReturn(result); 

        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.processMultimodal( 
            MultimodalRequest.newBuilder() 
                .setAudioData(ByteString.copyFrom(new byte[]{1})) 
                .build(), 
            observer));

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().hasVisualAnalysis()).isFalse(); 
    }

    // ─────────────────────────────────────────────────────────────────────────
    // generateDescription
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("generateDescription: audio + context → description with key elements")
    void generateDescription_withAudioAndContext_returnsDescription() { 
        MultimodalResult result = MultimodalResult.builder() 
            .audioResult(AudioResult.builder().transcription("meeting summary").confidence(0.9).build())
            .combinedAnalysis("Meeting was productive")
            .processingTimeMs(20L) 
            .build(); 
        when(mockEngine.analyse(any())).thenReturn(result); 

        CapturingObserver<DescriptionResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.generateDescription( 
            DescriptionRequest.newBuilder() 
                .setAudioData(ByteString.copyFrom(new byte[]{1, 2})) 
                .setContext("quarterly review")
                .build(), 
            observer));

        assertThat(observer.hasError()).isFalse(); 
        DescriptionResponse response = observer.getValue(); 
        assertThat(response.getDescription()).isNotBlank(); 
        assertThat(response.getKeyElementsList()).contains("speech");
        assertThat(response.getConfidence()).isGreaterThan(0.0); 
    }

    @Test
    @DisplayName("generateDescription: empty input is invalid before dispatch")
    void generateDescription_emptyInputIsRejectedWithoutDispatch() {
        CapturingObserver<DescriptionResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.generateDescription(DescriptionRequest.getDefaultInstance(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        verifyNoInteractions(mockEngine);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // analyzeVideoWithAudio
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("analyzeVideoWithAudio: valid video → combined narrative returned")
    void analyzeVideoWithAudio_valid_returnsCombinedNarrative() { 
        VideoAudioResult result = VideoAudioResult.builder() 
            .audioResult(AudioResult.builder().transcription("narrator speaking").confidence(0.85).build())
            .videoResult(VisualResult.builder().sceneDescription("outdoor scene").confidence(0.9).build())
            .temporalAlignments(List.of()) 
            .combinedNarrative("narrator speaking with outdoor scene")
            .processingTimeMs(30L) 
            .build(); 
        when(mockEngine.analyseVideoWithAudio(any(), anyBoolean(), anyBoolean(), anyInt())) 
            .thenReturn(result); 

        CapturingObserver<VideoAudioResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.analyzeVideoWithAudio( 
            VideoAudioRequest.newBuilder() 
                .setVideoData(ByteString.copyFrom(new byte[]{9, 8, 7})) 
                .setExtractAudio(true) 
                .setAnalyzeFrames(true) 
                .build(), 
            observer));

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getCombinedNarrative()).isEqualTo("narrator speaking with outdoor scene");
        assertThat(observer.getValue().getAudioTranscription()).isEqualTo("narrator speaking");
        assertThat(observer.getValue().getSynchronizationStatus())
            .isEqualTo(VideoAudioResponse.SynchronizationStatus.SYNC_UNDETERMINED);
    }

    @Test
    @DisplayName("analyzeVideoWithAudio: empty video is invalid before dispatch")
    void analyzeVideoWithAudio_emptyVideoIsRejectedWithoutDispatch() {
        CapturingObserver<VideoAudioResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.analyzeVideoWithAudio(
                VideoAudioRequest.getDefaultInstance(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("analyzeVideoWithAudio: unknown source PTS stays absent on the wire")
    void analyzeVideoWithAudio_unknownPtsIsNotSerializedAsZero() {
        VideoAudioResult result = VideoAudioResult.builder()
                .videoResult(VisualResult.builder().frameResults(List.of(new com.ghatana.audio.video.multimodal.engine
                        .FrameResult(1, com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp
                                .unknown("NO_SOURCE_PTS"), List.of()))).build())
                .temporalAlignments(List.of())
                .combinedNarrative("frame time unknown")
                .processingTimeMs(1L)
                .build();
        when(mockEngine.analyseVideoWithAudio(any(), anyBoolean(), anyBoolean(), anyInt())).thenReturn(result);

        CapturingObserver<VideoAudioResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.analyzeVideoWithAudio(VideoAudioRequest.newBuilder()
                .setVideoData(ByteString.copyFrom(new byte[] {1})).setAnalyzeFrames(true).build(), observer));

        assertThat(observer.hasError()).isFalse();
        FrameAnalysis frame = observer.getValue().getFrameAnalyses(0);
        assertThat(frame.hasTimestampMs()).isFalse();
        assertThat(frame.getTimestampStatus())
                .isEqualTo(FrameAnalysis.TimestampStatus.TIMESTAMP_STATUS_UNKNOWN);
        assertThat(frame.getTimestampUnknownReason()).isEqualTo("NO_SOURCE_PTS");
    }

    @Test
    @DisplayName("getInsights: empty modality set is invalid even when authority admits")
    void getInsights_emptyInputIsRejectedBeforeDispatch() {
        CapturingObserver<InsightsResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.getInsights(InsightsRequest.getDefaultInstance(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        verifyNoInteractions(mockEngine);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // analyzeCrossModal (AV-004.4) 
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("analyzeCrossModal: no audio and no video → INVALID_ARGUMENT")
    void analyzeCrossModal_noAudioNoVideo_returnsInvalidArgument() { 
        CapturingObserver<CrossModalResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.analyzeCrossModal(CrossModalRequest.getDefaultInstance(), observer)); 

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("analyzeCrossModal: missing comparable clock evidence → synchronization undetermined")
    void analyzeCrossModal_withBothModalities_doesNotClaimAlignment() {
        MultimodalResult result = MultimodalResult.builder() 
            .audioResult(AudioResult.builder().transcription("a person running").confidence(0.9).build())
            .visualResult(VisualResult.builder().sceneDescription("a person running fast").confidence(0.85).build())
            .combinedAnalysis("aligned")
            .processingTimeMs(25L) 
            .build(); 
        when(mockEngine.analyse(any())).thenReturn(result); 

        CapturingObserver<CrossModalResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.analyzeCrossModal( 
            CrossModalRequest.newBuilder() 
                .setAudioData(ByteString.copyFrom(new byte[]{1, 2})) 
                .setVideoData(ByteString.copyFrom(new byte[]{3, 4})) 
                .build(), 
            observer));

        assertThat(observer.hasError()).isFalse(); 
        CrossModalResponse response = observer.getValue(); 
        assertThat(response.hasAlignmentScore()).isFalse();
        assertThat(response.getSynchronizationStatus())
                .isEqualTo(CrossModalResponse.SynchronizationStatus.SYNC_UNDETERMINED);
        assertThat(response.getEventsList()).isEmpty();
        assertThat(response.getSummary()).contains("synchronization undetermined");
    }

    @Test
    @DisplayName("analyzeCrossModal: audio only → synchronization remains undetermined")
    void analyzeCrossModal_audioOnly_returnsUndetermined() {
        MultimodalResult result = MultimodalResult.builder() 
            .audioResult(AudioResult.builder().transcription("hello").confidence(0.9).build())
            .combinedAnalysis("audio only")
            .processingTimeMs(10L) 
            .build(); 
        when(mockEngine.analyse(any())).thenReturn(result); 

        CapturingObserver<CrossModalResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.analyzeCrossModal( 
            CrossModalRequest.newBuilder() 
                .setAudioData(ByteString.copyFrom(new byte[]{1})) 
                .build(), 
            observer));

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().hasAlignmentScore()).isFalse();
        assertThat(observer.getValue().getSynchronizationStatus())
                .isEqualTo(CrossModalResponse.SynchronizationStatus.SYNC_UNDETERMINED);
        assertThat(observer.getValue().getEventsList()).isEmpty();
        assertThat(observer.getValue().getSummary()).contains("synchronization undetermined");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getInsights (AV-004.5) 
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("getInsights: audio with transcription → topics and sentiment extracted")
    void getInsights_withAudio_extractsTopicsAndSentiment() { 
        MultimodalResult result = MultimodalResult.builder() 
            .audioResult(AudioResult.builder() 
                .transcription("The project is great and the team did a good job")
                .confidence(0.9).build()) 
            .combinedAnalysis("positive meeting")
            .processingTimeMs(15L) 
            .build(); 
        when(mockEngine.analyse(any())).thenReturn(result); 

        CapturingObserver<InsightsResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.getInsights( 
            InsightsRequest.newBuilder() 
                .setAudioData(ByteString.copyFrom(new byte[]{1})) 
                .build(), 
            observer));

        assertThat(observer.hasError()).isFalse(); 
        InsightsResponse response = observer.getValue(); 
        assertThat(response.getTopicsList()).contains("speech");
        assertThat(response.getOverallSentiment()).isEqualTo("positive");
        assertThat(response.getProcessingTimeMs()).isGreaterThanOrEqualTo(0); 
    }

    @Test
    @DisplayName("getInsights: text only → text topic included")
    void getInsights_withTextOnly_includesTextTopic() { 
        MultimodalResult result = MultimodalResult.builder() 
            .combinedAnalysis("text only")
            .processingTimeMs(5L) 
            .build(); 
        when(mockEngine.analyse(any())).thenReturn(result); 

        CapturingObserver<InsightsResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.getInsights( 
            InsightsRequest.newBuilder().setText("some context").build(),
            observer));

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getTopicsList()).contains("text");
        assertThat(observer.getValue().getOverallSentiment()).isEqualTo("neutral");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // loadModel (AV-004.1) 
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("loadModel: blank modelId → INVALID_ARGUMENT")
    void loadModel_blankModelId_returnsInvalidArgument() { 
        CapturingObserver<LoadModelResponse> observer = new CapturingObserver<>(); 
        service.loadModel(LoadModelRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    @Test
    @DisplayName("loadModel: valid modelId → success response")
    void loadModel_validModelId_returnsSuccess() { 
        CapturingObserver<LoadModelResponse> observer = new CapturingObserver<>(); 
        service.loadModel(LoadModelRequest.newBuilder().setModelId("clip-vit-large").build(), observer);

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getSuccess()).isTrue(); 
        assertThat(observer.getValue().getModelId()).isEqualTo("clip-vit-large");
        assertThat(observer.getValue().getLoadTimeMs()).isGreaterThanOrEqualTo(0); 
    }

    // ─────────────────────────────────────────────────────────────────────────
    // unloadModel (AV-004.2) 
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("unloadModel: blank modelId → INVALID_ARGUMENT")
    void unloadModel_blankModelId_returnsInvalidArgument() { 
        CapturingObserver<UnloadModelResponse> observer = new CapturingObserver<>(); 
        service.unloadModel(UnloadModelRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    @Test
    @DisplayName("unloadModel: unregistered modelId → NOT_FOUND")
    void unloadModel_unregisteredModel_returnsNotFound() { 
        CapturingObserver<UnloadModelResponse> observer = new CapturingObserver<>(); 
        service.unloadModel(UnloadModelRequest.newBuilder().setModelId("ghost-model").build(), observer);

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.NOT_FOUND.getCode()); 
    }

    @Test
    @DisplayName("unloadModel: loaded model → success response with freed bytes")
    void unloadModel_loadedModel_returnsSuccess() { 
        // Load first
        service.loadModel(LoadModelRequest.newBuilder().setModelId("clip-vit").build(),
            new CapturingObserver<>()); 

        CapturingObserver<UnloadModelResponse> observer = new CapturingObserver<>(); 
        service.unloadModel(UnloadModelRequest.newBuilder().setModelId("clip-vit").build(), observer);

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getSuccess()).isTrue(); 
    }

    // ─────────────────────────────────────────────────────────────────────────
    // listModels (AV-004.3) 
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("listModels: empty registry → zero count")
    void listModels_emptyRegistry_returnsZeroModels() { 
        CapturingObserver<ListModelsResponse> observer = new CapturingObserver<>(); 
        service.listModels(ListModelsRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getTotalCount()).isEqualTo(0); 
    }

    @Test
    @DisplayName("listModels: after loadModel → includes loaded model")
    void listModels_afterLoad_includesModel() { 
        service.loadModel(LoadModelRequest.newBuilder().setModelId("whisper-large").build(),
            new CapturingObserver<>()); 

        CapturingObserver<ListModelsResponse> observer = new CapturingObserver<>(); 
        service.listModels(ListModelsRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isFalse(); 
        ListModelsResponse response = observer.getValue(); 
        assertThat(response.getTotalCount()).isGreaterThanOrEqualTo(1); 
        assertThat(response.getLoadedCount()).isGreaterThanOrEqualTo(1); 
    }

    @Test
    @DisplayName("listModels: loadedOnly filter → unloaded models excluded")
    void listModels_loadedOnlyFilter_excludesUnloaded() { 
        // Load then unload a model
        service.loadModel(LoadModelRequest.newBuilder().setModelId("test-model").build(),
            new CapturingObserver<>()); 
        service.unloadModel(UnloadModelRequest.newBuilder().setModelId("test-model").build(),
            new CapturingObserver<>()); 

        CapturingObserver<ListModelsResponse> observer = new CapturingObserver<>(); 
        service.listModels( 
            ListModelsRequest.newBuilder().setIncludeLoadedOnly(true).build(), 
            observer);

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getTotalCount()).isEqualTo(0); 
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getStatus
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("getStatus: does not promote a generic adapter backend to provider readiness")
    void getStatus_returnsStatus() { 
        CapturingObserver<StatusResponse> observer = new CapturingObserver<>(); 
        service.getStatus(StatusRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getStatus()).isEqualTo("NOT_ADMITTED");
        assertThat(observer.getValue().getStatus()).doesNotContain("test-backend", "healthy");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // healthCheck
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("healthCheck: missing qualified child providers returns not healthy")
    void healthCheck_returnsNotServingWithoutQualifiedProviders() {
        CapturingObserver<HealthCheckResponse> observer = new CapturingObserver<>();
        service.healthCheck(HealthCheckRequest.getDefaultInstance(), observer);

        assertThat(observer.hasError()).isFalse();
        assertThat(observer.getValue().getHealthy()).isFalse();
        assertThat(observer.getValue().getMessage())
                .isEqualTo("MULTIMODAL_NOT_SERVING: qualified child provider readiness unavailable");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test infrastructure
    // ─────────────────────────────────────────────────────────────────────────

    static class CapturingObserver<T> implements StreamObserver<T> {
        private T value;
        private Throwable error;

        @Override public void onNext(T value) { this.value = value; } 
        @Override public void onError(Throwable t) { this.error = t; } 
        @Override public void onCompleted() {} 

        T getValue() { return value; } 
        boolean hasError() { return error != null; } 
        Throwable getError() { return error; } 
    }

    private static void withContext(String tenantId, Runnable action) {
        Context.current().withValue(JwtServerInterceptor.CTX_TENANT, tenantId)
                .withValue(JwtServerInterceptor.CTX_SUBJECT, SUBJECT_ID).run(action);
    }
}
