/*
 * Copyright (c) 2026 Ghatana Inc. 
 * All rights reserved.
 */
package com.ghatana.audio.video.vision.service;

import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Verifies that {@link PersistentVisionService} registers its detection latency timer
 * with P50/P95/P99 histogram percentile tracking enabled (AV-M1).
 *
 * <p>Each test constructs the real production service and verifies that the
 * {@code vision.persistent.detect} timer in the registry is configured with
 * {@code publishPercentiles(0.50, 0.95, 0.99)}, so percentile values are
 * tracked (non-NaN) after any recording.
 *
 * @doc.type class
 * @doc.purpose Histogram percentile configuration regression tests for PersistentVisionService
 * @doc.layer product
 * @doc.pattern TestCase
 */
@DisplayName("PersistentVisionService — vision.persistent.detect P50/P95/P99 histogram")
@ExtendWith(MockitoExtension.class)
class PersistentVisionServiceMetricsTest {

    @Mock
    private VisionDetector detector;

    @Mock
    private VideoFrameExtractor frameExtractor;

    @Mock
    private AudioFileService audioFileService;

    private SimpleMeterRegistry meterRegistry;
    private Timer detectTimer;

    @BeforeEach
    void setUp() { 
        meterRegistry = new SimpleMeterRegistry(); 
        // Constructing the real PersistentVisionService registers the timer
        // with publishPercentiles(0.50, 0.95, 0.99) and publishPercentileHistogram().
        new PersistentVisionService(detector, frameExtractor, audioFileService, meterRegistry); 
        detectTimer = meterRegistry.find("vision.persistent.detect").timer(); 
    }

    @Test
    @DisplayName("vision.persistent.detect timer registered after service construction")
    void detectTimer_registeredInRegistry_afterConstruction() { 
        assertThat(detectTimer).isNotNull(); 
    }

    @Test
    @DisplayName("vision.persistent.detect P50 percentile is tracked (not NaN) after recording")
    void detectTimer_p50Percentile_trackedAfterRecording() { 
        detectTimer.record(50, TimeUnit.MILLISECONDS); 

        assertThat(detectTimer.percentile(0.50, TimeUnit.MILLISECONDS))
            .isNotNaN(); 
    }

    @Test
    @DisplayName("vision.persistent.detect P95 percentile is tracked (not NaN) after recording")
    void detectTimer_p95Percentile_trackedAfterRecording() { 
        detectTimer.record(100, TimeUnit.MILLISECONDS); 

        assertThat(detectTimer.percentile(0.95, TimeUnit.MILLISECONDS))
            .isNotNaN(); 
    }

    @Test
    @DisplayName("vision.persistent.detect P99 percentile is tracked (not NaN) after recording")
    void detectTimer_p99Percentile_trackedAfterRecording() { 
        detectTimer.record(300, TimeUnit.MILLISECONDS); 

        assertThat(detectTimer.percentile(0.99, TimeUnit.MILLISECONDS))
            .isNotNaN(); 
    }
}
