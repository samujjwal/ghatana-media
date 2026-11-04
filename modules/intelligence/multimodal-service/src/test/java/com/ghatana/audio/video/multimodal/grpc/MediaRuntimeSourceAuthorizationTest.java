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

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * W2-R01: the production gRPC source-authorization seam maps the canonical runtime
 * authority decision exactly and never manufactures an admission.
 */
class MediaRuntimeSourceAuthorizationTest {

    private static final byte[] SOURCE_BYTES = new byte[] {1, 2, 3, 4};
    private static final String SHA_A = sha256(SOURCE_BYTES);
    private static final String SHA_B = "b".repeat(64);
    private static final UUID PRINCIPAL =
            UUID.fromString("2f3b6bd3-4bf7-4f06-9f9a-45ea8b8f11cc");

    @Test
    void allowedAuthorityDecisionAdmitsTheOperation() {
        var port = new ProbePort(jobType -> allowedDecision(jobType));
        var authorization = new MediaRuntimeSourceAuthorization(port);
        assertThat(authorization.authorize(request())).isEqualTo(SourceAuthorization.Decision.ADMITTED);
        assertThat(port.resolutions.get()).isEqualTo(2);
        assertThat(port.jobTypes).containsExactly(JobType.MULTIMODAL, JobType.SPEECH_TO_TEXT);
        assertThat(port.lastArtifactId).isEqualTo("src-artifact-1");
        assertThat(port.lastVersion.value()).isEqualTo("sha256:" + SHA_A);
        assertThat(port.lastPrincipal).isEqualTo(PRINCIPAL.toString());
    }

    @Test
    void childProviderDenialPreventsAdmissionAfterParentRightsAllow() {
        var port = new ProbePort(jobType -> jobType == JobType.MULTIMODAL
                ? allowedDecision(jobType)
                : decision(MediaSourceAuthorizationContracts.Status.REVOKED));
        var authorization = new MediaRuntimeSourceAuthorization(port);

        assertThat(authorization.authorize(request())).isEqualTo(SourceAuthorization.Decision.DENIED);
        assertThat(port.jobTypes).containsExactly(JobType.MULTIMODAL, JobType.SPEECH_TO_TEXT);
        assertThat(port.submissions.get()).isZero();
    }

    @Test
    void changedPayloadDigestIsDeniedBeforeRuntimeProbe() {
        var port = new ProbePort(allowedDecision(JobType.MULTIMODAL));
        var authorization = new MediaRuntimeSourceAuthorization(port);
        var changed = new SourceAuthorization.AuthorizationRequest(
                "tenant-a", PRINCIPAL, Set.of(SourceAuthorization.Modality.AUDIO),
                "media.multimodal.observe.source-grounded",
                "media.operation.capability.media-multimodal-observe-source-grounded",
                1, "req-1", "src-artifact-1", "sha256:" + SHA_A, "mm-observe", "",
                List.of(), null, SOURCE_BYTES.length, SHA_B);

        assertThat(authorization.authorize(changed)).isEqualTo(SourceAuthorization.Decision.DENIED);
        assertThat(port.resolutions.get()).isZero();
    }

    @Test
    void compositeModalityRequestIsNotAdmittedBySingleArtifactProbe() {
        var port = new ProbePort(allowedDecision(JobType.MULTIMODAL));
        var authorization = new MediaRuntimeSourceAuthorization(port);
        var composite = new SourceAuthorization.AuthorizationRequest(
                "tenant-a", PRINCIPAL, Set.of(SourceAuthorization.Modality.AUDIO, SourceAuthorization.Modality.VIDEO),
                "media.multimodal.observe.source-grounded",
                "media.operation.capability.media-multimodal-observe-source-grounded",
                1, "req-1", "src-artifact-1", "sha256:" + SHA_A, "mm-observe", "",
                List.of(), null, SOURCE_BYTES.length, SHA_A);

        assertThat(authorization.authorize(composite)).isEqualTo(SourceAuthorization.Decision.NOT_ADMITTED);
        assertThat(port.resolutions.get()).isZero();
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

        var nullDecision = new MediaRuntimeSourceAuthorization(new ProbePort(jobType -> null));
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
        var port = new ProbePort(allowedDecision(JobType.MULTIMODAL));
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
                List.of(), null, SOURCE_BYTES.length, SHA_A);
    }

    private static String sha256(byte[] bytes) {
        try {
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
    }

    private static MediaSourceAuthorizationContracts.Decision decision(
            MediaSourceAuthorizationContracts.Status status) {
        return new MediaSourceAuthorizationContracts.Decision(status, null);
    }

    /** Valid ALLOWED evidence; the contract refuses ALLOWED without real evidence. */
    private static MediaSourceAuthorizationContracts.Decision allowedDecision(JobType jobType) {
        java.time.Instant now = java.time.Instant.now();
        var version = new ArtifactVersion("sha256:" + SHA_A);
        var evidence = new MediaSourceAuthorizationContracts.Evidence(
                "fixture-authority", "decision-1", "tenant-a", PRINCIPAL.toString(),
                "owner-1", "src-artifact-1", version, SHA_A,
                jobType.name(), "mm-observe", "media-multimodal-delegating",
                "multimodal-delegating-v1",
                com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary.LOCAL,
                "local", com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE,
                Set.of(jobType.name()), Set.of("local"),
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
        private final Function<JobType, MediaSourceAuthorizationContracts.Decision> decisions;
        final List<JobType> jobTypes = new ArrayList<>();
        String lastArtifactId;
        String lastPrincipal;
        ArtifactVersion lastVersion;
        JobType lastJobType;

        ProbePort(MediaSourceAuthorizationContracts.Decision decision) {
            this(jobType -> decision);
        }

        ProbePort(Function<JobType, MediaSourceAuthorizationContracts.Decision> decisions) {
            this.decisions = decisions;
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
            jobTypes.add(jobType);
            lastArtifactId = artifactId;
            lastPrincipal = principalId;
            lastVersion = sourceVersion;
            lastJobType = jobType;
            return decisions.apply(jobType);
        }
    }
}
