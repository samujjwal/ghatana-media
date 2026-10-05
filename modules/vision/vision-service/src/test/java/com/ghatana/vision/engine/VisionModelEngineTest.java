package com.ghatana.vision.engine;

import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.detection.VisionDetector.VisionCapability;
import com.ghatana.audio.video.vision.model.BoundingBox;
import com.ghatana.audio.video.vision.model.ClassificationCandidate;
import com.ghatana.audio.video.vision.model.DetectedFace;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.model.Point;
import com.ghatana.vision.engine.VisionModelEngine.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.*;
import static org.assertj.core.data.Offset.offset;

/**
 * Tests for {@link VisionModelEngine}.
 *
 * @doc.type    class
 * @doc.purpose VisionModelEngine: object detection, classification, OCR, face detection, confidence threshold
 * @doc.layer   product
 * @doc.pattern Test
 */
@DisplayName("VisionModelEngineTest")
class VisionModelEngineTest {

    /** Minimal synthetic JPEG-like payload to satisfy non-empty validation. */
    private static final byte[] SAMPLE_IMAGE = buildImage("sample_scene");

    private VisionModelEngine engine;

    @BeforeEach
    void setUp() {
        engine = new VisionModelEngine("yolov8-base", 0.5, detectorWithCapabilities());
    }

    // ── Object detection ──────────────────────────────────────────────────────

    @Test
    @DisplayName("detectObjects returns a non-null list for valid image")
    void detectObjectsReturnsResult() {
        assertThat(engine.detectObjects(SAMPLE_IMAGE)).isNotNull();
    }

    @Test
    @DisplayName("all detected objects have confidence above the threshold")
    void detectedObjectsMeetConfidenceThreshold() {
        engine.detectObjects(SAMPLE_IMAGE).forEach(obj ->
                assertThat(obj.confidence()).isGreaterThanOrEqualTo(0.5));
    }

    @Test
    @DisplayName("detected objects have valid bounding box dimensions (width/height > 0)")
    void detectedObjectsBoundingBoxPositive() {
        engine.detectObjects(SAMPLE_IMAGE).forEach(obj -> {
            assertThat(obj.width()).isGreaterThan(0.0);
            assertThat(obj.height()).isGreaterThan(0.0);
        });
    }

    @Test
    @DisplayName("detected objects have non-blank labels")
    void detectedObjectsHaveLabels() {
        engine.detectObjects(SAMPLE_IMAGE).forEach(obj ->
                assertThat(obj.label()).isNotBlank());
    }

    @Test
    @DisplayName("higher confidence threshold reduces number of detections")
    void higherThresholdReducesDetections() {
        VisionModelEngine strict = new VisionModelEngine("yolov8-base", 0.9, detectorWithCapabilities());
        int strictCount = strict.detectObjects(SAMPLE_IMAGE).size();
        int lenientCount = engine.detectObjects(SAMPLE_IMAGE).size();
        // strict ≤ lenient
        assertThat(strictCount).isLessThanOrEqualTo(lenientCount);
    }

    // ── Image classification ──────────────────────────────────────────────────

    @Test
    @DisplayName("classify returns a non-null result")
    void classifyReturnsResult() {
        assertThat(engine.classify(SAMPLE_IMAGE)).isNotNull();
    }

    @Test
    @DisplayName("classification label is non-blank")
    void classificationLabelIsNonBlank() {
        ClassificationResult result = engine.classify(SAMPLE_IMAGE);
        assertThat(result.label()).isNotBlank();
    }

    @Test
    @DisplayName("classification confidence is normalized [0, 1]")
    void classificationConfidenceNormalized() {
        ClassificationResult result = engine.classify(SAMPLE_IMAGE);
        assertThat(result.confidence()).isBetween(0.0, 1.0);
    }

    @Test
    @DisplayName("classification includes non-empty top-label list")
    void classificationTopLabelsNonEmpty() {
        ClassificationResult result = engine.classify(SAMPLE_IMAGE);
        assertThat(result.topLabels()).isNotEmpty();
    }

