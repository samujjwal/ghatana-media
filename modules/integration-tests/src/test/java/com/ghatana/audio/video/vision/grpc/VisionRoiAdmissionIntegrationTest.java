package com.ghatana.audio.video.vision.grpc;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.grpc.proto.DetectRequest;
import com.ghatana.audio.video.vision.grpc.proto.DetectResponse;
import com.ghatana.audio.video.vision.grpc.proto.SourceRasterRoi;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Integration boundary coverage for source-raster ROI requests. */
@DisplayName("Vision ROI admission integration")
class VisionRoiAdmissionIntegrationTest {

    @Test
    @DisplayName("unavailable detector is reported before provider or output effects")
    void unavailableDetectorDoesNotProduceDetectionOutput() {
        AtomicInteger providerCalls = new AtomicInteger();
        VisionDetector detector = new VisionDetector() {
            @Override
            public List<com.ghatana.audio.video.vision.model.DetectedObject> detectObjects(
                    byte[] imageData, DetectionOptions options) {
                providerCalls.incrementAndGet();
                return List.of();
            }

            @Override
            public boolean isInitialized() {
                return true;
            }
        };
        VisionGrpcService service = new VisionGrpcService(detector, null) {
            @Override
            protected boolean isInferenceProviderAdmitted() {
                return false;
            }
        };
        CapturingObserver observer = new CapturingObserver();
        DetectRequest request = DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(png(4, 3)))
                .build();

