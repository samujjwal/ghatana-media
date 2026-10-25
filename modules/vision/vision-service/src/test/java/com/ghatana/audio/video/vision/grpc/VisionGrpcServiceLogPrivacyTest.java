package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audit.AuditEvent;
import com.ghatana.audit.AuditService;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.vision.VisionLogCapture;
import com.ghatana.audio.video.vision.grpc.proto.DetectRequest;
import com.ghatana.audio.video.vision.grpc.proto.VideoFileRequest;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import org.mockito.ArgumentCaptor;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class VisionGrpcServiceLogPrivacyTest {
    private static final String TENANT_MARKER = "tenant-marker-vision-private";
    private static final String USER_MARKER = "user-marker-vision-private";

    @Test
    void imageAndVideoRequestLogsDoNotIncludeTenantOrUserMarkers() throws Exception {
        VideoFrameExtractor extractor = mock(VideoFrameExtractor.class);
        when(extractor.getVideoMetadata(any(Path.class))).thenReturn(
                new VideoFrameExtractor.VideoMetadata(640, 480, 1.0, 30.0, 30));
        when(extractor.extractFrames(any(Path.class), any(Path.class), any()))
                .thenReturn(List.of());
        VisionGrpcService service = new VisionGrpcService(new VisionGrpcServiceTest.FakeVisionDetector(), extractor);

        try (VisionLogCapture logs = new VisionLogCapture(VisionGrpcService.class)) {
            Context.current().withValue(JwtServerInterceptor.CTX_TENANT, TENANT_MARKER)
                    .withValue(JwtServerInterceptor.CTX_SUBJECT, USER_MARKER)
                    .run(() -> {
                        service.detectObjects(DetectRequest.newBuilder()
                                .setImageData(ByteString.copyFrom(new byte[] {1, 2, 3})).build(),
                                new VisionGrpcServiceTest.CapturingObserver<>());
                        service.analyzeVideoFile(VideoFileRequest.newBuilder()
                                .setVideoData(ByteString.copyFrom(new byte[] {4, 5, 6})).build(),
                                new VisionGrpcServiceTest.CapturingObserver<>());
                    });

            String output = String.join("\n", logs.messages());
            assertThat(output).contains("Detecting objects in image (3 bytes)", "Analyzing video file (3 bytes)");
            assertThat(output).doesNotContain(TENANT_MARKER, USER_MARKER);
            assertThat(logs.throwables()).isEmpty();
        }
    }

    @Test
    void detectorFailureLogDoesNotIncludeProviderExceptionDetailsOrStack() {
        var detector = new VisionGrpcServiceTest.FakeVisionDetector();
        String providerMarker = "provider-path-marker-private";
        detector.setThrowOnDetect(new com.ghatana.audio.video.vision.detection.VisionDetector.DetectionException(
                providerMarker, new IllegalStateException(providerMarker)));
        AuditService audit = mock(AuditService.class);
        VisionGrpcService service = new VisionGrpcService(detector, mock(VideoFrameExtractor.class),
                com.ghatana.audio.video.common.observability.MediaProcessingMetrics.noop(), audit);

        VisionGrpcServiceTest.CapturingObserver<com.ghatana.audio.video.vision.grpc.proto.DetectResponse> observer =
                new VisionGrpcServiceTest.CapturingObserver<>();
        try (VisionLogCapture logs = new VisionLogCapture(VisionGrpcService.class)) {
            Context.current().withValue(JwtServerInterceptor.CTX_TENANT, TENANT_MARKER)
                    .withValue(JwtServerInterceptor.CTX_SUBJECT, USER_MARKER)
                    .run(() -> service.detectObjects(DetectRequest.newBuilder()
                            .setImageData(ByteString.copyFrom(new byte[] {1})).build(),
                            observer));

            String output = String.join("\n", logs.messages());
            assertThat(output).contains("Object detection engine failure (DetectionException)");
            assertThat(output).doesNotContain(TENANT_MARKER, USER_MARKER, providerMarker);
            assertThat(logs.throwables()).isEmpty();
            assertThat(((io.grpc.StatusRuntimeException) observer.getError()).getStatus().getDescription())
                    .isEqualTo("Detection engine error").doesNotContain(providerMarker);
            ArgumentCaptor<AuditEvent> auditEvent = ArgumentCaptor.forClass(AuditEvent.class);
            verify(audit, times(1)).record(auditEvent.capture());
            assertThat(auditEvent.getValue().getTenantId()).isEqualTo(TENANT_MARKER);
            assertThat(auditEvent.getValue().getPrincipal()).isEqualTo(USER_MARKER);
            assertThat(auditEvent.getValue().getSuccess()).isFalse();
            assertThat(auditEvent.getValue().getDetails())
                    .containsEntry("errorCode", "DETECTION_FAILED")
                    .doesNotContainValue(providerMarker);
        }
    }

    @Test
    void videoAnalysisTransportErrorDoesNotExposeFileOrProviderDetails() throws Exception {
        String providerMarker = "ffmpeg-source-path-marker-private";
        VideoFrameExtractor extractor = mock(VideoFrameExtractor.class);
        when(extractor.getVideoMetadata(any(Path.class))).thenThrow(new java.io.IOException(providerMarker));
        VisionGrpcService service = new VisionGrpcService(new VisionGrpcServiceTest.FakeVisionDetector(), extractor);
        VisionGrpcServiceTest.CapturingObserver<com.ghatana.audio.video.vision.grpc.proto.VideoFileResponse> observer =
                new VisionGrpcServiceTest.CapturingObserver<>();

        try (VisionLogCapture logs = new VisionLogCapture(VisionGrpcService.class)) {
            Context.current().withValue(JwtServerInterceptor.CTX_TENANT, TENANT_MARKER)
                    .run(() -> service.analyzeVideoFile(VideoFileRequest.newBuilder()
                            .setVideoData(ByteString.copyFrom(new byte[] {1, 2, 3})).build(), observer));

            assertThat(((io.grpc.StatusRuntimeException) observer.getError()).getStatus().getDescription())
                    .isEqualTo("Video analysis failed").doesNotContain(providerMarker);
            assertThat(String.join("\n", logs.messages())).doesNotContain(TENANT_MARKER, providerMarker);
            assertThat(logs.throwables()).isEmpty();
        }
    }
}