    @Test
    @DisplayName("top label appears in the top-labels list")
    void topLabelInTopLabelsList() {
        ClassificationResult result = engine.classify(SAMPLE_IMAGE);
        assertThat(result.topLabels()).contains(result.label());
    }

    // ── OCR ───────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("OCR returns non-null result")
    void ocrReturnsResult() {
        assertThat(engine.extractText(SAMPLE_IMAGE)).isNotNull();
    }

    @Test
    @DisplayName("OCR extracted text is non-null")
    void ocrTextIsNonNull() {
        OcrResult result = engine.extractText(SAMPLE_IMAGE);
        assertThat(result.text()).isNotNull();
    }

    @Test
    @DisplayName("OCR confidence is in [0, 1]")
    void ocrConfidenceNormalized() {
        OcrResult result = engine.extractText(SAMPLE_IMAGE);
        assertThat(result.confidence()).isBetween(0.0, 1.0);
    }

    // ── Face detection ────────────────────────────────────────────────────────

    @Test
    @DisplayName("detectFaces returns non-null list")
    void detectFacesReturnsResult() {
        assertThat(engine.detectFaces(SAMPLE_IMAGE)).isNotNull();
    }

    @Test
    @DisplayName("all detected faces meet confidence threshold")
    void detectedFacesMeetThreshold() {
        engine.detectFaces(SAMPLE_IMAGE).forEach(face ->
                assertThat(face.confidence()).isGreaterThanOrEqualTo(0.5));
    }

    @Test
    @DisplayName("detected faces have positive bounding box dimensions")
    void detectedFacesBoundingBoxPositive() {
        engine.detectFaces(SAMPLE_IMAGE).forEach(face -> {
            assertThat(face.width()).isGreaterThan(0.0);
            assertThat(face.height()).isGreaterThan(0.0);
        });
    }

    @Test
    @DisplayName("detected faces have non-empty landmark map")
    void detectedFacesHaveLandmarks() {
        engine.detectFaces(SAMPLE_IMAGE).forEach(face ->
                assertThat(face.landmarks()).isNotEmpty());
    }

    // ── Real-detector delegation path ─────────────────────────────────────────

    @Nested
    @DisplayName("Real-detector delegation")
    class RealDetectorDelegation {

        /**
         * Test-only inline detector that supports CLASSIFICATION and FACE_DETECTION.
         * Avoids native library loading while exercising the real delegation code path.
         */
        private VisionDetector fullCapabilityDetector(
                List<ClassificationCandidate> classResults,
                List<DetectedFace> faceResults,
                String ocrText) {
            return new VisionDetector() {
                @Override
                public List<com.ghatana.audio.video.vision.model.DetectedObject> detectObjects(
                        byte[] imageData, DetectionOptions options) {
                    return List.of();
                }

                @Override
                public boolean isInitialized() { return true; }

                @Override
                public boolean supportsCapability(VisionCapability capability) {
                    return capability == VisionCapability.CLASSIFICATION
                            || capability == VisionCapability.FACE_DETECTION
                            || capability == VisionCapability.OCR
                            || capability == VisionCapability.OBJECT_DETECTION;
                }

                @Override
                public List<ClassificationCandidate> classify(
                        byte[] imageData, DetectionOptions options) {
                    return classResults;
                }

                @Override
                public List<DetectedFace> detectFaces(
                        byte[] imageData, DetectionOptions options) {
                    return faceResults;
                }

                @Override
                public String extractText(byte[] imageData, DetectionOptions options) {
                    return ocrText;
                }
            };
        }

        @Test
        @DisplayName("classify delegates to detector when CLASSIFICATION capability is declared")
        void classifyDelegatesToDetector() {
            List<ClassificationCandidate> candidates = List.of(
                    new ClassificationCandidate("vehicle", 0.91),
                    new ClassificationCandidate("outdoor", 0.78));
            VisionDetector det = fullCapabilityDetector(candidates, List.of(), "");

            VisionModelEngine realEngine = new VisionModelEngine("resnet50", 0.5, det);
            ClassificationResult result = realEngine.classify(SAMPLE_IMAGE);

            assertThat(result.label()).isEqualTo("vehicle");
            assertThat(result.confidence()).isCloseTo(0.91, offset(0.001));
            assertThat(result.topLabels()).containsExactly("vehicle", "outdoor");
        }

