package com.ghatana.audio.video.vision.detection;

import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.testing.activej.EventloopTestBase;
import io.activej.promise.Promise;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Tests for the shared detector contract configuration.
 *
 * @doc.type test
 * @doc.purpose Verifies shared VisionDetector configuration is immutable and consistent
 * @doc.layer product
 */
@DisplayName("DetectionConfig Tests")
class DetectionConfigTest extends EventloopTestBase {

    @Test
    @DisplayName("Should preserve configured thresholds and target classes")
    void shouldPreserveConfiguredThresholdsAndTargetClasses() { 
        DetectionOptions config = runPromise(() -> Promise.of( 
            DetectionOptions.builder() 
                .confidenceThreshold(0.65f) 
                .nmsThreshold(0.25f) 
                .maxDetections(12) 
                .targetClasses(new java.util.HashSet<>(List.of("person", "dog"))) 
                .build() 
        ));

        assertEquals(0.65f, config.getConfidenceThreshold()); 
        assertEquals(0.25f, config.getNmsThreshold()); 
        assertEquals(12, config.getMaxDetections()); 
        assertEquals(Set.of("person", "dog"), config.getTargetClasses()); 
        assertThrows(UnsupportedOperationException.class, () -> config.getTargetClasses().add("car"));
    }
}
