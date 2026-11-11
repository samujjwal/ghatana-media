package com.ghatana.audio.video.vision.scenetext;

import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.CropRefused;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.CropOutcome;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.CropRequest;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Decision;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.ResolvedCrop;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Roi;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceCheck;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceStatus;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactContentReadReceipt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Evidence;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Fake-port fixtures; no real artifact store or DI worker is involved. */
class MediaRuntimeSceneTextSourceTest {

    private static final String TENANT = "tenant-1";
    private static final String PRINCIPAL = "principal-1";

    @Test
    void sourceProbeDoesNotAuthorizeDiEgressAndMapsOtherStatuses() throws Exception {
        FakePort port = new FakePort();
        MediaRuntimeSceneTextSource source = new MediaRuntimeSceneTextSource(port);
        SourceCheck check = check("sha256:" + "a".repeat(64));

        port.authDecision = new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.DENIED, null);
        assertThat(source.verify(check).status()).isEqualTo(SourceStatus.DENIED);

        port.authDecision = null;
        port.forceNullAuth = true;
        assertThat(source.verify(check).status()).isEqualTo(SourceStatus.UNAVAILABLE);
        port.forceNullAuth = false;

        port.authDecision = new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.UNAVAILABLE, null);
        assertThat(source.verify(check).status()).isEqualTo(SourceStatus.UNAVAILABLE);

        port.authDecision = new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED,
                evidence(check));
        Decision admitted = source.verify(check);
        assertThat(admitted.status()).isEqualTo(SourceStatus.NOT_ADMITTED);

        assertThat(source.verify(check("v3")).status()).isEqualTo(SourceStatus.DENIED);
    }

    @Test
    void authorityRejectsAllowedEvidenceForDifferentArtifactVersionOrPrincipal() throws Exception {
        FakePort port = new FakePort();
        MediaRuntimeSceneTextSource source = new MediaRuntimeSceneTextSource(port);
        SourceCheck requested = check("sha256:" + "a".repeat(64));
        port.authDecision = new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED,
                evidence(check("sha256:" + "b".repeat(64))));
        assertThat(source.verify(requested).status()).isEqualTo(SourceStatus.DENIED);

        SourceCheck foreign = new SourceCheck("tenant-other", PRINCIPAL, "caption", "artifact-1",
                requested.sourceVersion(), "0", "a".repeat(64), "di.ocr.en", "2.4.1");
        port.authDecision = new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED,
                evidence(requested));
        assertThat(source.verify(foreign).status()).isEqualTo(SourceStatus.DENIED);
    }

    @Test
    void authorityRejectsExpiredOrWrongOperationEvidence() throws Exception {
        FakePort port = new FakePort();
        MediaRuntimeSceneTextSource source = new MediaRuntimeSceneTextSource(port);
        SourceCheck check = check("sha256:" + "a".repeat(64));
        port.authDecision = new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED,
                evidence(check, "vision.scene-text", Instant.now().minusSeconds(60), Instant.now().plusSeconds(300)));
        assertThat(source.verify(check).status()).isEqualTo(SourceStatus.DENIED);

        port.authDecision = new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED,
                evidence(check, "VISION", Instant.now().minusSeconds(600), Instant.now().minusSeconds(300)));
        assertThat(source.verify(check).status()).isEqualTo(SourceStatus.DENIED);
    }

    @Test
    void authorityRejectsEvidenceForDifferentDiProviderOrLocalBoundary() throws Exception {
        FakePort port = new FakePort();
        MediaRuntimeSceneTextSource source = new MediaRuntimeSceneTextSource(port);
        SourceCheck check = check("sha256:" + "a".repeat(64));
        port.authDecision = new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED,
                evidence(check, "VISION", Instant.now(), Instant.now().plusSeconds(300), "other-provider",
                        com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary.EXTERNAL));
        assertThat(source.verify(check).status()).isEqualTo(SourceStatus.DENIED);

        port.authDecision = new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED,
                evidence(check, "VISION", Instant.now(), Instant.now().plusSeconds(300), "di.ocr.en",
                        com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary.LOCAL));
        assertThat(source.verify(check).status()).isEqualTo(SourceStatus.DENIED);
    }

    @Test
    void legacySourceCheckWithoutDiDestinationFailsClosed() throws Exception {
        FakePort port = new FakePort();
        MediaRuntimeSceneTextSource source = new MediaRuntimeSceneTextSource(port);
        SourceCheck current = check("sha256:" + "a".repeat(64));
        SourceCheck legacy = new SourceCheck(TENANT, PRINCIPAL, "caption", "artifact-1",
                current.sourceVersion(), "0", "a".repeat(64));
        port.authDecision = new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED, evidence(current));

        assertThat(source.verify(legacy).status()).isEqualTo(SourceStatus.DENIED);
    }

    @Test
    void resolverReDerivesRoiPixelsFromVerifiedArtifactBytes() throws Exception {
        byte[] png = image(100, 60);
        String sha = sha256(png);
        FakePort port = new FakePort();
        port.content = png;
        port.receiptSha = sha;
        MediaRuntimeSceneTextSource source = new MediaRuntimeSceneTextSource(port);

        CropOutcome outcome = source.resolve(cropRequest(sha, "0", 0, 100, 60, new Roi(10, 5, 40, 30)));

        assertThat(outcome).isInstanceOf(ResolvedCrop.class);
        ResolvedCrop resolved = (ResolvedCrop) outcome;
        assertThat(resolved.originalFrameSha256()).isEqualTo(sha);
        assertThat(resolved.mediaType()).isEqualTo("image/png");
        assertThat(resolved.frameWidth()).isEqualTo(100);
        assertThat(resolved.frameHeight()).isEqualTo(60);
        BufferedImage crop = ImageIO.read(new ByteArrayInputStream(resolved.pixels()));
        assertThat(crop.getWidth()).isEqualTo(40);
        assertThat(crop.getHeight()).isEqualTo(30);
    }

    @Test
    void resolverRefusesWrongFrameIdentityMissingSourceAndOversizedRoi() throws Exception {
        byte[] png = image(100, 60);
        String sha = sha256(png);
        FakePort port = new FakePort();
        port.content = png;
        port.receiptSha = sha;
        MediaRuntimeSceneTextSource source = new MediaRuntimeSceneTextSource(port);

        // Still-image sources expose exactly one frame at pts 0; any other identity is refused.
        assertThat(((CropRefused) source.resolve(cropRequest(sha, "7", 0, 100, 60, new Roi(0, 0, 10, 10)))).status())
                .isEqualTo(SourceStatus.NOT_ADMITTED);
        assertThat(((CropRefused) source.resolve(cropRequest(sha, "0", 4_000_000, 100, 60, new Roi(0, 0, 10, 10)))).status())
                .isEqualTo(SourceStatus.NOT_ADMITTED);
        // ROI outside the true raster cannot be produced.
        assertThat(((CropRefused) source.resolve(cropRequest(sha, "0", 0, 100, 60, new Roi(90, 50, 40, 30)))).status())
                .isEqualTo(SourceStatus.NOT_ADMITTED);
        // Missing artifact content is not-admitted, never an empty crop.
        port.content = null;
        assertThat(((CropRefused) source.resolve(cropRequest(sha, "0", 0, 100, 60, new Roi(0, 0, 10, 10)))).status())
                .isEqualTo(SourceStatus.NOT_ADMITTED);
    }

    @Test
    void resolverRefusesTimestampedVideoFrameWithoutReadingOrTreatingItAsAStillImage() {
        FakePort port = new FakePort();
        MediaRuntimeSceneTextSource source = new MediaRuntimeSceneTextSource(port);
        Roi roi = new Roi(0, 0, 10, 10);

        assertThat(((CropRefused) source.resolve(cropRequest("a".repeat(64), "1", 33_367,
                100, 60, roi))).status()).isEqualTo(SourceStatus.NOT_ADMITTED);
        assertThat(((CropRefused) source.resolve(cropRequest("a".repeat(64), "0", 33_367,
                100, 60, roi))).status()).isEqualTo(SourceStatus.NOT_ADMITTED);
        assertThat(((CropRefused) source.resolve(cropRequest("a".repeat(64), "1", 0,
                100, 60, roi))).status()).isEqualTo(SourceStatus.NOT_ADMITTED);

        // Until a source-bound video extractor and timestamp contract are wired, video-like
        // requests must not be read as still images or acquire fabricated frame timing.
        assertThat(port.acceptedBytes).isZero();
    }

    @Test
    void resolverRejectsInvalidClaimedRoiBeforeReadingArtifactAndMismatchedRasterDimensions() throws Exception {
        byte[] png = image(100, 60);
        String sha = sha256(png);
        FakePort port = new FakePort();
        port.content = png;
        port.receiptSha = sha;
        MediaRuntimeSceneTextSource source = new MediaRuntimeSceneTextSource(port);

        // Invalid coordinates, including overflow-prone sums, must not trigger an artifact read.
        for (Roi roi : new Roi[] {new Roi(-1, 0, 1, 1), new Roi(0, 0, Integer.MAX_VALUE, 1),
                new Roi(0, 0, 0, 1)}) {
            assertThat(((CropRefused) source.resolve(cropRequest(sha, "0", 0, 100, 60, roi))).status())
                    .isEqualTo(SourceStatus.NOT_ADMITTED);
        }
        assertThat(port.acceptedBytes).isZero();

        // A valid ROI against a caller-claimed raster is still refused if decoded immutable
        // artifact dimensions differ from that claim.
        assertThat(((CropRefused) source.resolve(cropRequest(sha, "0", 0, 101, 60,
                new Roi(0, 0, 10, 10)))).status()).isEqualTo(SourceStatus.NOT_ADMITTED);
        assertThat(port.acceptedBytes).isEqualTo(png.length);
    }

    @Test
    void resolverRefusesUndecodableAndIoFailureAsTypedOutcomes() throws Exception {
        FakePort port = new FakePort();
        port.content = new byte[] {1, 2, 3};
        port.receiptSha = "b".repeat(64);
        port.artifactShaOverride = port.receiptSha;
        MediaRuntimeSceneTextSource source = new MediaRuntimeSceneTextSource(port);
        assertThat(((CropRefused) source.resolve(cropRequest("b".repeat(64), "0", 0, 100, 60, new Roi(0, 0, 10, 10)))).status())
                .isEqualTo(SourceStatus.NOT_ADMITTED);
        port.ioFailure = true;
        assertThat(((CropRefused) source.resolve(cropRequest("b".repeat(64), "0", 0, 100, 60, new Roi(0, 0, 10, 10)))).status())
                .isEqualTo(SourceStatus.UNAVAILABLE);
    }

    @Test
    void resolverRejectsContentReceiptForAnotherImmutableVersion() throws Exception {
        byte[] png = image(100, 60);
        String sha = sha256(png);
        FakePort port = new FakePort();
        port.content = png;
        port.receiptSha = "b".repeat(64);
        port.receiptVersion = new ArtifactVersion("sha256:" + "b".repeat(64));
        MediaRuntimeSceneTextSource source = new MediaRuntimeSceneTextSource(port);

        assertThat(((CropRefused) source.resolve(cropRequest(sha, "0", 0, 100, 60, new Roi(0, 0, 10, 10))))
                .status()).isEqualTo(SourceStatus.NOT_ADMITTED);
    }

    @Test
    void resolverBoundsBytesEvenWhenPortIgnoresMaximum() throws Exception {
        FakePort port = new FakePort();
        port.writePastLimit = true;
        MediaRuntimeSceneTextSource source = new MediaRuntimeSceneTextSource(port);

        CropOutcome outcome = source.resolve(cropRequest("a".repeat(64), "0", 0, 100, 60,
                new Roi(0, 0, 10, 10)));

        assertThat(outcome).isInstanceOf(CropRefused.class);
        assertThat(((CropRefused) outcome).status()).isEqualTo(SourceStatus.NOT_ADMITTED);
        assertThat(port.acceptedBytes).isEqualTo(port.maxBytesObserved);
    }

    private static SourceCheck check(String sourceVersion) {
        return new SourceCheck(TENANT, PRINCIPAL, "caption", "artifact-1", sourceVersion, "0", "a".repeat(64),
                "di.ocr.en", "2.4.1", new AuthenticatedPrincipal(TENANT, PRINCIPAL, Instant.now()));
    }

    private static CropRequest cropRequest(String artifactSha, String frameId, long ptsUs,
                                           int width, int height, Roi roi) {
        return new CropRequest(TENANT, PRINCIPAL, "caption", "artifact-1", "sha256:" + artifactSha,
                frameId, ptsUs, width, height, roi, "image/png",
                new AuthenticatedPrincipal(TENANT, PRINCIPAL, Instant.now()));
    }

    private static Evidence evidence(SourceCheck check) {
        Instant now = Instant.now();
        return evidence(check, "VISION", now, now.plusSeconds(300));
    }

    private static Evidence evidence(SourceCheck check, String operation, Instant verifiedAt, Instant expiresAt) {
        return evidence(check, operation, verifiedAt, expiresAt, check.dispatchProviderRef(),
                com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary.EXTERNAL);
    }

    private static Evidence evidence(SourceCheck check, String operation, Instant verifiedAt, Instant expiresAt,
                                     String providerId,
                                     com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary boundary) {
        String sha = check.sourceVersion().substring("sha256:".length());
        return new Evidence("authority-1", "decision-1", TENANT, PRINCIPAL, PRINCIPAL, "artifact-1",
                new ArtifactVersion(check.sourceVersion()), sha, operation, "caption",
                providerId, check.dispatchProviderVersion(), boundary, "local",
                com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE,
                Set.of("VISION", "vision.scene-text"), Set.of("*"),
                Set.of(com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE),
                "rights-1", "policy-1", "policy-v1",
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                "", "clock-1", 0, verifiedAt, expiresAt);
    }

    private static byte[] image(int width, int height) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static final class FakePort implements MediaProcessingRuntimePort {
        byte[] content;
        String receiptSha;
        ArtifactVersion receiptVersion;
        boolean ioFailure;
        boolean writePastLimit;
        long acceptedBytes;
        long maxBytesObserved;
        String artifactShaOverride;
        com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision authDecision;
        boolean forceNullAuth;

        @Override public ProcessingJob submit(ProcessingJobRequest request) {
            throw new UnsupportedOperationException();
        }

        @Override public Optional<ProcessingJob> job(String tenantId, String principalId, String jobId) {
            return Optional.empty();
        }

        @Override public Optional<MediaArtifact> artifact(String tenantId, String principalId, String artifactId) {
            String digest;
            try { digest = artifactShaOverride != null ? artifactShaOverride
                    : content == null ? receiptSha : sha256(content); }
            catch (Exception impossible) { throw new AssertionError(impossible); }
            if (digest == null) digest = "a".repeat(64);
            return Optional.of(new MediaArtifact(tenantId, principalId, artifactId, "source.png", "image/png",
                    Math.max(1, content == null ? 1 : content.length), digest, "fixture-ref", "fixture",
                    Instant.now(), Instant.now().plusSeconds(300), java.util.Map.of()));
        }

        @Override public Optional<ArtifactContentReadReceipt> copyArtifactContent(
                String tenantId, String principalId, String artifactId, ArtifactVersion expectedVersion,
                OutputStream target, long maxBytes) throws IOException {
            if (ioFailure) throw new IOException("fixture io failure");
            maxBytesObserved = maxBytes;
            if (writePastLimit) {
                byte[] chunk = new byte[64 * 1024];
                long remaining = maxBytes + 1;
                while (remaining > 0) {
                    int next = (int) Math.min(chunk.length, remaining);
                    target.write(chunk, 0, next);
                    acceptedBytes += next;
                    remaining -= next;
                }
                return Optional.empty();
            }
            if (content == null || content.length > maxBytes) return Optional.empty();
            target.write(content);
            acceptedBytes = content.length;
            return Optional.of(new ArtifactContentReadReceipt(
                    receiptVersion == null ? expectedVersion : receiptVersion, receiptSha, content.length));
        }

        @Override public com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision resolveSourceAuthorization(
                String tenantId, String principalId, String artifactId, ArtifactVersion sourceVersion,
                JobType jobType, String purpose, AuthenticatedPrincipal authenticated) {
            if (forceNullAuth) return null;
            if (authDecision != null) return authDecision;
            SourceCheck lookup = new SourceCheck(tenantId, principalId, purpose, artifactId,
                    sourceVersion.value(), "0", sourceVersion.value().substring("sha256:".length()),
                    "di.ocr.en", "2.4.1", authenticated);
            return new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED,
                    evidence(lookup));
        }
    }
}