        @Test
        @DisplayName("detectFaces delegates to detector when FACE_DETECTION capability is declared")
        void detectFacesDelegatesToDetector() {
            BoundingBox box = BoundingBox.builder().x(0.1).y(0.2).width(0.3).height(0.4).build();
            DetectedFace face = new DetectedFace(box, 0.88);
            VisionDetector det = fullCapabilityDetector(List.of(), List.of(face), "");

            VisionModelEngine realEngine = new VisionModelEngine("mediapipe-face", 0.5, det);
            List<FaceDetection> faces = realEngine.detectFaces(SAMPLE_IMAGE);

            assertThat(faces).hasSize(1);
            FaceDetection f = faces.get(0);
            assertThat(f.confidence()).isCloseTo(0.88, offset(0.001));
            assertThat(f.x()).isCloseTo(0.1, offset(0.001));
            assertThat(f.y()).isCloseTo(0.2, offset(0.001));
        }

        @Test
        @DisplayName("extractText delegates to detector when OCR capability is declared")
        void extractTextDelegatesToDetector() {
            VisionDetector det = fullCapabilityDetector(
                    List.of(), List.of(), "Hello World from Tesseract");

            VisionModelEngine realEngine = new VisionModelEngine("tesseract", 0.5, det);
            OcrResult result = realEngine.extractText(SAMPLE_IMAGE);

            assertThat(result.text()).isEqualTo("Hello World from Tesseract");
        }

        @Test
        @DisplayName("classify fails closed when detector does not support CLASSIFICATION")
        void classifyFailsClosedWhenCapabilityAbsent() {
            // detector only supports OBJECT_DETECTION (default supportsCapability behaviour)
            VisionDetector yoloOnly = new VisionDetector() {
                @Override
                public List<com.ghatana.audio.video.vision.model.DetectedObject> detectObjects(
                        byte[] imageData, DetectionOptions options) {
                    return List.of();
                }
                @Override
                public boolean isInitialized() { return true; }
                // supportsCapability defaults: only OBJECT_DETECTION = true
            };

            VisionModelEngine realEngine = new VisionModelEngine("yolov8-base", 0.5, yoloOnly);
            assertThatThrownBy(() -> realEngine.classify(SAMPLE_IMAGE))
                    .isInstanceOf(VisionModelEngine.VisionException.class)
                    .hasMessageContaining("classification");
        }

        @Test
        @DisplayName("engine fails closed when detector is not initialized")
        void uninitializedDetectorFailsClosed() {
            VisionDetector uninit = new VisionDetector() {
                @Override
                public List<com.ghatana.audio.video.vision.model.DetectedObject> detectObjects(
                        byte[] imageData, DetectionOptions options) {
                    return List.of();
                }
                @Override
                public boolean isInitialized() { return false; }
                @Override
                public boolean supportsCapability(VisionCapability capability) { return true; }
            };

            VisionModelEngine realEngine = new VisionModelEngine("resnet", 0.5, uninit);

            assertThatThrownBy(() -> realEngine.classify(SAMPLE_IMAGE))
                    .isInstanceOf(VisionModelEngine.VisionException.class)
                    .hasMessageContaining("not initialized");
            assertThatThrownBy(() -> realEngine.detectFaces(SAMPLE_IMAGE))
                    .isInstanceOf(VisionModelEngine.VisionException.class)
                    .hasMessageContaining("not initialized");
            assertThatThrownBy(() -> realEngine.extractText(SAMPLE_IMAGE))
                    .isInstanceOf(VisionModelEngine.VisionException.class)
                    .hasMessageContaining("not initialized");
        }
    }

    // ── Error handling ────────────────────────────────────────────────────────

