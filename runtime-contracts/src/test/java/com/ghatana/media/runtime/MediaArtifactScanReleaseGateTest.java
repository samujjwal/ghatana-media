package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanVerdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.QuarantinedArtifact;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/** MED-06: Media artifact release stays quarantined unless a current, exact, CLEAN scan decision exists. */
class MediaArtifactScanReleaseGateTest {
    private static final String SHA = "a".repeat(64);
    private static final Instant NOW = Instant.parse("2026-11-12T12:00:00Z");
    private static final QuarantinedArtifact ARTIFACT = new QuarantinedArtifact(
            "tenant-a", "principal-a", "upload-a", SHA, 42, "video/mp4", "quarantine://object-a");

    private static ArtifactScanDecision decision(
            ArtifactScanVerdict verdict, String tenant, String principal, String upload, String sha,
            long size, String contentType, Instant expiresAt) {
        return new ArtifactScanDecision("scanner", "v1", "policy", "p1", tenant, principal, upload, sha,
                size, contentType, verdict, NOW.minusSeconds(5), expiresAt);
    }

    private static ArtifactScanDecision clean() {
        return decision(ArtifactScanVerdict.CLEAN, "tenant-a", "principal-a", "upload-a", SHA, 42,
                "video/mp4", NOW.plusSeconds(60));
    }

    @Test
    void exactCurrentCleanDecisionIsTheOnlyReleaseAuthority() {
        assertThat(ArtifactScanDecision.admitsRelease(clean(), ARTIFACT, NOW)).isTrue();
    }

    @Test
    void absentScanKeepsArtifactQuarantined() {
        assertThat(ArtifactScanDecision.admitsRelease(null, ARTIFACT, NOW)).isFalse();
    }

    @Test
    void staleScanKeepsArtifactQuarantined() {
        assertThat(ArtifactScanDecision.admitsRelease(clean(), ARTIFACT, NOW.plusSeconds(60))).isFalse();
        assertThat(ArtifactScanDecision.admitsRelease(clean(), ARTIFACT, NOW.plusSeconds(3600))).isFalse();
    }

    @Test
    void rejectedOrUnavailableScanNeverAdmitsEvenWhenIdentityMatches() {
        for (ArtifactScanVerdict verdict : new ArtifactScanVerdict[] {
                ArtifactScanVerdict.REJECT, ArtifactScanVerdict.UNAVAILABLE}) {
            var d = decision(verdict, "tenant-a", "principal-a", "upload-a", SHA, 42, "video/mp4",
                    NOW.plusSeconds(60));
            assertThat(d.matches(ARTIFACT, NOW)).as("identity matches for %s", verdict).isTrue();
            assertThat(ArtifactScanDecision.admitsRelease(d, ARTIFACT, NOW)).as("%s", verdict).isFalse();
        }
    }

    @Test
    void crossTenantPrincipalUploadDigestSizeOrTypeMismatchNeverAdmits() {
        Instant exp = NOW.plusSeconds(60);
        assertThat(ArtifactScanDecision.admitsRelease(decision(ArtifactScanVerdict.CLEAN, "tenant-b",
                "principal-a", "upload-a", SHA, 42, "video/mp4", exp), ARTIFACT, NOW)).isFalse();
        assertThat(ArtifactScanDecision.admitsRelease(decision(ArtifactScanVerdict.CLEAN, "tenant-a",
                "principal-b", "upload-a", SHA, 42, "video/mp4", exp), ARTIFACT, NOW)).isFalse();
        assertThat(ArtifactScanDecision.admitsRelease(decision(ArtifactScanVerdict.CLEAN, "tenant-a",
                "principal-a", "upload-b", SHA, 42, "video/mp4", exp), ARTIFACT, NOW)).isFalse();
        assertThat(ArtifactScanDecision.admitsRelease(decision(ArtifactScanVerdict.CLEAN, "tenant-a",
                "principal-a", "upload-a", "b".repeat(64), 42, "video/mp4", exp), ARTIFACT, NOW)).isFalse();
        assertThat(ArtifactScanDecision.admitsRelease(decision(ArtifactScanVerdict.CLEAN, "tenant-a",
                "principal-a", "upload-a", SHA, 43, "video/mp4", exp), ARTIFACT, NOW)).isFalse();
        assertThat(ArtifactScanDecision.admitsRelease(decision(ArtifactScanVerdict.CLEAN, "tenant-a",
                "principal-a", "upload-a", SHA, 42, "audio/wav", exp), ARTIFACT, NOW)).isFalse();
    }

    @Test
    void releaseGateHasNoMimeOrSignatureInputSoFormatMatchCannotSubstituteForScan() {
        // The gate's inputs are decision + quarantined identity + clock only; a claimed content type
        // that matches the bytes still needs a CLEAN decision from a scanner.
        var unavailable = decision(ArtifactScanVerdict.UNAVAILABLE, "tenant-a", "principal-a", "upload-a",
                SHA, 42, "video/mp4", NOW.plusSeconds(60));
        assertThat(ArtifactScanDecision.admitsRelease(unavailable, ARTIFACT, NOW)).isFalse();
    }
}
