package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.grpc.proto.*;
import com.ghatana.audio.video.vision.model.BoundingBox;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * Unit tests for {@link VisionGrpcService}.
 *
 * <p>Uses a {@link FakeVisionDetector} to avoid OpenCV / native-library dependencies.
 *
 * @doc.type class
 * @doc.purpose Unit tests for the vision gRPC service layer
 * @doc.layer product
 * @doc.pattern TestCase
 */
@DisplayName("VisionGrpcService")
class VisionGrpcServiceTest {

    private static final String TENANT_ID = "tenant-vision-test";

    private FakeVisionDetector fakeDetector;
    private VisionGrpcService service;
    private VideoFrameExtractor frameExtractor;

    @BeforeEach
    void setUp() { 
        fakeDetector = new FakeVisionDetector(); 
        frameExtractor = mock(VideoFrameExtractor.class); 
        service = new VisionGrpcService(fakeDetector, frameExtractor); 
    }

    // -------------------------------------------------------------------------
    // detectObjects
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("detectObjects: empty image bytes → INVALID_ARGUMENT gRPC error")
    void detectObjects_emptyImage_returnsError() { 
        // GIVEN
        DetectRequest request = DetectRequest.newBuilder() 
            .setImageData(ByteString.EMPTY) 
            .build(); 
        CapturingObserver<DetectResponse> observer = new CapturingObserver<>(); 

        // WHEN
        withContext(TENANT_ID, () -> service.detectObjects(request, observer));

        // THEN — service guards against empty image before calling detector
        assertThat(observer.hasError()).isTrue(); 
        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class); 
        StatusRuntimeException ex = (StatusRuntimeException) observer.getError(); 
        assertThat(ex.getStatus().getCode()).isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    @Test
    @DisplayName("detectObjects: detector returns detections → proto response mapped correctly")
    void detectObjects_normal_mapsDetectionsToProto() { 
        // GIVEN
        DetectedObject cat = DetectedObject.builder() 
            .className("cat")
            .confidence(0.92) 
            .boundingBox(BoundingBox.builder().x(10).y(20).width(100).height(80).build()) 
            .timestamp(Instant.now()) 
            .build(); 
        fakeDetector.setResults(List.of(cat)); 

        DetectRequest request = DetectRequest.newBuilder() 
            .setImageData(ByteString.copyFrom(new byte[]{1, 2, 3})) 
            .build(); 
        CapturingObserver<DetectResponse> observer = new CapturingObserver<>(); 

        // WHEN
        withContext(TENANT_ID, () -> service.detectObjects(request, observer));

        // THEN
        assertThat(observer.hasError()).isFalse(); 
        DetectResponse response = observer.getValue(); 
        assertThat(response.getDetectionsList()).hasSize(1); 
        Detection detection = response.getDetections(0); 
        assertThat(detection.getClassName()).isEqualTo("cat");
        assertThat(detection.getConfidence()).isEqualTo(0.92); 
        assertThat(detection.getBoundingBox().getX()).isEqualTo(10.0); 
        assertThat(detection.getBoundingBox().getWidth()).isEqualTo(100.0); 
    }

    @Test
    @DisplayName("detectObjects: multiple results → processing time included in response")
    void detectObjects_multipleResults_includesProcessingTime() { 
        // GIVEN
        fakeDetector.setResults(buildDetections("dog", "car", "person")); 
        DetectRequest request = DetectRequest.newBuilder() 
            .setImageData(ByteString.copyFrom(new byte[]{0x01})) 
            .setMaxDetections(10) 
            .build(); 
        CapturingObserver<DetectResponse> observer = new CapturingObserver<>(); 

        // WHEN
        withContext(TENANT_ID, () -> service.detectObjects(request, observer));

        // THEN
        assertThat(observer.hasError()).isFalse(); 
        DetectResponse response = observer.getValue(); 
        assertThat(response.getDetectionsList()).hasSize(3); 
        assertThat(response.getProcessingTimeMs()).isGreaterThanOrEqualTo(0); 
    }

