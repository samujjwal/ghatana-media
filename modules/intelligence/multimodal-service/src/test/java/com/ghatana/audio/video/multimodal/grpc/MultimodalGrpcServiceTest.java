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

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.when;

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

    @Mock
    private MultimodalAnalysisEngine mockEngine;

    @Mock
    private PlatformMultimodalAdapter mockAdapter;

    private MultimodalGrpcService service;

    @BeforeEach
    void setUp() { 
        service = new MultimodalGrpcService(mockEngine, mockAdapter, MediaProcessingMetrics.noop()); 
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
    }

    @Test
    @DisplayName("analyzeCrossModal: both audio and video → alignment score computed")
    void analyzeCrossModal_withBothModalities_returnsAlignmentScore() { 
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
        assertThat(response.getAlignmentScore()).isGreaterThan(0.0); 
        assertThat(response.getEventsList()).isNotEmpty(); 
        assertThat(response.getSummary()).isNotBlank(); 
    }

    @Test
    @DisplayName("analyzeCrossModal: audio only → partial alignment score")
    void analyzeCrossModal_audioOnly_returnsPartialAlignment() { 
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
        assertThat(observer.getValue().getAlignmentScore()).isEqualTo(0.4); 
        assertThat(observer.getValue().getEvents(0).getEventType()).isEqualTo("mismatch");
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
    @DisplayName("getStatus: returns healthy status with backend name")
    void getStatus_returnsStatus() { 
        CapturingObserver<StatusResponse> observer = new CapturingObserver<>(); 
        service.getStatus(StatusRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getStatus()).contains("healthy");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // healthCheck
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("healthCheck: always returns healthy = true")
    void healthCheck_returnsHealthy() { 
        CapturingObserver<HealthCheckResponse> observer = new CapturingObserver<>(); 
        service.healthCheck(HealthCheckRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getHealthy()).isTrue(); 
        assertThat(observer.getValue().getMessage()).isNotBlank(); 
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
        Context.current().withValue(JwtServerInterceptor.CTX_TENANT, tenantId).run(action);
    }
}
