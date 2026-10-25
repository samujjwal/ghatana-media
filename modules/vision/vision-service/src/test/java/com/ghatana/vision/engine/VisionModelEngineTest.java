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
import java.util.concurrent.atomic.AtomicInteger;

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
    @DisplayName("legacy OCR fails closed without admitted Document Intelligence")
    void genericOcrFailsClosedWithoutProviderDispatch() {
        AtomicInteger providerCalls = new AtomicInteger();
        VisionDetector detector = new VisionDetector() {
            @Override
            public List<com.ghatana.audio.video.vision.model.DetectedObject> detectObjects(
                    byte[] imageData, DetectionOptions options) {
                return List.of();
            }

            @Override
            public boolean isInitialized() { return true; }

            @Override
            public boolean supportsCapability(VisionCapability capability) { return true; }

            @Override
            public String extractText(byte[] imageData, DetectionOptions options) {
                providerCalls.incrementAndGet();
                return "sensitive marker text";
            }
        };

        VisionModelEngine genericEngine = new VisionModelEngine("generic-ocr", 0.5, detector);
        assertThatThrownBy(() -> genericEngine.extractText(SAMPLE_IMAGE))
                .isInstanceOf(VisionModelEngine.OcrNotAdmittedException.class)
                .hasMessage("NOT_ADMITTED: Document Intelligence public API adapter is unavailable");
        assertThat(providerCalls).hasValue(0);
    }

    // ── Face detection ────────────────────────────────────────────────────────

    @Test
    @DisplayName("face analysis fails closed before model dispatch without trusted rights")
    void faceAnalysisFailsClosedBeforeModelDispatch() {
        AtomicInteger providerCalls = new AtomicInteger();
        VisionDetector detector = new VisionDetector() {
            @Override
            public List<com.ghatana.audio.video.vision.model.DetectedObject> detectObjects(
                    byte[] imageData, DetectionOptions options) {
                return List.of();
            }

            @Override
            public boolean isInitialized() { return true; }

            @Override
            public boolean supportsCapability(VisionCapability capability) { return true; }

            @Override
            public List<DetectedFace> detectFaces(byte[] imageData, DetectionOptions options) {
                providerCalls.incrementAndGet();
                return List.of(new DetectedFace(
                        BoundingBox.builder().x(0.2).y(0.25).width(0.2).height(0.25).build(),
                        0.88, Map.of("eye", new Point(0.3, 0.3))));
            }
        };
        VisionModelEngine biometricEngine = new VisionModelEngine("face-model", 0.5, detector);

        assertThatThrownBy(() -> biometricEngine.detectFaces(SAMPLE_IMAGE))
                .isInstanceOf(VisionModelEngine.BiometricNotAdmittedException.class)
                .hasMessage("NOT_ADMITTED: trusted biometric rights authority is unavailable");
        assertThat(providerCalls).hasValue(0);
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
        @DisplayName("detector capability does not authorize biometric analysis")
        void detectorCapabilityDoesNotAuthorizeBiometricAnalysis() {
            AtomicInteger providerCalls = new AtomicInteger();
            VisionDetector det = new VisionDetector() {
                @Override
                public List<com.ghatana.audio.video.vision.model.DetectedObject> detectObjects(
                        byte[] imageData, DetectionOptions options) {
                    return List.of();
                }

                @Override
                public boolean isInitialized() { return true; }

                @Override
                public boolean supportsCapability(VisionCapability capability) { return true; }

                @Override
                public List<DetectedFace> detectFaces(byte[] imageData, DetectionOptions options) {
                    providerCalls.incrementAndGet();
                    return List.of(new DetectedFace(
                            BoundingBox.builder().x(0.1).y(0.2).width(0.3).height(0.4).build(),
                            0.88, Map.of("eye", new Point(0.2, 0.3))));
                }
            };

            VisionModelEngine realEngine = new VisionModelEngine("mediapipe-face", 0.5, det);

            assertThatThrownBy(() -> realEngine.detectFaces(SAMPLE_IMAGE))
                    .isInstanceOf(VisionModelEngine.BiometricNotAdmittedException.class)
                    .hasMessage("NOT_ADMITTED: trusted biometric rights authority is unavailable");
            assertThat(providerCalls).hasValue(0);
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
                    .isInstanceOf(VisionModelEngine.BiometricNotAdmittedException.class)
                    .hasMessageContaining("NOT_ADMITTED");
            assertThatThrownBy(() -> realEngine.extractText(SAMPLE_IMAGE))
                    .isInstanceOf(VisionModelEngine.OcrNotAdmittedException.class)
                    .hasMessageContaining("NOT_ADMITTED");
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

    @Test
    @DisplayName("constructor rejects non-finite thresholds")
    void nonFiniteThresholdThrows() {
        for (double invalid : new double[] {
                Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY
        }) {
            assertThatThrownBy(() -> new VisionModelEngine("yolo", invalid))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    @DisplayName("public model result records reject non-finite confidence and accept bounds")
    void publicModelResultsValidateConfidence() {
        for (double invalid : new double[] {
                Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, -0.1, 1.1
        }) {
            assertThatThrownBy(() -> new VisionModelEngine.DetectedObject("cat", invalid, 0, 0, 1, 1))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> new VisionModelEngine.OcrResult("text", invalid, List.of()))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> new VisionModelEngine.ClassificationResult("cat", invalid, List.of()))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> new VisionModelEngine.FaceDetection(0, 0, 1, 1, invalid, Map.of()))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        for (double boundary : new double[] {0.0, 1.0}) {
            assertThatCode(() -> new VisionModelEngine.DetectedObject("cat", boundary, 0, 0, 1, 1))
                    .doesNotThrowAnyException();
            assertThatCode(() -> new VisionModelEngine.OcrResult("text", boundary, List.of()))
                    .doesNotThrowAnyException();
            assertThatCode(() -> new VisionModelEngine.ClassificationResult("cat", boundary, List.of()))
                    .doesNotThrowAnyException();
            assertThatCode(() -> new VisionModelEngine.FaceDetection(0, 0, 1, 1, boundary, Map.of()))
                    .doesNotThrowAnyException();
        }
    }

    @Test
    @DisplayName("object and face records validate finite pixel geometry")
    void publicGeometryResultsValidateBoundingBoxGeometry() {
        for (double[] invalid : new double[][] {
                new double[] {Double.NaN, 0, 1, 1},
                new double[] {Double.POSITIVE_INFINITY, 0, 1, 1},
                new double[] {Double.NEGATIVE_INFINITY, 0, 1, 1},
                new double[] {0, Double.NaN, 1, 1},
                new double[] {0, Double.NEGATIVE_INFINITY, 1, 1},
                new double[] {0, 0, Double.NaN, 1},
                new double[] {0, 0, Double.POSITIVE_INFINITY, 1},
                new double[] {0, 0, 1, Double.NEGATIVE_INFINITY},
                new double[] {0, 0, -1, 1},
                new double[] {0, 0, 1, -1},
                new double[] {Double.MAX_VALUE, 0, Double.MAX_VALUE, 1},
                new double[] {0, Double.MAX_VALUE, 1, Double.MAX_VALUE},
                new double[] {0, 0, Double.MAX_VALUE, 2}
        }) {
            assertThatThrownBy(() -> new VisionModelEngine.DetectedObject(
                    "cat", 0.5, invalid[0], invalid[1], invalid[2], invalid[3]))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> new VisionModelEngine.FaceDetection(
                    invalid[0], invalid[1], invalid[2], invalid[3], 0.5, Map.of()))
                    .isInstanceOf(IllegalArgumentException.class);
        }

        assertThatCode(() -> new VisionModelEngine.DetectedObject("cat", 0.0, -4, -2, 0, 0))
                .doesNotThrowAnyException();
        assertThatCode(() -> new VisionModelEngine.FaceDetection(-4, -2, 3, 0, 1.0, Map.of()))
                .doesNotThrowAnyException();
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
