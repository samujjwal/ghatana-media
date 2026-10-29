package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaSourceAuthorizationContractsTest {
    private static final String DIGEST = "a".repeat(64);

    @Test
    void evidenceMatchesOnlyTheExactTenantSourcePurposeAndProviderRequest() {
        var request = request();
        var evidence = evidence(request);

        assertThat(evidence.matches(request)).isTrue();
        assertThat(evidence.matches(new MediaSourceAuthorizationContracts.Request(
                request.tenantId(), request.principalId(), request.artifactId(), request.sourceVersion(),
                request.sourceSha256(), request.operation(), "model-training", request.providerId(),
                request.providerVersion(), request.processingBoundary(), request.processingRegion(),
                request.providerRetention()))).isFalse();
        assertThat(evidence.currentAt(Clock.fixed(Instant.parse("2026-10-28T12:00:00Z"), ZoneOffset.UTC)))
                .isTrue();
    }

    @Test
    void unknownSourceCannotBeTurnedIntoAnAllowedDecision() {
        var request = request();
        assertThatThrownBy(() -> new MediaSourceAuthorizationContracts.Evidence(
                "authority", "decision", request.tenantId(), request.principalId(), "owner",
                request.artifactId(), request.sourceVersion(), request.sourceSha256(), request.operation(),
                request.purpose(), request.providerId(), request.providerVersion(), request.processingBoundary(),
                request.processingRegion(), request.providerRetention(), Set.of("speech_to_text"), Set.of("us"),
                Set.of(ProviderDataRetention.NONE), "rights", "policy", "policy-v1",
                MediaSourceAuthorizationContracts.SourceKind.UNKNOWN,
                MediaSourceAuthorizationContracts.HumanConsentDisposition.UNRESOLVED,
                "", "clock-evidence", 0, Instant.parse("2026-10-28T11:59:00Z"),
                Instant.parse("2026-10-28T12:01:00Z")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unknown source kind");
    }

    @Test
    void authenticatedPrincipalRequiresBoundedIdentityAndVerificationTime() {
        var authenticated = new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                "tenant-a", "principal-a", Instant.parse("2026-10-28T12:00:00Z"));
        assertThat(authenticated.tenantId()).isEqualTo("tenant-a");
        assertThat(authenticated.principalId()).isEqualTo("principal-a");
        assertThatThrownBy(() -> new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                " ", "principal-a", Instant.now()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                "tenant-a", null, Instant.now()))
                .isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                "tenant-a", "principal-a", null))
                .isInstanceOf(NullPointerException.class);
    }

    @Test
    void decisionStatusAndEvidenceCannotContradictEachOther() {
        assertThatThrownBy(() -> new MediaSourceAuthorizationContracts.Decision(
                MediaSourceAuthorizationContracts.Status.ALLOWED, null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaSourceAuthorizationContracts.Decision(
                MediaSourceAuthorizationContracts.Status.DENIED, evidence(request())))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static MediaSourceAuthorizationContracts.Request request() {
        return new MediaSourceAuthorizationContracts.Request(
                "tenant-a", "principal-a", "artifact-a", ArtifactVersion.fromSha256(DIGEST), DIGEST,
                "SPEECH_TO_TEXT", "speech-transcription", "provider-a", "v1",
                ProcessingBoundary.LOCAL, "us", ProviderDataRetention.NONE);
    }

    private static MediaSourceAuthorizationContracts.Evidence evidence(
            MediaSourceAuthorizationContracts.Request request) {
        Instant verified = Instant.parse("2026-10-28T11:59:00Z");
        return new MediaSourceAuthorizationContracts.Evidence(
                "authority", "decision", request.tenantId(), request.principalId(), "owner",
                request.artifactId(), request.sourceVersion(), request.sourceSha256(), request.operation(),
                request.purpose(), request.providerId(), request.providerVersion(), request.processingBoundary(),
                request.processingRegion(), request.providerRetention(), Set.of("speech_to_text"), Set.of("us"),
                Set.of(ProviderDataRetention.NONE), "rights", "policy", "policy-v1",
                MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                "", "clock-evidence", 7, verified, verified.plusSeconds(120));
    }
}
