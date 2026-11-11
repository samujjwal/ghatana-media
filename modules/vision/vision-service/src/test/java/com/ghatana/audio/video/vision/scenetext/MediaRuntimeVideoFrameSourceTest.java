package com.ghatana.audio.video.vision.scenetext;

import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.CropOutcome;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.CropRefused;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.CropRequest;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.ResolvedCrop;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Roi;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceStatus;
import com.ghatana.audio.video.vision.video.SourceMediaTimestamp;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
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
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/** Adversarial integration tests for Media's immutable video readback-to-frame-crop path. */
class MediaRuntimeVideoFrameSourceTest {
    private static final String TENANT = "tenant-video";
    private static final String PRINCIPAL = "principal-video";
    private static final byte[] VIDEO = "immutable-video-fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8);

    @Test
    void resolvesExactNonzeroVfrFrameAndCropsOnlyPixelsFromVerifiedArtifact() throws Exception {
        byte[] frame = bitmap(80, 48);
        FixtureExtractor extractor = new FixtureExtractor(frame,
                new SourceMediaTimestamp(SourceMediaTimestamp.Status.KNOWN, 1_500L, 1L, 30_000L, 50L, null), 3);
        FakePort port = new FakePort(VIDEO);
        MediaRuntimeSceneTextSource source = new MediaRuntimeSceneTextSource(port, extractor);

        CropOutcome outcome = source.resolve(request(3, 50_000L, 80, 48, new Roi(9, 7, 25, 20)));

        assertThat(outcome).isInstanceOf(ResolvedCrop.class);
        ResolvedCrop crop = (ResolvedCrop) outcome;
        assertThat(crop.originalFrameSha256()).isEqualTo(sha(frame));
        assertThat(crop.ptsUs()).isEqualTo(50_000L);
        assertThat(crop.videoFrameBinding().frameNumber()).isEqualTo(3);
        assertThat(crop.videoFrameBinding().sourcePts()).isEqualTo(1_500L);
        assertThat(crop.videoFrameBinding().timeBaseNumerator()).isEqualTo(1L);
        assertThat(crop.videoFrameBinding().timeBaseDenominator()).isEqualTo(30_000L);
        assertThat(crop.videoFrameBinding().frameSha256()).isEqualTo(sha(frame));
        assertThat(crop.videoFrameBinding().cropSha256()).isEqualTo(sha(crop.pixels()));
        assertThat(crop.videoFrameBinding().artifactLocalEpoch()).startsWith("artifact-local:");
        BufferedImage pixels = ImageIO.read(new ByteArrayInputStream(crop.pixels()));
        assertThat(pixels.getWidth()).isEqualTo(25);
        assertThat(pixels.getHeight()).isEqualTo(20);
        assertThat(extractor.requestedOrdinal).isEqualTo(3);
        assertThat(port.copiedTenant).isEqualTo(TENANT);
        assertThat(port.copiedPrincipal).isEqualTo(PRINCIPAL);
        assertThat(port.copiedArtifact).isEqualTo("artifact-video");
        assertThat(extractor.inputBytes).containsExactly(VIDEO);
    }

    @Test
    void videoFrameZeroAtZeroPtsUsesTrustedContainerTypeAndExtractor() throws Exception {
        byte[] frame = bitmap(80, 48);
        FixtureExtractor extractor = new FixtureExtractor(frame, known(0, 1, 30), 0);
        CropOutcome outcome = new MediaRuntimeSceneTextSource(new FakePort(VIDEO), extractor)
                .resolve(request(0, 0, 80, 48, new Roi(0, 0, 10, 10)));

        assertThat(outcome).isInstanceOf(ResolvedCrop.class);
        assertThat(extractor.requestedOrdinal).isZero();
        assertThat(((ResolvedCrop) outcome).videoFrameBinding().sourcePts()).isZero();
    }

