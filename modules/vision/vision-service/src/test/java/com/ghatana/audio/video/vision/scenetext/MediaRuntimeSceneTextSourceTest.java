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
    void authorityAdmitsOnlyAllowedEvidenceAndMapsOtherStatuses() throws Exception {
        FakePort port = new FakePort();
        MediaRuntimeSceneTextSource source = new MediaRuntimeSceneTextSource(port);
        SourceCheck check = check("sha256:" + "a".repeat(64));

        port.authDecision = new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.DENIED, null);
        assertThat(source.verify(check).status()).isEqualTo(SourceStatus.DENIED);

        port.authDecision = null;
        assertThat(source.verify(check).status()).isEqualTo(SourceStatus.UNAVAILABLE);

        port.authDecision = new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.UNAVAILABLE, null);
        assertThat(source.verify(check).status()).isEqualTo(SourceStatus.UNAVAILABLE);

        port.authDecision = new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED,
                evidence(check));
        Decision admitted = source.verify(check);
        assertThat(admitted.status()).isEqualTo(SourceStatus.ADMITTED);
        assertThat(admitted.sourceVersion()).isEqualTo(check.sourceVersion());
        assertThat(admitted.decisionRef()).isEqualTo("decision-1");

        assertThat(source.verify(check("v3")).status()).isEqualTo(SourceStatus.DENIED);
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
    void resolverRefusesUndecodableAndIoFailureAsTypedOutcomes() throws Exception {
        FakePort port = new FakePort();
        port.content = new byte[] {1, 2, 3};
        port.receiptSha = "b".repeat(64);
        MediaRuntimeSceneTextSource source = new MediaRuntimeSceneTextSource(port);
        assertThat(((CropRefused) source.resolve(cropRequest("b".repeat(64), "0", 0, 100, 60, new Roi(0, 0, 10, 10)))).status())
                .isEqualTo(SourceStatus.NOT_ADMITTED);
        port.ioFailure = true;
        assertThat(((CropRefused) source.resolve(cropRequest("b".repeat(64), "0", 0, 100, 60, new Roi(0, 0, 10, 10)))).status())
                .isEqualTo(SourceStatus.UNAVAILABLE);
    }

    private static SourceCheck check(String sourceVersion) {
        return new SourceCheck(TENANT, PRINCIPAL, "caption", "artifact-1", sourceVersion, "0", "a".repeat(64));
    }

    private static CropRequest cropRequest(String artifactSha, String frameId, long ptsUs,
                                           int width, int height, Roi roi) {
        return new CropRequest(TENANT, PRINCIPAL, "caption", "artifact-1", "sha256:" + artifactSha,
                frameId, ptsUs, width, height, roi, "image/png");
    }

    private static Evidence evidence(SourceCheck check) {
        String sha = check.sourceVersion().substring("sha256:".length());
        Instant now = Instant.now();
        return new Evidence("authority-1", "decision-1", TENANT, PRINCIPAL, PRINCIPAL, "artifact-1",
                new ArtifactVersion(check.sourceVersion()), sha, "vision.scene-text", "caption",
                "di.ocr.en", "2.4.1",
                com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary.EXTERNAL, "local",
                com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE,
                Set.of("vision.scene-text"), Set.of("*"),
                Set.of(com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE),
                "rights-1", "policy-1", "policy-v1",
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                "", "clock-1", 0, now, now.plusSeconds(300));
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
        boolean ioFailure;
        com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision authDecision;

        @Override public ProcessingJob submit(ProcessingJobRequest request) {
            throw new UnsupportedOperationException();
        }

        @Override public Optional<ProcessingJob> job(String tenantId, String principalId, String jobId) {
            return Optional.empty();
        }

        @Override public Optional<MediaArtifact> artifact(String tenantId, String principalId, String artifactId) {
            return Optional.empty();
        }

        @Override public Optional<ArtifactContentReadReceipt> copyArtifactContent(
                String tenantId, String principalId, String artifactId, ArtifactVersion expectedVersion,
                OutputStream target, long maxBytes) throws IOException {
            if (ioFailure) throw new IOException("fixture io failure");
            if (content == null || content.length > maxBytes) return Optional.empty();
            target.write(content);
            return Optional.of(new ArtifactContentReadReceipt(expectedVersion, receiptSha, content.length));
        }

        @Override public com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision resolveSourceAuthorization(
                String tenantId, String principalId, String artifactId, ArtifactVersion sourceVersion,
                JobType jobType, String purpose, AuthenticatedPrincipal authenticated) {
            return authDecision;
        }
    }
}
