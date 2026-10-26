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
import com.ghatana.audio.video.vision.model.ObjectAttributes;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

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
    private SimpleMeterRegistry meterRegistry;
    private VideoFrameExtractor frameExtractor;
    @TempDir Path tempDir;

    @BeforeEach
    void setUp() { 
        fakeDetector = new LocalFakeDetector(); 
        frameExtractor = mock(VideoFrameExtractor.class);
        metrics = MediaProcessingMetrics.create(); 
        meterRegistry = new SimpleMeterRegistry();
        service = new VisionGrpcService(fakeDetector, frameExtractor, metrics, null,
                new com.ghatana.audio.video.common.model.FileSystemModelStore(), meterRegistry);
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
        assertProviderTimer("unknown", 1);
    }

    @Test
    @DisplayName("detectObjects request records a bounded provider timer in the Micrometer registry")
    void detectObjects_success_exportsProviderTimerWithoutRequestLabels() {
        fakeDetector.results = List.of(DetectedObject.builder()
                .className("car").confidence(0.9)
                .boundingBox(BoundingBox.builder().x(0).y(0).width(10).height(10).build()).build());
        DetectRequest request = DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom("sensitive-fixture-content".getBytes()))
                .build();
        SimpleObserver<DetectResponse> observer = new SimpleObserver<>();

        withContext("tenant-must-not-be-a-metric-label", () -> service.detectObjects(request, observer));

        assertThat(observer.error).isNull();
        assertProviderTimer("success", 1);
        assertResponseTimer("success", 1);
    }

    @Test
    @DisplayName("detectObjects invalid provider response mapping records response failure")
    void detectObjects_invalidProviderMappingRecordsResponseFailure() {
        MapWithNullKey attributes = new MapWithNullKey();
        fakeDetector.results = List.of(DetectedObject.builder()
                .className("car").confidence(0.9)
                .boundingBox(BoundingBox.builder().x(0).y(0).width(10).height(10).build())
                .attributes(ObjectAttributes.builder().additionalProperties(attributes.map).build())
                .build());
        SimpleObserver<DetectResponse> observer = new SimpleObserver<>();

        withContext("tenant-metrics-test", () -> service.detectObjects(
                DetectRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[]{1})).build(), observer));

        assertThat(observer.error).isNotNull();
        assertResponseTimer("failure", 1);
    }

    @Test
    @DisplayName("detectObjects ambiguous observer completion records response UNKNOWN")
    void detectObjects_observerCompletionThrowsRecordsResponseUnknown() {
        fakeDetector.results = validDetections();
        SimpleObserver<DetectResponse> observer = new SimpleObserver<>() {
            @Override public void onCompleted() { throw new IllegalStateException("ambiguous delivery"); }
        };

        withContext("tenant-metrics-test", () -> service.detectObjects(
                DetectRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[]{1})).build(), observer));

        assertThat(observer.value).isNotNull();
        assertThat(observer.error).isNull();
        assertResponseTimer("unknown", 1);
    }

    @Test
    @DisplayName("invalid provider result is UNKNOWN rather than a successful provider execution")
    void detectObjects_invalidProviderResultExportsUnknown() {
        fakeDetector.results = java.util.Arrays.asList((DetectedObject) null);
        SimpleObserver<DetectResponse> observer = new SimpleObserver<>();

        withContext("tenant-metrics-test", () -> service.detectObjects(
                DetectRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[]{1})).build(), observer));

        assertThat(observer.error).isNotNull();
        assertProviderTimer("unknown", 1);
    }

    @Test
    @DisplayName("transport cancellation during detection exports UNKNOWN")
    void detectObjects_cancelledContextExportsUnknown() {
        fakeDetector.results = List.of(DetectedObject.builder()
                .className("car").confidence(0.9)
                .boundingBox(BoundingBox.builder().x(0).y(0).width(10).height(10).build()).build());
        Context.CancellableContext context = Context.current()
                .withValue(JwtServerInterceptor.CTX_TENANT, "tenant-metrics-test")
                .withCancellation();
        fakeDetector.onDetect = () -> context.cancel(null);
        SimpleObserver<DetectResponse> observer = new SimpleObserver<>();

        context.run(() -> service.detectObjects(
                DetectRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[]{1})).build(), observer));

        assertProviderTimer("unknown", 1);
        assertResponseTimer("unknown", 1);
    }

    @Test
    @DisplayName("analyzeVideoFile request records its detector boundary in Micrometer")
    void analyzeVideoFile_recordsProviderBoundary() throws Exception {
        stubSingleExtractedFrame();
        fakeDetector.results = validDetections();
        SimpleObserver<VideoFileResponse> observer = new SimpleObserver<>();

        withContext("tenant-video-fixture", () -> service.analyzeVideoFile(
                VideoFileRequest.newBuilder().setVideoData(ByteString.copyFrom(new byte[]{1})).build(), observer));

        assertThat(observer.error).isNull();
        assertDecodeBoundary("success");
        assertProviderTimer("success", 1);
        assertResponseTimer("success", 1);
    }

    @Test
    @DisplayName("analyzeVideoFile extraction rejection records a failed decode and never calls the detector")
    void analyzeVideoFile_extractionRejectionRecordsFailure() throws Exception {
        when(frameExtractor.getVideoMetadata(any(Path.class)))
                .thenReturn(new VideoFrameExtractor.VideoMetadata(1, 1, 1, 1, 1));
        when(frameExtractor.extractFrames(any(Path.class), any(Path.class),
                any(VideoFrameExtractor.ExtractionConfig.class)))
                .thenThrow(new java.io.IOException("fixture extraction failure"));
        SimpleObserver<VideoFileResponse> observer = new SimpleObserver<>();

        withContext("tenant-video-fixture", () -> service.analyzeVideoFile(
                VideoFileRequest.newBuilder().setVideoData(ByteString.copyFrom(new byte[]{1})).build(), observer));

        assertThat(observer.error).isNotNull();
        assertThat(fakeDetector.calls).isZero();
        assertDecodeBoundary("failure");
    }

    @Test
    @DisplayName("unexpected frame decoder exception records unknown")
    void analyzeVideoFile_unexpectedExtractionExceptionRecordsUnknown() throws Exception {
        when(frameExtractor.getVideoMetadata(any(Path.class)))
                .thenReturn(new VideoFrameExtractor.VideoMetadata(1, 1, 1, 1, 1));
        when(frameExtractor.extractFrames(any(Path.class), any(Path.class),
                any(VideoFrameExtractor.ExtractionConfig.class)))
                .thenThrow(new IllegalStateException("fixture decoder state failure"));
        SimpleObserver<VideoFileResponse> observer = new SimpleObserver<>();

        withContext("tenant-video-fixture", () -> service.analyzeVideoFile(
                VideoFileRequest.newBuilder().setVideoData(ByteString.copyFrom(new byte[]{1})).build(), observer));

        assertThat(observer.error).isNotNull();
        assertThat(fakeDetector.calls).isZero();
        assertDecodeBoundary("unknown");
    }

    @Test
    @DisplayName("analyzeVideoFile provider exception records UNKNOWN")
    void analyzeVideoFile_providerExceptionRecordsUnknown() throws Exception {
        stubSingleExtractedFrame();
        fakeDetector.throwOn = new VisionDetector.DetectionException("synthetic provider failure");
        SimpleObserver<VideoFileResponse> observer = new SimpleObserver<>();

        withContext("tenant-video-fixture", () -> service.analyzeVideoFile(
                VideoFileRequest.newBuilder().setVideoData(ByteString.copyFrom(new byte[]{1})).build(), observer));

        assertThat(observer.error).isNotNull();
        assertProviderTimer("unknown", 1);
    }

    @Test
    @DisplayName("processVideo request records a provider boundary for each frame")
    void processVideo_recordsProviderBoundary() {
        fakeDetector.results = validDetections();
        SimpleObserver<VideoFrameResponse> observer = new SimpleObserver<>();

        withContext("tenant-video-fixture", () -> service.processVideo(observer).onNext(
                VideoFrameRequest.newBuilder().setFrameData(ByteString.copyFrom(new byte[]{1})).build()));

        assertThat(observer.error).isNull();
        assertProviderTimer("success", 1);
    }

    @Test
    @DisplayName("processVideo provider exception records UNKNOWN")
    void processVideo_providerExceptionRecordsUnknown() {
        fakeDetector.throwOn = new VisionDetector.DetectionException("synthetic provider failure");
        SimpleObserver<VideoFrameResponse> observer = new SimpleObserver<>();

        withContext("tenant-video-fixture", () -> service.processVideo(observer).onNext(
                VideoFrameRequest.newBuilder().setFrameData(ByteString.copyFrom(new byte[]{1})).build()));

        assertThat(observer.error).isNotNull();
        assertProviderTimer("unknown", 1);
    }

    private void assertProviderTimer(String outcome, long expectedCount) {
        Timer timer = meterRegistry.find("media.modality.boundary.duration")
                .tags("modality", "vision", "service", "vision", "boundary", "provider",
                        "execution_class", "model", "outcome", outcome, "contract_version", "v1").timer();
        assertThat(timer).isNotNull();
        assertThat(timer.count()).isEqualTo(expectedCount);
        assertThat(timer.totalTime(java.util.concurrent.TimeUnit.SECONDS)).isGreaterThanOrEqualTo(0);
        assertThat(timer.takeSnapshot().percentileValues()).hasSize(3);
        assertThat(timer.getId().getTags()).extracting("key")
                .containsExactlyInAnyOrder("modality", "service", "boundary", "execution_class",
                        "outcome", "contract_version");
        assertThat(meterRegistry.getMeters()).allSatisfy(meter -> {
            assertThat(meter.getId().getTag("tenant")).isNull();
            assertThat(meter.getId().getTag("request")).isNull();
            assertThat(meter.getId().getTag("content")).isNull();
        });
    }

    private void assertDecodeBoundary(String outcome) {
        Timer timer = meterRegistry.find("media.modality.boundary.duration")
                .tags("modality", "vision", "service", "vision", "boundary", "decode",
                        "execution_class", "model", "outcome", outcome, "contract_version", "v1").timer();
        assertThat(timer).isNotNull();
        assertThat(timer.count()).isEqualTo(1);
        assertThat(timer.getId().getTags()).extracting("key")
                .containsExactlyInAnyOrder("modality", "service", "boundary", "execution_class",
                        "outcome", "contract_version");
        assertThat(meterRegistry.getMeters()).allSatisfy(meter -> {
            assertThat(meter.getId().getTag("tenant")).isNull();
            assertThat(meter.getId().getTag("request_id")).isNull();
            assertThat(meter.getId().getTag("content")).isNull();
        });
    }

    private void assertResponseTimer(String outcome, long expectedCount) {
        Timer timer = meterRegistry.find("media.modality.boundary.duration")
                .tags("modality", "vision", "service", "vision", "boundary", "response",
                        "execution_class", "control", "outcome", outcome, "contract_version", "v1").timer();
        assertThat(timer).isNotNull();
        assertThat(timer.count()).isEqualTo(expectedCount);
        assertThat(timer.getId().getTags()).extracting("key")
                .containsExactlyInAnyOrder("modality", "service", "boundary", "execution_class",
                        "outcome", "contract_version");
        assertThat(meterRegistry.getMeters()).allSatisfy(meter -> {
            assertThat(meter.getId().getTag("tenant")).isNull();
            assertThat(meter.getId().getTag("request")).isNull();
            assertThat(meter.getId().getTag("content")).isNull();
        });
    }

    private List<DetectedObject> validDetections() {
        return List.of(DetectedObject.builder().className("car").confidence(0.9)
                .boundingBox(BoundingBox.builder().x(0).y(0).width(10).height(10).build()).build());
    }

    private void stubSingleExtractedFrame() throws Exception {
        Path framePath = tempDir.resolve("frame.jpg");
        Files.write(framePath, new byte[]{1});
        when(frameExtractor.getVideoMetadata(any(Path.class)))
                .thenReturn(new VideoFrameExtractor.VideoMetadata(1, 1, 1, 1, 1));
        when(frameExtractor.extractFrames(any(Path.class), any(Path.class),
                any(VideoFrameExtractor.ExtractionConfig.class)))
                .thenReturn(List.of(new VideoFrameExtractor.ExtractedFrame(framePath, 0, 0)));
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
        Runnable onDetect;
        int calls;

        @Override
        public List<DetectedObject> detectObjects(byte[] imageData, DetectionOptions options) { 
            calls++;
            if (onDetect != null) onDetect.run();
            if (throwOn != null) throw throwOn; 
            return results;
        }

        @Override
        public boolean isInitialized() { return true; } 
    }

    private static void withContext(String tenantId, Runnable action) {
        Context.current().withValue(JwtServerInterceptor.CTX_TENANT, tenantId).run(action);
    }

    private static final class MapWithNullKey {
        private final java.util.Map<String, Object> map = new HashMap<>();
        private MapWithNullKey() { map.put(null, "invalid"); }
    }
}
