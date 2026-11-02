package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.resilience.RpcDeadlineServerInterceptor;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audiovideo.observability.tracing.AudioVideoTracingService;
import com.ghatana.audio.video.multimodal.engine.MultimodalAnalysisEngine;
import com.ghatana.audio.video.multimodal.engine.PlatformMultimodalAdapter;
import com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalRequest;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceGrpc;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.Contexts;
import io.grpc.CallOptions;
import io.grpc.ClientCall;
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
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.time.Duration;
import java.util.concurrent.Callable;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

/**
 * M6 finality surface: the synchronous RPC maps each durable operation outcome to a
 * truthful status and always preserves the stable job identity for reconciliation.
 */
class MultimodalGrpcFinalitySurfaceTest {

    private Server server;
    private ManagedChannel channel;
    private MultimodalGrpcService service;
    private ExecutorService testWorkers;

    @AfterEach
    void tearDown() {
        if (channel != null) channel.shutdownNow();
        if (server != null) server.shutdownNow();
        if (service != null) service.close();
        if (testWorkers != null) testWorkers.shutdownNow();
    }

    @Test
    void unknownOutcomeKeepsTheStableJobIdForReconciliation() throws Exception {
        start(executorThrowing(new CanonicalOperationUnknownException("job-42")));
        assertThatThrownBy(() -> stub().processMultimodal(request()))
                .isInstanceOfSatisfying(StatusRuntimeException.class, error -> {
                    assertThat(error.getStatus().getCode()).isEqualTo(Status.Code.UNKNOWN);
                    assertThat(error.getStatus().getDescription())
                            .contains("jobId=job-42")
                            .contains("do not resubmit");
                });
    }

    @Test
    void failedParentMapsToUnavailableWithDurableFailureCode() throws Exception {
        start(executorFusing(JobStatus.FAILED, "CHILD_FAILED"));
        assertThatThrownBy(() -> stub().processMultimodal(request()))
                .isInstanceOfSatisfying(StatusRuntimeException.class, error -> {
                    assertThat(error.getStatus().getCode()).isEqualTo(Status.Code.UNAVAILABLE);
                    assertThat(error.getStatus().getDescription())
                            .contains("MULTIMODAL_OPERATION_FAILED")
                            .contains("jobId=job-7")
                            .contains("CHILD_FAILED");
                });
    }

    @Test
    void cancelledParentMapsToCancelled() throws Exception {
        start(executorFusing(JobStatus.CANCELLED, ""));
        assertThatThrownBy(() -> stub().processMultimodal(request()))
                .isInstanceOfSatisfying(StatusRuntimeException.class, error ->
                    assertThat(error.getStatus().getCode()).isEqualTo(Status.Code.CANCELLED));
    }

    @Test
    void admissionRefusalStaysFailedPreconditionNotUnknown() throws Exception {
        start(executorThrowing(new MediaCapabilityNotAdmittedException(
                MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED, "MULTIMODAL", "denied")));
        assertThatThrownBy(() -> stub().processMultimodal(request()))
                .isInstanceOfSatisfying(StatusRuntimeException.class, error ->
                    assertThat(error.getStatus().getCode())
                            .isEqualTo(Status.Code.FAILED_PRECONDITION));
    }

    @Test
    void preDispatchValidationStaysInvalidArgumentNotUnknown() throws Exception {
        start(executorThrowing(new IllegalArgumentException("spec malformed")));
        assertThatThrownBy(() -> stub().processMultimodal(request()))
                .isInstanceOfSatisfying(StatusRuntimeException.class, error ->
                    assertThat(error.getStatus().getCode())
                            .isEqualTo(Status.Code.INVALID_ARGUMENT));
    }

