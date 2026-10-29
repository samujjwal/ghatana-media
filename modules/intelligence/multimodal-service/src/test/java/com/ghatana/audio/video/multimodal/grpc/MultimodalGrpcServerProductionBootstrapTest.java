package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalRequest;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceGrpc;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
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
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * W2-R01 standalone bootstrap: the production composition wires real readiness and
 * source authority through the server entrypoint and fails closed without them.
 */
class MultimodalGrpcServerProductionBootstrapTest {

    private Server server;
    private ManagedChannel channel;

    @AfterEach
    void tearDown() {
        if (channel != null) channel.shutdownNow();
        if (server != null) server.shutdownNow();
    }

    @Test
    void absentRuntimeFactoryLeavesThePortUncomposed() {
        // The modality module must not depend on the launcher runtime; without an
        // installed MediaRuntimePortFactory the server stays fail-closed.
        assertThat(MultimodalGrpcServer.composeRuntimePort(Map.of())).isNull();
    }

    @Test
    void childReadinessFollowsComposedRuntimeTruthfully() {
        var port = new BootstrapPort();
        port.readiness.put(JobType.SPEECH_TO_TEXT, true);
        var service = new MultimodalGrpcService(
                MediaProcessingMetrics.noop(), new MediaRuntimeSourceAuthorization(port), port);
        assertThat(service.isSttProviderReady()).isTrue();
        assertThat(service.isVisionProviderReady()).isFalse();

        port.readiness.put(JobType.VISION, true);
        assertThat(service.isVisionProviderReady()).isTrue();

        var detached = new MultimodalGrpcService(
                MediaProcessingMetrics.noop(), SourceAuthorization.unavailable(),
                (MediaProcessingRuntimePort) null);
        assertThat(detached.isSttProviderReady()).isFalse();
        assertThat(detached.isVisionProviderReady()).isFalse();
    }

    @Test
    void deniedSourceRightsRejectBeforeAnyRuntimeEffect() throws Exception {
        var port = new BootstrapPort();
        port.decision = new MediaSourceAuthorizationContracts.Decision(
                MediaSourceAuthorizationContracts.Status.DENIED, null);
        startServer(port);

        assertThatThrownBy(() -> stub().processMultimodal(validRequest("sha256:" + "a".repeat(64))))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(error -> assertThat(((StatusRuntimeException) error).getStatus().getCode())
                        .isEqualTo(Status.Code.PERMISSION_DENIED));
        assertThat(port.submissions.get()).isZero();
    }

    @Test
    void revokedSourceRightsRejectBeforeAnyRuntimeEffect() throws Exception {
        var port = new BootstrapPort();
        port.decision = new MediaSourceAuthorizationContracts.Decision(
                MediaSourceAuthorizationContracts.Status.REVOKED, null);
        startServer(port);

        assertThatThrownBy(() -> stub().processMultimodal(validRequest("sha256:" + "a".repeat(64))))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(error -> assertThat(((StatusRuntimeException) error).getStatus().getCode())
                        .isEqualTo(Status.Code.PERMISSION_DENIED));
        assertThat(port.submissions.get()).isZero();
    }

    @Test
    void unavailableAuthoritySurfacesUnavailableWithoutEffects() throws Exception {
        var port = new BootstrapPort();
        port.decision = new MediaSourceAuthorizationContracts.Decision(
                MediaSourceAuthorizationContracts.Status.UNAVAILABLE, null);
        startServer(port);

        assertThatThrownBy(() -> stub().processMultimodal(validRequest("sha256:" + "a".repeat(64))))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(error -> assertThat(((StatusRuntimeException) error).getStatus().getCode())
                        .isEqualTo(Status.Code.UNAVAILABLE));
        assertThat(port.submissions.get()).isZero();
    }

    @Test
    void malformedSourceVersionDeniedBeforeResolution() throws Exception {
        var port = new BootstrapPort();
        port.decision = new MediaSourceAuthorizationContracts.Decision(
                MediaSourceAuthorizationContracts.Status.DENIED, null);
        startServer(port);

        assertThatThrownBy(() -> stub().processMultimodal(validRequest("v1")))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(error -> assertThat(((StatusRuntimeException) error).getStatus().getCode())
                        .isEqualTo(Status.Code.PERMISSION_DENIED));
        assertThat(port.resolutions.get()).isZero();
        assertThat(port.submissions.get()).isZero();
    }

