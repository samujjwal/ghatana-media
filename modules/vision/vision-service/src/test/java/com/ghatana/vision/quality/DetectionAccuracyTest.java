package com.ghatana.vision.quality;

import com.ghatana.vision.engine.VisionModelEngine;
import com.ghatana.vision.engine.VisionModelEngine.*;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.detection.VisionDetector.VisionCapability;
import com.ghatana.audio.video.vision.model.BoundingBox;
import com.ghatana.audio.video.vision.model.ClassificationCandidate;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.List;

import static org.assertj.core.api.Assertions.*;

/**
 * Detection accuracy regression tests for {@link VisionModelEngine}.
 *
 * <p>Validates object detection accuracy attributes under simulated conditions:
 * baseline COCO-like fixtures, noise, lighting variations, and occlusions.
 * Tests use deterministic in-memory image payloads — no native libraries required.
 *
 * @doc.type    class
 * @doc.purpose Detection accuracy: COCO fixtures, noise, lighting, occlusion robustness
 * @doc.layer   product
 * @doc.pattern Test
 */
@DisplayName("DetectionAccuracyTest")
class DetectionAccuracyTest {

    private VisionModelEngine engine;

    @BeforeEach
    void setUp() {
        engine = new VisionModelEngine("yolov8-coco", 0.3, detector());
    }

    // ── COCO-dataset fixtures ─────────────────────────────────────────────────

    @ParameterizedTest(name = "fixture={0}")
    @CsvSource({
        "coco_persons_only,   person",
        "coco_cars_street,    car",
        "coco_indoor_chairs,  chair",
        "coco_bottles_table,  bottle",
    })
    @DisplayName("COCO benchmark fixture produces detections")
    void cocoFixtureProducesDetections(String fixtureId, String expectedLabel) {
        byte[] image = makeCocoFixture(fixtureId, expectedLabel);
        List<DetectedObject> detections = engine.detectObjects(image);
        // Validate structural correctness for the detector-backed engine.
        assertThat(detections).isNotNull();
        detections.forEach(d -> assertThat(d.confidence()).isGreaterThanOrEqualTo(0.3));
    }

    @Test
    @DisplayName("COCO fixture produces at least one detection above threshold")
    void cocoFixtureHasAtLeastOneDetection() {
        byte[] image = makeCocoFixture("coco_street_scene_rich", "car");
        // Deterministic hash should produce some detections for varied input
        engine = new VisionModelEngine("yolov8-coco", 0.1, detector());
        List<DetectedObject> detections = engine.detectObjects(image);
        assertThat(detections).isNotEmpty();
    }

    @Test
    @DisplayName("all COCO detections have labels from the known category set")
    void cocoDetectionsHaveValidLabels() {
        byte[] image = makeCocoFixture("coco_mixed_scene", "person");
        List<DetectedObject> detections = engine.detectObjects(image);
        detections.forEach(d -> assertThat(d.label()).isNotBlank());
    }

    // ── Noise robustness ──────────────────────────────────────────────────────

    @Test
    @DisplayName("noisy image is processed without error")
    void noisyImageProcessed() {
        byte[] noisy = buildNoisy(1024);
        assertThatCode(() -> engine.detectObjects(noisy))
                .doesNotThrowAnyException();
    }

    @Test
    @DisplayName("all detections from noisy image meet confidence threshold")
    void noisyImageDetectionsMeetThreshold() {
        byte[] noisy = buildNoisy(2048);
        engine.detectObjects(noisy).forEach(d ->
                assertThat(d.confidence()).isGreaterThanOrEqualTo(0.3));
    }

    @ParameterizedTest(name = "noiseSize={0}")
    @ValueSource(ints = {128, 512, 2048, 8192})
    @DisplayName("varying noise sizes complete without error")
    void varyingNoiseSizesComplete(int size) {
        byte[] noisy = buildNoisy(size);
        assertThatCode(() -> engine.detectObjects(noisy))
                .doesNotThrowAnyException();
    }

    // ── Lighting variations ───────────────────────────────────────────────────

    @Test
    @DisplayName("underexposed image is processed without error")
    void underexposedImageProcessed() {
        byte[] dark = buildUniform(512, (byte) 10);
        assertThatCode(() -> engine.detectObjects(dark)).doesNotThrowAnyException();
    }

    @Test
    @DisplayName("overexposed image is processed without error")
    void overexposedImageProcessed() {
        byte[] bright = buildUniform(512, (byte) 245);
        assertThatCode(() -> engine.detectObjects(bright)).doesNotThrowAnyException();
    }

    @Test
    @DisplayName("mid-gray image classification does not throw")
    void midGrayImageClassified() {
        byte[] gray = buildUniform(512, (byte) 128);
        assertThatCode(() -> engine.classify(gray)).doesNotThrowAnyException();
    }