    @Test
    void refusesUnknownPtsAndPtsThatDoesNotExactlyMatchRequestedMicroseconds() throws Exception {
        byte[] frame = bitmap(80, 48);
        for (SourceMediaTimestamp timestamp : List.of(
                SourceMediaTimestamp.unknown("SOURCE_PTS_MISSING"),
                new SourceMediaTimestamp(SourceMediaTimestamp.Status.KNOWN, 1L, 1L, 3L, 333L, null))) {
            FixtureExtractor extractor = new FixtureExtractor(frame, timestamp, 2);
            CropOutcome outcome = new MediaRuntimeSceneTextSource(new FakePort(VIDEO), extractor)
                    .resolve(request(2, 333_333L, 80, 48, new Roi(0, 0, 10, 10)));
            assertRefused(outcome, SourceStatus.NOT_ADMITTED);
        }
    }

    @Test
    void refusesStaleOrForgedFrameIdentityAndRoiGeometry() throws Exception {
        byte[] frame = bitmap(80, 48);
        CropRequest valid = request(4, 2_000_000L, 80, 48, new Roi(0, 0, 10, 10));
        assertRefused(resolve(frame, new SourceMediaTimestamp(SourceMediaTimestamp.Status.KNOWN,
                2L, 1L, 1L, 2_000L, null), 3, valid), SourceStatus.NOT_ADMITTED);
        assertRefused(resolve(frame, new SourceMediaTimestamp(SourceMediaTimestamp.Status.KNOWN,
                3L, 1L, 1L, 3_000L, null), 4, request(4, 4_000_000L, 80, 48,
                        new Roi(0, 0, 10, 10))), SourceStatus.NOT_ADMITTED);
        assertRefused(resolve(frame, new SourceMediaTimestamp(SourceMediaTimestamp.Status.KNOWN,
                4L, 1L, 1L, 4_000L, null), 4, request(4, 4_000_000L, 81, 48,
                        new Roi(0, 0, 10, 10))), SourceStatus.NOT_ADMITTED);
        assertRefused(resolve(frame, new SourceMediaTimestamp(SourceMediaTimestamp.Status.KNOWN,
                4L, 1L, 1L, 4_000L, null), 4, request(4, 4_000_000L, 80, 48,
                        new Roi(75, 45, 20, 20))), SourceStatus.NOT_ADMITTED);
    }

    @Test
    void refusesArtifactReadbackWithWrongTenantPrincipalArtifactVersionOrDigest() throws Exception {
        byte[] frame = bitmap(80, 48);
        CropRequest request = request(1, 1_000_000L, 80, 48, new Roi(0, 0, 10, 10));
        FakePort foreign = new FakePort(VIDEO);
        foreign.artifactTenant = "tenant-other";
        assertRefused(new MediaRuntimeSceneTextSource(foreign,
                new FixtureExtractor(frame, known(1, 1, 1), 1)).resolve(request), SourceStatus.NOT_ADMITTED);

        FakePort wrongPrincipal = new FakePort(VIDEO);
        wrongPrincipal.artifactPrincipal = "principal-other";
        assertRefused(new MediaRuntimeSceneTextSource(wrongPrincipal,
                new FixtureExtractor(frame, known(1, 1, 1), 1)).resolve(request), SourceStatus.NOT_ADMITTED);

        FakePort wrongArtifact = new FakePort(VIDEO);
        wrongArtifact.artifactId = "artifact-other";
        assertRefused(new MediaRuntimeSceneTextSource(wrongArtifact,
                new FixtureExtractor(frame, known(1, 1, 1), 1)).resolve(request), SourceStatus.NOT_ADMITTED);

        FakePort staleVersion = new FakePort(VIDEO);
        staleVersion.artifactDigest = "c".repeat(64);
        assertRefused(new MediaRuntimeSceneTextSource(staleVersion,
                new FixtureExtractor(frame, known(1, 1, 1), 1)).resolve(request), SourceStatus.NOT_ADMITTED);

        FakePort mismatchedReceipt = new FakePort(VIDEO);
        mismatchedReceipt.receiptDigest = "b".repeat(64);
        assertRefused(new MediaRuntimeSceneTextSource(mismatchedReceipt,
                new FixtureExtractor(frame, known(1, 1, 1), 1)).resolve(request), SourceStatus.NOT_ADMITTED);
    }

