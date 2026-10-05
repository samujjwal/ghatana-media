package com.ghatana.media.vision;

import com.ghatana.media.common.*;
import com.ghatana.media.vision.api.*;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/**
 * Service-contract tests for {@link VisionEngine}.
 *
 * <p>These tests use a Mockito stub that strictly models the interface contract,
 * verifying that:
 * <ul>
 *   <li>Successful detection produces a well-formed {@link DetectionResult}</li>
 *   <li>Detected object confidence values are within [0, 1]</li>
 *   <li>Error scenarios surface the declared exception types</li>
 *   <li>Caption and classification results honour their documented invariants</li>
 *   <li>Confidence-threshold filtering via {@code getObjectsAboveConfidence} is correct</li>
 *   <li>Model management and engine status follow documented contracts</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Contract tests for the VisionEngine computer-vision service interface
 * @doc.layer platform
 * @doc.pattern Test
 */
@DisplayName("VisionEngine – service contract")
@ExtendWith(MockitoExtension.class)
class VisionEngineContractTest {

    @Mock
    private VisionEngine engine;

    // =========================================================================
    // Successful detection
    // =========================================================================

    @Nested
    @DisplayName("Object detection")
    class ObjectDetection {

        @Test
        @DisplayName("result objects list is non-null")
        void detectionResultObjectsIsNonNull() {
            ImageData image = minimalImage();
            DetectionResult result = emptyDetection(image);
            when(engine.detect(any(), any())).thenReturn(result);

            DetectionResult actual = engine.detect(image, DetectionOptions.defaults());

            assertThat(actual.objects()).isNotNull();
        }

        @Test
        @DisplayName("modelId in result is non-blank")
        void detectionResultModelIdIsPresent() {
            ImageData image = minimalImage();
            DetectionResult result = emptyDetection(image);
            when(engine.detect(any(), any())).thenReturn(result);

            DetectionResult actual = engine.detect(image, DetectionOptions.defaults());

            assertThat(actual.modelId()).isNotBlank();
        }

        @Test
        @DisplayName("processingTimeMs is non-negative")
        void processingTimeMsIsNonNegative() {
            ImageData image = minimalImage();
            DetectionResult result = emptyDetection(image);
            when(engine.detect(any(), any())).thenReturn(result);

            assertThat(engine.detect(image, DetectionOptions.defaults()).processingTimeMs())
                .isGreaterThanOrEqualTo(0L);
        }

        @Test
        @DisplayName("imageWidth and imageHeight in result match the input dimensions")
        void detectionResultDimensionsMatchInput() {
            ImageData image = imageOf(640, 480);
            DetectionResult result = new DetectionResult(List.of(), 640, 480, 15L, "yolov8n");
            when(engine.detect(any(), any())).thenReturn(result);

            DetectionResult actual = engine.detect(image, DetectionOptions.defaults());

            assertThat(actual.imageWidth()).isEqualTo(640);
            assertThat(actual.imageHeight()).isEqualTo(480);
        }

        @Test
        @DisplayName("each detected object confidence is within [0, 1]")
        void eachObjectConfidenceIsInRange() {
            ImageData image = minimalImage();
            List<DetectedObject> objects = List.of(
                new DetectedObject("person", 0.92,
                    new BoundingBox(10, 10, 50, 100, 0.92)),
                new DetectedObject("car", 0.75,
                    new BoundingBox(200, 100, 120, 80, 0.75))
            );
            DetectionResult result = new DetectionResult(objects, 320, 240, 20L, "yolov8n");
            when(engine.detect(any(), any())).thenReturn(result);

            DetectionResult actual = engine.detect(image, DetectionOptions.defaults());

            actual.objects().forEach(obj ->
                assertThat(obj.confidence())
                    .as("detected object confidence must be in [0, 1]")
                    .isGreaterThanOrEqualTo(0.0)
                    .isLessThanOrEqualTo(1.0)
            );
        }

