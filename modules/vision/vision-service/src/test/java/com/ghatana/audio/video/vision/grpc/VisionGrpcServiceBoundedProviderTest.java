package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.grpc.proto.DetectRequest;
import com.ghatana.audio.video.vision.model.BoundingBox;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.Deadline;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class VisionGrpcServiceBoundedProviderTest {
    private static final String TENANT = "vision-bounded-test";
    private static final Context.Key<String> CORRELATION = Context.key("test-correlation");
    private static final DetectRequest REQUEST = DetectRequest.newBuilder()
            .setImageData(ByteString.copyFrom(new byte[]{1, 2, 3}))
            .build();

    @Test
    void providerRunsOffCallerThreadAndReturnsNormalResponse() throws Exception {
        VisionDetector detector = mock(VisionDetector.class);
        AtomicReference<Thread> providerThread = new AtomicReference<>();
        when(detector.detectObjects(any(byte[].class), any(DetectionOptions.class))).thenAnswer(call -> {
            providerThread.set(Thread.currentThread());
            return List.of(detection());
        });
        VisionGrpcService service = new VisionGrpcService(detector, mock(VideoFrameExtractor.class));
        ExecutorService workers = workerPool(1, 1);
        service.bindProviderExecutor(workers);
        CapturingObserver observer = new CapturingObserver();
        Thread caller = Thread.currentThread();

        tenantContext().run(() -> service.detectObjects(REQUEST, observer));

        assertThat(observer.terminal.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(observer.completed).isTrue();
        assertThat(observer.failure).isNull();
        assertThat(providerThread.get()).isNotSameAs(caller);
        workers.shutdownNow();
    }

    @Test
    void saturatedInferenceQueueReturnsResourceExhaustedWithoutCallingProvider() throws Exception {
        VisionDetector detector = mock(VisionDetector.class);
        VisionGrpcService service = new VisionGrpcService(detector, mock(VideoFrameExtractor.class));
        ExecutorService workers = workerPool(1, 1);
        service.bindProviderExecutor(workers);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch started = new CountDownLatch(1);
        workers.execute(() -> {
            started.countDown();
            awaitUninterruptibly(release);
        });
        assertThat(started.await(1, TimeUnit.SECONDS)).isTrue();
        workers.execute(() -> { }); // Occupy the only queue slot.
        CapturingObserver observer = new CapturingObserver();

        tenantContext().run(() -> service.detectObjects(REQUEST, observer));

        assertThat(observer.failure).isInstanceOf(StatusRuntimeException.class);
        assertThat(Status.fromThrowable(observer.failure).getCode()).isEqualTo(Status.Code.RESOURCE_EXHAUSTED);
        org.mockito.Mockito.verifyNoInteractions(detector);
        release.countDown();
        workers.shutdownNow();
    }

    @Test
    void cancellationAfterDispatchReportsUnknownAndSuppressesLateSuccess() throws Exception {
        VisionDetector detector = mock(VisionDetector.class);
        CountDownLatch providerStarted = new CountDownLatch(1);
        CountDownLatch providerFinished = new CountDownLatch(1);
        CountDownLatch releaseProvider = new CountDownLatch(1);
        AtomicBoolean interrupted = new AtomicBoolean();
        when(detector.detectObjects(any(byte[].class), any(DetectionOptions.class))).thenAnswer(call -> {
            providerStarted.countDown();
            try {
                for (;;) {
                    try {
                        releaseProvider.await();
                        break;
                    } catch (InterruptedException ignored) {
                        interrupted.set(true);
                    }
                }
                return List.of(detection());
            } finally {
                providerFinished.countDown();
            }
        });
        VisionGrpcService service = new VisionGrpcService(detector, mock(VideoFrameExtractor.class));
        ExecutorService workers = workerPool(1, 1);
        service.bindProviderExecutor(workers);
        ExecutorService caller = java.util.concurrent.Executors.newSingleThreadExecutor();
        CapturingObserver observer = new CapturingObserver();
        Context.CancellableContext requestContext = tenantContext().withCancellation();

        Future<?> request = caller.submit(() -> requestContext.run(() -> service.detectObjects(REQUEST, observer)));
        assertThat(providerStarted.await(1, TimeUnit.SECONDS)).isTrue();
        requestContext.cancel(new RuntimeException("test cancellation"));
        request.get(1, TimeUnit.SECONDS);

        assertThat(observer.completed).isFalse();
        assertThat(observer.failure).isNull();
        assertThat(observer.responseCount).isZero();
        assertThat(interrupted).isTrue();

        releaseProvider.countDown();
        assertThat(providerFinished.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(observer.responseCount).isZero();
        caller.shutdownNow();
        workers.shutdownNow();
    }

    @Test
    void processVideoChildReceivesOriginalRpcDeadlineAndCorrelationAfterCallbackContextChanges() throws Exception {
        VisionDetector detector = mock(VisionDetector.class);
        AtomicReference<Deadline> observedDeadline = new AtomicReference<>();
        AtomicReference<String> observedCorrelation = new AtomicReference<>();
        CountDownLatch providerCalled = new CountDownLatch(1);
        when(detector.detectObjects(any(byte[].class), any(DetectionOptions.class))).thenAnswer(call -> {
            observedDeadline.set(Context.current().getDeadline());
            observedCorrelation.set(CORRELATION.get());
            providerCalled.countDown();
            return List.of(detection());
        });
        VisionGrpcService service = new VisionGrpcService(detector, mock(VideoFrameExtractor.class)) {
            @Override protected boolean isInferenceProviderAdmitted() { return true; }
        };
        ExecutorService workers = workerPool(1, 1);
        service.bindProviderExecutor(workers);
        ScheduledExecutorService scheduler = java.util.concurrent.Executors.newSingleThreadScheduledExecutor();
        Deadline rpcDeadline = Deadline.after(10, TimeUnit.SECONDS);
        Context requestContext = tenantContext().withValue(CORRELATION, "corr-video-stream")
                .withDeadline(rpcDeadline, scheduler);
        CapturingStreamObserver observer = new CapturingStreamObserver();
        AtomicReference<StreamObserver<com.ghatana.audio.video.vision.grpc.proto.VideoFrameRequest>> requestStream =
                new AtomicReference<>();

        requestContext.run(() -> requestStream.set(service.processVideo(observer)));
        // Simulate a later transport callback running under a reduced/different Context.
        tenantContext().run(() -> requestStream.get().onNext(
                com.ghatana.audio.video.vision.grpc.proto.VideoFrameRequest.newBuilder()
                        .setFrameData(ByteString.copyFrom(new byte[]{1, 2, 3}))
                        .build()));

        assertThat(providerCalled.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(observer.failure).isNull();
        assertThat(observedDeadline.get()).isSameAs(rpcDeadline);
        assertThat(observedCorrelation.get()).isEqualTo("corr-video-stream");
        requestStream.get().onCompleted();
        assertThat(observer.terminal.await(1, TimeUnit.SECONDS)).isTrue();
        scheduler.shutdownNow();
        workers.shutdownNow();
    }

    private static ThreadPoolExecutor workerPool(int workers, int queueCapacity) {
        return new ThreadPoolExecutor(workers, workers, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(queueCapacity), runnable -> {
                    Thread thread = new Thread(runnable, "vision-bounded-test-worker");
                    thread.setDaemon(true);
                    return thread;
                }, new ThreadPoolExecutor.AbortPolicy());
    }

    private static Context tenantContext() {
        return Context.current().withValue(JwtServerInterceptor.CTX_TENANT, TENANT);
    }

    private static DetectedObject detection() {
        return DetectedObject.builder().className("object").confidence(0.9)
                .boundingBox(BoundingBox.builder().x(0).y(0).width(1).height(1).build())
                .timestamp(Instant.EPOCH).build();
    }

    private static void awaitUninterruptibly(CountDownLatch latch) {
        boolean interrupted = false;
        for (;;) {
            try {
                latch.await();
                break;
            } catch (InterruptedException ignored) {
                interrupted = true;
            }
        }
        if (interrupted) Thread.currentThread().interrupt();
    }

    private static final class CapturingObserver implements StreamObserver<com.ghatana.audio.video.vision.grpc.proto.DetectResponse> {
        private volatile com.ghatana.audio.video.vision.grpc.proto.DetectResponse response;
        private volatile Throwable failure;
        private volatile boolean completed;
        private volatile int responseCount;
        private final CountDownLatch terminal = new CountDownLatch(1);

        @Override public void onNext(com.ghatana.audio.video.vision.grpc.proto.DetectResponse value) {
            response = value;
            responseCount++;
        }

        @Override public void onError(Throwable value) { failure = value; terminal.countDown(); }

        @Override public void onCompleted() { completed = true; terminal.countDown(); }
    }

    private static final class CapturingStreamObserver
            implements StreamObserver<com.ghatana.audio.video.vision.grpc.proto.VideoFrameResponse> {
        private volatile Throwable failure;
        private final CountDownLatch terminal = new CountDownLatch(1);

        @Override public void onNext(com.ghatana.audio.video.vision.grpc.proto.VideoFrameResponse value) { }
        @Override public void onError(Throwable value) { failure = value; terminal.countDown(); }
        @Override public void onCompleted() { terminal.countDown(); }
    }
}