    @Test
    @DisplayName("null image throws VisionException for detectObjects")
    void nullImageThrowsForDetect() {
        assertThatThrownBy(() -> engine.detectObjects(null))
                .isInstanceOf(VisionModelEngine.VisionException.class);
    }

    @Test
    @DisplayName("empty image throws VisionException for classify")
    void emptyImageThrowsForClassify() {
        assertThatThrownBy(() -> engine.classify(new byte[0]))
                .isInstanceOf(VisionModelEngine.VisionException.class);
    }

    @Test
    @DisplayName("null image throws VisionException for extractText")
    void nullImageThrowsForOcr() {
        assertThatThrownBy(() -> engine.extractText(null))
                .isInstanceOf(VisionModelEngine.VisionException.class);
    }

    @Test
    @DisplayName("invalid confidence threshold throws IllegalArgumentException")
    void invalidThresholdThrows() {
        assertThatThrownBy(() -> new VisionModelEngine("yolo", 1.5))
                .isInstanceOf(IllegalArgumentException.class);
    }

    // ── Engine metadata ───────────────────────────────────────────────────────

    @Test
    @DisplayName("engine reports correct model ID")
    void engineModelId() {
        assertThat(engine.getModelId()).isEqualTo("yolov8-base");
    }

    @Test
    @DisplayName("engine reports the configured confidence threshold")
    void engineConfidenceThreshold() {
        assertThat(engine.getConfidenceThreshold()).isEqualTo(0.5);
    }

    @ParameterizedTest(name = "threshold={0}")
    @ValueSource(doubles = {0.0, 0.3, 0.5, 0.7, 0.99, 1.0})
    @DisplayName("valid confidence thresholds are accepted without error")
    void validThresholdsAccepted(double threshold) {
        assertThatCode(() -> new VisionModelEngine("yolo", threshold))
                .doesNotThrowAnyException();
    }

    // ── Helper ────────────────────────────────────────────────────────────────

    private static byte[] buildImage(String label) {
        byte[] data = new byte[512];
        byte[] bytes = label.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        System.arraycopy(bytes, 0, data, 0, Math.min(bytes.length, data.length));
        // Pad remainder with repeating pattern
        for (int i = bytes.length; i < data.length; i++) {
            data[i] = (byte) (i % 128);
        }
        return data;
    }

    private static VisionDetector detectorWithCapabilities() {
        return new VisionDetector() {
            @Override
            public List<com.ghatana.audio.video.vision.model.DetectedObject> detectObjects(
                    byte[] imageData, DetectionOptions options) {
                return List.of(
                        com.ghatana.audio.video.vision.model.DetectedObject.builder()
                                .className("person")
                                .confidence(0.92)
                                .boundingBox(BoundingBox.builder()
                                        .x(0.1).y(0.2).width(0.3).height(0.4).build())
                                .build(),
                        com.ghatana.audio.video.vision.model.DetectedObject.builder()
                                .className("chair")
                                .confidence(0.72)
                                .boundingBox(BoundingBox.builder()
                                        .x(0.5).y(0.4).width(0.2).height(0.2).build())
                                .build())
                        .stream()
                        .filter(d -> d.getConfidence() >= options.getConfidenceThreshold())
                        .toList();
            }

            @Override
            public boolean isInitialized() { return true; }

            @Override
            public boolean supportsCapability(VisionCapability capability) { return true; }

            @Override
            public List<ClassificationCandidate> classify(byte[] imageData, DetectionOptions options) {
                return List.of(new ClassificationCandidate("indoor", 0.91));
            }

            @Override
            public List<DetectedFace> detectFaces(byte[] imageData, DetectionOptions options) {
                BoundingBox box = BoundingBox.builder().x(0.2).y(0.2).width(0.3).height(0.3).build();
                DetectedFace face = new DetectedFace(box, 0.89, Map.of("left_eye", new Point(0.3, 0.3)));
                return face.confidence() >= options.getConfidenceThreshold() ? List.of(face) : List.of();
            }

            @Override
            public String extractText(byte[] imageData, DetectionOptions options) {
                return "Hello World";
            }
        };
    }
}