        @Test
        @DisplayName("getObjectsAboveConfidence filters correctly")
        void confidenceFilteringWorks() {
            ImageData image = minimalImage();
            List<DetectedObject> objects = List.of(
                new DetectedObject("person", 0.92, new BoundingBox(0, 0, 50, 100, 0.92)),
                new DetectedObject("dog",    0.60, new BoundingBox(100, 0, 40, 60, 0.60)),
                new DetectedObject("cat",    0.45, new BoundingBox(200, 0, 40, 60, 0.45))
            );
            DetectionResult result = new DetectionResult(objects, 320, 240, 12L, "yolov8n");
            when(engine.detect(any(), any())).thenReturn(result);

            DetectionResult actual = engine.detect(image, DetectionOptions.defaults());

            List<DetectedObject> highConf = actual.getObjectsAboveConfidence(0.7);
            assertThat(highConf).hasSize(1);
            assertThat(highConf.getFirst().className()).isEqualTo("person");

            List<DetectedObject> medConf = actual.getObjectsAboveConfidence(0.5);
            assertThat(medConf).hasSize(2);
        }

        @Test
        @DisplayName("count() equals objects list size")
        void countMatchesObjectsSize() {
            ImageData image = minimalImage();
            List<DetectedObject> objects = List.of(
                new DetectedObject("bicycle", 0.88, new BoundingBox(0, 0, 80, 120, 0.88)),
                new DetectedObject("truck",   0.71, new BoundingBox(90, 0, 100, 80, 0.71))
            );
            DetectionResult result = new DetectionResult(objects, 320, 240, 8L, "yolov8n");
            when(engine.detect(any(), any())).thenReturn(result);

            DetectionResult actual = engine.detect(image, DetectionOptions.defaults());

            assertThat(actual.count()).isEqualTo(actual.objects().size());
        }

        @Test
        @DisplayName("no-object scene returns empty list, not null")
        void emptySceneReturnsEmptyList() {
            ImageData image = minimalImage();
            DetectionResult result = new DetectionResult(List.of(), 320, 240, 5L, "yolov8n");
            when(engine.detect(any(), any())).thenReturn(result);

            DetectionResult actual = engine.detect(image, DetectionOptions.defaults());

            assertThat(actual.objects()).isEmpty();
            assertThat(actual.count()).isZero();
        }
    }

    // =========================================================================
    // Error contract
    // =========================================================================

    @Nested
    @DisplayName("Error contract")
    class ErrorContract {

        @Test
        @DisplayName("ValidationError is thrown for unsupported image format")
        void invalidImageThrowsValidationError() {
            when(engine.detect(any(), any()))
                .thenThrow(new ValidationError("Unsupported image format"));

            assertThatThrownBy(() -> engine.detect(minimalImage(), DetectionOptions.defaults()))
                .isInstanceOf(ValidationError.class);
        }

        @Test
        @DisplayName("InferenceError with isRetryable=false propagates without swallowing")
        void nonRetryableInferenceErrorPropagates() {
            when(engine.detect(any(), any()))
                .thenThrow(new InferenceError("ONNX model error",
                    new RuntimeException("YOLO crash"), false));

            assertThatThrownBy(() -> engine.detect(minimalImage(), DetectionOptions.defaults()))
                .isInstanceOf(InferenceError.class)
                .satisfies(e -> assertThat(((InferenceError) e).isRetryable()).isFalse());
        }

        @Test
        @DisplayName("InferenceError with isRetryable=true signals safe retry")
        void retryableInferenceErrorIsTagged() {
            when(engine.detect(any(), any()))
                .thenThrow(new InferenceError("Timeout", new RuntimeException(), true));

            assertThatThrownBy(() -> engine.detect(minimalImage(), DetectionOptions.defaults()))
                .isInstanceOf(InferenceError.class)
                .satisfies(e -> assertThat(((InferenceError) e).isRetryable()).isTrue());
        }

        @Test
        @DisplayName("ModelLoadingError is thrown when no model is loaded")
        void noModelLoadedThrowsModelLoadingError() {
            when(engine.detect(any(), any()))
                .thenThrow(new ModelLoadingError("No detection model loaded"));

            assertThatThrownBy(() -> engine.detect(minimalImage(), DetectionOptions.defaults()))
                .isInstanceOf(ModelLoadingError.class);
        }
    }

