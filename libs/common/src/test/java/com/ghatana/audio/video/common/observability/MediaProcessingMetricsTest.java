/*
 * Copyright (c) 2026 Ghatana Inc. 
 * All rights reserved.
 */
package com.ghatana.audio.video.common.observability;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

/**
 * Unit tests for {@link MediaProcessingMetrics}.
 *
 * @doc.type class
 * @doc.purpose Regression tests for media processing metrics contract
 * @doc.layer product
 * @doc.pattern TestCase
 */
@DisplayName("MediaProcessingMetrics")
class MediaProcessingMetricsTest {

    private MediaProcessingMetrics metrics;

    @BeforeEach
    void setUp() { 
        metrics = MediaProcessingMetrics.create(); 
    }

    @Test
    @DisplayName("recordStarted increments started counter for operation")
    void recordStarted_incrementsCounter() { 
        metrics.recordStarted("vision.detect");
        metrics.recordStarted("vision.detect");

        assertThat(metrics.startedCount("vision.detect")).isEqualTo(2);
    }

    @Test
    @DisplayName("recordSucceeded increments succeeded counter and accumulates latency")
    void recordSucceeded_incrementsSucceededAndLatency() { 
        metrics.recordSucceeded("vision.detect", 25L); 
        metrics.recordSucceeded("vision.detect", 35L); 

        assertThat(metrics.succeededCount("vision.detect")).isEqualTo(2);
        assertThat(metrics.latencyMsTotal("vision.detect")).isEqualTo(60L);
    }

    @Test
    @DisplayName("recordFailed increments failed counter without affecting succeeded")
    void recordFailed_incrementsFailedOnly() { 
        metrics.recordFailed("multimodal.analyse");

        assertThat(metrics.failedCount("multimodal.analyse")).isEqualTo(1);
        assertThat(metrics.succeededCount("multimodal.analyse")).isEqualTo(0);
    }

    @Test
    @DisplayName("operations are tracked independently")
    void operationsAreIsolated() { 
        metrics.recordStarted("vision.detect");
        metrics.recordStarted("vision.analyze");
        metrics.recordSucceeded("vision.detect", 10L); 

        assertThat(metrics.startedCount("vision.detect")).isEqualTo(1);
        assertThat(metrics.startedCount("vision.analyze")).isEqualTo(1);
        assertThat(metrics.succeededCount("vision.detect")).isEqualTo(1);
        assertThat(metrics.succeededCount("vision.analyze")).isEqualTo(0);
    }

    @Test
    @DisplayName("noop instance never increments any counter")
    void noop_neverRecordsAnything() { 
        MediaProcessingMetrics noop = MediaProcessingMetrics.noop(); 

        noop.recordStarted("vision.detect");
        noop.recordSucceeded("vision.detect", 100L); 
        noop.recordFailed("vision.detect");

        assertThat(noop.startedCount("vision.detect")).isEqualTo(0);
        assertThat(noop.succeededCount("vision.detect")).isEqualTo(0);
        assertThat(noop.failedCount("vision.detect")).isEqualTo(0);
        assertThat(noop.latencyMsTotal("vision.detect")).isEqualTo(0);
    }

    @Test
    @DisplayName("recordStarted with null operation does not throw")
    void recordStarted_nullOperation_doesNotThrow() { 
        assertThatCode(() -> metrics.recordStarted(null)).doesNotThrowAnyException(); 
    }

    @Test
    @DisplayName("recordSucceeded with null operation does not throw")
    void recordSucceeded_nullOperation_doesNotThrow() { 
        assertThatCode(() -> metrics.recordSucceeded(null, 50L)).doesNotThrowAnyException(); 
    }

    @Test
    @DisplayName("recordFailed with null operation does not throw")
    void recordFailed_nullOperation_doesNotThrow() { 
        assertThatCode(() -> metrics.recordFailed(null)).doesNotThrowAnyException(); 
    }

    @Test
    @DisplayName("scrape returns prometheus-format text for all recorded operations")
    void scrape_containsAllOperations() { 
        metrics.recordStarted("vision.detect");
        metrics.recordSucceeded("vision.detect", 20L); 
        metrics.recordFailed("multimodal.analyse");

        String output = metrics.scrape(); 

        assertThat(output).contains("media_processing_started_total");
        assertThat(output).contains("vision.detect");
        assertThat(output).contains("media_processing_failed_total");
        assertThat(output).contains("multimodal.analyse");
    }

    @Test
    @DisplayName("unrecorded operation returns zero for all accessors")
    void unknownOperation_returnsZero() { 
        assertThat(metrics.startedCount("unknown.op")).isEqualTo(0);
        assertThat(metrics.succeededCount("unknown.op")).isEqualTo(0);
        assertThat(metrics.failedCount("unknown.op")).isEqualTo(0);
        assertThat(metrics.latencyMsTotal("unknown.op")).isEqualTo(0);
    }
}