    @Test
    void extractorFailureIsUnavailableAndTemporaryContentIsNotAcceptedAsCrop() {
        FakePort port = new FakePort(VIDEO);
        VideoFrameExtractor failing = new VideoFrameExtractor() {
            @Override public List<ExtractedFrame> extractFrames(Path input, Path output, ExtractionConfig config)
                    throws IOException {
                throw new IOException("fixture decoder failure");
            }
        };
        CropOutcome outcome = new MediaRuntimeSceneTextSource(port, failing)
                .resolve(request(1, 1_000_000L, 80, 48, new Roi(0, 0, 10, 10)));
        assertRefused(outcome, SourceStatus.UNAVAILABLE);
    }

    @Test
    void deniedOrRevokedFreshRightsNeverExposeDerivedCropBytes() throws Exception {
        byte[] frame = bitmap(80, 48);
        FakePort denied = new FakePort(VIDEO);
        denied.authorizationStatus = com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.DENIED;
        FixtureExtractor untouchedExtractor = new FixtureExtractor(frame, known(1, 1, 1), 1);
        assertRefused(new MediaRuntimeSceneTextSource(denied, untouchedExtractor)
                .resolve(request(1, 1_000_000L, 80, 48, new Roi(0, 0, 10, 10))), SourceStatus.NOT_ADMITTED);
        assertThat(denied.readbackCalls).isZero();
        assertThat(untouchedExtractor.requestedOrdinal).isEqualTo(-1);

        FakePort revoked = new FakePort(VIDEO);
        revoked.revokeAtAuthorizationCall = 3; // before read, before decode, then immediately before return
        FixtureExtractor extracted = new FixtureExtractor(frame, known(1, 1, 1), 1);
        CropOutcome outcome = new MediaRuntimeSceneTextSource(revoked, extracted)
                .resolve(request(1, 1_000_000L, 80, 48, new Roi(0, 0, 10, 10)));
        assertRefused(outcome, SourceStatus.NOT_ADMITTED);
        assertThat(revoked.authorizationCalls).isEqualTo(3);
        assertThat(extracted.requestedOrdinal).isEqualTo(1);
    }

    private static CropOutcome resolve(byte[] frame, SourceMediaTimestamp timestamp, int actualOrdinal,
                                       CropRequest request) throws Exception {
        return new MediaRuntimeSceneTextSource(new FakePort(VIDEO),
                new FixtureExtractor(frame, timestamp, actualOrdinal)).resolve(request);
    }

    private static CropRequest request(int ordinal, long ptsUs, int width, int height, Roi roi) {
        return new CropRequest(TENANT, PRINCIPAL, "caption", "artifact-video", "sha256:" + sha(VIDEO),
                Integer.toString(ordinal), ptsUs, width, height, roi, "image/png",
                new AuthenticatedPrincipal(TENANT, PRINCIPAL, Instant.now()));
    }

    private static SourceMediaTimestamp known(long pts, long numerator, long denominator) {
        long millis = Math.round((double) pts * numerator * 1_000d / denominator);
        return new SourceMediaTimestamp(SourceMediaTimestamp.Status.KNOWN, pts, numerator, denominator, millis, null);
    }

    private static void assertRefused(CropOutcome outcome, SourceStatus status) {
        assertThat(outcome).isInstanceOf(CropRefused.class);
        assertThat(((CropRefused) outcome).status()).isEqualTo(status);
    }

