package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.model.ModelRegistry;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.grpc.proto.*;
import com.ghatana.audio.video.vision.model.BoundingBox;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.model.ObjectAttributes;
import com.ghatana.audio.video.vision.model.VisionCapabilityDisposition;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audio.video.vision.video.SourceMediaTimestamp;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

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

    @Test
    void sourceFrameTimestampWireMappingPreservesKnownPtsAndMarksUnknownWithoutFabricatedMillis() {
        var known = VisionGrpcService.mapSourceTimestamp(new VideoFrameExtractor.ExtractedFrame(
                java.nio.file.Path.of("frame.jpg"), SourceMediaTimestamp.fromPts("90000", "1/90000"), 3)).build();
        assertThat(known.getTimestampStatus()).isEqualTo(SourceTimestampStatus.SOURCE_TIMESTAMP_KNOWN);
        assertThat(known.getTimestampMs()).isEqualTo(1000L);
        assertThat(known.getSourcePts()).isEqualTo(90000L);
        assertThat(known.getSourceTimeBaseDenominator()).isEqualTo(90000L);

        var unknown = VisionGrpcService.mapSourceTimestamp(new VideoFrameExtractor.ExtractedFrame(
                java.nio.file.Path.of("frame.jpg"), SourceMediaTimestamp.unknown("SOURCE_PTS_MISSING"), 4)).build();
        assertThat(unknown.getTimestampStatus()).isEqualTo(SourceTimestampStatus.SOURCE_TIMESTAMP_UNKNOWN);
        assertThat(unknown.getTimestampUnknownReason()).isEqualTo("SOURCE_PTS_MISSING");
        assertThat(unknown.getTimestampMs()).isZero(); // Protobuf default, explicitly marked unknown above.
        assertThat(unknown.getSourcePts()).isZero(); // No source PTS was serialized.
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
            .attributes(ObjectAttributes.builder().orientation("EXIF_ORIENTATION_1_OR_ABSENT")
                .additionalProperties(java.util.Map.of("bbox.coordinate_space", "exif_oriented_source_raster_pixel_xywh",
                    "source.content_version", "NOT_PROVIDED_BY_CONTRACT")).build())
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
        assertThat(detection.getAttributes()).containsEntry("bbox.coordinate_space", "exif_oriented_source_raster_pixel_xywh");
        assertThat(fakeDetector.lastOptions.isConfidenceThresholdSpecified()).isFalse();
        assertThat(detection.getAttributes()).containsEntry("source.content_version", "NOT_PROVIDED_BY_CONTRACT");
    }

    @Test
    void detectObjectsPassesAnExplicitConfidenceThresholdToTheDetector() {
        DetectRequest request = DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[]{1, 2, 3}))
                .setConfidenceThreshold(0.77)
                .build();
        CapturingObserver<DetectResponse> observer = new CapturingObserver<>();

        withContext(TENANT_ID, () -> service.detectObjects(request, observer));

        assertThat(observer.hasError()).isFalse();
        assertThat(fakeDetector.lastOptions.isConfidenceThresholdSpecified()).isTrue();
        assertThat(fakeDetector.lastOptions.getConfidenceThreshold()).isEqualTo(0.77);
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

    @Test
    @DisplayName("detectObjects: unsupported EXIF orientation maps to UNIMPLEMENTED")
    void detectObjects_unsupportedExif_returnsUnimplemented() {
        fakeDetector.setThrowOnDetect(new com.ghatana.audio.video.vision.image.BoundedImageDecoder.UnsupportedImageMetadataException(
                "EXIF orientation 6 is unsupported; image was not inferred"));
        DetectRequest request = DetectRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[] {1})).build();
        CapturingObserver<DetectResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.detectObjects(request, observer));
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNIMPLEMENTED.getCode());
    }

    // -------------------------------------------------------------------------
    // analyzeImage
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("analyzeImage: objects cannot be substituted for admitted scene analysis")
    void analyzeImage_withObjectsRemainsUnimplemented() {
        fakeDetector.setResults(buildDetections("person", "dog"));
        AnalyzeRequest request = AnalyzeRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[]{1})).addAnalysisTypes("scene").build();
        CapturingObserver<AnalyzeResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.analyzeImage(request, observer));
        assertUnimplemented(observer);
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    @DisplayName("analyzeImage: no detections does not produce an inferred scene")
    void analyzeImage_noDetectionsRemainsUnimplemented() {
        AnalyzeRequest request = AnalyzeRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[]{1})).build();
        CapturingObserver<AnalyzeResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.analyzeImage(request, observer));
        assertUnimplemented(observer);
        assertThat(fakeDetector.calls).isZero();
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
    @DisplayName("analyzeImage: missing authentication precedes unsupported disposition")
    void analyzeImage_missingTenant_returnsUnauthenticatedWithoutDetectorCall() {
        AnalyzeRequest request = AnalyzeRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[] {1})).build();
        CapturingObserver<AnalyzeResponse> observer = new CapturingObserver<>();
        service.analyzeImage(request, observer);
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    @DisplayName("analyzeImage: unsupported analysis does not dispatch to detector")
    void analyzeImage_unsupportedAnalysisDoesNotCallDetector() {
        fakeDetector.setThrowOnDetect(new VisionDetector.DetectionException("model error", null));
        AnalyzeRequest request = AnalyzeRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[]{1})).build();
        CapturingObserver<AnalyzeResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.analyzeImage(request, observer));
        assertUnimplemented(observer);
        assertThat(fakeDetector.calls).isZero();
    }

    @ParameterizedTest
    @EnumSource(VisionCapabilityDisposition.class)
    @DisplayName("registered Vision intents return NOT_ADMITTED before detector dispatch")
    void analyzeImage_registeredIntentIsNotAdmittedBeforeDetectorCall(
            VisionCapabilityDisposition disposition) {
        AnalyzeRequest request = AnalyzeRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[] {1}))
                .addAnalysisTypes(disposition.intentId())
                .build();
        CapturingObserver<AnalyzeResponse> observer = new CapturingObserver<>();

        withContext(TENANT_ID, () -> service.analyzeImage(request, observer));

        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) observer.getError();
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.UNIMPLEMENTED.getCode());
        assertThat(failure.getStatus().getDescription())
                .contains(disposition.intentId())
                .contains(VisionCapabilityDisposition.Status.NOT_ADMITTED.name());
        assertThat(fakeDetector.calls).isZero();
    }

    @ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {
            "media.vision.segment.image",
            "media.vision.segment.video",
            "media.vision.segment.motion",
            "media.vision.estimate.optical-flow",
            "media.vision.estimate.depth",
            "media.vision.estimate.surface-normals",
            "media.vision.estimate.human-pose",
            "media.vision.estimate.hand-pose",
            "media.vision.matte.foreground-background",
            "media.vision.estimate.saliency"
    })
    @DisplayName("analyzeImage: advanced tensor intents never fall back to YOLO boxes or scene labels")
    void analyzeImage_advancedIntentNeverFallsBackToObjectDetections(String intentId) {
        // An available detection is not evidence for segmentation, geometry, pose, matte,
        // saliency, or a scene label. The RPC must fail before dispatching to that provider.
        fakeDetector.setResults(buildDetections("person", "dog"));
        AnalyzeRequest request = AnalyzeRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[] {1}))
                .addAnalysisTypes(intentId)
                .build();
        CapturingObserver<AnalyzeResponse> observer = new CapturingObserver<>();

        withContext(TENANT_ID, () -> service.analyzeImage(request, observer));

        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) observer.getError();
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.UNIMPLEMENTED.getCode());
        assertThat(failure.getStatus().getDescription())
                .contains(intentId)
                .contains(VisionCapabilityDisposition.Status.NOT_ADMITTED.name());
        assertThat(observer.getValue()).isNull();
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    @DisplayName("Vision capability census maps exactly 22 intents to the ten proto RPCs")
    void visionCapabilityCensusMatchesPdpIdsRpcContractsAndProviderQualification() {
        Map<String, Set<String>> expectedRpcBindings = Map.ofEntries(
                Map.entry("media.vision.scene-text.region.track", Set.of("AnalyzeVideoFile", "ProcessVideo")),
                Map.entry("media.vision.scene-text.observation.create",
                        Set.of("AnalyzeImage", "AnalyzeVideoFile", "ProcessVideo")),
                Map.entry("media.vision.detect", Set.of("DetectObjects", "AnalyzeVideoFile", "ProcessVideo")),
                Map.entry("media.vision.classify", Set.of("ClassifyImage")),
                Map.entry("media.vision.segment.image", Set.of("AnalyzeImage")),
                Map.entry("media.vision.segment.video", Set.of("AnalyzeVideoFile", "ProcessVideo")),
                Map.entry("media.vision.track.object", Set.of("AnalyzeVideoFile", "ProcessVideo")),
                Map.entry("media.vision.track.point", Set.of("AnalyzeVideoFile", "ProcessVideo")),
                Map.entry("media.vision.estimate.optical-flow", Set.of("AnalyzeVideoFile", "ProcessVideo")),
                Map.entry("media.vision.estimate.depth",
                        Set.of("AnalyzeImage", "AnalyzeVideoFile", "ProcessVideo")),
                Map.entry("media.vision.estimate.surface-normals", Set.of("AnalyzeImage")),
                Map.entry("media.vision.estimate.human-pose", Set.of("AnalyzeImage")),
                Map.entry("media.vision.estimate.hand-pose", Set.of("AnalyzeImage")),
                Map.entry("media.vision.estimate.face-landmarks", Set.of("AnalyzeImage")),
                Map.entry("media.vision.analyze.expression", Set.of("AnalyzeImage")),
                Map.entry("media.vision.analyze.gaze", Set.of("AnalyzeImage")),
                Map.entry("media.vision.matte.foreground-background",
                        Set.of("AnalyzeImage", "AnalyzeVideoFile")),
                Map.entry("media.vision.segment.motion", Set.of("AnalyzeVideoFile", "ProcessVideo")),
                Map.entry("media.vision.estimate.saliency", Set.of("AnalyzeImage", "AnalyzeVideoFile")),
                Map.entry("media.vision.classify.scene", Set.of("AnalyzeImage", "ClassifyImage")),
                Map.entry("media.vision.detect.shot-boundary", Set.of("AnalyzeVideoFile")),
                Map.entry("media.vision.estimate.camera-motion", Set.of("AnalyzeVideoFile", "ProcessVideo")));

        assertThat(java.util.Arrays.stream(VisionCapabilityDisposition.values())
                .map(VisionCapabilityDisposition::intentId).toList())
                .containsExactlyInAnyOrderElementsOf(expectedRpcBindings.keySet());
        assertThat(VisionCapabilityDisposition.values()).hasSize(22);

        for (VisionCapabilityDisposition capability : VisionCapabilityDisposition.values()) {
            assertThat(capability.rpcMethods())
                    .as("RPC bindings for %s", capability.intentId())
                    .containsExactlyInAnyOrderElementsOf(expectedRpcBindings.get(capability.intentId()));
            assertThat(capability.status()).isEqualTo(VisionCapabilityDisposition.Status.NOT_ADMITTED);
            assertThat(capability.qualifiedModelVersion()).isEmpty();
            assertThat(capability.qualifiedFormats()).isEmpty();
        }
        assertThat(java.util.Arrays.stream(VisionCapabilityDisposition.values())
                .filter(capability -> capability.status() == VisionCapabilityDisposition.Status.NOT_ADMITTED))
                .hasSize(22);

        List<String> implemented = java.util.Arrays.stream(VisionCapabilityDisposition.values())
                .filter(capability -> capability.implementationStatus()
                        == VisionCapabilityDisposition.ImplementationStatus.IMPLEMENTED)
                .map(VisionCapabilityDisposition::intentId).toList();
        assertThat(implemented).containsExactly("media.vision.detect");
        List<String> contractOnly = java.util.Arrays.stream(VisionCapabilityDisposition.values())
                .filter(capability -> capability.implementationStatus()
                        == VisionCapabilityDisposition.ImplementationStatus.CONTRACT_ONLY)
                .map(VisionCapabilityDisposition::intentId).toList();
        assertThat(contractOnly).containsExactlyInAnyOrder(
                        "media.vision.classify",
                        "media.vision.classify.scene",
                        "media.vision.detect.shot-boundary",
                        "media.vision.estimate.camera-motion");

        assertThat(VisionServiceGrpc.getServiceDescriptor().getMethods())
                .extracting("bareMethodName")
                .containsExactlyInAnyOrder(
                        "DetectObjects", "AnalyzeImage", "ClassifyImage", "AnalyzeVideoFile", "ProcessVideo",
                        "LoadModel", "UnloadModel", "ListModels", "GetStatus", "HealthCheck");
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
    @DisplayName("classifyImage: missing authentication precedes unsupported disposition")
    void classifyImage_missingTenant_returnsUnauthenticatedWithoutDetectorCall() {
        ClassifyRequest request = ClassifyRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[] {1})).build();
        CapturingObserver<ClassifyResponse> observer = new CapturingObserver<>();
        service.classifyImage(request, observer);
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    @DisplayName("classifyImage: object detections cannot be substituted for classification")
    void classifyImage_withDetectionsRemainsUnimplemented() {
        fakeDetector.setResults(buildDetections("cat", "cat", "dog"));
        ClassifyRequest request = ClassifyRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[]{1})).setTopK(5).build();
        CapturingObserver<ClassifyResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.classifyImage(request, observer));
        assertUnimplemented(observer);
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    @DisplayName("classifyImage: unsupported classification does not dispatch to detector")
    void classifyImage_unsupportedClassificationDoesNotCallDetector() {
        fakeDetector.setThrowOnDetect(new VisionDetector.DetectionException("model error", null));
        ClassifyRequest request = ClassifyRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[]{1})).build();
        CapturingObserver<ClassifyResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.classifyImage(request, observer));
        assertUnimplemented(observer);
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    void analyzeVideoFile_missingTenantRejectsBeforeTemporaryStorageOrProvider() {
        CapturingObserver<VideoFileResponse> observer = new CapturingObserver<>();
        service.analyzeVideoFile(VideoFileRequest.newBuilder()
                .setVideoData(ByteString.copyFrom(new byte[]{1, 2, 3})).build(), observer);
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    void analyzeVideoFile_emptyPayloadRejectsBeforeTemporaryStorageOrProvider() {
        CapturingObserver<VideoFileResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.analyzeVideoFile(
                VideoFileRequest.getDefaultInstance(), observer));
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    void analyzeVideoFile_rejectsOutOfRangeSamplingBeforeProviderOrTempStorage() {
        CapturingObserver<VideoFileResponse> excessiveFps = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.analyzeVideoFile(VideoFileRequest.newBuilder()
                .setVideoData(ByteString.copyFrom(new byte[]{1}))
                .setSampleFps(61)
                .build(), excessiveFps));
        assertThat(((StatusRuntimeException) excessiveFps.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());

        CapturingObserver<VideoFileResponse> excessiveFrames = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.analyzeVideoFile(VideoFileRequest.newBuilder()
                .setVideoData(ByteString.copyFrom(new byte[]{1}))
                .setMaxFrames(10_001)
                .build(), excessiveFrames));
        assertThat(((StatusRuntimeException) excessiveFrames.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    void videoStreamBudgetBoundsCumulativeInputAndFrameCount() {
        VisionGrpcService.VideoStreamBudget byteBudget = new VisionGrpcService.VideoStreamBudget();
        int maxImageBytes = 50 * 1024 * 1024;
        for (int frame = 0; frame < 10; frame++) {
            assertThat(byteBudget.tryAccept(maxImageBytes)).isTrue();
        }
        assertThat(byteBudget.tryAccept(maxImageBytes)).isFalse();

        VisionGrpcService.VideoStreamBudget frameBudget = new VisionGrpcService.VideoStreamBudget();
        for (int frame = 0; frame < VisionGrpcService.VideoStreamBudget.MAX_FRAMES; frame++) {
            assertThat(frameBudget.tryAccept(1)).isTrue();
        }
        assertThat(frameBudget.tryAccept(1)).isFalse();
        assertThat(frameBudget.tryAccept(0)).isFalse();
    }

    @Test
    void processVideo_missingTenantRejectsFrameBeforeProvider() {
        CapturingObserver<VideoFrameResponse> observer = new CapturingObserver<>();
        var stream = service.processVideo(observer);
        stream.onNext(VideoFrameRequest.newBuilder()
                .setFrameData(ByteString.copyFrom(new byte[]{1})).build());
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    void processVideoUnauthenticatedFailureIsTerminalForTheStream() {
        CapturingObserver<VideoFrameResponse> observer = new CapturingObserver<>();
        var stream = service.processVideo(observer);
        stream.onNext(VideoFrameRequest.newBuilder()
                .setFrameData(ByteString.copyFrom(new byte[]{1})).build());
        withContext(TENANT_ID, () -> stream.onNext(VideoFrameRequest.newBuilder()
                .setFrameData(ByteString.copyFrom(new byte[]{2})).build()));
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
        assertThat(observer.getValue()).isNull();
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    void processVideo_emptyFrameRejectsBeforeProvider() {
        CapturingObserver<VideoFrameResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.processVideo(observer)
                .onNext(VideoFrameRequest.getDefaultInstance()));
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        assertThat(fakeDetector.calls).isZero();
    }

    // -------------------------------------------------------------------------
    // loadModel (AV-003.1) 
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("loadModel: blank modelId → INVALID_ARGUMENT")
    void loadModel_blankModelId_returnsInvalidArgument() { 
        CapturingObserver<LoadModelResponse> observer = new CapturingObserver<>(); 

        withContext(TENANT_ID, () -> service.loadModel(LoadModelRequest.getDefaultInstance(), observer));

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    @Test
    @DisplayName("loadModel: valid modelId without provider admission → UNAVAILABLE")
    void loadModel_validModelId_returnsUnavailableWithoutRegistryMutation() {
        CapturingObserver<LoadModelResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.loadModel(
                LoadModelRequest.newBuilder().setModelId("yolov8n").build(), observer));
        assertStatus(observer, Status.UNAVAILABLE);
    }

    // -------------------------------------------------------------------------
    // unloadModel (AV-003.2) 
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("unloadModel: blank modelId → INVALID_ARGUMENT")
    void unloadModel_blankModelId_returnsInvalidArgument() { 
        CapturingObserver<UnloadModelResponse> observer = new CapturingObserver<>(); 

        withContext(TENANT_ID, () -> service.unloadModel(UnloadModelRequest.getDefaultInstance(), observer));

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    @Test
    @DisplayName("unloadModel: modelId without provider admission → UNAVAILABLE")
    void unloadModel_modelId_returnsUnavailableWithoutRegistryMutation() {
        CapturingObserver<UnloadModelResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.unloadModel(
                UnloadModelRequest.newBuilder().setModelId("unknown-model").build(), observer));
        assertStatus(observer, Status.UNAVAILABLE);
    }

    @Test
    void modelManagementAndListingRequireTenantBeforeModelEffects() {
        CapturingObserver<LoadModelResponse> load = new CapturingObserver<>();
        service.loadModel(LoadModelRequest.newBuilder().setModelId("candidate").build(), load);
        assertStatus(load, Status.UNAUTHENTICATED);

        CapturingObserver<UnloadModelResponse> unload = new CapturingObserver<>();
        service.unloadModel(UnloadModelRequest.newBuilder().setModelId("candidate").build(), unload);
        assertStatus(unload, Status.UNAUTHENTICATED);

        CapturingObserver<ListModelsResponse> list = new CapturingObserver<>();
        service.listModels(ListModelsRequest.getDefaultInstance(), list);
        assertStatus(list, Status.UNAUTHENTICATED);
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    void modelManagementAndListingFailClosedBeforeRegistryAccessWithoutProviderAdmission() {
        ModelRegistry registry = mock(ModelRegistry.class);
        VisionGrpcService unadmittedService = new VisionGrpcService(
                fakeDetector, frameExtractor, MediaProcessingMetrics.noop(), null, registry);

        CapturingObserver<LoadModelResponse> blankLoad = new CapturingObserver<>();
        withContext(TENANT_ID, () -> unadmittedService.loadModel(
                LoadModelRequest.getDefaultInstance(), blankLoad));
        assertStatus(blankLoad, Status.INVALID_ARGUMENT);

        CapturingObserver<UnloadModelResponse> blankUnload = new CapturingObserver<>();
        withContext(TENANT_ID, () -> unadmittedService.unloadModel(
                UnloadModelRequest.getDefaultInstance(), blankUnload));
        assertStatus(blankUnload, Status.INVALID_ARGUMENT);

        CapturingObserver<LoadModelResponse> load = new CapturingObserver<>();
        withContext(TENANT_ID, () -> unadmittedService.loadModel(
                LoadModelRequest.newBuilder().setModelId("candidate").build(), load));
        assertStatus(load, Status.UNAVAILABLE);

        CapturingObserver<UnloadModelResponse> unload = new CapturingObserver<>();
        withContext(TENANT_ID, () -> unadmittedService.unloadModel(
                UnloadModelRequest.newBuilder().setModelId("candidate").build(), unload));
        assertStatus(unload, Status.UNAVAILABLE);

        CapturingObserver<ListModelsResponse> list = new CapturingObserver<>();
        withContext(TENANT_ID, () -> unadmittedService.listModels(
                ListModelsRequest.getDefaultInstance(), list));
        assertStatus(list, Status.UNAVAILABLE);

        verifyNoInteractions(registry);
    }

    @Test
    void declaredTenRpcDispositionMatrix() {
        // Each declared RPC has an executable unauthenticated or availability
        // disposition; no positive fake-provider response is treated as real qualification.
        CapturingObserver<DetectResponse> detect = new CapturingObserver<>();
        service.detectObjects(DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[]{1})).build(), detect);
        assertStatus(detect, Status.UNAUTHENTICATED);

        CapturingObserver<AnalyzeResponse> analyze = new CapturingObserver<>();
        service.analyzeImage(AnalyzeRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[]{1})).build(), analyze);
        assertStatus(analyze, Status.UNAUTHENTICATED);

        CapturingObserver<ClassifyResponse> classify = new CapturingObserver<>();
        service.classifyImage(ClassifyRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[]{1})).build(), classify);
        assertStatus(classify, Status.UNAUTHENTICATED);

        CapturingObserver<VideoFileResponse> video = new CapturingObserver<>();
        service.analyzeVideoFile(VideoFileRequest.newBuilder()
                .setVideoData(ByteString.copyFrom(new byte[]{1})).build(), video);
        assertStatus(video, Status.UNAUTHENTICATED);

        CapturingObserver<VideoFrameResponse> streamResponse = new CapturingObserver<>();
        var process = service.processVideo(streamResponse);
        process.onNext(VideoFrameRequest.newBuilder()
                .setFrameData(ByteString.copyFrom(new byte[]{1})).build());
        assertStatus(streamResponse, Status.UNAUTHENTICATED);

        CapturingObserver<LoadModelResponse> load = new CapturingObserver<>();
        service.loadModel(LoadModelRequest.newBuilder().setModelId("unknown").build(), load);
        assertStatus(load, Status.UNAUTHENTICATED);

        CapturingObserver<UnloadModelResponse> unload = new CapturingObserver<>();
        service.unloadModel(UnloadModelRequest.newBuilder().setModelId("unknown").build(), unload);
        assertStatus(unload, Status.UNAUTHENTICATED);

        CapturingObserver<ListModelsResponse> list = new CapturingObserver<>();
        service.listModels(ListModelsRequest.getDefaultInstance(), list);
        assertStatus(list, Status.UNAUTHENTICATED);

        CapturingObserver<StatusResponse> status = new CapturingObserver<>();
        service.getStatus(StatusRequest.getDefaultInstance(), status);
        assertThat(status.getValue().getStatus()).isEqualTo("not_admitted");
        assertThat(status.getValue().getModelName()).isEqualTo("UNAVAILABLE");

        CapturingObserver<HealthCheckResponse> health = new CapturingObserver<>();
        service.healthCheck(HealthCheckRequest.getDefaultInstance(), health);
        assertThat(health.getValue().getHealthy()).isFalse();
        assertThat(fakeDetector.calls).isZero();
    }

    // -------------------------------------------------------------------------
    // listModels (AV-003.3) 
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("listModels: no admitted provider → UNAVAILABLE")
    void listModels_withoutProviderAdmission_returnsUnavailable() {
        CapturingObserver<ListModelsResponse> observer = new CapturingObserver<>(); 

        withContext(TENANT_ID, () -> service.listModels(ListModelsRequest.getDefaultInstance(), observer));

        assertStatus(observer, Status.UNAVAILABLE);
    }

    // -------------------------------------------------------------------------
    // getStatus
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("getStatus: initialized detector remains not admitted without trusted root readiness")
    void getStatus_initialized_notAdmitted() {
        // GIVEN
        fakeDetector.setInitialized(true); 
        CapturingObserver<StatusResponse> observer = new CapturingObserver<>(); 

        // WHEN
        service.getStatus(StatusRequest.getDefaultInstance(), observer); 

        // THEN
        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getStatus()).isEqualTo("not_admitted");
        assertThat(observer.getValue().getModelName()).isEqualTo("UNAVAILABLE");
        assertThat(observer.getValue().getDegradedReason()).isEqualTo("PROVIDER_NOT_ADMITTED");
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
        assertThat(observer.getValue().getStatus()).isEqualTo("not_admitted");
    }

    // -------------------------------------------------------------------------
    // healthCheck
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("healthCheck: detector initialization alone does not establish readiness")
    void healthCheck_initialized_returnsNotAdmitted() {
        // GIVEN
        fakeDetector.setInitialized(true); 
        CapturingObserver<HealthCheckResponse> observer = new CapturingObserver<>(); 

        // WHEN
        service.healthCheck(HealthCheckRequest.getDefaultInstance(), observer); 

        // THEN
        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getHealthy()).isFalse();
        assertThat(observer.getValue().getMessage()).contains("NOT_SERVING");
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static void assertUnimplemented(CapturingObserver<?> observer) {
        assertThat(observer.hasError()).isTrue();
        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNIMPLEMENTED.getCode());
    }

    private static void assertStatus(CapturingObserver<?> observer, Status expected) {
        assertThat(observer.hasError()).isTrue();
        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(expected.getCode());
    }

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
        private int calls = 0;
        private DetectionOptions lastOptions;

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
            calls++;
            lastOptions = options;
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
