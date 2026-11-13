package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanVerdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.QuarantinedArtifact;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * MED-05/MED-06: the development scanner (EICAR + container-signature check) is never a production
 * scanner and never yields CLEAN when it cannot read the exact quarantined bytes.
 */
class DevelopmentMediaArtifactScannerTest {
    private static final String SHA = "a".repeat(64);

    @Test
    void developmentScannerIsNeverProductionEligible() {
        try (var scanner = new DevelopmentMediaArtifactScanner()) {
            assertThat(scanner.productionEligible()).isFalse();
            assertThat(scanner.scannerId()).contains("development");
        }
    }

    @Test
    void unavailableObjectStoreYieldsUnavailableNeverCleanAndAttestationExpires() {
        try (var scanner = new DevelopmentMediaArtifactScanner()) {
            var artifact = new QuarantinedArtifact("tenant-a", "principal-a", "upload-a", SHA, 42,
                    "audio/wav", "s3://not-configured/object");
            ArtifactScanDecision decision = scanner.scan(artifact);
            assertThat(decision.verdict()).isEqualTo(ArtifactScanVerdict.UNAVAILABLE);
            assertThat(ArtifactScanDecision.admitsRelease(decision, artifact, Instant.now())).isFalse();
            assertThat(decision.scannerVersion()).contains("development");
            // Even a CLEAN development verdict could not outlive its five-minute attestation.
            assertThat(decision.expiresAt()).isBefore(decision.evaluatedAt().plusSeconds(301));
        }
    }
}
