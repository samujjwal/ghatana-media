package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanVerdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactScanner;
import com.ghatana.media.runtime.MediaRuntimeContracts.QuarantinedArtifact;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;

import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;

/**
 * Bounded development-only integrity and container-signature candidate. It detects the standard
 * EICAR test string but is not an antivirus scanner and is never production eligible.
 */
public final class DevelopmentMediaArtifactScanner implements MediaArtifactScanner {
    private static final long DEFAULT_MAX_SCAN_BYTES = 64L * 1024 * 1024;
    private static final byte[] EICAR =
            "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
                    .getBytes(java.nio.charset.StandardCharsets.US_ASCII);
    private final MediaAwsPostgresqlRuntimeState state;
    private final long maximumBytes;

    public DevelopmentMediaArtifactScanner() {
        state = MediaAwsPostgresqlRuntimeState.acquire();
        String configured = System.getenv("MEDIA_DEV_SCAN_MAX_BYTES");
        long parsed;
        try {
            parsed = configured == null ? DEFAULT_MAX_SCAN_BYTES : Long.parseLong(configured);
        } catch (NumberFormatException invalid) {
            parsed = DEFAULT_MAX_SCAN_BYTES;
        }
        maximumBytes = Math.max(1, Math.min(parsed, DEFAULT_MAX_SCAN_BYTES));
    }

    @Override public String scannerId() { return "media-development-integrity-candidate"; }
    @Override public boolean ready() { return state.ready(); }
    @Override public boolean productionEligible() { return false; }

    @Override
    public ArtifactScanDecision scan(QuarantinedArtifact artifact) {
        Instant now = Instant.now();
        ArtifactScanVerdict verdict = ArtifactScanVerdict.UNAVAILABLE;
        try {
            if (artifact.sizeBytes() > maximumBytes || !artifact.objectReference().startsWith(
                    "s3://" + state.bucket() + "/")) {
                return decision(artifact, ArtifactScanVerdict.UNAVAILABLE, now);
            }
            String key = artifact.objectReference().substring(("s3://" + state.bucket() + "/").length());
            byte[] content = state.s3().getObjectAsBytes(GetObjectRequest.builder()
                    .bucket(state.bucket()).key(key).build()).asByteArray();
            if (content.length != artifact.sizeBytes() || !sha256(content).equals(artifact.sha256())) {
                verdict = ArtifactScanVerdict.REJECT;
            } else if (contains(content, EICAR)) {
                verdict = ArtifactScanVerdict.REJECT;
            } else if (!MediaArtifactFormatVerifier.matches(artifact.contentType(), content)) {
                verdict = ArtifactScanVerdict.REJECT;
            } else {
                verdict = ArtifactScanVerdict.CLEAN;
            }
        } catch (RuntimeException failure) {
            verdict = ArtifactScanVerdict.UNAVAILABLE;
        }
        return decision(artifact, verdict, now);
    }

    private ArtifactScanDecision decision(QuarantinedArtifact artifact, ArtifactScanVerdict verdict, Instant now) {
        return new ArtifactScanDecision(
                scannerId(), "0.1-development", "integrity-container-eicar-candidate", "v1",
                artifact.tenantId(), artifact.principalId(), artifact.uploadId(), artifact.sha256(),
                artifact.sizeBytes(), artifact.contentType(), verdict, now, now.plus(Duration.ofMinutes(5)));
    }

    private static boolean contains(byte[] source, byte[] target) {
        outer: for (int i = 0; i <= source.length - target.length; i++) {
            for (int j = 0; j < target.length; j++) if (source[i + j] != target[j]) continue outer;
            return true;
        }
        return false;
    }

    private static String sha256(byte[] content) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    @Override public void close() { state.release(); }
}