    @Test
    void unauthenticatedCallerIsRejectedBeforeAuthorization() throws Exception {
        var port = new BootstrapPort();
        port.decision = new MediaSourceAuthorizationContracts.Decision(
                MediaSourceAuthorizationContracts.Status.DENIED, null);
        // No tenant injector: the verified identity never reaches the RPC.
        server = ServerBuilder.forPort(0).directExecutor()
                .addService(new MultimodalGrpcService(
                        MediaProcessingMetrics.noop(), new MediaRuntimeSourceAuthorization(port), port))
                .build().start();
        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort())
                .usePlaintext().directExecutor().build();

        assertThatThrownBy(() -> stub().processMultimodal(validRequest("sha256:" + "a".repeat(64))))
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(error -> assertThat(((StatusRuntimeException) error).getStatus().getCode())
                        .isEqualTo(Status.Code.UNAUTHENTICATED));
        assertThat(port.resolutions.get()).isZero();
        assertThat(port.submissions.get()).isZero();
    }

    // ── Fixtures ────────────────────────────────────────────────────────────

    private void startServer(BootstrapPort port) throws Exception {
        var service = new MultimodalGrpcService(
                MediaProcessingMetrics.noop(), new MediaRuntimeSourceAuthorization(port), port);
        server = ServerBuilder.forPort(0).directExecutor()
                .intercept(new TenantInjector())
                .addService(service)
                .build().start();
        channel = ManagedChannelBuilder.forAddress("localhost", server.getPort())
                .usePlaintext().directExecutor().build();
    }

    private MultimodalServiceGrpc.MultimodalServiceBlockingStub stub() {
        return MultimodalServiceGrpc.newBlockingStub(channel);
    }

    private static MultimodalRequest validRequest(String sourceVersion) {
        return MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {0x01, 0x02}))
                .setOperationBinding(CanonicalOperationBinding.newBuilder()
                        .setCapabilityRef("media.multimodal.observe.source-grounded")
                        .setOperationRef("media.operation.capability.media-multimodal-observe-source-grounded")
                        .setOperationVersion(1)
                        .setRequestId("req-bootstrap-1")
                        .setSourceArtifactId("src-artifact-1")
                        .setSourceVersionId(sourceVersion)
                        .setPurpose("mm-observe")
                        .build())
                .build();
    }

    private static final class TenantInjector implements ServerInterceptor {
        @Override
        public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
                ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {
            Context ctx = Context.current()
                    .withValue(JwtServerInterceptor.CTX_TENANT, "tenant-a")
                    .withValue(JwtServerInterceptor.CTX_SUBJECT,
                            "2f3b6bd3-4bf7-4f06-9f9a-45ea8b8f11cc");
            return Contexts.interceptCall(ctx, call, headers, next);
        }
    }

    /** Fail-closed fake port with configurable readiness and authority decision. */
    private static final class BootstrapPort implements MediaProcessingRuntimePort {
        final Map<JobType, Boolean> readiness = new ConcurrentHashMap<>();
        final AtomicInteger resolutions = new AtomicInteger();
        final AtomicInteger submissions = new AtomicInteger();
        MediaSourceAuthorizationContracts.Decision decision =
                new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.UNAVAILABLE, null);

        @Override public com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob submit(
                com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest request) {
            submissions.incrementAndGet();
            throw new UnsupportedOperationException("no jobs in bootstrap test");
        }

        @Override public java.util.Optional<com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob>
                job(String tenantId, String principalId, String jobId) {
            return java.util.Optional.empty();
        }

        @Override public java.util.Optional<com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact>
                artifact(String tenantId, String principalId, String artifactId) {
            return java.util.Optional.empty();
        }

        @Override public boolean processingReady(JobType jobType) {
            return readiness.getOrDefault(jobType, false);
        }

        @Override public MediaSourceAuthorizationContracts.Decision resolveSourceAuthorization(
                String tenantId, String principalId, String artifactId,
                ArtifactVersion sourceVersion, JobType jobType, String purpose,
                AuthenticatedPrincipal authenticated) {
            resolutions.incrementAndGet();
            return decision;
        }
    }
}
