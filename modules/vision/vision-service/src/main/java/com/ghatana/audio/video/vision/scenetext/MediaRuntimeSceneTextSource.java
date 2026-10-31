package com.ghatana.audio.video.vision.scenetext;

import com.ghatana.audio.video.vision.image.BoundedImageDecoder;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.CropOutcome;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.CropRefused;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.CropRequest;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Decision;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.FrameCropResolver;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.ResolvedCrop;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Roi;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceAuthority;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceCheck;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceStatus;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactContentReadReceipt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.time.Instant;
import java.util.Objects;
import java.util.Optional;

/**
 * Production VIS-09 source binding over the canonical Media runtime port.
 *
 * <p>As {@link SourceAuthority} it resolves the same effect-free
 * {@link MediaProcessingRuntimePort#resolveSourceAuthorization} probe job admission uses, so the
 * gRPC caller's tenant/principal are lookup inputs checked against the verified ingress identity.
 * As {@link FrameCropResolver} it re-reads the admitted artifact's exact immutable bytes through
 * {@link MediaProcessingRuntimePort#copyArtifactContent}, decodes the true original frame under a
 * bounded decoder and re-derives the ROI pixels itself. Caller-supplied crops are never an input;
 * a caller cannot reach Document Intelligence with pixels the authority did not produce.
 *
 * <p>Only single-frame image sources are admitted: {@code frameId} must be {@code "0"} and
 * {@code ptsUs} must be {@code 0}. Video frame extraction requires a separately qualified path and
 * is refused, never silently approximated.
 *
 * @doc.type class
 * @doc.purpose Runtime-bound source rights and trusted frame-crop resolver for VIS-09
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class MediaRuntimeSceneTextSource implements SourceAuthority, FrameCropResolver {

    private static final long MAX_SOURCE_BYTES = BoundedImageDecoder.MAX_ENCODED_BYTES;
    private static final long MAX_CROP_BYTES = 20L * 1024 * 1024;
    private static final String STILL_FRAME_ID = "0";

    private final MediaProcessingRuntimePort port;

    public MediaRuntimeSceneTextSource(MediaProcessingRuntimePort port) {
        this.port = Objects.requireNonNull(port, "port");
    }

    @Override
    public Decision verify(SourceCheck check) {
        Objects.requireNonNull(check, "check");
        final ArtifactVersion sourceVersion;
        try {
            sourceVersion = new ArtifactVersion(check.sourceVersion());
        } catch (IllegalArgumentException malformed) {
            return Decision.of(SourceStatus.DENIED);
        }
        final com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision decision;
        try {
            decision = port.resolveSourceAuthorization(
                    check.tenantId(), check.principalId(), check.sourceArtifactId(), sourceVersion,
                    JobType.VISION, check.purposeRef(),
                    new AuthenticatedPrincipal(check.tenantId(), check.principalId(), Instant.now()));
        } catch (RuntimeException unavailable) {
            return Decision.of(SourceStatus.UNAVAILABLE);
        }
        if (decision == null || decision.status() == null) {
            return Decision.of(SourceStatus.UNAVAILABLE);
        }
        return switch (decision.status()) {
            case ALLOWED -> new Decision(SourceStatus.ADMITTED, check.sourceVersion(),
                    check.originalFrameSha256(), decision.evidence().decisionId());
            case DENIED, REVOKED, STALE -> Decision.of(SourceStatus.DENIED);
            case UNAVAILABLE -> Decision.of(SourceStatus.UNAVAILABLE);
        };
    }

    @Override
    public CropOutcome resolve(CropRequest request) {
        Objects.requireNonNull(request, "request");
        if (!STILL_FRAME_ID.equals(request.frameId()) || request.ptsUs() != 0) {
            return new CropRefused(SourceStatus.NOT_ADMITTED);
        }
        final ArtifactVersion sourceVersion;
        try {
            sourceVersion = new ArtifactVersion(request.sourceVersion());
        } catch (IllegalArgumentException malformed) {
            return new CropRefused(SourceStatus.NOT_ADMITTED);
        }
        ByteArrayOutputStream content = new ByteArrayOutputStream();
        final Optional<ArtifactContentReadReceipt> receipt;
        try {
            receipt = port.copyArtifactContent(request.tenantId(), request.principalId(),
                    request.sourceArtifactId(), sourceVersion, content, MAX_SOURCE_BYTES);
        } catch (IOException | RuntimeException unavailable) {
            return new CropRefused(SourceStatus.UNAVAILABLE);
        }
        if (receipt.isEmpty() || content.size() == 0) {
            return new CropRefused(SourceStatus.NOT_ADMITTED);
        }
        byte[] sourceBytes = content.toByteArray();
        final BufferedImage frame;
        try {
            frame = BoundedImageDecoder.decode(sourceBytes);
        } catch (RuntimeException undecodable) {
            // Non-image sources are refused, never approximated: a qualified video frame
            // extractor is a separate admission.
            return new CropRefused(SourceStatus.NOT_ADMITTED);
        }
        Roi roi = request.roi();
        if (roi.x() + roi.width() > frame.getWidth() || roi.y() + roi.height() > frame.getHeight()) {
            return new CropRefused(SourceStatus.NOT_ADMITTED);
        }
        byte[] png;
        try {
            BufferedImage cropped = frame.getSubimage(roi.x(), roi.y(), roi.width(), roi.height());
            ByteArrayOutputStream encoded = new ByteArrayOutputStream();
            if (!ImageIO.write(cropped, "png", encoded)) {
                return new CropRefused(SourceStatus.UNAVAILABLE);
            }
            png = encoded.toByteArray();
        } catch (RuntimeException | IOException failure) {
            return new CropRefused(SourceStatus.UNAVAILABLE);
        }
        if (png.length == 0 || png.length > MAX_CROP_BYTES) {
            return new CropRefused(SourceStatus.NOT_ADMITTED);
        }
        return new ResolvedCrop(png, "image/png", receipt.get().sha256(),
                request.ptsUs(), frame.getWidth(), frame.getHeight());
    }
}
