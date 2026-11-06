package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.grpc.proto.DetectRequest;
import com.ghatana.audio.video.vision.grpc.proto.VisionServiceGrpc;
import com.ghatana.audio.video.vision.model.BoundingBox;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.Contexts;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.ServerBuilder;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.Deadline;
import io.grpc.ForwardingServerCall;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class VisionGrpcDeadlineProviderIntegrationTest {
    private static final String TENANT = "vision-deadline-test";

    @Test
    void clientDeadlineReachesBoundedProviderAndSuppressesItsLateSuccess() throws Exception {
        VisionDetector detector = mock(VisionDetector.class);
        CountDownLatch providerStarted = new CountDownLatch(1);
        CountDownLatch providerContextCancelled = new CountDownLatch(1);
        CountDownLatch releaseProvider = new CountDownLatch(1);
        CountDownLatch providerFinished = new CountDownLatch(1);
        CountDownLatch queuedProviderStarted = new CountDownLatch(1);
        AtomicInteger dispatches = new AtomicInteger();
        AtomicReference<Deadline> providerDeadline = new AtomicReference<>();
        AtomicReference<Context> providerContext = new AtomicReference<>();
        when(detector.detectObjects(any(byte[].class), any(DetectionOptions.class))).thenAnswer(invocation -> {
            if (dispatches.incrementAndGet() == 1) {
                Context context = Context.current();
                providerContext.set(context);
                context.addListener(ignored -> providerContextCancelled.countDown(), Runnable::run);
                providerDeadline.set(context.getDeadline());
                providerStarted.countDown();
                try {
                    for (;;) {
                        try {
                            releaseProvider.await();
                            return List.of(detection());
                        } catch (InterruptedException ignored) {
                            // Model a native provider that does not stop when its Java worker is interrupted.
                        }
                    }
                } finally {
                    providerFinished.countDown();
                }
            }
            queuedProviderStarted.countDown();
            return List.of(detection());
        });

        VisionGrpcService service = new VisionGrpcService(detector, mock(VideoFrameExtractor.class));
        ThreadPoolExecutor providerWorkers = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(1), runnable -> {
                    Thread thread = new Thread(runnable, "vision-deadline-integration-worker");
                    thread.setDaemon(true);
                    return thread;
                }, new ThreadPoolExecutor.AbortPolicy());
        service.bindProviderExecutor(providerWorkers);

        TenantInjector tenantInjector = new TenantInjector();
        Server server = ServerBuilder.forPort(0).directExecutor()
                .intercept(tenantInjector)
                .addService(service)
                .build()
                .start();
        ManagedChannel channel = ManagedChannelBuilder.forAddress("localhost", server.getPort())
                .usePlaintext()
                .directExecutor()
                .build();
        ExecutorService callers = Executors.newCachedThreadPool();
        try {
            var firstCall = callers.submit(() -> VisionServiceGrpc.newBlockingStub(channel)
                    .withDeadlineAfter(500, TimeUnit.MILLISECONDS)
                    .detectObjects(DetectRequest.newBuilder()
                            .setImageData(ByteString.copyFrom(new byte[]{1, 2, 3}))
                            .build()));

            assertThat(providerStarted.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(providerDeadline.get()).isNotNull();
            assertThat(providerWorkers.getActiveCount()).isEqualTo(1);
            assertThat(org.assertj.core.api.Assertions.catchThrowable(
                    () -> firstCall.get(2, TimeUnit.SECONDS)))
                    .isInstanceOf(java.util.concurrent.ExecutionException.class)
                    .hasCauseInstanceOf(StatusRuntimeException.class)
                    .satisfies(failure -> assertThat(Status.fromThrowable(failure.getCause()).getCode())
                            .isEqualTo(Status.Code.DEADLINE_EXCEEDED));
            assertThat(providerContextCancelled.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(providerContext.get().isCancelled()).isTrue();

            var secondCall = callers.submit(() -> VisionServiceGrpc.newBlockingStub(channel)
                    .withDeadlineAfter(4, TimeUnit.SECONDS)
                    .detectObjects(DetectRequest.newBuilder()
                            .setImageData(ByteString.copyFrom(new byte[]{1, 2, 3}))
                            .build()));
            long queueDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
            while (providerWorkers.getQueue().isEmpty() && System.nanoTime() < queueDeadline) Thread.yield();
            assertThat(providerWorkers.getQueue()).hasSize(1);
            assertThat(providerWorkers.getActiveCount()).isEqualTo(1);
            assertThat(dispatches).hasValue(1);

            // Keep the noncooperative provider occupying its worker until the queued request is visible.
            releaseProvider.countDown();
            assertThat(providerFinished.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(queuedProviderStarted.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(secondCall.get(2, TimeUnit.SECONDS)).isNotNull();
            // Only the second request can produce a response message; the first provider's late
            // success is suppressed after its caller deadline has already completed.
            assertThat(tenantInjector.responseMessages).hasValue(1);
            assertThat(dispatches).hasValue(2);
        } finally {
            releaseProvider.countDown();
            callers.shutdownNow();
            channel.shutdownNow();
            server.shutdownNow();
            providerWorkers.shutdownNow();
        }
    }

    private static DetectedObject detection() {
        return DetectedObject.builder().className("object").confidence(0.9)
                .boundingBox(BoundingBox.builder().x(0).y(0).width(1).height(1).build())
                .timestamp(Instant.EPOCH).build();
    }

    private static final class TenantInjector implements ServerInterceptor {
        private final AtomicInteger responseMessages = new AtomicInteger();

        @Override
        public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
                ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {
            ServerCall<ReqT, RespT> observedCall = new ForwardingServerCall.SimpleForwardingServerCall<>(call) {
                @Override
                public void sendMessage(RespT message) {
                    responseMessages.incrementAndGet();
                    super.sendMessage(message);
                }
            };
            return Contexts.interceptCall(Context.current().withValue(JwtServerInterceptor.CTX_TENANT, TENANT),
                    observedCall, headers, next);
        }
    }
}