    @Test
    void knownNoEffectDeadlineMapsToSanitizedDeadlineExceeded() throws Exception {
        start(executorThrowing(new CanonicalOperationDeadlineExceededException(
                new IllegalStateException("private adapter detail"))));
        assertThatThrownBy(() -> stub().processMultimodal(request()))
                .isInstanceOfSatisfying(StatusRuntimeException.class, error -> {
                    assertThat(error.getStatus().getCode()).isEqualTo(Status.Code.DEADLINE_EXCEEDED);
                    assertThat(error.getStatus().getDescription())
                            .isEqualTo("MULTIMODAL_OPERATION_DEADLINE_EXCEEDED")
                            .doesNotContain("private adapter detail");
                });
    }

    @Test
    void knownNoEffectCallerCancellationMapsToSanitizedCancelled() throws Exception {
        start(executorThrowing(new CanonicalOperationCancelledException(
                new IllegalStateException("private adapter detail"))));
        assertThatThrownBy(() -> stub().processMultimodal(request()))
                .isInstanceOfSatisfying(StatusRuntimeException.class, error -> {
                    assertThat(error.getStatus().getCode()).isEqualTo(Status.Code.CANCELLED);
                    assertThat(error.getStatus().getDescription())
                            .isEqualTo("MULTIMODAL_OPERATION_CANCELLED_BEFORE_DISPATCH")
                            .doesNotContain("private adapter detail");
                });
    }

    @Test
    void localPortCapacityRefusalMapsToSanitizedResourceExhausted() throws Exception {
        start(executorThrowing(new CanonicalOperationResourceExhaustedException(
                new IllegalStateException("private queue detail"))));
        assertThatThrownBy(() -> stub().processMultimodal(request()))
                .isInstanceOfSatisfying(StatusRuntimeException.class, error -> {
                    assertThat(error.getStatus().getCode()).isEqualTo(Status.Code.RESOURCE_EXHAUSTED);
                    assertThat(error.getStatus().getDescription())
                            .isEqualTo("MULTIMODAL_PORT_CAPACITY_UNAVAILABLE")
                            .doesNotContain("private queue detail");
                });
    }

    @Test
    void genericDeadlineFromExecutorRemainsUnknownBecauseEffectFinalityIsUnproven() throws Exception {
        start(executorThrowing(Status.DEADLINE_EXCEEDED
                .withDescription("untrusted downstream detail").asRuntimeException()));
        assertThatThrownBy(() -> stub().processMultimodal(request()))
                .isInstanceOfSatisfying(StatusRuntimeException.class, error -> {
                    assertThat(error.getStatus().getCode()).isEqualTo(Status.Code.UNKNOWN);
                    assertThat(error.getStatus().getDescription())
                            .contains("MULTIMODAL_OPERATION_OUTCOME_UNKNOWN")
                            .doesNotContain("untrusted downstream detail");
                });
    }

