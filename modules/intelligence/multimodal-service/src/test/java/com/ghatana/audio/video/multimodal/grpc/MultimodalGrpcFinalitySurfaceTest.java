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