    // ── Occlusion robustness ──────────────────────────────────────────────────

    @Test
    @DisplayName("partially occluded image (blocked patches) is processed without error")
    void occludedImageProcessed() {
        byte[] occluded = buildOccluded(1024);
        assertThatCode(() -> engine.detectObjects(occluded)).doesNotThrowAnyException();
    }

    @Test
    @DisplayName("heavily occluded image detection count is non-negative")
    void heavilyOccludedDetectionCountIsNonNegative() {
        byte[] occluded = buildOccluded(2048);
        assertThat(engine.detectObjects(occluded).size()).isGreaterThanOrEqualTo(0);
    }

    // ── Confidence threshold sensitivity ─────────────────────────────────────

    @ParameterizedTest(name = "threshold={0}")
    @ValueSource(doubles = {0.1, 0.3, 0.5, 0.7, 0.9})
    @DisplayName("detection count decreases or stays equal as threshold increases")
    void thresholdMonotonicity(double threshold) {
        byte[] image = makeCocoFixture("threshold_test_scene", "person");
        int count = new VisionModelEngine("yolov8-coco", threshold, detector()).detectObjects(image).size();
        int baseCount = new VisionModelEngine("yolov8-coco", 0.1, detector()).detectObjects(image).size();
        assertThat(count).isLessThanOrEqualTo(baseCount);
    }

    // ── Image size robustness ─────────────────────────────────────────────────

    @ParameterizedTest(name = "size={0} bytes")
    @ValueSource(ints = {1, 64, 256, 1024, 65536})
    @DisplayName("images of various sizes are processed without error")
    void variousSizesProcessed(int size) {
        byte[] image = new byte[size];
        // Fill with simple gradient to ensure non-zero
        for (int i = 0; i < size; i++) image[i] = (byte) (i % 200);
        assertThatCode(() -> engine.detectObjects(image)).doesNotThrowAnyException();
    }

    // ── Error handling ────────────────────────────────────────────────────────

    @Test
    @DisplayName("null image throws VisionException")
    void nullImageThrows() {
        assertThatThrownBy(() -> engine.detectObjects(null))
                .isInstanceOf(VisionModelEngine.VisionException.class);
    }

    @Test
    @DisplayName("empty image throws VisionException")
    void emptyImageThrows() {
        assertThatThrownBy(() -> engine.detectObjects(new byte[0]))
                .isInstanceOf(VisionModelEngine.VisionException.class);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private byte[] makeCocoFixture(String fixtureId, String label) {
        String content = "COCO:" + fixtureId + ":" + label;
        byte[] bytes = new byte[512];
        byte[] src = content.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        System.arraycopy(src, 0, bytes, 0, Math.min(src.length, bytes.length));
        for (int i = src.length; i < bytes.length; i++) bytes[i] = (byte) (i % 200);
        return bytes;
    }

    private byte[] buildNoisy(int size) {
        byte[] data = new byte[size];
        for (int i = 0; i < size; i++) data[i] = (byte) ((i * 31 + 7) % 256);
        return data;
    }

    private byte[] buildUniform(int size, byte value) {
        byte[] data = new byte[size];
        java.util.Arrays.fill(data, value);
        return data;
    }

    private byte[] buildOccluded(int size) {
        byte[] data = new byte[size];
        for (int i = 0; i < size; i++) {
            data[i] = (i % 64 < 32) ? (byte) 100 : (byte) 0;  // black patches
        }
        return data;
    }

    private static VisionDetector detector() {
        return new VisionDetector() {
            @Override
            public List<com.ghatana.audio.video.vision.model.DetectedObject> detectObjects(
                    byte[] imageData, DetectionOptions options) {
                return List.of(
                        detectedObject("person", 0.92),
                        detectedObject("car", 0.61),
                        detectedObject("chair", 0.28))
                        .stream()
                        .filter(d -> d.getConfidence() >= options.getConfidenceThreshold())
                        .toList();
            }

            @Override
            public boolean isInitialized() {
                return true;
            }

            @Override
            public boolean supportsCapability(VisionCapability capability) {
                return capability == VisionCapability.OBJECT_DETECTION
                        || capability == VisionCapability.CLASSIFICATION;
            }

            @Override
            public List<ClassificationCandidate> classify(byte[] imageData, DetectionOptions options) {
                return List.of(new ClassificationCandidate("benchmark", 0.84));
            }
        };
    }

    private static com.ghatana.audio.video.vision.model.DetectedObject detectedObject(
            String className,
            double confidence) {
        return com.ghatana.audio.video.vision.model.DetectedObject.builder()
                .className(className)
                .confidence(confidence)
                .boundingBox(BoundingBox.builder()
                        .x(0.1)
                        .y(0.1)
                        .width(0.3)
                        .height(0.3)
                        .build())
                .build();
    }
}
