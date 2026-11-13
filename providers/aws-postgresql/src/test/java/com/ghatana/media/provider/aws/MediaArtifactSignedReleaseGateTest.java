package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanVerdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.QuarantinedArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ScanAttestationBinding;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/** MED-06 store gate: production-grade release needs a signed decision and an affirming injected verifier. */
class MediaArtifactSignedReleaseGateTest {
    private static final String SHA = "a".repeat(64);
    private static final Instant NOW = Instant.parse("2026-11-12T12:00:00Z");
    private static final QuarantinedArtifact ARTIFACT = new QuarantinedArtifact(
            "tenant-a", "principal-a", "upload-a", SHA, 42, "video/mp4", "s3://b/k");
    private static final ScanAttestationBinding BINDING =
            new ScanAttestationBinding("att-1", "Ed25519", "key-1", "c2ln", "b".repeat(64));

    private static ArtifactScanDecision decision(ArtifactScanVerdict verdict) {
        return new ArtifactScanDecision("s", "1", "p", "1", "tenant-a", "principal-a", "upload-a", SHA, 42,
                "video/mp4", verdict, NOW.minusSeconds(5), NOW.plusSeconds(60));
    }

    @Test
    void absentVerifierOrUnsignedDecisionStaysQuarantinedWhenSignedReleaseIsRequired() {
        var signed = decision(ArtifactScanVerdict.CLEAN).withAttestation(BINDING);
        assertThat(S3PostgresqlMediaArtifactStore.releaseAdmitted(signed, ARTIFACT, NOW, true, null)).isFalse();
        assertThat(S3PostgresqlMediaArtifactStore.releaseAdmitted(
                decision(ArtifactScanVerdict.CLEAN), ARTIFACT, NOW, true, (d, b, n) -> true)).isFalse();
        assertThat(S3PostgresqlMediaArtifactStore.releaseAdmitted(signed, ARTIFACT, NOW, true, (d, b, n) -> false)).isFalse();
        assertThat(S3PostgresqlMediaArtifactStore.releaseAdmitted(signed, ARTIFACT, NOW, true,
                (d, b, n) -> { throw new IllegalStateException("boom"); })).isFalse();
    }

    @Test
    void signedCleanDecisionWithAffirmingVerifierIsAdmitted() {
        var signed = decision(ArtifactScanVerdict.CLEAN).withAttestation(BINDING);
        assertThat(S3PostgresqlMediaArtifactStore.releaseAdmitted(signed, ARTIFACT, NOW, true, (d, b, n) -> true)).isTrue();
    }

    @Test
    void nonCleanDecisionsStillFlowToRecordedRefusalPaths() {
        assertThat(S3PostgresqlMediaArtifactStore.releaseAdmitted(
                decision(ArtifactScanVerdict.REJECT), ARTIFACT, NOW, true, null)).isTrue();
        assertThat(S3PostgresqlMediaArtifactStore.releaseAdmitted(
                decision(ArtifactScanVerdict.UNAVAILABLE), ARTIFACT, NOW, true, null)).isTrue();
    }

    @Test
    void developmentGateKeepsLegacyIdentityCheckOnlyWhenSignedReleaseIsNotRequired() {
        assertThat(S3PostgresqlMediaArtifactStore.releaseAdmitted(
                decision(ArtifactScanVerdict.CLEAN), ARTIFACT, NOW, false, null)).isTrue();
        assertThat(S3PostgresqlMediaArtifactStore.releaseAdmitted(
                decision(ArtifactScanVerdict.CLEAN), ARTIFACT, NOW.plusSeconds(120), false, null)).isFalse();
        assertThat(S3PostgresqlMediaArtifactStore.releaseAdmitted(null, ARTIFACT, NOW, false, null)).isFalse();
    }
}
