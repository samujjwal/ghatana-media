package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaSourceRightsAdministrationTest {
    private static final String DIGEST = "a".repeat(64);

    @Test
    void registrationDoesNotNormalizeIdentityOrAuthorityReferences() {
        assertThatThrownBy(() -> request("\u00a0tenant-a", "principal-a", "owner-a",
                MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                "", "provenance://source/1"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("tenantId");
        assertThatThrownBy(() -> request("tenant-a", "principal-a", "owner-a ",
                MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                "", "provenance://source/1"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sourceOwnerId");
        assertThatThrownBy(() -> request("tenant-a", "principal-a", "owner-a",
                MediaSourceAuthorizationContracts.SourceKind.HUMAN_RECORDING,
                MediaSourceAuthorizationContracts.HumanConsentDisposition.REQUIRED,
                "consent-ref\u00a0", "provenance://source/1"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("consentDecisionId");
    }

    private static MediaSourceRightsAdministration.RegisterRequest request(
            String tenant, String principal, String owner,
            MediaSourceAuthorizationContracts.SourceKind kind,
            MediaSourceAuthorizationContracts.HumanConsentDisposition consentDisposition,
            String consentId, String provenanceRef) {
        return new MediaSourceRightsAdministration.RegisterRequest(
                tenant, principal, "artifact-a", "sha256:" + DIGEST, DIGEST, owner, kind,
                consentDisposition, consentId, Set.of("speech_to_text"), Set.of("transcription"),
                Set.of("local"), Set.of(ProviderDataRetention.NONE), "clock-evidence", provenanceRef,
                Instant.now().plusSeconds(300), "correlation-a");
    }
}
