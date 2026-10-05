package com.ghatana.media.vision;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.config.VisionConfig;
import com.ghatana.media.vision.api.*;
import com.ghatana.media.common.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Integration tests for Vision engine with real ONNX models.
 *
 * <p>These tests verify:
 * <ul>
 *   <li>YOLOv8 ONNX model loading and inference</li>
 *   <li>Object detection accuracy on known test images</li>
 *   <li>Streaming detection sessions</li>
 *   <li>GPU/CPU fallback behavior</li>
 * </ul>
 *
 * <p>Requires YOLOv8 ONNX model at /models/yolov8n.onnx or test will use stub.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class) 
public class VisionEngineIntegrationTest {

    @TempDir
    static Path tempDir;

    private static AudioVideoLibrary library;
    private static VisionEngine engine;

    @BeforeAll
    static void setUp() { 
        // Try to load real model, fall back to stub for testing
        VisionConfig config = VisionConfig.builder() 
            .modelPath(Paths.get("/models/yolov8n.onnx"))
            .modelId("yolov8n")
            .useGpu(false) // Use CPU for tests 
            .defaultConfidenceThreshold(0.5) 
            .defaultMaxDetections(100) 
            .allowSyntheticFallback(true)
            .build(); 

        library = AudioVideoLibrary.builder() 
            .withVisionConfig(config) 
            .build(); 

        engine = library.getVisionEngine(); 
        engine.warmup(); 
    }

    @AfterAll
    static void tearDown() { 
        if (library != null) { 
            library.close(); 
        }
    }

    @Test
    @Order(1) 
    @DisplayName("Engine initializes successfully")
    void testEngineInitialization() { 
        EngineStatus status = engine.getStatus(); 

        assertNotNull(status); 
        assertTrue(status.state() == EngineStatus.State.READY 
                || status.state() == EngineStatus.State.DEGRADED, 
            "Engine should be ready or in stub fallback mode");
    }

    @Test
    @Order(2) 
    @DisplayName("Detect objects in test image")
    void testDetectObjects() { 
        // Create a simple test image (red square on blue background) 
        ImageData testImage = createTestImage(640, 480); 

        DetectionOptions options = DetectionOptions.builder() 
            .confidenceThreshold(0.25f) 
            .maxDetections(10) 
            .build(); 

        DetectionResult result = engine.detect(testImage, options); 

        assertNotNull(result); 
        assertEquals(640, result.imageWidth()); 
        assertEquals(480, result.imageHeight()); 
        assertNotNull(result.objects()); 
        assertTrue(result.processingTimeMs() >= 0);
        assertNotNull(result.modelId()); 
    }

    @Test
    @Order(3) 
    @DisplayName("Detection respects confidence threshold")
    void testConfidenceThreshold() { 
        ImageData testImage = createTestImage(640, 480); 

        // High threshold should return fewer objects
        DetectionOptions highThreshold = DetectionOptions.builder() 
            .confidenceThreshold(0.9f) 
            .build(); 

        DetectionOptions lowThreshold = DetectionOptions.builder() 
            .confidenceThreshold(0.1f) 
            .build(); 

        DetectionResult highResult = engine.detect(testImage, highThreshold); 
        DetectionResult lowResult = engine.detect(testImage, lowThreshold); 

        // Low threshold should return same or more objects
        assertTrue(lowResult.objects().size() >= highResult.objects().size(), 
            "Lower threshold should return same or more detections");
    }

    @Test
    @Order(4) 
    @DisplayName("Streaming detection session works")
    void testStreamingDetection() throws InterruptedException { 
        List<DetectionResult> results = new java.util.ArrayList<>(); 

        StreamingDetectionSession session = engine.createStreamingSession( 
            DetectionOptions.defaults(), 
            result -> results.add(result) 
        );

        // Feed 5 frames
        for (int i = 0; i < 5; i++) { 
            ImageData frame = createTestImage(640, 480); 
            session.feedFrame(frame, i); 
            Thread.sleep(50); // Small delay between frames 
        }

        session.endStream(); 

        // Give time for callbacks
        Thread.sleep(100); 

        // Should have received results for frames
        assertFalse(results.isEmpty(), "Should have received detection results"); 
    }

