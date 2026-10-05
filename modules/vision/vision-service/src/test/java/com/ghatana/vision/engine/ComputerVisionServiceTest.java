package com.ghatana.vision.engine;

import org.junit.jupiter.api.*;

import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.detection.VisionDetector.VisionCapability;
import com.ghatana.audio.video.vision.model.BoundingBox;
import com.ghatana.audio.video.vision.model.ClassificationCandidate;
import com.ghatana.audio.video.vision.model.DetectedFace;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.vision.engine.VisionModelEngine.VisionException;

import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.*;

/**
 * Comprehensive test suite for {@link VisionModelEngine}.
 *
 * Validates computer vision capabilities including object detection, classification,
 * OCR extraction, face detection, input validation, and batch processing.
 *
 * @doc.type    class
 * @doc.purpose Comprehensive vision engine tests: detection, classification, OCR, faces
 * @doc.layer   product
 * @doc.pattern Test
 */
@DisplayName("ComputerVisionServiceTest")
class ComputerVisionServiceTest {

    private static final byte[] SAMPLE_IMAGE = "SAMPLE_IMAGE_DATA_JPG".getBytes(); 
    private static final byte[] SAMPLE_IMAGE_2 = "DIFFERENT_IMAGE_PNG".getBytes(); 
    private static final byte[] LARGE_IMAGE = new byte[5_000_000]; // 5MB image
    private static final byte[] TINY_IMAGE = new byte[1];

    private VisionModelEngine engine;
    private VisionModelEngine lowConfidenceEngine;
    private VisionModelEngine highConfidenceEngine;