    private static byte[] bitmap(int width, int height) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ImageIO.write(image, "bmp", output);
        return output.toByteArray();
    }

    private static String sha(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (Exception impossible) { throw new AssertionError(impossible); }
    }

    private static final class FixtureExtractor extends VideoFrameExtractor {
        private final byte[] frameBytes;
        private final SourceMediaTimestamp timestamp;
        private final int reportedOrdinal;
        private int requestedOrdinal = -1;
        private byte[] inputBytes;

        FixtureExtractor(byte[] frameBytes, SourceMediaTimestamp timestamp, int reportedOrdinal) {
            this.frameBytes = frameBytes;
            this.timestamp = timestamp;
            this.reportedOrdinal = reportedOrdinal;
        }

        @Override public List<ExtractedFrame> extractFrames(Path input, Path output, ExtractionConfig config)
                throws IOException {
            requestedOrdinal = config.getSourceFrameNumber();
            inputBytes = Files.readAllBytes(input);
            Files.createDirectories(output);
            Path extracted = output.resolve("frame_0001.bmp");
            Files.write(extracted, frameBytes);
            return List.of(new ExtractedFrame(extracted, timestamp, reportedOrdinal));
        }
    }

    private static final class FakePort implements MediaProcessingRuntimePort {
        final byte[] bytes;
        final String digest;
        String receiptDigest;
        String artifactTenant = TENANT;
        String artifactPrincipal = PRINCIPAL;
        String artifactId = "artifact-video";
        String artifactDigest;
        int authorizationCalls;
        int revokeAtAuthorizationCall = -1;
        int readbackCalls;
        com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status authorizationStatus =
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED;
        String copiedTenant;
        String copiedPrincipal;
        String copiedArtifact;

        FakePort(byte[] bytes) {
            this.bytes = bytes;
            digest = sha(bytes);
            receiptDigest = digest;
            artifactDigest = digest;
        }

        @Override public ProcessingJob submit(ProcessingJobRequest request) { throw new UnsupportedOperationException(); }
        @Override public Optional<ProcessingJob> job(String tenantId, String principalId, String jobId) {
            return Optional.empty();
        }
        @Override public Optional<MediaArtifact> artifact(String tenantId, String principalId, String artifactId) {
            return Optional.of(new MediaArtifact(artifactTenant, artifactPrincipal, this.artifactId, "source.mp4",
                    "video/mp4", bytes.length, artifactDigest, "private-ref", "restricted", Instant.now(),
                    Instant.now().plusSeconds(300), java.util.Map.of()));
        }
        @Override public Optional<ArtifactContentReadReceipt> copyArtifactContent(String tenantId, String principalId,
                String artifactId, ArtifactVersion expectedVersion, OutputStream target, long maxBytes) throws IOException {
            copiedTenant = tenantId;
            copiedPrincipal = principalId;
            copiedArtifact = artifactId;
            readbackCalls++;
            if (bytes.length > maxBytes) return Optional.empty();
            target.write(bytes);
            return Optional.of(new ArtifactContentReadReceipt(ArtifactVersion.fromSha256(receiptDigest),
                    receiptDigest, bytes.length));
        }
        @Override public com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision resolveSourceAuthorization(
                String tenantId, String principalId, String artifactId, ArtifactVersion sourceVersion,
                JobType jobType, String purpose, AuthenticatedPrincipal authenticated) {
            authorizationCalls++;
            var status = authorizationCalls == revokeAtAuthorizationCall
                    ? com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.REVOKED
                    : authorizationStatus;
            if (status != com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED) {
                return new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(status, null);
            }
            String sha = sourceVersion.value().substring("sha256:".length());
            Evidence evidence = new Evidence("fixture-authority", "fixture-decision", tenantId, principalId,
                    principalId, artifactId, sourceVersion, sha, jobType.name(), purpose,
                    "vision-local-frame-reader", "1", com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary.LOCAL,
                    "local", com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE,
                    java.util.Set.of(jobType.name()), java.util.Set.of("*"),
                    java.util.Set.of(com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE),
                    "fixture-rights", "fixture-policy", "fixture-policy-v1",
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                    "", "artifact-local-clock", 0, Instant.now().minusSeconds(1), Instant.now().plusSeconds(300));
            return new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(status, evidence);
        }
    }
}