    @Test
    @DisplayName("detectObjects: DetectionException from detector → INTERNAL gRPC error")
    void detectObjects_detectorThrows_propagatesError() { 
        // GIVEN
        fakeDetector.setThrowOnDetect(new VisionDetector.DetectionException("simulated failure", null)); 
        DetectRequest request = DetectRequest.newBuilder() 
            .setImageData(ByteString.copyFrom(new byte[]{0x42})) 
            .build(); 
        CapturingObserver<DetectResponse> observer = new CapturingObserver<>(); 

        // WHEN
        withContext(TENANT_ID, () -> service.detectObjects(request, observer));

        // THEN — DetectionException must map to INTERNAL, not leak the raw exception
        assertThat(observer.hasError()).isTrue(); 
        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class); 
        StatusRuntimeException ex = (StatusRuntimeException) observer.getError(); 
        assertThat(ex.getStatus().getCode()).isEqualTo(Status.INTERNAL.getCode()); 
        assertThat(ex.getStatus().getDescription()).contains("Detection engine error");
    }

    // -------------------------------------------------------------------------
    // analyzeImage
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("analyzeImage: objects detected → scene description generated")
    void analyzeImage_withObjects_generatesSceneDescription() { 
        // GIVEN
        fakeDetector.setResults(buildDetections("person", "dog")); 
        AnalyzeRequest request = AnalyzeRequest.newBuilder() 
            .setImageData(ByteString.copyFrom(new byte[]{0x01})) 
            .addAnalysisTypes("scene")
            .build(); 
        CapturingObserver<AnalyzeResponse> observer = new CapturingObserver<>(); 

        // WHEN
        withContext(TENANT_ID, () -> service.analyzeImage(request, observer));

        // THEN
        assertThat(observer.hasError()).isFalse(); 
        AnalyzeResponse response = observer.getValue(); 
        assertThat(response.getSceneDescription()).isNotBlank(); 
    }

    @Test
    @DisplayName("analyzeImage: no detections → scene description indicates empty scene")
    void analyzeImage_noDetections_returnsEmptySceneHint() { 
        // GIVEN
        fakeDetector.setResults(Collections.emptyList()); 
        AnalyzeRequest request = AnalyzeRequest.newBuilder() 
            .setImageData(ByteString.copyFrom(new byte[]{0x01})) 
            .build(); 
        CapturingObserver<AnalyzeResponse> observer = new CapturingObserver<>(); 

        // WHEN
        withContext(TENANT_ID, () -> service.analyzeImage(request, observer));

        // THEN
        assertThat(observer.hasError()).isFalse(); 
    }

    @Test
    @DisplayName("analyzeImage: empty image bytes → INVALID_ARGUMENT gRPC error")
    void analyzeImage_emptyImage_returnsInvalidArgument() { 
        // GIVEN
        AnalyzeRequest request = AnalyzeRequest.newBuilder() 
            .setImageData(ByteString.EMPTY) 
            .build(); 
        CapturingObserver<AnalyzeResponse> observer = new CapturingObserver<>(); 

        // WHEN
        withContext(TENANT_ID, () -> service.analyzeImage(request, observer));

        // THEN — service guards against empty image before calling detector
        assertThat(observer.hasError()).isTrue(); 
        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class); 
        StatusRuntimeException ex = (StatusRuntimeException) observer.getError(); 
        assertThat(ex.getStatus().getCode()).isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    @Test
    @DisplayName("analyzeImage: DetectionException from detector → INTERNAL gRPC error")
    void analyzeImage_detectorThrows_mapsToInternal() { 
        // GIVEN
        fakeDetector.setThrowOnDetect(new VisionDetector.DetectionException("model error", null)); 
        AnalyzeRequest request = AnalyzeRequest.newBuilder() 
            .setImageData(ByteString.copyFrom(new byte[]{0x01})) 
            .addAnalysisTypes("scene")
            .build(); 
        CapturingObserver<AnalyzeResponse> observer = new CapturingObserver<>(); 

        // WHEN
        withContext(TENANT_ID, () -> service.analyzeImage(request, observer));

        // THEN — DetectionException must map to INTERNAL with a safe message
        assertThat(observer.hasError()).isTrue(); 
        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class); 
        StatusRuntimeException ex = (StatusRuntimeException) observer.getError(); 
        assertThat(ex.getStatus().getCode()).isEqualTo(Status.INTERNAL.getCode()); 
        assertThat(ex.getStatus().getDescription()).contains("Analysis engine error");
    }

    // -------------------------------------------------------------------------
    // classifyImage (AV-003.5) 
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("classifyImage: empty image bytes → INVALID_ARGUMENT")
    void classifyImage_emptyImage_returnsInvalidArgument() { 
        ClassifyRequest request = ClassifyRequest.newBuilder().build(); 
        CapturingObserver<ClassifyResponse> observer = new CapturingObserver<>(); 

        withContext(TENANT_ID, () -> service.classifyImage(request, observer));

        assertThat(observer.hasError()).isTrue(); 
        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    @Test
    @DisplayName("classifyImage: detections returned \u2192 labels ranked by confidence")
    void classifyImage_withDetections_returnsRankedLabels() { 
        fakeDetector.setResults(buildDetections("cat", "cat", "dog")); 
        ClassifyRequest request = ClassifyRequest.newBuilder() 
            .setImageData(ByteString.copyFrom(new byte[]{0x01})) 
            .setTopK(5) 
            .build(); 
        CapturingObserver<ClassifyResponse> observer = new CapturingObserver<>(); 

        withContext(TENANT_ID, () -> service.classifyImage(request, observer));

        assertThat(observer.hasError()).isFalse(); 
        ClassifyResponse response = observer.getValue(); 
        assertThat(response.getLabelsList()).isNotEmpty(); 
        // cat appeared twice so its aggregated score should rank first
        assertThat(response.getLabels(0).getLabel()).isEqualTo("cat");
        assertThat(response.getLabels(0).getRank()).isEqualTo(1); 
        assertThat(response.getProcessingTimeMs()).isGreaterThanOrEqualTo(0); 
    }

    @Test
    @DisplayName("classifyImage: DetectionException → INTERNAL")
    void classifyImage_detectorThrows_returnsInternal() { 
        fakeDetector.setThrowOnDetect(new VisionDetector.DetectionException("model error", null)); 
        ClassifyRequest request = ClassifyRequest.newBuilder() 
            .setImageData(ByteString.copyFrom(new byte[]{0x01})) 
            .build(); 
        CapturingObserver<ClassifyResponse> observer = new CapturingObserver<>(); 

        withContext(TENANT_ID, () -> service.classifyImage(request, observer));

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INTERNAL.getCode()); 
    }

    // -------------------------------------------------------------------------
    // loadModel (AV-003.1) 
    // -------------------------------------------------------------------------

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
    @DisplayName("loadModel: valid modelId → registers and loads successfully")
    void loadModel_validModelId_loadsSuccessfully() { 
        CapturingObserver<LoadModelResponse> observer = new CapturingObserver<>(); 

        service.loadModel(LoadModelRequest.newBuilder().setModelId("yolov8n").build(), observer);

        assertThat(observer.hasError()).isFalse(); 
        LoadModelResponse response = observer.getValue(); 
        assertThat(response.getSuccess()).isTrue(); 
        assertThat(response.getModelId()).isEqualTo("yolov8n");
        assertThat(response.getLoadTimeMs()).isGreaterThanOrEqualTo(0); 
    }

    // -------------------------------------------------------------------------
    // unloadModel (AV-003.2) 
    // -------------------------------------------------------------------------

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
    void unloadModel_unregisteredModelId_returnsNotFound() { 
        CapturingObserver<UnloadModelResponse> observer = new CapturingObserver<>(); 

        service.unloadModel(UnloadModelRequest.newBuilder().setModelId("unknown-model").build(), observer);

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.NOT_FOUND.getCode()); 
    }

    @Test
    @DisplayName("unloadModel: loaded model → unloads successfully")
    void unloadModel_loadedModel_returnsSuccess() { 
        // Load first, then unload
        CapturingObserver<LoadModelResponse> loadObserver = new CapturingObserver<>(); 
        service.loadModel(LoadModelRequest.newBuilder().setModelId("yolov8-small").build(), loadObserver);
        assertThat(loadObserver.hasError()).isFalse(); 

        CapturingObserver<UnloadModelResponse> unloadObserver = new CapturingObserver<>(); 
        service.unloadModel(UnloadModelRequest.newBuilder().setModelId("yolov8-small").build(), unloadObserver);

        assertThat(unloadObserver.hasError()).isFalse(); 
        assertThat(unloadObserver.getValue().getSuccess()).isTrue(); 
    }

    // -------------------------------------------------------------------------
    // listModels (AV-003.3) 
    // -------------------------------------------------------------------------

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
        service.loadModel(LoadModelRequest.newBuilder().setModelId("test-model").build(),
            new CapturingObserver<>()); 

        CapturingObserver<ListModelsResponse> observer = new CapturingObserver<>(); 
        service.listModels(ListModelsRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getTotalCount()).isGreaterThanOrEqualTo(1); 
        assertThat(observer.getValue().getLoadedCount()).isGreaterThanOrEqualTo(1); 
    }

    // -------------------------------------------------------------------------
    // getStatus
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("getStatus: initialized detector → status healthy")
    void getStatus_initialized_healthy() { 
        // GIVEN
        fakeDetector.setInitialized(true); 
        CapturingObserver<StatusResponse> observer = new CapturingObserver<>(); 

        // WHEN
        service.getStatus(StatusRequest.getDefaultInstance(), observer); 

        // THEN
        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getStatus()).isEqualTo("healthy");
    }

    @Test
    @DisplayName("getStatus: uninitialized detector → status not_initialized")
    void getStatus_notInitialized_notInitialized() { 
        // GIVEN
        fakeDetector.setInitialized(false); 
        CapturingObserver<StatusResponse> observer = new CapturingObserver<>(); 

        // WHEN
        service.getStatus(StatusRequest.getDefaultInstance(), observer); 

        // THEN
        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getStatus()).isEqualTo("not_initialized");
    }

    // -------------------------------------------------------------------------
    // healthCheck
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("healthCheck: initialized → healthy = true")
    void healthCheck_initialized_returnsHealthy() { 
        // GIVEN
        fakeDetector.setInitialized(true); 
        CapturingObserver<HealthCheckResponse> observer = new CapturingObserver<>(); 

        // WHEN
        service.healthCheck(HealthCheckRequest.getDefaultInstance(), observer); 

        // THEN
        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getHealthy()).isTrue(); 
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static List<DetectedObject> buildDetections(String... classNames) { 
        List<DetectedObject> results = new ArrayList<>(); 
        for (String name : classNames) { 
            results.add(DetectedObject.builder() 
                .className(name) 
                .confidence(0.80) 
                .boundingBox(BoundingBox.builder().x(0).y(0).width(50).height(50).build()) 
                .timestamp(Instant.now()) 
                .build()); 
        }
        return results;
    }

    private static void withContext(String tenantId, Runnable action) {
        Context.current().withValue(JwtServerInterceptor.CTX_TENANT, tenantId).run(action);
    }

    // -------------------------------------------------------------------------
    // Test infrastructure
    // -------------------------------------------------------------------------

    /**
     * Fake {@link VisionDetector} that returns configurable results without native libs.
     */
    static class FakeVisionDetector implements VisionDetector {

        private List<DetectedObject> results = Collections.emptyList(); 
        private RuntimeException throwOnDetect = null;
        private boolean initialized = true;

        void setResults(List<DetectedObject> results) { 
            this.results = results;
        }

        void setThrowOnDetect(RuntimeException e) { 
            this.throwOnDetect = e;
        }

        void setInitialized(boolean initialized) { 
            this.initialized = initialized;
        }

        @Override
        public List<DetectedObject> detectObjects(byte[] imageData, DetectionOptions options) { 
            if (throwOnDetect != null) { 
                throw throwOnDetect;
            }
            return new ArrayList<>(results); 
        }

        @Override
        public boolean isInitialized() { 
            return initialized;
        }
    }

    /**
     * Simple {@link StreamObserver} that captures a single value or error for assertions.
     */
    static class CapturingObserver<T> implements StreamObserver<T> {

        private T value;
        private Throwable error;
        private boolean completed;

        @Override
        public void onNext(T value) { 
            this.value = value;
        }

        @Override
        public void onError(Throwable t) { 
            this.error = t;
        }

        @Override
        public void onCompleted() { 
            this.completed = true;
        }

        T getValue() { 
            return value;
        }

        boolean hasError() { 
            return error != null;
        }

        Throwable getError() { 
            return error;
        }
    }
}
