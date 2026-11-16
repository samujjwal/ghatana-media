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
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
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
import java.util.Optional;
import java.util.Set;
import javax.imageio.ImageIO;

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
    @DisplayName("detectObjects: ROI request fails closed until crop-aware provider admission")
    void detectObjects_roiRequestDoesNotDispatchAsFullFrame() {
        DetectRequest request = DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(png(4, 3)))
                .setSourceRasterRoi(SourceRasterRoi.newBuilder()
                        .setX(3).setY(0).setWidth(1).setHeight(3)
                        .setSourceFrameVersion("frame-v42"))
                .build();
        CapturingObserver<DetectResponse> observer = new CapturingObserver<>();

        withContext(TENANT_ID, () -> service.detectObjects(request, observer));

        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.FAILED_PRECONDITION.getCode());
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    @DisplayName("detectObjects: ROI outside decoded EXIF-oriented raster is invalid before provider admission")
    void detectObjects_roiOutsideDecodedRasterIsRejectedBeforeProviderDispatch() {
        DetectRequest request = DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(png(4, 3)))
                .setSourceRasterRoi(SourceRasterRoi.newBuilder()
                        .setX(3).setY(0).setWidth(2).setHeight(3)
                        .setSourceFrameVersion("frame-v42"))
                .build();
        CapturingObserver<DetectResponse> observer = new CapturingObserver<>();

        withContext(TENANT_ID, () -> service.detectObjects(request, observer));

        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    @DisplayName("detectObjects: ROI bounds use the EXIF-oriented raster dimensions")
    void detectObjects_roiBoundsUseExifOrientedRasterDimensions() {
        byte[] rotatedImage = jpegWithExifOrientation(8, 6, 6);
        DetectRequest rotatedEdge = DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(rotatedImage))
                .setSourceRasterRoi(SourceRasterRoi.newBuilder()
                        .setX(5).setY(7).setWidth(1).setHeight(1)
                        .setSourceFrameVersion("frame-v42"))
                .build();
        CapturingObserver<DetectResponse> edgeObserver = new CapturingObserver<>();

        withContext(TENANT_ID, () -> service.detectObjects(rotatedEdge, edgeObserver));

        assertThat(edgeObserver.getError()).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) edgeObserver.getError()).getStatus().getCode())
                .isEqualTo(Status.FAILED_PRECONDITION.getCode());

        DetectRequest outsideOrientedEdge = DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(rotatedImage))
                .setSourceRasterRoi(SourceRasterRoi.newBuilder()
                        .setX(6).setY(0).setWidth(1).setHeight(1)
                        .setSourceFrameVersion("frame-v42"))
                .build();
        CapturingObserver<DetectResponse> outsideObserver = new CapturingObserver<>();

        withContext(TENANT_ID, () -> service.detectObjects(outsideOrientedEdge, outsideObserver));

        assertThat(outsideObserver.getError()).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) outsideObserver.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    @DisplayName("detectObjects: malformed ROI metadata is invalid before provider admission")
    void detectObjects_malformedRoiMetadataIsRejectedAsInvalidArgument() {
        List<SourceRasterRoi> malformedRois = List.of(
                SourceRasterRoi.newBuilder().setX(10).setY(20).setWidth(100).setHeight(80).build(),
                SourceRasterRoi.newBuilder().setX(10).setY(20).setWidth(0).setHeight(80)
                        .setSourceFrameVersion("frame-v42").build(),
                SourceRasterRoi.newBuilder().setX(-1).setY(20).setWidth(100).setHeight(80)
                        .setSourceFrameVersion("frame-v42").build(),
                SourceRasterRoi.newBuilder().setX(Integer.MAX_VALUE).setY(20).setWidth(100).setHeight(80)
                        .setSourceFrameVersion("frame-v42").build());

        for (SourceRasterRoi roi : malformedRois) {
            DetectRequest request = DetectRequest.newBuilder()
                    .setImageData(ByteString.copyFrom(new byte[] {1, 2, 3}))
                    .setSourceRasterRoi(roi)
                    .build();
            CapturingObserver<DetectResponse> observer = new CapturingObserver<>();

            withContext(TENANT_ID, () -> service.detectObjects(request, observer));

            assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class);
            assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                    .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        }
        assertThat(fakeDetector.calls).isZero();
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
    @DisplayName("detectObjects: malformed source-pixel boxes fail before response delivery")
    void detectObjects_malformedProviderBoxesAreRejected() {
        List<BoundingBox> malformedBoxes = List.of(
                BoundingBox.builder().x(-1).y(0).width(10).height(10).build(),
                BoundingBox.builder().x(0).y(-1).width(10).height(10).build(),
                BoundingBox.builder().x(0).y(0).width(0).height(10).build(),
                BoundingBox.builder().x(0).y(0).width(10).height(0).build());

        for (BoundingBox box : malformedBoxes) {
            fakeDetector.setResults(List.of(DetectedObject.builder()
                    .className("object")
                    .confidence(0.8)
                    .boundingBox(box)
                    .build()));
            CapturingObserver<DetectResponse> observer = new CapturingObserver<>();
            DetectRequest request = DetectRequest.newBuilder()
                    .setImageData(ByteString.copyFrom(new byte[] {1}))
                    .build();

            withContext(TENANT_ID, () -> service.detectObjects(request, observer));

            assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class);
            assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                    .isEqualTo(Status.INTERNAL.getCode());
            assertThat(observer.getValue()).isNull();
        }
    }

    @Test
    @DisplayName("detectObjects: malformed provider confidence is rejected before response delivery")
    void detectObjects_nonFiniteProviderConfidenceIsRejected() {
        fakeDetector.setResults(List.of(DetectedObject.builder()
                .className("object")
                .confidence(Double.NaN)
                .boundingBox(BoundingBox.builder().x(0).y(0).width(10).height(10).build())
                .build()));
        CapturingObserver<DetectResponse> observer = new CapturingObserver<>();
        DetectRequest request = DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[] {1}))
                .build();

        withContext(TENANT_ID, () -> service.detectObjects(request, observer));

        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INTERNAL.getCode());
        assertThat(observer.getValue()).isNull();
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
    @DisplayName("detectObjects: invalid confidence thresholds fail before provider dispatch")
    void detectObjects_rejectsOutOfRangeAndNonFiniteConfidenceThresholds() {
        List<Double> invalidThresholds = List.of(-0.01, 1.01, Double.NaN,
                Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY);

        for (double threshold : invalidThresholds) {
            CapturingObserver<DetectResponse> observer = new CapturingObserver<>();
            DetectRequest request = DetectRequest.newBuilder()
                    .setImageData(ByteString.copyFrom(new byte[] {1}))
                    .setConfidenceThreshold(threshold)
                    .build();

            withContext(TENANT_ID, () -> service.detectObjects(request, observer));

            assertStatus(observer, Status.INVALID_ARGUMENT);
            assertThat(observer.getValue()).isNull();
        }
        assertThat(fakeDetector.calls).isZero();
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
    void detectObjects_providerTimeoutMapsToDeadlineExceeded() {
        fakeDetector.setThrowOnDetect(new java.util.concurrent.CompletionException(
                new java.util.concurrent.TimeoutException("private provider timeout detail")));
        CapturingObserver<DetectResponse> observer = new CapturingObserver<>();

        withContext(TENANT_ID, () -> service.detectObjects(DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[]{0x42})).build(), observer));

        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) observer.getError();
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.DEADLINE_EXCEEDED.getCode());
        assertThat(failure.getStatus().getDescription()).isEqualTo("Vision provider deadline exceeded");
    }

    @Test
    void detectObjects_providerCancellationMapsToCancelled() {
        fakeDetector.setThrowOnDetect(new java.util.concurrent.CancellationException(
                "private provider cancellation detail"));
        CapturingObserver<DetectResponse> observer = new CapturingObserver<>();

        withContext(TENANT_ID, () -> service.detectObjects(DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[]{0x42})).build(), observer));

        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) observer.getError();
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.CANCELLED.getCode());
        assertThat(failure.getStatus().getDescription()).isEqualTo("Vision provider operation was cancelled");
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

    @Test
    void analyzeImage_rejectsBlankAnalysisSelectorsAndKeepsValidSelectorNotAdmitted() {
        for (String invalidSelector : List.of("", "   ", "\t\n")) {
            AnalyzeRequest malformed = AnalyzeRequest.newBuilder()
                    .setImageData(ByteString.copyFrom(new byte[] {1}))
                    .addAnalysisTypes(invalidSelector)
                    .build();
            CapturingObserver<AnalyzeResponse> rejected = new CapturingObserver<>();
            withContext(TENANT_ID, () -> service.analyzeImage(malformed, rejected));
            assertStatus(rejected, Status.INVALID_ARGUMENT);
            assertThat(rejected.getValue()).isNull();
        }

        AnalyzeRequest validSelector = AnalyzeRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[] {1}))
                .addAnalysisTypes("scene")
                .build();
        CapturingObserver<AnalyzeResponse> notAdmitted = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.analyzeImage(validSelector, notAdmitted));

        assertUnimplemented(notAdmitted);
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    void recognizeSceneText_oversizedCallerCropIsRejectedBeforeSourceOrDiAccess() {
        java.util.concurrent.atomic.AtomicInteger sourceChecks = new java.util.concurrent.atomic.AtomicInteger();
        var documentIntelligence = mock(
                com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.class);
        var sceneText = new com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService(
                Optional.of(documentIntelligence), check -> {
                    sourceChecks.incrementAndGet();
                    return com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Decision.of(
                            com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceStatus.UNAVAILABLE);
                }, new com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Policy(
                        "di.ocr.en", "2.4.1", "model.scene-text.en", "2026.09.2",
                        Set.of("image/png"), Set.of("en"), 5_000, Map.of()));
        service.bindSceneTextService(sceneText);

        String sourceSha = "a".repeat(64);
        SceneTextRecognizeRequest request = validSceneTextRequest(sourceSha)
                .setCroppedBytes(ByteString.copyFrom(new byte[
                        com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.MAX_CROP_BYTES + 1]))
                .setCroppedFrameSha256("b".repeat(64))
                .build();
        CapturingObserver<SceneTextRecognizeResponse> observer = new CapturingObserver<>();

        withAuthenticatedSubject(() -> service.recognizeSceneText(request, observer));

        assertThat(observer.getValue()).isNotNull();
        assertThat(observer.getValue().hasRejected()).isTrue();
        assertThat(observer.getValue().getRejected().getCode()).isEqualTo("INVALID_REQUEST");
        assertThat(observer.getValue().getRejected().getRetryable()).isFalse();
        assertThat(sourceChecks).hasValue(0);
        verifyNoInteractions(documentIntelligence);
    }

    @Test
    void recognizeSceneText_validOmittedCropUsesSourceGateAndStillAvoidsUnadmittedDi() {
        java.util.concurrent.atomic.AtomicInteger sourceChecks = new java.util.concurrent.atomic.AtomicInteger();
        var documentIntelligence = mock(
                com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.class);
        var sceneText = new com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService(
                Optional.of(documentIntelligence), check -> {
                    sourceChecks.incrementAndGet();
                    return com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Decision.of(
                            com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceStatus.NOT_ADMITTED);
                }, new com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Policy(
                        "di.ocr.en", "2.4.1", "model.scene-text.en", "2026.09.2",
                        Set.of("image/png"), Set.of("en"), 5_000, Map.of()));
        service.bindSceneTextService(sceneText);
        CapturingObserver<SceneTextRecognizeResponse> observer = new CapturingObserver<>();

        withAuthenticatedSubject(() -> service.recognizeSceneText(
                validSceneTextRequest("a".repeat(64)).build(), observer));

        assertThat(observer.getValue()).isNotNull();
        assertThat(observer.getValue().hasRejected()).isTrue();
        assertThat(observer.getValue().getRejected().getCode()).isEqualTo("SOURCE_DENIED");
        assertThat(sourceChecks).hasValue(1);
        verifyNoInteractions(documentIntelligence);
    }

    private static SceneTextRecognizeRequest.Builder validSceneTextRequest(String sourceSha) {
        return SceneTextRecognizeRequest.newBuilder()
                .setOperationId("operation-1")
                .setPurposeRef("captioning")
                .setSourceArtifactId("artifact-1")
                .setSourceVersion("sha256:" + sourceSha)
                .setFrameId("frame-1")
                .setPtsUs(0)
                .setFrameWidth(100)
                .setFrameHeight(80)
                .setRoi(SceneTextRoi.newBuilder().setX(10).setY(20).setWidth(40).setHeight(30))
                .setMediaType("image/png")
                .setOriginalFrameSha256(sourceSha);
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
    void resolveSourceFrameRejectsNegativePtsAndNonCanonicalOrdinalsBeforeSourceAdmission() {
        List<SourceFrameResolveRequest> malformed = List.of(
                validSourceFrameRequest().setPtsUs(-1).build(),
                validSourceFrameRequest().setFrameId("00").build(),
                validSourceFrameRequest().setFrameId("10000001").build());

        for (SourceFrameResolveRequest request : malformed) {
            CapturingObserver<SourceFrameResolveResponse> observer = new CapturingObserver<>();
            withAuthenticatedSubject(() -> service.resolveSourceFrame(request, observer));
            assertThat(observer.getValue()).isNotNull();
            assertThat(observer.getValue().hasRejected()).isTrue();
            assertThat(observer.getValue().getRejected().getCode()).isEqualTo("INVALID_REQUEST");
            assertThat(observer.getValue().getRejected().getRetryable()).isFalse();
        }
    }

    @Test
    void resolveSourceFrameValidRequestRemainsNotAdmittedWhenReaderIsAbsent() {
        CapturingObserver<SourceFrameResolveResponse> observer = new CapturingObserver<>();
        withAuthenticatedSubject(() -> service.resolveSourceFrame(validSourceFrameRequest().build(), observer));

        assertThat(observer.getValue()).isNotNull();
        assertThat(observer.getValue().hasRejected()).isTrue();
        assertThat(observer.getValue().getRejected().getCode()).isEqualTo("SOURCE_NOT_ADMITTED");
        assertThat(observer.getValue().getRejected().getRetryable()).isFalse();
    }

    private static SourceFrameResolveRequest.Builder validSourceFrameRequest() {
        return SourceFrameResolveRequest.newBuilder()
                .setSourceArtifactId("artifact-vision-test")
                .setSourceVersion("sha256:" + "a".repeat(64))
                .setFrameId("0")
                .setPtsUs(0)
                .setFrameWidth(8)
                .setFrameHeight(8)
                .setRoi(SceneTextRoi.newBuilder().setX(1).setY(1).setWidth(4).setHeight(4))
                .setPurposeRef("captioning");
    }

    private static void withAuthenticatedSubject(Runnable action) {
        Context.current()
                .withValue(JwtServerInterceptor.CTX_TENANT, TENANT_ID)
                .withValue(JwtServerInterceptor.CTX_SUBJECT, "principal-vision-test")
                .run(action);
    }

    @Test
    @DisplayName("Vision capability census maps exactly 22 intents; source-frame read is a separate RPC")
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
                        "DetectObjects", "AnalyzeImage", "ClassifyImage", "RecognizeSceneText",
                        "AnalyzeVideoFile", "ProcessVideo",
                        "LoadModel", "UnloadModel", "ListModels", "GetStatus", "HealthCheck",
                        "ResolveSourceFrame");
        // ResolveSourceFrame performs an authenticated, rights-revalidated metadata-only source read.
        // It is covered by resolveSourceFrameOverGrpcReturnsMetadataAndFailsClosedOnRightsDenial,
        // and is deliberately outside the 22 model-intent dispositions above.
        assertThat(expectedRpcBindings).hasSize(22);
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
    void classifyImage_rejectsMalformedTopKAndConfidenceBeforeProviderDisposition() {
        List<ClassifyRequest> invalidRequests = List.of(
                ClassifyRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[] {1}))
                        .setTopK(-1).build(),
                ClassifyRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[] {1}))
                        .setConfidenceThreshold(-0.01).build(),
                ClassifyRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[] {1}))
                        .setConfidenceThreshold(1.01).build(),
                ClassifyRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[] {1}))
                        .setConfidenceThreshold(Double.NaN).build(),
                ClassifyRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[] {1}))
                        .setConfidenceThreshold(Double.POSITIVE_INFINITY).build());

        for (ClassifyRequest request : invalidRequests) {
            CapturingObserver<ClassifyResponse> observer = new CapturingObserver<>();
            withContext(TENANT_ID, () -> service.classifyImage(request, observer));
            assertStatus(observer, Status.INVALID_ARGUMENT);
            assertThat(observer.getValue()).isNull();
        }
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    void classifyImage_validDefaultAndThresholdBoundaryRemainNotAdmitted() {
        ClassifyRequest request = ClassifyRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[] {1}))
                .setTopK(0) // proto default means use the declared default of five labels
                .setConfidenceThreshold(1.0)
                .build();
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
    void analyzeVideoFile_rejectsOutOfRangeAndNonFiniteThresholdBeforeCodecOrProvider() {
        List<Double> invalidThresholds = List.of(-0.01, 1.01, Double.NaN,
                Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY);

        for (double threshold : invalidThresholds) {
            CapturingObserver<VideoFileResponse> observer = new CapturingObserver<>();
            VideoFileRequest request = VideoFileRequest.newBuilder()
                    .setVideoData(ByteString.copyFrom(new byte[] {1, 2, 3}))
                    .setConfidenceThreshold(threshold)
                    .build();

            withContext(TENANT_ID, () -> service.analyzeVideoFile(request, observer));

            assertStatus(observer, Status.INVALID_ARGUMENT);
            assertThat(observer.getValue()).isNull();
        }
        assertThat(fakeDetector.calls).isZero();
        verifyNoInteractions(frameExtractor);
    }

    @Test
    void analyzeVideoFile_confidenceThresholdBoundsAndProtoDefaultAreStable() {
        assertThat(VisionGrpcService.isValidVideoConfidenceThreshold(0.0)).isTrue();
        assertThat(VisionGrpcService.isValidVideoConfidenceThreshold(1.0)).isTrue();
        assertThat(VisionGrpcService.effectiveVideoConfidenceThreshold(0.0)).isEqualTo(0.5);
        assertThat(VisionGrpcService.effectiveVideoConfidenceThreshold(0.73)).isEqualTo(0.73);
        assertThat(VisionGrpcService.effectiveVideoConfidenceThreshold(1.0)).isEqualTo(1.0);
        assertThat(VisionGrpcService.isValidVideoConfidenceThreshold(Double.NaN)).isFalse();
        assertThat(VisionGrpcService.isValidVideoConfidenceThreshold(Double.POSITIVE_INFINITY)).isFalse();
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

    @Test
    void processVideo_negativeFrameOrdinalRejectsBeforeProviderDispatch() {
        CapturingObserver<VideoFrameResponse> observer = new CapturingObserver<>();
        java.util.concurrent.atomic.AtomicReference<StreamObserver<VideoFrameRequest>> requestStream =
                new java.util.concurrent.atomic.AtomicReference<>();

        withContext(TENANT_ID, () -> requestStream.set(service.processVideo(observer)));
        withContext(TENANT_ID, () -> requestStream.get().onNext(VideoFrameRequest.newBuilder()
                .setFrameData(ByteString.copyFrom(new byte[] {0x42}))
                .setFrameNumber(-1)
                .build()));

        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getDescription())
                .isEqualTo("frameNumber must be non-negative");
        assertThat(observer.getValue()).isNull();
        assertThat(fakeDetector.calls).isZero();
    }

    @Test
    void processVideo_zeroBasedFirstFrameIsAcceptedAndEchoed() {
        CapturingObserver<VideoFrameResponse> observer = new CapturingObserver<>();
        java.util.concurrent.atomic.AtomicReference<StreamObserver<VideoFrameRequest>> requestStream =
                new java.util.concurrent.atomic.AtomicReference<>();

        withContext(TENANT_ID, () -> requestStream.set(service.processVideo(observer)));
        withContext(TENANT_ID, () -> requestStream.get().onNext(VideoFrameRequest.newBuilder()
                .setFrameData(ByteString.copyFrom(new byte[] {0x42}))
                .setFrameNumber(0)
                .setTimestampMs(0)
                .build()));

        assertThat(observer.getError()).isNull();
        assertThat(observer.getValue()).isNotNull();
        assertThat(observer.getValue().getFrameNumber()).isZero();
        assertThat(observer.getValue().getTimestampMs()).isZero();
        assertThat(fakeDetector.calls).isEqualTo(1);
    }

    @Test
    void processVideo_providerTimeoutMapsToDeadlineExceededAndRedactsDetails() {
        String privateDetail = "private vision provider timeout detail";
        fakeDetector.setThrowOnDetect(new java.util.concurrent.CompletionException(
                new java.util.concurrent.TimeoutException(privateDetail)));
        CapturingObserver<VideoFrameResponse> observer = new CapturingObserver<>();
        java.util.concurrent.atomic.AtomicReference<StreamObserver<VideoFrameRequest>> requestStream =
                new java.util.concurrent.atomic.AtomicReference<>();

        withContext(TENANT_ID, () -> requestStream.set(service.processVideo(observer)));
        withContext(TENANT_ID, () -> requestStream.get().onNext(VideoFrameRequest.newBuilder()
                .setFrameData(ByteString.copyFrom(new byte[] {0x42}))
                .build()));

        assertThat(observer.getError()).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) observer.getError();
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.DEADLINE_EXCEEDED.getCode());
        assertThat(failure.getStatus().getDescription()).isEqualTo("Vision provider deadline exceeded");
        assertThat(failure.getStatus().getDescription()).doesNotContain(privateDetail);
        assertThat(observer.getValue()).isNull();
        assertThat(fakeDetector.calls).isEqualTo(1);
    }

    // -------------------------------------------------------------------------
    // loadModel (AV-003.1) 
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("loadModel: blank modelId → INVALID_ARGUMENT")
    void loadModel_blankModelId_returnsInvalidArgument() { 
        CapturingObserver<LoadModelResponse> observer = new CapturingObserver<>(); 

        withAuthenticatedSubject(() -> service.loadModel(LoadModelRequest.getDefaultInstance(), observer));

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    @Test
    @DisplayName("loadModel: valid modelId without provider admission → UNAVAILABLE")
    void loadModel_validModelId_returnsUnavailableWithoutRegistryMutation() {
        CapturingObserver<LoadModelResponse> observer = new CapturingObserver<>();
        withAuthenticatedSubject(() -> service.loadModel(
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

        withAuthenticatedSubject(() -> service.unloadModel(UnloadModelRequest.getDefaultInstance(), observer));

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    @Test
    @DisplayName("unloadModel: modelId without provider admission → UNAVAILABLE")
    void unloadModel_modelId_returnsUnavailableWithoutRegistryMutation() {
        CapturingObserver<UnloadModelResponse> observer = new CapturingObserver<>();
        withAuthenticatedSubject(() -> service.unloadModel(
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
        withAuthenticatedSubject(() -> unadmittedService.loadModel(
                LoadModelRequest.getDefaultInstance(), blankLoad));
        assertStatus(blankLoad, Status.INVALID_ARGUMENT);

        CapturingObserver<UnloadModelResponse> blankUnload = new CapturingObserver<>();
        withAuthenticatedSubject(() -> unadmittedService.unloadModel(
                UnloadModelRequest.getDefaultInstance(), blankUnload));
        assertStatus(blankUnload, Status.INVALID_ARGUMENT);

        CapturingObserver<LoadModelResponse> missingActorLoad = new CapturingObserver<>();
        withContext(TENANT_ID, () -> unadmittedService.loadModel(
                LoadModelRequest.newBuilder().setModelId("caller-selected-model").build(), missingActorLoad));
        assertStatus(missingActorLoad, Status.UNAUTHENTICATED);

        CapturingObserver<UnloadModelResponse> missingActorUnload = new CapturingObserver<>();
        withContext(TENANT_ID, () -> unadmittedService.unloadModel(
                UnloadModelRequest.newBuilder().setModelId("caller-selected-model").build(), missingActorUnload));
        assertStatus(missingActorUnload, Status.UNAUTHENTICATED);

        CapturingObserver<LoadModelResponse> load = new CapturingObserver<>();
        withAuthenticatedSubject(() -> unadmittedService.loadModel(
                LoadModelRequest.newBuilder().setModelId("candidate").build(), load));
        assertStatus(load, Status.UNAVAILABLE);

        CapturingObserver<UnloadModelResponse> unload = new CapturingObserver<>();
        withAuthenticatedSubject(() -> unadmittedService.unloadModel(
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

    private static byte[] png(int width, int height) {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (!ImageIO.write(image, "png", output)) {
                throw new IllegalStateException("PNG writer is unavailable");
            }
            return output.toByteArray();
        } catch (IOException failure) {
            throw new IllegalStateException("Unable to encode PNG fixture", failure);
        }
    }

    private static byte[] jpegWithExifOrientation(int width, int height, int orientation) {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (!ImageIO.write(image, "jpg", output)) {
                throw new IllegalStateException("JPEG writer is unavailable");
            }
            byte[] jpeg = output.toByteArray();
            byte[] tiff = new byte[] {
                    'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0,
                    0x12, 0x01, 3, 0, 1, 0, 0, 0, (byte) orientation, 0, 0, 0,
                    0, 0, 0, 0
            };
            byte[] exif = new byte[6 + tiff.length];
            System.arraycopy(new byte[] {'E', 'x', 'i', 'f', 0, 0}, 0, exif, 0, 6);
            System.arraycopy(tiff, 0, exif, 6, tiff.length);
            int segmentLength = exif.length + 2;
            byte[] result = new byte[jpeg.length + exif.length + 4];
            result[0] = (byte) 0xFF;
            result[1] = (byte) 0xD8;
            result[2] = (byte) 0xFF;
            result[3] = (byte) 0xE1;
            result[4] = (byte) (segmentLength >>> 8);
            result[5] = (byte) segmentLength;
            System.arraycopy(exif, 0, result, 6, exif.length);
            System.arraycopy(jpeg, 2, result, 6 + exif.length, jpeg.length - 2);
            return result;
        } catch (IOException failure) {
            throw new IllegalStateException("Unable to encode JPEG fixture", failure);
        }
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
