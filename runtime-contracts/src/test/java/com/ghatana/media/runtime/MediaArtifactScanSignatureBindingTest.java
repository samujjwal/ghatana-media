package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanVerdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.QuarantinedArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ScanAttestationBinding;
import com.ghatana.media.runtime.MediaRuntimeContracts.ScanAttestationVerifier;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** MED-06: additive signature binding; unsigned or unverified decisions are never signed-admitted. */
class MediaArtifactScanSignatureBindingTest {
    private static final String SHA = "a".repeat(64);
    private static final Instant NOW = Instant.parse("2026-11-12T12:00:00Z");
    private static final QuarantinedArtifact ARTIFACT = new QuarantinedArtifact(
            "tenant-a", "principal-a", "upload-a", SHA, 42, "video/mp4", "quarantine://object-a");
    private static final ScanAttestationBinding BINDING =
            new ScanAttestationBinding("att-1", "Ed25519", "key-1", "c2lnbmF0dXJl", "b".repeat(64));

    private static ArtifactScanDecision decision(ArtifactScanVerdict verdict) {
        return new ArtifactScanDecision("scanner", "v1", "policy", "p1", "tenant-a", "principal-a", "upload-a",
                SHA, 42, "video/mp4", verdict, NOW.minusSeconds(5), NOW.plusSeconds(60));
    }

    private static final ScanAttestationVerifier ACCEPT = (d, b, now) -> true;

    @Test
    void legacyConstructorYieldsUnsignedDecisionThatIsNeverSignedAdmitted() {
        var unsigned = decision(ArtifactScanVerdict.CLEAN);
        assertThat(unsigned.attestation()).isNull();
        assertThat(ArtifactScanDecision.admitsRelease(unsigned, ARTIFACT, NOW)).isTrue(); // legacy gate unchanged
        assertThat(ArtifactScanDecision.admitsSignedRelease(unsigned, ARTIFACT, NOW, ACCEPT)).isFalse();
    }

    @Test
    void signedCleanDecisionIsAdmittedOnlyWhenInjectedVerifierAffirms() {
        var signed = decision(ArtifactScanVerdict.CLEAN).withAttestation(BINDING);
        assertThat(ArtifactScanDecision.admitsSignedRelease(signed, ARTIFACT, NOW, ACCEPT)).isTrue();
        assertThat(ArtifactScanDecision.admitsSignedRelease(signed, ARTIFACT, NOW, (d, b, n) -> false)).isFalse();
        assertThat(ArtifactScanDecision.admitsSignedRelease(signed, ARTIFACT, NOW, null)).isFalse();
    }

    @Test
    void verifierFailureFailsClosedAndVerifierReceivesBindingAndDecision() {
        var signed = decision(ArtifactScanVerdict.CLEAN).withAttestation(BINDING);
        assertThat(ArtifactScanDecision.admitsSignedRelease(signed, ARTIFACT, NOW,
                (d, b, n) -> { throw new IllegalStateException("key store down"); })).isFalse();
        assertThat(ArtifactScanDecision.admitsSignedRelease(signed, ARTIFACT, NOW,
                (d, b, n) -> d == signed && b == BINDING && n.equals(NOW))).isTrue();
    }

    @Test
    void signatureNeverOverridesVerdictExpiryOrIdentity() {
        for (var verdict : new ArtifactScanVerdict[] {ArtifactScanVerdict.REJECT, ArtifactScanVerdict.UNAVAILABLE}) {
            assertThat(ArtifactScanDecision.admitsSignedRelease(
                    decision(verdict).withAttestation(BINDING), ARTIFACT, NOW, ACCEPT)).isFalse();
        }
        var signed = decision(ArtifactScanVerdict.CLEAN).withAttestation(BINDING);
        assertThat(ArtifactScanDecision.admitsSignedRelease(signed, ARTIFACT, NOW.plusSeconds(60), ACCEPT)).isFalse();
        assertThat(ArtifactScanDecision.admitsSignedRelease(signed, null, NOW, ACCEPT)).isFalse();
        assertThat(ArtifactScanDecision.admitsSignedRelease(null, ARTIFACT, NOW, ACCEPT)).isFalse();
        var other = new QuarantinedArtifact("tenant-b", "principal-a", "upload-a", SHA, 42, "video/mp4", "q://x");
        assertThat(ArtifactScanDecision.admitsSignedRelease(signed, other, NOW, ACCEPT)).isFalse();
    }

    @Test
    void bindingRequiresAllFieldsAndHexPayloadDigest() {
        assertThatThrownBy(() -> new ScanAttestationBinding("", "Ed25519", "k", "sig", "b".repeat(64)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ScanAttestationBinding("a", "Ed25519", "k", "sig", "nothex"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ScanAttestationBinding("a", "Ed25519", "k", null, "b".repeat(64)))
                .isInstanceOf(RuntimeException.class);
    }
}