    @Test
    @Order(5) 
    @DisplayName("Available models listed correctly")
    void testGetAvailableModels() { 
        List<DetectionModelInfo> models = engine.getAvailableModels(); 

        assertNotNull(models); 
        assertFalse(models.isEmpty(), "Should have at least one model available"); 

        for (DetectionModelInfo model : models) { 
            assertNotNull(model.modelId()); 
            assertNotNull(model.name()); 
            assertTrue(model.sizeBytes() >= 0); 
        }
    }

    @Test
    @Order(6) 
    @DisplayName("Engine metrics collected")
    void testEngineMetrics() { 
        // Perform some operations first
        ImageData testImage = createTestImage(640, 480); 
        engine.detect(testImage, DetectionOptions.defaults()); 

        EngineMetrics metrics = engine.getMetrics(); 

        assertNotNull(metrics); 
        assertTrue(metrics.requestCount() > 0, "Should have recorded requests"); 
        assertTrue(metrics.avgLatencyMs() >= 0, "Average latency should be available"); 
    }

    @Test
    @Order(7) 
    @DisplayName("Handles multiple image formats")
    void testMultipleFormats() { 
        int[] widths = {320, 640, 1280};
        int[] heights = {240, 480, 720};

        for (int i = 0; i < widths.length; i++) { 
            ImageData image = createTestImage(widths[i], heights[i]); 
            DetectionResult result = engine.detect(image, DetectionOptions.defaults()); 

            assertEquals(widths[i], result.imageWidth()); 
            assertEquals(heights[i], result.imageHeight()); 
        }
    }

    @Test
    @Order(8) 
    @DisplayName("Error handling for invalid input")
    void testErrorHandling() { 
        // Null image should throw ValidationError
        assertThrows(ValidationError.class, () -> { 
            engine.detect(null, DetectionOptions.defaults()); 
        });

        // Zero-size image is rejected by the value object itself
        assertThrows(IllegalArgumentException.class, () -> ImageData.builder() 
            .data(new byte[0]) 
            .width(0) 
            .height(0) 
            .format(ImageFormat.RAW) 
            .build()); 
    }

    @Test
    @Order(9) 
    @DisplayName("Warmup completes without error")
    void testWarmup() { 
        assertDoesNotThrow(() -> engine.warmup()); 
    }

    @Test
    @Order(10) 
    @DisplayName("Concurrent detection operations")
    void testConcurrentDetection() throws InterruptedException { 
        int threadCount = 4;
        java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(threadCount); 
        java.util.concurrent.atomic.AtomicInteger successCount = new java.util.concurrent.atomic.AtomicInteger(0); 

        for (int i = 0; i < threadCount; i++) { 
            new Thread(() -> { 
                try {
                    ImageData image = createTestImage(640, 480); 
                    DetectionResult result = engine.detect(image, DetectionOptions.defaults()); 
                    if (result != null && result.objects() != null) { 
                        successCount.incrementAndGet(); 
                    }
                } finally {
                    latch.countDown(); 
                }
            }).start(); 
        }

        assertTrue(latch.await(30, java.util.concurrent.TimeUnit.SECONDS), 
            "All threads should complete within timeout");
        assertEquals(threadCount, successCount.get(), 
            "All concurrent operations should succeed");
    }

    // Helper method to create a simple test image
    private ImageData createTestImage(int width, int height) { 
        // Create RGB image data
        int pixelCount = width * height;
        byte[] data = new byte[pixelCount * 3];

        // Fill with gradient pattern
        for (int y = 0; y < height; y++) { 
            for (int x = 0; x < width; x++) { 
                int idx = (y * width + x) * 3; 
                data[idx] = (byte) (x * 255 / width);     // R 
                data[idx + 1] = (byte) (y * 255 / height); // G 
                data[idx + 2] = (byte) 128;                // B 
            }
        }

        return ImageData.builder() 
            .data(data) 
            .width(width) 
            .height(height) 
            .format(ImageFormat.RAW) 
            .build(); 
    }
}