    @Test
    void callerDeadlineReachesCanonicalExecutorAndSuppressesLateServiceSuccess() throws Exception {
        CountDownLatch executorEntered = new CountDownLatch(1);
        CountDownLatch releaseExecutor = new CountDownLatch(1);
        AtomicInteger dispatches = new AtomicInteger();
        AtomicBoolean deadlinePropagated = new AtomicBoolean();
        AtomicBoolean deadlineExpiredOrCancellationObserved = new AtomicBoolean();
        AtomicBoolean clientReceivedResponse = new AtomicBoolean();
        AtomicReference<Throwable> clientFailure = new AtomicReference<>();
        start(new CanonicalOperationExecutor() {
            @Override public <T> T execute(CanonicalOperationBinding binding, String operationRef,
                                         Callable<T> action) throws Exception {
                throw new UnsupportedOperationException("typed operation required");
            }
            @Override public <T> T execute(CanonicalOperationBinding binding, String operationRef,
                                         CanonicalOperation<T> operation,
                                         AuthenticatedPrincipal authenticated) throws Exception {
                dispatches.incrementAndGet();
                deadlinePropagated.set(Context.current().getDeadline() != null);
                executorEntered.countDown();
                long observationLimit = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
                while (releaseExecutor.getCount() > 0 && System.nanoTime() < observationLimit) {
                    io.grpc.Deadline deadline = Context.current().getDeadline();
                    if (Context.current().isCancelled() || deadline != null && deadline.isExpired()) {
                        deadlineExpiredOrCancellationObserved.set(true);
                        break;
                    }
                    try {
                        releaseExecutor.await(5, TimeUnit.MILLISECONDS);
                    } catch (InterruptedException cancelled) {
                        if (Context.current().isCancelled()) {
                            deadlineExpiredOrCancellationObserved.set(true);
                            break;
                        }
                    }
                }
                return operation.fixtureAction().call();
            }
        });

        Thread caller = Thread.startVirtualThread(() -> {
            try {
                stub().withDeadlineAfter(150, TimeUnit.MILLISECONDS).processMultimodal(request());
                clientReceivedResponse.set(true);
            } catch (Throwable failure) {
                clientFailure.set(failure);
            }
        });
        try {
            assertThat(executorEntered.await(2, TimeUnit.SECONDS)).isTrue();
            caller.join(2_000);
            assertThat(caller.isAlive()).isFalse();
            assertThat(clientFailure.get()).isInstanceOfSatisfying(StatusRuntimeException.class, failure ->
                    assertThat(failure.getStatus().getCode()).isEqualTo(Status.Code.DEADLINE_EXCEEDED));
            assertThat(deadlinePropagated).isTrue();
            long observationLimit = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
            while (!deadlineExpiredOrCancellationObserved.get() && System.nanoTime() < observationLimit) {
                Thread.sleep(5);
            }
            assertThat(deadlineExpiredOrCancellationObserved).isTrue();
        } finally {
            releaseExecutor.countDown();
            caller.join(2_000);
        }
        assertThat(dispatches).hasValue(1);
        assertThat(deadlineExpiredOrCancellationObserved).isTrue();
        assertThat(clientReceivedResponse).isFalse();
    }

