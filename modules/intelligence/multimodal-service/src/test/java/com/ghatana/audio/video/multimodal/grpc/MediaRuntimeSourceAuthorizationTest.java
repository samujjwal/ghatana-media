package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * W2-R01: the production gRPC source-authorization seam maps the canonical runtime
 * authority decision exactly and never manufactures an admission.
 */
class MediaRuntimeSourceAuthorizationTest {

    private static final String SHA_A = "a".repeat(64);
    private static final String SHA_B = "b".repeat(64);
    private static final UUID PRINCIPAL =
            UUID.fromString("2f3b6bd3-4bf7-4f06-9f9a-45ea8b8f11cc");

    @Test
    void allowedAuthorityDecisionAdmitsTheOperation() {
        var port = new ProbePort(allowedDecision());
        var authorization = new MediaRuntimeSourceAuthorization(port);
        assertThat(authorization.authorize(request())).isEqualTo(SourceAuthorization.Decision.ADMITTED);
        assertThat(port.resolutions.get()).isEqualTo(1);
        assertThat(port.lastJobType).isEqualTo(JobType.MULTIMODAL);
        assertThat(port.lastArtifactId).isEqualTo("src-artifact-1");
        assertThat(port.lastVersion.value()).isEqualTo("sha256:" + SHA_A);
        assertThat(port.lastPrincipal).isEqualTo(PRINCIPAL.toString());
    }

    @Test
    void deniedRevokedAndStaleAuthorityDecisionsDenyTheOperation() {
        for (var status : List.of(MediaSourceAuthorizationContracts.Status.DENIED,
                MediaSourceAuthorizationContracts.Status.REVOKED,
                MediaSourceAuthorizationContracts.Status.STALE)) {
            var port = new ProbePort(decision(status));
            var authorization = new MediaRuntimeSourceAuthorization(port);
            assertThat(authorization.authorize(request()))
                    .as("status %s", status)
                    .isEqualTo(SourceAuthorization.Decision.DENIED);
        }
    }

    @Test
    void unavailableMissingOrFailingAuthorityStaysNotAdmitted() {
        var unavailable = new MediaRuntimeSourceAuthorization(
                new ProbePort(decision(MediaSourceAuthorizationContracts.Status.UNAVAILABLE)));
        assertThat(unavailable.authorize(request())).isEqualTo(SourceAuthorization.Decision.NOT_ADMITTED);

        var nullDecision = new MediaRuntimeSourceAuthorization(new ProbePort(null));
        assertThat(nullDecision.authorize(request())).isEqualTo(SourceAuthorization.Decision.NOT_ADMITTED);

        var throwing = new MediaRuntimeSourceAuthorization(new ProbePort(
                decision(MediaSourceAuthorizationContracts.Status.UNAVAILABLE)) {
            @Override public MediaSourceAuthorizationContracts.Decision resolveSourceAuthorization(
                    String tenantId, String principalId, String artifactId,
                    ArtifactVersion sourceVersion, JobType jobType, String purpose,
                    AuthenticatedPrincipal authenticated) {
                throw new IllegalStateException("authority backend unreachable");
            }
        });
        assertThat(throwing.authorize(request())).isEqualTo(SourceAuthorization.Decision.NOT_ADMITTED);
    }

    @Test
    void malformedSourceVersionIsDeniedWithoutTouchingTheRuntime() {
        var port = new ProbePort(allowedDecision());
        var authorization = new MediaRuntimeSourceAuthorization(port);
        var malformed = new SourceAuthorization.AuthorizationRequest(
                "tenant-a", PRINCIPAL, Set.of(SourceAuthorization.Modality.AUDIO),
                "media.multimodal.observe.source-grounded",
                "media.operation.capability.media-multimodal-observe-source-grounded",
                1, "req-1", "src-artifact-1", "v1", "mm-observe", "",
                List.of(), null, 4, SHA_B);
        assertThat(authorization.authorize(malformed)).isEqualTo(SourceAuthorization.Decision.DENIED);
        assertThat(port.resolutions.get()).isZero();
    }

    private static SourceAuthorization.AuthorizationRequest request() {
        return new SourceAuthorization.AuthorizationRequest(
                "tenant-a", PRINCIPAL, Set.of(SourceAuthorization.Modality.AUDIO),
                "media.multimodal.observe.source-grounded",
                "media.operation.capability.media-multimodal-observe-source-grounded",
                1, "req-1", "src-artifact-1", "sha256:" + SHA_A, "mm-observe", "",
                List.of(), null, 4, SHA_B);
    }

    private static MediaSourceAuthorizationContracts.Decision decision(
            MediaSourceAuthorizationContracts.Status status) {
        return new MediaSourceAuthorizationContracts.Decision(status, null);
    }

    /** Valid ALLOWED evidence; the contract refuses ALLOWED without real evidence. */
    private static MediaSourceAuthorizationContracts.Decision allowedDecision() {
        java.time.Instant now = java.time.Instant.now();
        var version = new ArtifactVersion("sha256:" + SHA_A);
        var evidence = new MediaSourceAuthorizationContracts.Evidence(
                "fixture-authority", "decision-1", "tenant-a", PRINCIPAL.toString(),
                "owner-1", "src-artifact-1", version, SHA_A,
                "multimodal", "mm-observe", "media-multimodal-delegating",
                "multimodal-delegating-v1",
                com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary.LOCAL,
                "local", com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE,
                Set.of("multimodal"), Set.of("local"),
                Set.of(com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE),
                "rights-1", "policy-1", "policy-v1",
                MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                "", "fixture-clock", 0, now.minusSeconds(1), now.plusSeconds(300));
        return new MediaSourceAuthorizationContracts.Decision(
                MediaSourceAuthorizationContracts.Status.ALLOWED, evidence);
    }

    /** Fail-closed fake port recording the authorization probe calls. */
    static class ProbePort implements MediaProcessingRuntimePort {
        final AtomicInteger resolutions = new AtomicInteger();
        final AtomicInteger submissions = new AtomicInteger();
        private final MediaSourceAuthorizationContracts.Decision decision;
        String lastArtifactId;
        String lastPrincipal;
        ArtifactVersion lastVersion;
        JobType lastJobType;

        ProbePort(MediaSourceAuthorizationContracts.Decision decision) {
            this.decision = decision;
        }

        @Override public ProcessingJob submit(ProcessingJobRequest request) {
            submissions.incrementAndGet();
            throw new UnsupportedOperationException("no jobs in authorization probe test");
        }

        @Override public Optional<ProcessingJob> job(String tenantId, String principalId, String jobId) {
            return Optional.empty();
        }

        @Override public Optional<MediaArtifact> artifact(String tenantId, String principalId, String artifactId) {
            return Optional.empty();
        }

        @Override public boolean processingReady(JobType jobType) {
            return false;
        }

        @Override public MediaSourceAuthorizationContracts.Decision resolveSourceAuthorization(
                String tenantId, String principalId, String artifactId,
                ArtifactVersion sourceVersion, JobType jobType, String purpose,
                AuthenticatedPrincipal authenticated) {
            resolutions.incrementAndGet();
            lastArtifactId = artifactId;
            lastPrincipal = principalId;
            lastVersion = sourceVersion;
            lastJobType = jobType;
            return decision;
        }
    }
}