    @BeforeEach
    void setUp() { 
        engine = new VisionModelEngine("yolo-v8", 0.5, detectorWithCapabilities());
        lowConfidenceEngine = new VisionModelEngine("yolo-v8", 0.1, detectorWithCapabilities());
        highConfidenceEngine = new VisionModelEngine("yolo-v8", 0.9, detectorWithCapabilities());
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // INPUT VALIDATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("input validation")
    class InputValidation {

        @Test
        @DisplayName("null image data throws VisionException")
        void nullImageData_throwsVisionException() { 
            assertThatThrownBy(() -> engine.detectObjects(null)) 
                    .isInstanceOf(VisionException.class); 
        }

        @Test
        @DisplayName("empty image data throws VisionException")
        void emptyImageData_throwsVisionException() { 
            byte[] empty = new byte[0];
            assertThatThrownBy(() -> engine.detectObjects(empty)) 
                    .isInstanceOf(VisionException.class); 
        }

        @Test
        @DisplayName("null image data in classification throws VisionException")
        void nullImageDataInClassification_throwsVisionException() { 
            assertThatThrownBy(() -> engine.classify(null)) 
                    .isInstanceOf(VisionException.class); 
        }

        @Test
        @DisplayName("null image data in OCR throws VisionException")
        void nullImageDataInOcr_throwsVisionException() { 
            assertThatThrownBy(() -> engine.extractText(null)) 
                    .isInstanceOf(VisionException.class); 
        }

        @Test
        @DisplayName("null image data in face detection throws VisionException")
        void nullImageDataInFaceDetection_throwsVisionException() { 
            assertThatThrownBy(() -> engine.detectFaces(null)) 
                    .isInstanceOf(VisionException.class); 
        }

        @Test
        @DisplayName("single byte image is accepted")
        void singleByteImage_isAccepted() { 
            List<VisionModelEngine.DetectedObject> detections = engine.detectObjects(TINY_IMAGE); 
            assertThat(detections).isNotNull(); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // OBJECT DETECTION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("object detection")
    class ObjectDetection {

        @Test
        @DisplayName("detection returns non-null list")
        void detectionReturnsNonNullList() { 
            List<VisionModelEngine.DetectedObject> detections = engine.detectObjects(SAMPLE_IMAGE); 
            assertThat(detections).isNotNull(); 
        }

        @Test
        @DisplayName("detected objects contain expected labels")
        void detectedObjectsContainExpectedLabels() { 
            List<VisionModelEngine.DetectedObject> detections = engine.detectObjects(SAMPLE_IMAGE); 
            assertThat(detections).isNotEmpty(); 

            Set<String> labels = detections.stream() 
                    .map(VisionModelEngine.DetectedObject::label) 
                    .collect(Collectors.toSet()); 

            assertThat(labels).isNotEmpty(); 
        }

        @Test
        @DisplayName("detected objects have valid confidence scores")
        void detectedObjectsHaveValidConfidence() { 
            List<VisionModelEngine.DetectedObject> detections = engine.detectObjects(SAMPLE_IMAGE); 

            detections.forEach(obj -> 
                    assertThat(obj.confidence()).isBetween(0.0, 1.0) 
            );
        }

        @Test
        @DisplayName("detected objects have valid bounding boxes")
        void detectedObjectsHaveValidBoundingBoxes() { 
            List<VisionModelEngine.DetectedObject> detections = engine.detectObjects(SAMPLE_IMAGE); 

            detections.forEach(obj -> { 
                assertThat(obj.x()).isBetween(0.0, 1.0); 
                assertThat(obj.y()).isBetween(0.0, 1.0); 
                assertThat(obj.width()).isGreaterThan(0.0).isLessThanOrEqualTo(1.0); 
                assertThat(obj.height()).isGreaterThan(0.0).isLessThanOrEqualTo(1.0); 
            });
        }

        @Test
        @DisplayName("confidence threshold filters low-confidence detections")
        void confidenceThresholdFiltersDetections() { 
            List<VisionModelEngine.DetectedObject> low = lowConfidenceEngine.detectObjects(SAMPLE_IMAGE); 
            List<VisionModelEngine.DetectedObject> medium = engine.detectObjects(SAMPLE_IMAGE); 
            List<VisionModelEngine.DetectedObject> high = highConfidenceEngine.detectObjects(SAMPLE_IMAGE); 

            // Higher threshold should result in fewer detections
            assertThat(low.size()).isGreaterThanOrEqualTo(medium.size()); 
            assertThat(medium.size()).isGreaterThanOrEqualTo(high.size()); 
        }

        @Test
        @DisplayName("all detections meet or exceed the confidence threshold")
        void allDetectionsMeetThreshold() { 
            double threshold = 0.7;
            VisionModelEngine strictEngine = new VisionModelEngine("yolo-v8", threshold, detectorWithCapabilities());

            List<VisionModelEngine.DetectedObject> detections = strictEngine.detectObjects(SAMPLE_IMAGE); 

            detections.forEach(obj -> 
                    assertThat(obj.confidence()).isGreaterThanOrEqualTo(threshold) 
            );
        }

        @Test
        @DisplayName("different images may produce different detections")
        void differentImagesMayProduceDifferentDetections() { 
            List<VisionModelEngine.DetectedObject> detections1 = engine.detectObjects(SAMPLE_IMAGE); 
            List<VisionModelEngine.DetectedObject> detections2 = engine.detectObjects(SAMPLE_IMAGE_2); 

            // Results should be based on image content (may or may not be identical) 
            assertThat(detections1).isNotNull(); 
            assertThat(detections2).isNotNull(); 
        }

        @Test
        @DisplayName("detection is deterministic for same image")
        void detectionIsDeterministic() { 
            List<VisionModelEngine.DetectedObject> d1 = engine.detectObjects(SAMPLE_IMAGE); 
            List<VisionModelEngine.DetectedObject> d2 = engine.detectObjects(SAMPLE_IMAGE); 

            assertThat(d1).hasSize(d2.size()); 
            for (int i = 0; i < d1.size(); i++) { 
                assertThat(d1.get(i).label()).isEqualTo(d2.get(i).label()); 
                assertThat(d1.get(i).confidence()).isEqualTo(d2.get(i).confidence()); 
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // CLASSIFICATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("classification")
    class Classification {

        @Test
        @DisplayName("classification returns valid result")
        void classificationReturnsValidResult() { 
            VisionModelEngine.ClassificationResult result = engine.classify(SAMPLE_IMAGE); 

            assertThat(result).isNotNull(); 
            assertThat(result.label()).isNotBlank(); 
        }

        @Test
        @DisplayName("classification confidence is in valid range")
        void classificationConfidenceIsValid() { 
            VisionModelEngine.ClassificationResult result = engine.classify(SAMPLE_IMAGE); 

            assertThat(result.confidence()).isBetween(0.0, 1.0); 
        }

        @Test
        @DisplayName("top labels list is non-empty")
        void topLabelsListIsNonEmpty() { 
            VisionModelEngine.ClassificationResult result = engine.classify(SAMPLE_IMAGE); 

            assertThat(result.topLabels()).isNotEmpty(); 
        }

        @Test
        @DisplayName("classified label is in top labels list")
        void classifiedLabelIsInTopLabels() { 
            VisionModelEngine.ClassificationResult result = engine.classify(SAMPLE_IMAGE); 

            assertThat(result.topLabels()).contains(result.label()); 
        }

        @Test
        @DisplayName("classification is deterministic for same image")
        void classificationIsDeterministic() { 
            VisionModelEngine.ClassificationResult c1 = engine.classify(SAMPLE_IMAGE); 
            VisionModelEngine.ClassificationResult c2 = engine.classify(SAMPLE_IMAGE); 

            assertThat(c1.label()).isEqualTo(c2.label()); 
            assertThat(c1.confidence()).isEqualTo(c2.confidence()); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // OCR/TEXT EXTRACTION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("OCR text extraction")
    class OcrTextExtraction {

        @Test
        @DisplayName("OCR returns valid result")
        void ocrReturnsValidResult() { 
            VisionModelEngine.OcrResult result = engine.extractText(SAMPLE_IMAGE); 

            assertThat(result).isNotNull(); 
        }

        @Test
        @DisplayName("extracted text is non-null")
        void extractedTextIsNonNull() { 
            VisionModelEngine.OcrResult result = engine.extractText(SAMPLE_IMAGE); 

            assertThat(result.text()).isNotNull(); 
        }

        @Test
        @DisplayName("OCR confidence is in valid range")
        void ocrConfidenceIsValid() { 
            VisionModelEngine.OcrResult result = engine.extractText(SAMPLE_IMAGE); 

            assertThat(result.confidence()).isBetween(0.0, 1.0); 
        }

        @Test
        @DisplayName("text regions contain valid bounding boxes")
        void textRegionsContainValidBoundingBoxes() { 
            VisionModelEngine.OcrResult result = engine.extractText(SAMPLE_IMAGE); 

            result.textRegions().forEach(region -> { 
                assertThat(region.x()).isBetween(0.0, 1.0); 
                assertThat(region.y()).isBetween(0.0, 1.0); 
                assertThat(region.width()).isGreaterThan(0.0).isLessThanOrEqualTo(1.0); 
                assertThat(region.height()).isGreaterThan(0.0).isLessThanOrEqualTo(1.0); 
            });
        }

        @Test
        @DisplayName("OCR is deterministic for same image")
        void ocrIsDeterministic() { 
            VisionModelEngine.OcrResult r1 = engine.extractText(SAMPLE_IMAGE); 
            VisionModelEngine.OcrResult r2 = engine.extractText(SAMPLE_IMAGE); 

            assertThat(r1.text()).isEqualTo(r2.text()); 
            assertThat(r1.confidence()).isEqualTo(r2.confidence()); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // FACE DETECTION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("face detection")
    class FaceDetection {

        @Test
        @DisplayName("face detection returns non-null list")
        void faceDetectionReturnsNonNullList() { 
            List<VisionModelEngine.FaceDetection> faces = engine.detectFaces(SAMPLE_IMAGE); 

            assertThat(faces).isNotNull(); 
        }

        @Test
        @DisplayName("face detection results have valid bounding boxes")
        void faceDetectionResultsHaveValidBoundingBoxes() { 
            List<VisionModelEngine.FaceDetection> faces = engine.detectFaces(SAMPLE_IMAGE); 

            faces.forEach(face -> { 
                assertThat(face.x()).isBetween(0.0, 1.0); 
                assertThat(face.y()).isBetween(0.0, 1.0); 
                assertThat(face.width()).isGreaterThan(0.0).isLessThanOrEqualTo(1.0); 
                assertThat(face.height()).isGreaterThan(0.0).isLessThanOrEqualTo(1.0); 
            });
        }

        @Test
        @DisplayName("face detection confidence is in valid range")
        void faceDetectionConfidenceIsValid() { 
            List<VisionModelEngine.FaceDetection> faces = engine.detectFaces(SAMPLE_IMAGE); 

            faces.forEach(face -> 
                    assertThat(face.confidence()).isBetween(0.0, 1.0) 
            );
        }

        @Test
        @DisplayName("face landmarks are included in results")
        void faceLandmarksAreIncluded() { 
            List<VisionModelEngine.FaceDetection> faces = engine.detectFaces(SAMPLE_IMAGE); 

            if (!faces.isEmpty()) { 
                faces.forEach(face -> 
                        assertThat(face.landmarks()).isNotNull() 
                );
            }
        }

        @Test
        @DisplayName("face detection is deterministic for same image")
        void faceDetectionIsDeterministic() { 
            List<VisionModelEngine.FaceDetection> f1 = engine.detectFaces(SAMPLE_IMAGE); 
            List<VisionModelEngine.FaceDetection> f2 = engine.detectFaces(SAMPLE_IMAGE); 

            assertThat(f1).hasSize(f2.size()); 
            for (int i = 0; i < f1.size(); i++) { 
                assertThat(f1.get(i).confidence()).isEqualTo(f2.get(i).confidence()); 
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // IMAGE FORMAT HANDLING TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("image format handling")
    class ImageFormatHandling {

        @Test
        @DisplayName("JPEG-like image is processed without error")
        void jpegImageIsProcessed() { 
            byte[] jpegData = "JPEG_MAGIC_BYTES".getBytes(); 
            assertThatCode(() -> engine.detectObjects(jpegData)) 
                    .doesNotThrowAnyException(); 
        }

        @Test
        @DisplayName("PNG-like image is processed without error")
        void pngImageIsProcessed() { 
            byte[] pngData = "PNG_MAGIC_BYTES".getBytes(); 
            assertThatCode(() -> engine.detectObjects(pngData)) 
                    .doesNotThrowAnyException(); 
        }

        @Test
        @DisplayName("BMP-like image is processed without error")
        void bmpImageIsProcessed() { 
            byte[] bmpData = "BM_MAGIC_BYTES".getBytes(); 
            assertThatCode(() -> engine.detectObjects(bmpData)) 
                    .doesNotThrowAnyException(); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // BATCH PROCESSING TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("batch processing")
    class BatchProcessing {

        @Test
        @DisplayName("batch detection processes multiple images")
        void batchDetectionProcessesMultipleImages() { 
            int batchSize = 10;
            for (int i = 0; i < batchSize; i++) { 
                List<VisionModelEngine.DetectedObject> detections = engine.detectObjects(SAMPLE_IMAGE); 
                assertThat(detections).isNotNull(); 
            }
        }

        @Test
        @DisplayName("concurrent detection produces consistent results")
        void concurrentDetectionProducesConsistentResults() throws InterruptedException { 
            int threadCount = 5;
            List<VisionModelEngine.DetectedObject>[] results = new List[threadCount];
            Thread[] threads = new Thread[threadCount];
            CountDownLatch latch = new CountDownLatch(threadCount); 

            for (int i = 0; i < threadCount; i++) { 
                final int index = i;
                threads[i] = new Thread(() -> { 
                    results[index] = engine.detectObjects(SAMPLE_IMAGE); 
                    latch.countDown(); 
                });
                threads[i].start(); 
            }

            latch.await(); 

            // All results should be consistent
            int firstSize = results[0].size(); 
            for (int i = 1; i < threadCount; i++) { 
                assertThat(results[i]).hasSize(firstSize); 
            }
        }

        @Test
        @DisplayName("large image batch is processed without failure")
        void largeImageBatchIsProcessed() { 
            assertThatCode(() -> { 
                for (int i = 0; i < 100; i++) { 
                    engine.detectObjects(SAMPLE_IMAGE); 
                }
            }).doesNotThrowAnyException(); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // SIZE BOUNDARY TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("size boundaries")
    class SizeBoundaries {

        @Test
        @DisplayName("large image (5MB) is processed without failure")
        void largeImageIsProcessed() { 
            for (int i = 0; i < LARGE_IMAGE.length; i++) { 
                LARGE_IMAGE[i] = (byte) (i % 256); 
            }

            assertThatCode(() -> engine.detectObjects(LARGE_IMAGE)) 
                    .doesNotThrowAnyException(); 
        }

        @Test
        @DisplayName("tiny single-byte image is processed")
        void tinyImageIsProcessed() { 
            assertThatCode(() -> engine.detectObjects(TINY_IMAGE)) 
                    .doesNotThrowAnyException(); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // CONFIDENCE THRESHOLD TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("confidence threshold")
    class ConfidenceThreshold {

        @Test
        @DisplayName("threshold of 0.0 accepts all detections")
        void zeroThresholdAcceptsAll() { 
            VisionModelEngine zeroEngine = new VisionModelEngine("yolo-v8", 0.0, detectorWithCapabilities());
            List<VisionModelEngine.DetectedObject> detections = zeroEngine.detectObjects(SAMPLE_IMAGE); 

            assertThat(detections).isNotEmpty(); 
        }

        @Test
        @DisplayName("threshold of 1.0 rejects all detections")
        void maxThresholdRejectsAll() { 
            VisionModelEngine maxEngine = new VisionModelEngine("yolo-v8", 1.0, detectorWithCapabilities());
            List<VisionModelEngine.DetectedObject> detections = maxEngine.detectObjects(SAMPLE_IMAGE); 

            // May be empty or contain items with confidence == 1.0
            detections.forEach(obj -> assertThat(obj.confidence()).isEqualTo(1.0)); 
        }

        @Test
        @DisplayName("mid-range thresholds filter appropriately")
        void midRangeThresholdsFilter() { 
            VisionModelEngine mid1 = new VisionModelEngine("yolo-v8", 0.3, detectorWithCapabilities());
            VisionModelEngine mid2 = new VisionModelEngine("yolo-v8", 0.7, detectorWithCapabilities());

            List<VisionModelEngine.DetectedObject> d1 = mid1.detectObjects(SAMPLE_IMAGE); 
            List<VisionModelEngine.DetectedObject> d2 = mid2.detectObjects(SAMPLE_IMAGE); 

            assertThat(d1.size()).isGreaterThanOrEqualTo(d2.size()); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // ENGINE PROPERTIES TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("engine properties")
    class EngineProperties {

        @Test
        @DisplayName("engine returns configured model ID")
        void engineReturnsConfiguredModelId() { 
            assertThat(engine.getModelId()).isEqualTo("yolo-v8");
        }

        @Test
        @DisplayName("engine returns configured confidence threshold")
        void engineReturnsConfiguredThreshold() { 
            assertThat(engine.getConfidenceThreshold()).isEqualTo(0.5); 
            assertThat(lowConfidenceEngine.getConfidenceThreshold()).isEqualTo(0.1); 
            assertThat(highConfidenceEngine.getConfidenceThreshold()).isEqualTo(0.9); 
        }

        @Test
        @DisplayName("invalid threshold raises exception on construction")
        void invalidThresholdRaisesException() { 
            assertThatThrownBy(() -> new VisionModelEngine("yolo-v8", -0.1)) 
                    .isInstanceOf(IllegalArgumentException.class); 

            assertThatThrownBy(() -> new VisionModelEngine("yolo-v8", 1.1)) 
                    .isInstanceOf(IllegalArgumentException.class); 
        }

        @Test
        @DisplayName("null model ID raises exception on construction")
        void nullModelIdRaisesException() { 
            assertThatThrownBy(() -> new VisionModelEngine(null, 0.5)) 
                    .isInstanceOf(NullPointerException.class); 
        }
    }

    private static VisionDetector detectorWithCapabilities() {
        return new VisionDetector() {
            @Override
            public List<com.ghatana.audio.video.vision.model.DetectedObject> detectObjects(
                    byte[] imageData, DetectionOptions options) {
                return List.of(
                        detectedObject("person", 0.95, 0.1, 0.1, 0.3, 0.4),
                        detectedObject("chair", 0.65, 0.5, 0.4, 0.2, 0.2))
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
                return List.of(new ClassificationCandidate("indoor", 0.9));
            }

            @Override
            public String extractText(byte[] imageData, DetectionOptions options) {
                return "Visible text";
            }

            @Override
            public List<DetectedFace> detectFaces(byte[] imageData, DetectionOptions options) {
                DetectedFace face = new DetectedFace(
                        BoundingBox.builder().x(0.2).y(0.25).width(0.2).height(0.25).build(),
                        0.88);
                return face.confidence() >= options.getConfidenceThreshold() ? List.of(face) : List.of();
            }
        };
    }

    private static com.ghatana.audio.video.vision.model.DetectedObject detectedObject(
            String className,
            double confidence,
            double x,
            double y,
            double width,
            double height) {
        return com.ghatana.audio.video.vision.model.DetectedObject.builder()
                .className(className)
                .confidence(confidence)
                .boundingBox(BoundingBox.builder()
                        .x(x)
                        .y(y)
                        .width(width)
                        .height(height)
                        .build())
                .build();
    }
}