    @Test
    void serverOwnedDeadlineReachesStartedWorkerAndReturnsUnknownWithoutClientDeadline() throws Exception {
        CountDownLatch executorEntered = new CountDownLatch(1);
        CountDownLatch workerObservedDeadline = new CountDownLatch(1);
        CountDownLatch releaseExecutor = new CountDownLatch(1);
        CountDownLatch lateExecutorCompletion = new CountDownLatch(1);
        AtomicInteger dispatches = new AtomicInteger();
        AtomicBoolean serverDeadlineInstalled = new AtomicBoolean();
        AtomicBoolean clientReceivedResponse = new AtomicBoolean();
        AtomicReference<Throwable> clientFailure = new AtomicReference<>();
        start(new CanonicalOperationExecutor() {
            @Override public <T> T execute(CanonicalOperationBinding binding, String operationRef,
                                         Callable<T> action) throws Exception {
                throw new UnsupportedOperationException("typed operation required");
            }
            @Override public <T> T execute(CanonicalOperationBinding binding, String operationRef,
                                         CanonicalOperation<T> operation,
                                         AuthenticatedPrincipal authenticated) throws Exception {
                dispatches.incrementAndGet();
                io.grpc.Deadline deadline = Context.current().getDeadline();
                serverDeadlineInstalled.set(deadline != null);
                executorEntered.countDown();
                long limit = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
                while (System.nanoTime() < limit) {
                    deadline = Context.current().getDeadline();
                    if (Context.current().isCancelled() || deadline != null && deadline.isExpired()) {
                        workerObservedDeadline.countDown();
                        break;
                    }
                    try {
                        Thread.sleep(5);
                    } catch (InterruptedException cancellation) {
                        if (Context.current().isCancelled()) {
                            workerObservedDeadline.countDown();
                            break;
                        }
                    }
                }
                awaitIgnoringInterrupts(releaseExecutor);
                try {
                    return operation.fixtureAction().call();
                } finally {
                    lateExecutorCompletion.countDown();
                }
            }
        }, workerPool(1, 1), new RpcDeadlineServerInterceptor(Duration.ofMillis(200), Map.of()));

        Thread caller = Thread.startVirtualThread(() -> {
            try {
                stub().processMultimodal(request());
                clientReceivedResponse.set(true);
            } catch (Throwable failure) {
                clientFailure.set(failure);
            }
        });
        try {
            assertThat(executorEntered.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(workerObservedDeadline.await(2, TimeUnit.SECONDS)).isTrue();
            caller.join(2_000);
            assertThat(caller.isAlive()).isFalse();
            assertThat(clientFailure.get()).isInstanceOfSatisfying(StatusRuntimeException.class, failure -> {
                assertThat(failure.getStatus().getCode()).isEqualTo(Status.Code.UNKNOWN);
                assertThat(failure.getStatus().getDescription()).contains("UNKNOWN_OUTCOME");
            });
            assertThat(serverDeadlineInstalled).isTrue();
            assertThat(clientReceivedResponse).isFalse();
            assertThat(dispatches).hasValue(1);
        } finally {
            releaseExecutor.countDown();
            caller.join(2_000);
        }
        assertThat(lateExecutorCompletion.await(2, TimeUnit.SECONDS)).isTrue();
        assertThat(clientReceivedResponse).isFalse();
    }

    @Test
    void productionServiceDispatchesBlockedCanonicalWorkOffRpcHandlerAndSuppressesLateCompletion()
            throws Exception {
        CountDownLatch executorEntered = new CountDownLatch(1);
        CountDownLatch releaseExecutor = new CountDownLatch(1);
        AtomicInteger dispatches = new AtomicInteger();
        AtomicBoolean clientReceivedResponse = new AtomicBoolean();
        AtomicReference<Throwable> clientFailure = new AtomicReference<>();
        ThreadPoolExecutor workers = workerPool(1, 1);
        start(blockingExecutor(dispatches, executorEntered, releaseExecutor), workers);

        Thread caller = Thread.startVirtualThread(() -> {
            try {
                stub().withDeadlineAfter(150, TimeUnit.MILLISECONDS).processMultimodal(request());
                clientReceivedResponse.set(true);
            } catch (Throwable failure) {
                clientFailure.set(failure);
            }
        });
        try {
            assertThat(executorEntered.await(2, TimeUnit.SECONDS)).isTrue();
            caller.join(2_000);
            assertThat(caller.isAlive()).isFalse();
            assertThat(clientFailure.get()).isInstanceOfSatisfying(StatusRuntimeException.class, failure ->
                    assertThat(failure.getStatus().getCode()).isEqualTo(Status.Code.DEADLINE_EXCEEDED));
        } finally {
            releaseExecutor.countDown();
            caller.join(2_000);
        }
        assertThat(dispatches).hasValue(1);
        assertThat(clientReceivedResponse).isFalse();
    }

    @Test
    void explicitClientCancellationInterruptsWorkerButLateCanonicalCompletionStaysUnknown()
            throws Exception {
        CountDownLatch executorEntered = new CountDownLatch(1);
        CountDownLatch releaseExecutor = new CountDownLatch(1);
        CountDownLatch clientClosed = new CountDownLatch(1);
        AtomicInteger dispatches = new AtomicInteger();
        AtomicInteger clientMessages = new AtomicInteger();
        AtomicReference<Status> clientStatus = new AtomicReference<>();
        ThreadPoolExecutor workers = workerPool(1, 1);
        start(blockingExecutor(dispatches, executorEntered, releaseExecutor), workers);
        ClientCall<MultimodalRequest, com.ghatana.audio.video.multimodal.grpc.proto.MultimodalResponse> call =
                channel.newCall(MultimodalServiceGrpc.getProcessMultimodalMethod(), CallOptions.DEFAULT);
        call.start(new ClientCall.Listener<>() {
            @Override public void onMessage(
                    com.ghatana.audio.video.multimodal.grpc.proto.MultimodalResponse response) {
                clientMessages.incrementAndGet();
            }
            @Override public void onClose(Status status, io.grpc.Metadata trailers) {
                clientStatus.set(status);
                clientClosed.countDown();
            }
        }, new io.grpc.Metadata());
        call.request(1);
        call.sendMessage(request());
        call.halfClose();
        try {
            assertThat(executorEntered.await(2, TimeUnit.SECONDS)).isTrue();
            call.cancel("test cancellation", null);
            assertThat(clientClosed.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(clientStatus.get().getCode()).isEqualTo(Status.Code.CANCELLED);
        } finally {
            releaseExecutor.countDown();
        }
        assertThat(dispatches).hasValue(1);
        assertThat(clientMessages).hasValue(0);
    }

    @Test
    void saturatedCanonicalWorkerQueueRejectsBeforeDispatch() throws Exception {
        CountDownLatch executorEntered = new CountDownLatch(1);
        CountDownLatch releaseExecutor = new CountDownLatch(1);
        AtomicInteger dispatches = new AtomicInteger();
        ThreadPoolExecutor workers = workerPool(1, 1);
        start(blockingExecutor(dispatches, executorEntered, releaseExecutor), workers);

        Thread first = Thread.startVirtualThread(() -> invokeIgnoringFailure(stub(), request()));
        try {
            assertThat(executorEntered.await(2, TimeUnit.SECONDS)).isTrue();
            Thread second = Thread.startVirtualThread(() -> invokeIgnoringFailure(stub(), request()));
            awaitQueueSize((ThreadPoolExecutor) workers, 1);
            assertThatThrownBy(() -> stub().withDeadlineAfter(2, TimeUnit.SECONDS).processMultimodal(request()))
                    .isInstanceOfSatisfying(StatusRuntimeException.class, failure -> {
                        assertThat(failure.getStatus().getCode()).isEqualTo(Status.Code.RESOURCE_EXHAUSTED);
                        assertThat(failure.getStatus().getDescription())
                                .contains("MULTIMODAL_PORT_CAPACITY_UNAVAILABLE");
                    });
            assertThat(dispatches).hasValue(1);
            releaseExecutor.countDown();
            first.join(2_000);
            second.join(2_000);
        } finally {
            releaseExecutor.countDown();
            first.join(2_000);
        }
    }

    private static CanonicalOperationExecutor blockingExecutor(AtomicInteger dispatches,
                                                                 CountDownLatch entered,
                                                                 CountDownLatch release) {
        return new CanonicalOperationExecutor() {
            @Override public <T> T execute(CanonicalOperationBinding binding, String operationRef,
                                         Callable<T> action) throws Exception {
                throw new UnsupportedOperationException("typed operation required");
            }
            @Override public <T> T execute(CanonicalOperationBinding binding, String operationRef,
                                         CanonicalOperation<T> operation,
                                         AuthenticatedPrincipal authenticated) throws Exception {
                dispatches.incrementAndGet();
                entered.countDown();
                awaitIgnoringInterrupts(release);
                return operation.fixtureAction().call();
            }
        };
    }

    private static void invokeIgnoringFailure(MultimodalServiceGrpc.MultimodalServiceBlockingStub stub,
                                              MultimodalRequest request) {
        try {
            stub.withDeadlineAfter(5, TimeUnit.SECONDS).processMultimodal(request);
        } catch (Throwable ignored) {
            // Concurrent requests only occupy bounded worker/queue slots for this saturation fixture.
        }
    }

    private static void awaitQueueSize(ThreadPoolExecutor executor, int size) throws InterruptedException {
        long limit = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (executor.getQueue().size() < size && System.nanoTime() < limit) Thread.sleep(5);
        assertThat(executor.getQueue()).hasSize(size);
    }

    private static ThreadPoolExecutor workerPool(int workers, int queueCapacity) {
        return new ThreadPoolExecutor(workers, workers, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(queueCapacity), task -> {
                    Thread thread = new Thread(task, "test-multimodal-worker");
                    thread.setDaemon(true);
                    return thread;
                }, new ThreadPoolExecutor.AbortPolicy());
    }

    private static void awaitIgnoringInterrupts(CountDownLatch latch) {
        boolean interrupted = false;
        while (true) {
            try {
                latch.await();
                break;
            } catch (InterruptedException ignored) {
                interrupted = true;
            }
        }
        if (interrupted) Thread.currentThread().interrupt();
    }

    // ── Harness ─────────────────────────────────────────────────────────────

    private void start(CanonicalOperationExecutor executor) throws Exception {
        start(executor, workerPool(2, 4));
    }

    private void start(CanonicalOperationExecutor executor, Executor workers) throws Exception {
        start(executor, workers, new ServerInterceptor[0]);
    }

    private void start(CanonicalOperationExecutor executor, Executor workers,
                       ServerInterceptor... additionalInterceptors) throws Exception {
        var engine = mock(MultimodalAnalysisEngine.class);
        var adapter = mock(PlatformMultimodalAdapter.class);
        service = new MultimodalGrpcService(engine, adapter, MediaProcessingMetrics.noop(),
                request -> SourceAuthorization.Decision.ADMITTED,
                new AudioVideoTracingService(io.opentelemetry.api.GlobalOpenTelemetry
                        .getTracer("multimodal-test")), executor, workers);
        if (workers instanceof ExecutorService executorService) testWorkers = executorService;
        ServerBuilder<?> serverBuilder = ServerBuilder.forPort(0).intercept(new TenantInjector());
        for (ServerInterceptor interceptor : additionalInterceptors) serverBuilder.intercept(interceptor);
        server = serverBuilder.addService(service).build().start();
        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort())
                .usePlaintext()
                .build();
    }

    private MultimodalServiceGrpc.MultimodalServiceBlockingStub stub() {
        return MultimodalServiceGrpc.newBlockingStub(channel);
    }

    private static MultimodalRequest request() {
        return MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1}))
                .setOperationBinding(CanonicalOperationBinding.newBuilder()
                        .setOperationVersion(1)
                        .setCapabilityRef("media.multimodal.observe.source-grounded")
                        .setOperationRef("media.operation.capability.media-multimodal-observe-source-grounded")
                        .setRequestId("req-finality-1")
                        .setSourceArtifactId("src")
                        .setSourceVersionId("v1")
                        .setPurpose("observe")
                        .build())
                .build();
    }

    private static CanonicalOperationExecutor executorThrowing(Exception failure) {
        return new CanonicalOperationExecutor() {
            @Override public <T> T execute(CanonicalOperationBinding binding, String operationRef,
                                         Callable<T> action) throws Exception {
                throw failure;
            }
            @Override public <T> T execute(CanonicalOperationBinding binding, String operationRef,
                                         CanonicalOperation<T> operation,
                                         AuthenticatedPrincipal authenticated) throws Exception {
                throw failure;
            }
        };
    }

    private static CanonicalOperationExecutor executorFusing(JobStatus status, String failureCode) {
        return new CanonicalOperationExecutor() {
            @Override public <T> T execute(CanonicalOperationBinding binding, String operationRef,
                                         Callable<T> action) throws Exception {
                throw new UnsupportedOperationException();
            }
            @Override public <T> T execute(CanonicalOperationBinding binding, String operationRef,
                                         CanonicalOperation<T> operation,
                                         AuthenticatedPrincipal authenticated) throws Exception {
                return operation.fuse(status == JobStatus.CANCELLED
                        ? new CanonicalOperationOutcome("job-7", JobStatus.CANCELLED, Map.of(), "")
                        : CanonicalOperationOutcome.failed("job-7", failureCode));
            }
        };
    }

    private static final class TenantInjector implements ServerInterceptor {
        @Override public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
                ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {
            Context ctx = Context.current().withValue(JwtServerInterceptor.CTX_TENANT, "tenant-a")
                    .withValue(JwtServerInterceptor.CTX_SUBJECT,
                            "d7fe98ce-75d3-4a2a-8a04-bb54e23a2f15");
            return Contexts.interceptCall(ctx, call, headers, next);
        }
    }
}
