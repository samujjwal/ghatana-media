package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
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
import java.util.concurrent.Callable;
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

    @AfterEach
    void tearDown() {
        if (channel != null) channel.shutdownNow();
        if (server != null) server.shutdownNow();
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
                awaitIgnoringInterrupts(releaseExecutor);
                io.grpc.Deadline deadline = Context.current().getDeadline();
                deadlineExpiredOrCancellationObserved.set(Context.current().isCancelled()
                        || deadline != null && deadline.isExpired());
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
        } finally {
            releaseExecutor.countDown();
            caller.join(2_000);
        }
        assertThat(dispatches).hasValue(1);
        assertThat(deadlineExpiredOrCancellationObserved).isTrue();
        assertThat(clientReceivedResponse).isFalse();
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
        var engine = mock(MultimodalAnalysisEngine.class);
        var adapter = mock(PlatformMultimodalAdapter.class);
        var service = new MultimodalGrpcService(engine, adapter, MediaProcessingMetrics.noop(),
                request -> SourceAuthorization.Decision.ADMITTED, executor);
        server = ServerBuilder.forPort(0)
                .directExecutor()
                .intercept(new TenantInjector())
                .addService(service)
                .build()
                .start();
        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort())
                .usePlaintext()
                .directExecutor()
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
