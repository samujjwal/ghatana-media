/*
 * Copyright (c) 2026 Ghatana Inc. 
 * All rights reserved.
 */
package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.grpc.proto.*;
import com.ghatana.audio.video.vision.model.BoundingBox;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Collections;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * Unit tests verifying that {@link VisionGrpcService} wires
 * {@link MediaProcessingMetrics} correctly.
 *
 * @doc.type class
 * @doc.purpose Metrics wiring regression tests for VisionGrpcService
 * @doc.layer product
 * @doc.pattern TestCase
 */
@DisplayName("VisionGrpcService metrics wiring")
class VisionGrpcServiceMetricsTest {

    private LocalFakeDetector fakeDetector;
    private VisionGrpcService service;
    private MediaProcessingMetrics metrics;

    @BeforeEach
    void setUp() { 
        fakeDetector = new LocalFakeDetector(); 
        VideoFrameExtractor frameExtractor = mock(VideoFrameExtractor.class); 
        metrics = MediaProcessingMetrics.create(); 
        service = new VisionGrpcService(fakeDetector, frameExtractor, metrics); 
    }

    @Test
    @DisplayName("detectObjects success path: records started and succeeded, not failed")
    void detectObjects_success_recordsStartedAndSucceeded() { 
        fakeDetector.results = List.of( 
            DetectedObject.builder() 
                .className("car")
                .confidence(0.9) 
                .boundingBox(BoundingBox.builder().x(0).y(0).width(50).height(50).build()) 
                .timestamp(Instant.now()) 
                .build() 
        );
        DetectRequest request = DetectRequest.newBuilder() 
            .setImageData(ByteString.copyFrom(new byte[]{1, 2, 3})) 
            .build(); 
        SimpleObserver<DetectResponse> observer = new SimpleObserver<>(); 

        withContext("tenant-metrics-test", () -> service.detectObjects(request, observer));

        assertThat(observer.error).isNull(); 
        assertThat(metrics.startedCount("vision.detect")).isEqualTo(1);
        assertThat(metrics.succeededCount("vision.detect")).isEqualTo(1);
        assertThat(metrics.failedCount("vision.detect")).isEqualTo(0);
        assertThat(metrics.latencyMsTotal("vision.detect")).isGreaterThanOrEqualTo(0);
    }

    @Test
    @DisplayName("detectObjects failure path: records started and failed, not succeeded")
    void detectObjects_failure_recordsStartedAndFailed() { 
        fakeDetector.throwOn = new VisionDetector.DetectionException("YOLO model unavailable");
        DetectRequest request = DetectRequest.newBuilder() 
            .setImageData(ByteString.copyFrom(new byte[]{1, 2, 3})) 
            .build(); 
        SimpleObserver<DetectResponse> observer = new SimpleObserver<>(); 

        withContext("tenant-metrics-test", () -> service.detectObjects(request, observer));

        assertThat(observer.error).isNotNull(); 
        assertThat(metrics.startedCount("vision.detect")).isEqualTo(1);
        assertThat(metrics.failedCount("vision.detect")).isEqualTo(1);
        assertThat(metrics.succeededCount("vision.detect")).isEqualTo(0);
    }

    @Test
    @DisplayName("noop metrics never throws and does not affect callers")
    void noopMetrics_neverThrows() { 
        VideoFrameExtractor frameExtractor = mock(VideoFrameExtractor.class); 
        VisionGrpcService noopService = new VisionGrpcService(fakeDetector, frameExtractor, 
                MediaProcessingMetrics.noop()); 
        DetectRequest request = DetectRequest.newBuilder() 
            .setImageData(ByteString.copyFrom(new byte[]{1, 2, 3})) 
            .build(); 
        SimpleObserver<DetectResponse> observer = new SimpleObserver<>(); 

        withContext("tenant-metrics-test", () -> noopService.detectObjects(request, observer));

        assertThat(observer.error).isNull(); 
    }

    // -------------------------------------------------------------------------
    // Local helpers — keep minimal, avoid duplicating VisionGrpcServiceTest's fakes
    // -------------------------------------------------------------------------

    /** Minimal StreamObserver that captures the last value and any error. */
    static class SimpleObserver<T> implements StreamObserver<T> {
        T value;
        Throwable error;

        @Override public void onNext(T v) { this.value = v; } 
        @Override public void onError(Throwable t) { this.error = t; } 
        @Override public void onCompleted() {} 
    }

    /** Minimal fake VisionDetector that returns configurable results or throws. */
    static class LocalFakeDetector implements VisionDetector {
        List<DetectedObject> results = Collections.emptyList(); 
        RuntimeException throwOn;

        @Override
        public List<DetectedObject> detectObjects(byte[] imageData, DetectionOptions options) { 
            if (throwOn != null) throw throwOn; 
            return results;
        }

        @Override
        public boolean isInitialized() { return true; } 
    }

    private static void withContext(String tenantId, Runnable action) {
        Context.current().withValue(JwtServerInterceptor.CTX_TENANT, tenantId).run(action);
    }
}
