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
import java.io.OutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.Arrays;
import java.util.HexFormat;
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
 * <p>The source probe does not expose MediaRuntime's separate external-processing consent
 * revalidation. Therefore it cannot currently authorize a DI HTTP egress, even when source rights
 * and provider identity match; it returns {@link SourceStatus#NOT_ADMITTED} for that effect until
 * an owning consent/egress revalidator is composed.
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
            case ALLOWED -> {
                var evidence = decision.evidence();
                String expectedDigest = sourceVersion.value().substring("sha256:".length());
                if (!evidence.tenantId().equals(check.tenantId())
                        || !evidence.principalId().equals(check.principalId())
                        || !evidence.artifactId().equals(check.sourceArtifactId())
                        || !evidence.sourceVersion().equals(sourceVersion)
                        || !evidence.sourceSha256().equals(expectedDigest)
                        || !evidence.operation().equalsIgnoreCase(JobType.VISION.name())
                        || !evidence.purpose().equalsIgnoreCase(check.purposeRef())
                        || !evidence.providerId().equals(check.dispatchProviderRef())
                        || !evidence.providerVersion().equals(check.dispatchProviderVersion())
                        // DI parse sends pixels to a distinct HTTP service. This integration has no
                        // separately negotiated boundary/retention contract, so only the pinned
                        // external, no-retention dispatch is admitted; other terms fail closed.
                        || evidence.processingBoundary()
                                != com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary.EXTERNAL
                        || evidence.providerRetention()
                                != com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE) {
                    yield Decision.of(SourceStatus.DENIED);
                }
                if (!evidence.currentAt(Clock.systemUTC())) yield Decision.of(SourceStatus.DENIED);
                // This probe refreshes rights evidence only. MediaRuntime job admission separately
                // revalidates external-processing consent, but that API is unavailable to this
                // direct DI client, so never treat this evidence as permission to send crop pixels.
                yield Decision.of(SourceStatus.NOT_ADMITTED);
            }
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
        Roi roi = request.roi();
        if (request.frameWidth() <= 0 || request.frameHeight() <= 0 || roi == null
                || roi.x() < 0 || roi.y() < 0 || roi.width() <= 0 || roi.height() <= 0
                || (long) roi.x() + roi.width() > request.frameWidth()
                || (long) roi.y() + roi.height() > request.frameHeight()) {
            return new CropRefused(SourceStatus.NOT_ADMITTED);
        }
        final ArtifactVersion sourceVersion;
        try {
            sourceVersion = new ArtifactVersion(request.sourceVersion());
        } catch (IllegalArgumentException malformed) {
            return new CropRefused(SourceStatus.NOT_ADMITTED);
        }
        BoundedContentOutputStream content = new BoundedContentOutputStream(MAX_SOURCE_BYTES);
        final Optional<ArtifactContentReadReceipt> receipt;
        try {
            receipt = port.copyArtifactContent(request.tenantId(), request.principalId(),
                    request.sourceArtifactId(), sourceVersion, content, MAX_SOURCE_BYTES);
        } catch (ContentLimitExceededException oversized) {
            return new CropRefused(SourceStatus.NOT_ADMITTED);
        } catch (IOException | RuntimeException unavailable) {
            return new CropRefused(SourceStatus.UNAVAILABLE);
        }
        if (receipt.isEmpty() || content.size() == 0) {
            return new CropRefused(SourceStatus.NOT_ADMITTED);
        }
        byte[] sourceBytes = content.toByteArray();
        ArtifactContentReadReceipt readReceipt = receipt.get();
        if (!readReceipt.version().equals(sourceVersion) || readReceipt.bytesCopied() != sourceBytes.length
                || !readReceipt.sha256().equals(sha256(sourceBytes))) {
            return new CropRefused(SourceStatus.NOT_ADMITTED);
        }
        final BufferedImage frame;
        try {
            frame = BoundedImageDecoder.decode(sourceBytes);
        } catch (RuntimeException undecodable) {
            // Non-image sources are refused, never approximated: a qualified video frame
            // extractor is a separate admission.
            return new CropRefused(SourceStatus.NOT_ADMITTED);
        }
        // The resolver owns this boundary too: a direct caller cannot use an ROI admitted
        // against a claimed raster size that differs from the decoded immutable artifact.
        if (request.frameWidth() != frame.getWidth() || request.frameHeight() != frame.getHeight()
                || (long) roi.x() + roi.width() > frame.getWidth()
                || (long) roi.y() + roi.height() > frame.getHeight()) {
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
        return new ResolvedCrop(png, "image/png", readReceipt.sha256(),
                request.ptsUs(), frame.getWidth(), frame.getHeight());
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is required by the Java runtime", impossible);
        }
    }

    private static final class BoundedContentOutputStream extends OutputStream {
        private final long maximumBytes;
        private final int maximumCapacity;
        private byte[] buffer = new byte[0];
        private int size;

        private BoundedContentOutputStream(long maximumBytes) {
            this.maximumBytes = maximumBytes;
            this.maximumCapacity = Math.toIntExact(maximumBytes);
        }

        @Override
        public void write(int value) throws IOException {
            requireCapacity(1);
            ensureCapacity(size + 1);
            buffer[size++] = (byte) value;
        }

        @Override
        public void write(byte[] bytes, int offset, int length) throws IOException {
            Objects.checkFromIndexSize(offset, length, bytes.length);
            requireCapacity(length);
            ensureCapacity(size + length);
            System.arraycopy(bytes, offset, buffer, size, length);
            size += length;
        }

        private void requireCapacity(int additionalBytes) throws ContentLimitExceededException {
            if (additionalBytes > maximumBytes - size) {
                throw new ContentLimitExceededException();
            }
        }

        private void ensureCapacity(int required) {
            if (required <= buffer.length) return;
            int capacity = buffer.length == 0 ? Math.min(8192, maximumCapacity) : buffer.length;
            while (capacity < required) {
                capacity = (int) Math.min(maximumCapacity, Math.max((long) capacity * 2, required));
            }
            buffer = Arrays.copyOf(buffer, capacity);
        }

        private int size() {
            return size;
        }

        private byte[] toByteArray() {
            return Arrays.copyOf(buffer, size);
        }
    }

    private static final class ContentLimitExceededException extends IOException {
        private ContentLimitExceededException() {
            super("Artifact content exceeded the bounded source read limit");
        }
    }
}
