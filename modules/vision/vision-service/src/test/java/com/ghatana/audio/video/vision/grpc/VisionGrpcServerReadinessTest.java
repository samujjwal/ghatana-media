package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.vision.model.VisionModelProfile;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audio.video.vision.yolo.YoloV8Adapter;
import com.ghatana.audiovideo.observability.AudioVideoHealthService;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import io.grpc.health.v1.HealthCheckRequest;
import io.grpc.health.v1.HealthCheckResponse;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class VisionGrpcServerReadinessTest {

    @Test
    void readinessAndVisionHealthTrackDetectorStateAndShutdown() {
        // This injected detector is only a state-transition fixture. It does not admit a model,
        // initialize OpenCV, or establish real inference quality.
        YoloV8Adapter detector = mock(YoloV8Adapter.class);
        AtomicBoolean initialized = new AtomicBoolean();
        when(detector.isInitialized()).thenAnswer(ignored -> initialized.get());
        VisionModelProfile fixtureProfile = new VisionModelProfile(
                "fixture-model", "fixture-version", Path.of("/fixture"), Path.of("/fixture/model.onnx"),
                "a".repeat(64), "test-only-license-label", List.of("cat"),
                VisionModelProfile.Device.CPU, 1L);
        ProductionVisionGrpcService service = new ProductionVisionGrpcService(
                new ProductionVisionGrpcService.Composition(
                        detector, new VideoFrameExtractor(), fixtureProfile),
                MediaProcessingMetrics.create());
        AudioVideoHealthService readiness = VisionGrpcServer.createReadinessLifecycle(
                new SimpleMeterRegistry(), service::isProviderReady);
        service.setReadinessProbe(readiness::isServing);
        try {
            assertThat(readiness.markReady()).isTrue();
            assertThat(check(readiness)).isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
            assertVisionHealth(service, false);

            initialized.set(true);
            assertThat(check(readiness)).isEqualTo(HealthCheckResponse.ServingStatus.SERVING);
            assertVisionHealth(service, true);

            initialized.set(false);
            assertThat(check(readiness)).isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
            assertVisionHealth(service, false);

            // Drain forces both service and standard health down even while the detector is initialized.
            initialized.set(true);
            readiness.setNotServing();
            assertThat(service.isProviderReady()).isTrue();
            assertThat(check(readiness)).isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
            assertVisionHealth(service, false);
        } finally {
            readiness.setNotServing();
            service.close();
        }

        assertThat(service.isProviderReady()).isFalse();
        assertThat(check(readiness)).isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
        readiness.close();
    }

    private static HealthCheckResponse.ServingStatus check(AudioVideoHealthService readiness) {
        CapturingHealthObserver observer = new CapturingHealthObserver();
        readiness.check(HealthCheckRequest.getDefaultInstance(), observer);
        return observer.response.getStatus();
    }

    private static void assertVisionHealth(ProductionVisionGrpcService service, boolean expected) {
        CapturingVisionObserver observer = new CapturingVisionObserver();
        service.healthCheck(
                com.ghatana.audio.video.vision.grpc.proto.HealthCheckRequest.getDefaultInstance(), observer);
        assertThat(observer.response.getHealthy()).isEqualTo(expected);
        assertThat(observer.response.getMessage()).doesNotContain("fixture-model", "test-only-license-label");
    }

    private static final class CapturingHealthObserver implements StreamObserver<HealthCheckResponse> {
        private HealthCheckResponse response;

        @Override public void onNext(HealthCheckResponse value) { response = value; }
        @Override public void onError(Throwable failure) { throw new AssertionError(failure); }
        @Override public void onCompleted() { }
    }

    private static final class CapturingVisionObserver
            implements StreamObserver<com.ghatana.audio.video.vision.grpc.proto.HealthCheckResponse> {
        private com.ghatana.audio.video.vision.grpc.proto.HealthCheckResponse response;

        @Override public void onNext(com.ghatana.audio.video.vision.grpc.proto.HealthCheckResponse value) {
            response = value;
        }
        @Override public void onError(Throwable failure) { throw new AssertionError(failure); }
        @Override public void onCompleted() { }
    }
}
