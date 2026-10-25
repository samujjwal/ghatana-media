package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.model.FileSystemModelStore;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.model.BoundingBox;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audio.video.vision.grpc.proto.*;
import com.ghatana.audiovideo.observability.tracing.AudioVideoTracingService;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.Status;
import io.grpc.stub.ServerCallStreamObserver;
import io.grpc.stub.StreamObserver;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class VisionGrpcServiceTracingTest {

    @Test
    void successfulDetectionExportsBoundedSpanWithoutProtectedInputs() {
        InMemorySpanExporter exporter = InMemorySpanExporter.create();
        SdkTracerProvider provider = SdkTracerProvider.builder()
                .addSpanProcessor(SimpleSpanProcessor.create(exporter)).build();
        try {
            VisionDetector detector = detector(List.of(detection()));
            VisionGrpcService service = service(detector, provider);
            String tenantMarker = "tenant-private-58391";
            String contentMarker = "image-private-94812";
            RecordingObserver<DetectResponse> observer = new RecordingObserver<>();
            DetectRequest request = DetectRequest.newBuilder()
                    .setImageData(ByteString.copyFrom(contentMarker.getBytes(java.nio.charset.StandardCharsets.UTF_8)))
                    .setConfidenceThreshold(0.5)
                    .build();

            Context.current().withValue(JwtServerInterceptor.CTX_TENANT, tenantMarker)
                    .run(() -> service.detectObjects(request, observer));

            assertThat(observer.error).isNull();
            assertThat(observer.completed).isTrue();
            SpanData span = exporter.getFinishedSpanItems().get(0);
            assertThat(span.getAttributes().get(io.opentelemetry.api.common.AttributeKey.stringKey("media.surface")))
                    .isEqualTo("vision");
            assertThat(span.getAttributes().get(io.opentelemetry.api.common.AttributeKey.stringKey("media.rpc.operation")))
                    .isEqualTo("detectObjects");
            assertThat(span.getAttributes().get(io.opentelemetry.api.common.AttributeKey.longKey("vision.detection_count")))
                    .isEqualTo(1L);
            assertNoProtectedMarker(span, tenantMarker, contentMarker);
        } finally {
            provider.close();
            exporter.close();
        }
    }

    @Test
    void failedDetectionExportsErrorSpanWithoutExceptionMessage() {
        InMemorySpanExporter exporter = InMemorySpanExporter.create();
        SdkTracerProvider provider = SdkTracerProvider.builder()
                .addSpanProcessor(SimpleSpanProcessor.create(exporter)).build();
        try {
            VisionDetector detector = detectorFailure("provider-private-33771");
            VisionGrpcService service = service(detector, provider);
            RecordingObserver<DetectResponse> observer = new RecordingObserver<>();
            DetectRequest request = DetectRequest.newBuilder()
                    .setImageData(ByteString.copyFrom(new byte[]{1, 2, 3})).build();

            Context.current().withValue(JwtServerInterceptor.CTX_TENANT, "tenant-private-44771")
                    .run(() -> service.detectObjects(request, observer));

            assertThat(Status.fromThrowable(observer.error).getCode()).isEqualTo(Status.Code.INTERNAL);
            SpanData span = exporter.getFinishedSpanItems().get(0);
            assertThat(span.getStatus().getStatusCode().name()).isEqualTo("ERROR");
            assertNoProtectedMarker(span, "tenant-private-44771", "provider-private-33771");
        } finally {
            provider.close();
            exporter.close();
        }
    }

    @Test
    void unaryRpcExportsRegisteredMethodNameWithoutRequestOrTenantContent() {
        InMemorySpanExporter exporter = InMemorySpanExporter.create();
        SdkTracerProvider provider = provider(exporter);
        try {
            VisionGrpcService service = service(detector(List.of()), provider);
            RecordingObserver<AnalyzeResponse> observer = new RecordingObserver<>();
            String tenantMarker = "tenant-unary-private-2259";
            String contentMarker = "image-unary-private-6071";
            AnalyzeRequest request = AnalyzeRequest.newBuilder().setImageData(ByteString.copyFrom(
                    contentMarker.getBytes(java.nio.charset.StandardCharsets.UTF_8))).build();

            withTenant(tenantMarker, () -> service.analyzeImage(request, observer));

            assertThat(Status.fromThrowable(observer.error).getCode()).isEqualTo(Status.Code.UNIMPLEMENTED);
            SpanData span = exporter.getFinishedSpanItems().get(0);
            assertThat(span.getName()).isEqualTo("audiovideo.vision.rpc");
            assertThat(span.getAttributes().get(
                    io.opentelemetry.api.common.AttributeKey.stringKey("vision.rpc.method")))
                    .isEqualTo("analyzeImage");
            assertNoProtectedMarker(span, tenantMarker, contentMarker);
        } finally {
            provider.close();
            exporter.close();
        }
    }

    @Test
    void detectionProviderRunsWithOperationSpanCurrentAndCallerContextIsRestored() {
        InMemorySpanExporter exporter = InMemorySpanExporter.create();
        SdkTracerProvider provider = provider(exporter);
        AtomicReference<Boolean> providerHadCurrentSpan = new AtomicReference<>(false);
        try {
            VisionGrpcService service = service(detector(List.of(detection()),
                    () -> providerHadCurrentSpan.set(io.opentelemetry.api.trace.Span.current()
                            .getSpanContext().isValid())), provider);
            RecordingObserver<DetectResponse> observer = new RecordingObserver<>();
            withTenant("tenant-private-scope-09173", () -> service.detectObjects(
                    DetectRequest.newBuilder().setImageData(ByteString.copyFrom(new byte[]{1, 2, 3})).build(), observer));

            assertThat(providerHadCurrentSpan).hasValue(true);
            assertThat(io.opentelemetry.api.trace.Span.current().getSpanContext().isValid()).isFalse();
            SpanData span = exporter.getFinishedSpanItems().get(0);
            assertNoProtectedMarker(span, "tenant-private-scope-09173");
        } finally {
            provider.close();
            exporter.close();
        }
    }

    @Test
    void streamingDetectionSuccessAndProviderFailureExportOneBoundedSpanEach() {
        InMemorySpanExporter exporter = InMemorySpanExporter.create();
        SdkTracerProvider provider = provider(exporter);
        try {
            VisionGrpcService success = service(detector(List.of(detection()), null), provider);
            RecordingObserver<VideoFrameResponse> successResponse = new RecordingObserver<>();
            StreamObserver<VideoFrameRequest> successRequest = success.processVideo(successResponse);
            withTenant("tenant-stream-private-1273", () -> {
                successRequest.onNext(videoFrame("frame-private-6104"));
                successRequest.onCompleted();
            });

            assertThat(successResponse.values).hasSize(1);
            assertThat(successResponse.completed).isTrue();
            SpanData successSpan = exporter.getFinishedSpanItems().get(0);
            assertThat(successSpan.getStatus().getStatusCode().name()).isEqualTo("OK");
            assertThat(successSpan.getAttributes().get(
                    io.opentelemetry.api.common.AttributeKey.stringKey("media.rpc.operation")))
                    .isEqualTo("processVideo");
            assertNoProtectedMarker(successSpan, "tenant-stream-private-1273", "frame-private-6104");

            VisionGrpcService failed = service(detectorFailure("provider-error-private-4402"), provider);
            RecordingObserver<VideoFrameResponse> failedResponse = new RecordingObserver<>();
            StreamObserver<VideoFrameRequest> failedRequest = failed.processVideo(failedResponse);
            withTenant("tenant-stream-private-9921", () -> {
                failedRequest.onNext(videoFrame("frame-private-7145"));
                failedRequest.onCompleted();
            });

            assertThat(Status.fromThrowable(failedResponse.error).getCode()).isEqualTo(Status.Code.INTERNAL);
            List<SpanData> spans = exporter.getFinishedSpanItems();
            assertThat(spans).hasSize(2);
            SpanData failureSpan = spans.get(1);
            assertThat(failureSpan.getStatus().getStatusCode().name()).isEqualTo("ERROR");
            assertNoProtectedMarker(failureSpan, "tenant-stream-private-9921", "frame-private-7145",
                    "provider-error-private-4402");
        } finally {
            provider.close();
            exporter.close();
        }
    }

    @Test
    void clientCancellationEndsStreamingSpanWithoutChangingResponseTerminalSemantics() {
        InMemorySpanExporter exporter = InMemorySpanExporter.create();
        SdkTracerProvider provider = provider(exporter);
        AtomicInteger providerCalls = new AtomicInteger();
        try {
            VisionGrpcService service = service(detector(List.of(detection()), providerCalls::incrementAndGet), provider);
            @SuppressWarnings("unchecked")
            ServerCallStreamObserver<VideoFrameResponse> response = mock(ServerCallStreamObserver.class);
            AtomicReference<Runnable> cancelHandler = new AtomicReference<>();
            doAnswer(invocation -> {
                cancelHandler.set(invocation.getArgument(0));
                return null;
            }).when(response).setOnCancelHandler(any(Runnable.class));
            when(response.isCancelled()).thenReturn(false);

            StreamObserver<VideoFrameRequest> request = service.processVideo(response);
            cancelHandler.get().run();
            withTenant("tenant-cancel-private-881", () -> request.onNext(videoFrame("frame-private-cancel-16")));

            assertThat(providerCalls).hasValue(0);
            verify(response, never()).onError(any());
            verify(response, never()).onCompleted();
            SpanData span = exporter.getFinishedSpanItems().get(0);
            assertThat(span.getStatus().getStatusCode().name()).isEqualTo("UNSET");
            assertNoProtectedMarker(span, "tenant-cancel-private-881", "frame-private-cancel-16");
        } finally {
            provider.close();
            exporter.close();
        }
    }

    private static SdkTracerProvider provider(InMemorySpanExporter exporter) {
        return SdkTracerProvider.builder().addSpanProcessor(SimpleSpanProcessor.create(exporter)).build();
    }

    private static VisionGrpcService service(VisionDetector detector, SdkTracerProvider provider) {
        return new VisionGrpcService(detector, new VideoFrameExtractor(), MediaProcessingMetrics.noop(), null,
                new FileSystemModelStore(), new SimpleMeterRegistry(),
                new AudioVideoTracingService(provider.get("vision-test")));
    }

    private static VisionDetector detector(List<DetectedObject> results) {
        return detector(results, null);
    }

    private static VisionDetector detector(List<DetectedObject> results, Runnable onDetect) {
        return new VisionDetector() {
            @Override public List<DetectedObject> detectObjects(byte[] bytes,
                    com.ghatana.audio.video.vision.model.DetectionOptions options) {
                if (onDetect != null) onDetect.run();
                return results;
            }
            @Override public boolean isInitialized() { return true; }
        };
    }

    private static VisionDetector detectorFailure(String marker) {
        return new VisionDetector() {
            @Override public List<DetectedObject> detectObjects(byte[] bytes,
                    com.ghatana.audio.video.vision.model.DetectionOptions options) {
                throw new VisionDetector.DetectionException(marker);
            }
            @Override public boolean isInitialized() { return true; }
        };
    }

    private static DetectedObject detection() {
        return DetectedObject.builder().className("vehicle").confidence(0.8)
                .boundingBox(BoundingBox.builder().x(0).y(0).width(4).height(4).build()).build();
    }

    private static VideoFrameRequest videoFrame(String content) {
        return VideoFrameRequest.newBuilder().setFrameData(ByteString.copyFrom(content.getBytes(
                        java.nio.charset.StandardCharsets.UTF_8)))
                .setFrameNumber(4).setTimestampMs(0).build();
    }

    private static void withTenant(String tenant, Runnable task) {
        Context.current().withValue(JwtServerInterceptor.CTX_TENANT, tenant).run(task);
    }

    private static void assertNoProtectedMarker(SpanData span, String... markers) {
        String exported = span.getName() + " " + span.getAttributes().asMap();
        for (String marker : markers) assertThat(exported).doesNotContain(marker);
    }

    private static final class RecordingObserver<T> implements StreamObserver<T> {
        private final java.util.ArrayList<T> values = new java.util.ArrayList<>();
        private Throwable error;
        private boolean completed;
        @Override public void onNext(T value) { values.add(value); }
        @Override public void onError(Throwable failure) { error = failure; }
        @Override public void onCompleted() { completed = true; }
    }
}