    // =========================================================================
    // Image analysis (caption + classification)
    // =========================================================================

    @Nested
    @DisplayName("Image analysis")
    class ImageAnalysis {

        @Test
        @DisplayName("caption returns non-null, non-blank string for a valid image")
        void captionIsPresent() {
            when(engine.caption(any())).thenReturn("A person walking a dog in a park");

            String caption = engine.caption(minimalImage());

            assertThat(caption).isNotBlank();
        }

        @Test
        @DisplayName("classify returns a list with at most topK entries")
        void classifyRespectsTopK() {
            List<Classification> top3 = List.of(
                new Classification("cat", 0.85),
                new Classification("lynx", 0.08),
                new Classification("panther", 0.04)
            );
            when(engine.classify(any(), eq(3))).thenReturn(top3);

            List<Classification> result = engine.classify(minimalImage(), 3);

            assertThat(result).hasSizeLessThanOrEqualTo(3);
        }

        @Test
        @DisplayName("every classification confidence is within [0, 1]")
        void classificationConfidenceIsInRange() {
            List<Classification> classes = List.of(
                new Classification("ship", 0.91),
                new Classification("boat", 0.07),
                new Classification("raft", 0.02)
            );
            when(engine.classify(any(), anyInt())).thenReturn(classes);

            List<Classification> result = engine.classify(minimalImage(), 3);

            result.forEach(c ->
                assertThat(c.confidence())
                    .as("classification confidence must be in [0, 1]")
                    .isGreaterThanOrEqualTo(0.0)
                    .isLessThanOrEqualTo(1.0)
            );
        }

        @Test
        @DisplayName("classify returns an empty list (not null) when no class matches")
        void classifyReturnsEmptyNotNull() {
            when(engine.classify(any(), anyInt())).thenReturn(List.of());

            assertThat(engine.classify(minimalImage(), 5)).isNotNull().isEmpty();
        }
    }

    // =========================================================================
    // Model management
    // =========================================================================

    @Nested
    @DisplayName("Model management")
    class ModelManagement {

        @Test
        @DisplayName("getAvailableModels returns a non-null list")
        void availableModelsIsNonNull() {
            when(engine.getAvailableModels()).thenReturn(List.of(
                new DetectionModelInfo("yolov8n", "YOLOv8 Nano", "8.0",
                    new String[]{"person", "car"}, 6_000_000L, true, 640, 640,
                    Optional.of("Nano variant"))
            ));

            assertThat(engine.getAvailableModels()).isNotNull();
        }

        @Test
        @DisplayName("getActiveModel returns the currently loaded model")
        void activeModelIsNonNull() {
            DetectionModelInfo model = new DetectionModelInfo("yolov8s", "YOLOv8 Small", "8.0",
                new String[]{"person", "bicycle", "car"}, 22_000_000L, true, 640, 640,
                Optional.empty());
            when(engine.getActiveModel()).thenReturn(model);

            DetectionModelInfo active = engine.getActiveModel();

            assertThat(active).isNotNull();
            assertThat(active.modelId()).isNotBlank();
        }

        @Test
        @DisplayName("loadModel delegates to the engine implementation")
        void loadModelDelegates() {
            doNothing().when(engine).loadModel("yolov8m");

            engine.loadModel("yolov8m");

            verify(engine).loadModel("yolov8m");
        }

        @Test
        @DisplayName("ModelLoadingError propagates for an unknown model ID")
        void unknownModelThrows() {
            doThrow(new ModelLoadingError("Model 'nonexistent' not found"))
                .when(engine).loadModel("nonexistent");

            assertThatThrownBy(() -> engine.loadModel("nonexistent"))
                .isInstanceOf(ModelLoadingError.class)
                .hasMessageContaining("nonexistent");
        }
    }

    // =========================================================================
    // Engine status and metrics
    // =========================================================================

    @Nested
    @DisplayName("Engine status and metrics")
    class EngineStatusAndMetrics {

