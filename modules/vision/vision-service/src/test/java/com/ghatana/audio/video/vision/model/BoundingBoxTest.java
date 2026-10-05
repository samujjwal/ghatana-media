package com.ghatana.audio.video.vision.model;

import com.ghatana.testing.activej.EventloopTestBase;
import io.activej.promise.Promise;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for canonical vision model bounding boxes.
 *
 * @doc.type test
 * @doc.purpose Verifies canonical BoundingBox math used by all vision detectors
 * @doc.layer product
 */
@DisplayName("BoundingBox Tests")
class BoundingBoxTest extends EventloopTestBase {

    @Test
    @DisplayName("Should calculate IoU for overlapping boxes")
    void shouldCalculateIouForOverlappingBoxes() { 
        BoundingBox left = BoundingBox.builder().x(0).y(0).width(4).height(4).build(); 
        BoundingBox right = BoundingBox.builder().x(2).y(2).width(4).height(4).build(); 

        double iou = runPromise(() -> Promise.of(left.calculateIoU(right))); 

        assertEquals(1.0d / 7.0d, iou, 0.0001d); 
        assertTrue(left.intersects(right)); 
    }

    @Test
    @DisplayName("Should expose default and tuned detection presets")
    void shouldExposeDefaultAndTunedDetectionPresets() { 
        DetectionOptions defaults = runPromise(() -> Promise.of(DetectionOptions.defaults())); 
        DetectionOptions highPrecision = runPromise(() -> Promise.of(DetectionOptions.highPrecision())); 
        DetectionOptions highRecall = runPromise(() -> Promise.of(DetectionOptions.highRecall())); 

        assertEquals(0.5d, defaults.getConfidenceThreshold(), 0.0001d); 
        assertEquals(0.8d, highPrecision.getConfidenceThreshold(), 0.0001d); 
        assertEquals(0.3d, highRecall.getConfidenceThreshold(), 0.0001d); 
        assertTrue(highPrecision.getConfidenceThreshold() > highRecall.getConfidenceThreshold()); 
        assertFalse(highPrecision.getNmsThreshold() > highRecall.getNmsThreshold()); 
    }
}
