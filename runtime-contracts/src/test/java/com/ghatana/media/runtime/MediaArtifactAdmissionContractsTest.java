package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanVerdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.QuarantinedArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptQuery;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

class MediaArtifactAdmissionContractsTest {
    private static final String SHA = "a".repeat(64);

    @Test
    void scanDecisionMustMatchExactQuarantineIdentityAndRemainCurrent() {
        Instant now = Instant.parse("2026-10-12T12:00:00Z");
        var quarantined = new QuarantinedArtifact(
                "tenant-a", "principal-a", "upload-a", SHA, 42, "video/mp4", "quarantine://object-a");
        var decision = new ArtifactScanDecision(
                "scanner", "scanner-v2", "policy", "policy-v3", "tenant-a", "principal-a",
                "upload-a", SHA, 42, "video/mp4", ArtifactScanVerdict.CLEAN,
                now.minusSeconds(1), now.plusSeconds(60));

        assertThat(decision.matches(quarantined, now)).isTrue();
        assertThat(decision.matches(quarantined, now.plusSeconds(60))).isFalse();
        assertThat(decision.matches(new QuarantinedArtifact(
                "tenant-b", "principal-a", "upload-a", SHA, 42, "video/mp4", "quarantine://object-a"), now))
                .isFalse();
        assertThat(decision.verdict()).isEqualTo(ArtifactScanVerdict.CLEAN);
    }

    @Test
    void typedCapabilityRefusalHasStableMachineReadableReason() {
        var unavailable = new MediaCapabilityNotAdmittedException(
                MediaCapabilityNotAdmittedException.Reason.PROVIDER_UNAVAILABLE, "VISION");

        assertThat(unavailable.reason()).isEqualTo(MediaCapabilityNotAdmittedException.Reason.PROVIDER_UNAVAILABLE);
        assertThat(unavailable.modality()).isEqualTo("VISION");
        assertThat(unavailable.getMessage()).doesNotContain("provider endpoint", "credential");
    }

    @Test
    void providerObservationCannotBeDetachedFromExactReceiptIdentity() {
        var query = new ProviderAttemptQuery(
                "tenant-a", "job-a", "request-a", 1, 7, SHA,
                "provider-a", "operation-a", "receipt-a");
        var exact = new ProviderAttemptObservation(
                query, AttemptFinality.UNKNOWN, "receipt-a", java.util.Map.of(), "", Instant.now());

        assertThat(exact.query()).isEqualTo(query);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new ProviderAttemptObservation(
                query, AttemptFinality.UNKNOWN, "receipt-other", java.util.Map.of(), "", Instant.now()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void providerNoEffectFinalityRequiresExactReceiptAndProvenanceEvidence() {
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new ProviderSubmission(
                AttemptFinality.NO_EFFECT_PROVEN, "", "", java.util.Map.of(), "", Instant.now()))
                .isInstanceOf(IllegalArgumentException.class);
        var proved = new ProviderSubmission(AttemptFinality.NO_EFFECT_PROVEN,
                "operation-a", "receipt-a", java.util.Map.of(), SHA, Instant.now());
        assertThat(proved.finality()).isEqualTo(AttemptFinality.NO_EFFECT_PROVEN);
    }
}