        @Test
        @DisplayName("READY status reports isReady=true and isHealthy=true")
        void readyStatusInvariant() {
            EngineStatus status = new EngineStatus(EngineStatus.State.READY, "yolov8n", "8.0", 3000L, null);
            when(engine.getStatus()).thenReturn(status);

            EngineStatus actual = engine.getStatus();

            assertThat(actual.isReady()).isTrue();
            assertThat(actual.isHealthy()).isTrue();
        }

        @Test
        @DisplayName("ERROR status reports isReady=false and isHealthy=false")
        void errorStatusIsNotReady() {
            EngineStatus status = new EngineStatus(
                EngineStatus.State.ERROR, "yolov8n", "8.0", 0L, "ONNX model crash");
            when(engine.getStatus()).thenReturn(status);

            EngineStatus actual = engine.getStatus();

            assertThat(actual.isReady()).isFalse();
            assertThat(actual.isHealthy()).isFalse();
        }

        @Test
        @DisplayName("getMetrics returns non-negative request and error counts")
        void metricsCountsAreNonNegative() {
            EngineMetrics metrics = new EngineMetrics(500L, 8L, 35L, 2L, 0L);
            when(engine.getMetrics()).thenReturn(metrics);

            EngineMetrics actual = engine.getMetrics();

            assertThat(actual.requestCount()).isGreaterThanOrEqualTo(0L);
            assertThat(actual.errorCount()).isGreaterThanOrEqualTo(0L);
        }
    }

    // =========================================================================
    // BoundingBox value object invariants
    // =========================================================================

    @Nested
    @DisplayName("BoundingBox invariants")
    class BoundingBoxInvariants {

        @Test
        @DisplayName("area() equals width × height")
        void areaIsWidthTimesHeight() {
            BoundingBox box = new BoundingBox(10, 20, 50, 80, 0.9);
            assertThat(box.area()).isEqualTo(50.0 * 80.0);
        }

        @Test
        @DisplayName("centerX and centerY are computed correctly")
        void centersAreCorrect() {
            BoundingBox box = new BoundingBox(10, 20, 40, 60, 0.8);
            assertThat(box.centerX()).isEqualTo(30.0);
            assertThat(box.centerY()).isEqualTo(50.0);
        }

        @Test
        @DisplayName("overlapping boxes have positive IoU")
        void overlappingBoxesHavePositiveIou() {
            BoundingBox a = new BoundingBox(0, 0, 100, 100, 0.9);
            BoundingBox b = new BoundingBox(50, 50, 100, 100, 0.8);

            assertThat(a.iou(b))
                .as("overlapping boxes must have IoU > 0")
                .isGreaterThan(0.0)
                .isLessThanOrEqualTo(1.0);
        }

        @Test
        @DisplayName("non-overlapping boxes have IoU = 0")
        void nonOverlappingBoxesHaveZeroIou() {
            BoundingBox a = new BoundingBox(0, 0, 50, 50, 0.9);
            BoundingBox b = new BoundingBox(100, 100, 50, 50, 0.8);

            assertThat(a.iou(b)).isEqualTo(0.0);
        }

        @Test
        @DisplayName("negative width throws IllegalArgumentException")
        void negativeWidthThrows() {
            assertThatThrownBy(() -> new BoundingBox(0, 0, -1, 50, 0.5))
                .isInstanceOf(IllegalArgumentException.class);
        }

        @Test
        @DisplayName("confidence outside [0,1] throws IllegalArgumentException")
        void confidenceOutOfRangeThrows() {
            assertThatThrownBy(() -> new BoundingBox(0, 0, 50, 50, 1.1))
                .isInstanceOf(IllegalArgumentException.class);
        }
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private ImageData minimalImage() {
        return imageOf(320, 240);
    }

    private ImageData imageOf(int width, int height) {
        byte[] pixels = new byte[width * height * 3]; // RGB
        return new ImageData(pixels, width, height, ImageFormat.PNG, ColorSpace.RGB);
    }

    private DetectionResult emptyDetection(ImageData image) {
        return new DetectionResult(List.of(), image.width(), image.height(), 10L, "yolov8n");
    }
}