        withTenant("tenant-j05", () -> service.detectObjects(request, observer));

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) observer.error;
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.UNAVAILABLE.getCode());
        assertThat(failure.getStatus().getDescription()).contains("PROVIDER_NOT_ADMITTED");
        assertThat(observer.responses).isZero();
        assertThat(observer.completed).isFalse();
        assertThat(providerCalls).hasValue(0);
    }

    @Test
    @DisplayName("malformed ROI is rejected and valid ROI remains NOT_ADMITTED before provider dispatch")
    void roiRequestsFailClosedBeforeProviderEffects() {
        AtomicInteger providerCalls = new AtomicInteger();
        VisionDetector detector = new VisionDetector() {
            @Override
            public List<com.ghatana.audio.video.vision.model.DetectedObject> detectObjects(
                    byte[] imageData, DetectionOptions options) {
                providerCalls.incrementAndGet();
                return List.of();
            }

            @Override
            public boolean isInitialized() {
                return true;
            }
        };
        VisionGrpcService service = new VisionGrpcService(detector, null);
        byte[] image = png(4, 3);

        DetectRequest malformed = DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(image))
                .setSourceRasterRoi(SourceRasterRoi.newBuilder()
                        .setX(3).setY(0).setWidth(2).setHeight(3)
                        .setSourceFrameVersion("source-frame-v7"))
                .build();
        CapturingObserver malformedObserver = new CapturingObserver();
        withTenant("tenant-j05", () -> service.detectObjects(malformed, malformedObserver));
        assertThat(malformedObserver.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) malformedObserver.error).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());

        DetectRequest overflowingGeometry = DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(image))
                .setSourceRasterRoi(SourceRasterRoi.newBuilder()
                        .setX(Integer.MAX_VALUE).setY(0).setWidth(1).setHeight(1)
                        .setSourceFrameVersion("source-frame-v7"))
                .build();
        CapturingObserver overflowingGeometryObserver = new CapturingObserver();
        withTenant("tenant-j05", () -> service.detectObjects(overflowingGeometry, overflowingGeometryObserver));
        assertThat(overflowingGeometryObserver.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) overflowingGeometryObserver.error).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());

        DetectRequest missingSourceFrameVersion = DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(image))
                .setSourceRasterRoi(SourceRasterRoi.newBuilder()
                        .setX(1).setY(1).setWidth(2).setHeight(2))
                .build();
        CapturingObserver missingVersionObserver = new CapturingObserver();
        withTenant("tenant-j05", () -> service.detectObjects(missingSourceFrameVersion, missingVersionObserver));
        assertThat(missingVersionObserver.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) missingVersionObserver.error).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());

        DetectRequest undecodableRaster = DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(new byte[] {0x01, 0x02, 0x03}))
                .setSourceRasterRoi(SourceRasterRoi.newBuilder()
                        .setX(0).setY(0).setWidth(1).setHeight(1)
                        .setSourceFrameVersion("source-frame-v7"))
                .build();
        CapturingObserver undecodableRasterObserver = new CapturingObserver();
        withTenant("tenant-j05", () -> service.detectObjects(undecodableRaster, undecodableRasterObserver));
        assertThat(undecodableRasterObserver.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) undecodableRasterObserver.error).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        assertThat(undecodableRasterObserver.responses).isZero();
        assertThat(undecodableRasterObserver.completed).isFalse();

        DetectRequest validButUnadmitted = DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(image))
                .setSourceRasterRoi(SourceRasterRoi.newBuilder()
                        .setX(1).setY(1).setWidth(2).setHeight(2)
                        .setSourceFrameVersion("source-frame-v7"))
                .build();
        CapturingObserver unadmittedObserver = new CapturingObserver();
        withTenant("tenant-j05", () -> service.detectObjects(validButUnadmitted, unadmittedObserver));
        assertThat(unadmittedObserver.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) unadmittedObserver.error).getStatus().getCode())
                .isEqualTo(Status.FAILED_PRECONDITION.getCode());
        assertThat(((StatusRuntimeException) unadmittedObserver.error).getStatus().getDescription())
                .contains("ROI detection is not admitted");

        assertThat(providerCalls).hasValue(0);
    }

    @Test
    @DisplayName("caller-asserted stale frame version cannot authorize ROI detector dispatch")
    void unboundSourceFrameVersionDoesNotReachDetector() {
        AtomicInteger providerCalls = new AtomicInteger();
        VisionDetector detector = new VisionDetector() {
            @Override
            public List<com.ghatana.audio.video.vision.model.DetectedObject> detectObjects(
                    byte[] imageData, DetectionOptions options) {
                providerCalls.incrementAndGet();
                return List.of();
            }

            @Override
            public boolean isInitialized() {
                return true;
            }
        };
        VisionGrpcService service = new VisionGrpcService(detector, null);
        DetectRequest request = DetectRequest.newBuilder()
                .setImageData(ByteString.copyFrom(png(4, 3)))
                .setSourceRasterRoi(SourceRasterRoi.newBuilder()
                        .setX(1).setY(1).setWidth(2).setHeight(2)
                        // A non-empty caller claim is not bound to an owner source/frame here.
                        .setSourceFrameVersion("stale-source-frame-v6"))
                .build();
        CapturingObserver observer = new CapturingObserver();

        withTenant("tenant-j05", () -> service.detectObjects(request, observer));

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) observer.error;
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.FAILED_PRECONDITION.getCode());
        assertThat(failure.getStatus().getDescription()).contains("ROI detection is not admitted");
        assertThat(observer.responses).isZero();
        assertThat(observer.completed).isFalse();
        assertThat(providerCalls).hasValue(0);
    }

    private static void withTenant(String tenantId, Runnable action) {
        Context.current().withValue(JwtServerInterceptor.CTX_TENANT, tenantId).run(action);
    }

    private static byte[] png(int width, int height) {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (!ImageIO.write(image, "png", output)) {
                throw new IllegalStateException("PNG writer is unavailable");
            }
            return output.toByteArray();
        } catch (IOException failure) {
            throw new IllegalStateException("Unable to encode PNG fixture", failure);
        }
    }

    private static final class CapturingObserver implements StreamObserver<DetectResponse> {
        private Throwable error;
        private int responses;
        private boolean completed;

        @Override
        public void onNext(DetectResponse value) {
            responses++;
        }

        @Override
        public void onError(Throwable failure) {
            error = failure;
        }

        @Override
        public void onCompleted() {
            completed = true;
        }
    }
}
