package com.ghatana.audio.video.vision.scenetext;

import com.ghatana.audio.video.vision.image.BoundedImageDecoder;
import com.ghatana.audio.video.vision.video.SourceMediaTimestamp;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor.ExtractedFrame;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor.ExtractionConfig;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor.FrameSelection;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor.FrameSelectionStatus;
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
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceFrameResolution;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceFrameResolutionOutcome;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceFrameResolved;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceFrameRefused;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.VideoFrameBinding;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactContentReadReceipt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

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
 * <p>Still images retain the original frameId {@code "0"}/PTS {@code 0} path. Video sources are
 * read back by exact immutable identity, then passed to the bounded Media FFmpeg extractor for one
 * exact source-frame ordinal. The extracted source PTS/timebase must exactly represent the request;
 * missing or mismatched timestamps are refused rather than inferred.
 *
 * @doc.type class
 * @doc.purpose Runtime-bound source rights and trusted frame-crop resolver for VIS-09
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class MediaRuntimeSceneTextSource implements SourceAuthority, FrameCropResolver {

    private static final long MAX_SOURCE_BYTES = BoundedImageDecoder.MAX_ENCODED_BYTES;
    private static final long MAX_CROP_BYTES = 20L * 1024 * 1024;
    private static final long MAX_VIDEO_SOURCE_BYTES = 500L * 1024 * 1024;
    private static final String STILL_FRAME_ID = "0";
    private static final String VIDEO_STREAM_SELECTOR = "0:v:0";

    private final MediaProcessingRuntimePort port;
    private final VideoFrameExtractor videoFrameExtractor;

    public MediaRuntimeSceneTextSource(MediaProcessingRuntimePort port) {
        this(port, new VideoFrameExtractor());
    }

    public MediaRuntimeSceneTextSource(MediaProcessingRuntimePort port, VideoFrameExtractor videoFrameExtractor) {
        this.port = Objects.requireNonNull(port, "port");
        this.videoFrameExtractor = Objects.requireNonNull(videoFrameExtractor, "videoFrameExtractor");
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
        if (!trustedPrincipalMatches(check.authenticatedPrincipal(), check.tenantId(), check.principalId())) {
            return Decision.of(SourceStatus.DENIED);
        }
        final com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision decision;
        try {
            decision = port.resolveSourceAuthorization(
                    check.tenantId(), check.principalId(), check.sourceArtifactId(), sourceVersion,
                    JobType.VISION, check.purposeRef(),
                    check.authenticatedPrincipal());
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
        if (!isCanonicalFrameOrdinal(request.frameId()) || request.ptsUs() < 0) {
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
        SourceStatus initialRights = revalidateLocalFrameRights(request, sourceVersion);
        if (initialRights != SourceStatus.ADMITTED) return new CropRefused(initialRights);
        Optional<MediaArtifact> artifact;
        try {
            artifact = port.artifact(request.tenantId(), request.principalId(), request.sourceArtifactId());
        } catch (RuntimeException unavailable) {
            return new CropRefused(SourceStatus.UNAVAILABLE);
        }
        if (artifact.isEmpty() || !artifactIdentityMatches(artifact.get(), request, sourceVersion)) {
            return new CropRefused(SourceStatus.NOT_ADMITTED);
        }
        boolean stillIdentity = STILL_FRAME_ID.equals(request.frameId()) && request.ptsUs() == 0;
        if (isVideoArtifact(artifact.get())) return resolveVideo(request, sourceVersion, roi, artifact.get());
        if (stillIdentity && isStillImageArtifact(artifact.get())) {
            return resolveStill(request, sourceVersion, roi, artifact.get());
        }
        return new CropRefused(SourceStatus.NOT_ADMITTED);
    }

    /** Public source-free result; exact crop pixels remain inside the trusted Media adapter. */
    public SourceFrameResolutionOutcome resolveSourceFrame(CropRequest request) {
        CropOutcome outcome = resolve(request);
        if (outcome instanceof CropRefused refused) return new SourceFrameRefused(refused.status());
        if (!(outcome instanceof ResolvedCrop resolved) || resolved.pixels() == null
                || resolved.pixels().length == 0 || resolved.pixels().length > MAX_CROP_BYTES) {
            return new SourceFrameRefused(SourceStatus.UNAVAILABLE);
        }
        final ArtifactVersion version;
        try { version = new ArtifactVersion(request.sourceVersion()); }
        catch (IllegalArgumentException malformed) { return new SourceFrameRefused(SourceStatus.NOT_ADMITTED); }
        SourceStatus current = revalidateLocalFrameRights(request, version);
        if (current != SourceStatus.ADMITTED) return new SourceFrameRefused(current);
        VideoFrameBinding binding = resolved.videoFrameBinding();
        String sourceSha = request.sourceVersion().startsWith("sha256:")
                ? request.sourceVersion().substring("sha256:".length()) : "";
        if (binding == null) {
            return new SourceFrameResolved(new SourceFrameResolution(request.tenantId(), request.principalId(),
                    request.sourceArtifactId(), request.sourceVersion(), sourceSha, request.frameId(), "",
                    "still-image", 0, false, 0, 0, 0, request.ptsUs(), resolved.frameWidth(),
                    resolved.frameHeight(), request.roi(), resolved.originalFrameSha256(), sha256(resolved.pixels())));
        }
        return new SourceFrameResolved(new SourceFrameResolution(binding.tenantId(), binding.principalId(),
                binding.artifactId(), binding.artifactVersion(), binding.sourceSha256(), request.frameId(),
                binding.artifactLocalEpoch(), binding.sourceStreamSelector(), binding.frameNumber(), true,
                binding.sourcePts(), binding.timeBaseNumerator(), binding.timeBaseDenominator(), request.ptsUs(),
                binding.frameWidth(), binding.frameHeight(), binding.roi(), binding.frameSha256(), binding.cropSha256()));
    }

    private CropOutcome resolveStill(CropRequest request, ArtifactVersion sourceVersion, Roi roi,
                                     MediaArtifact artifact) {
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
                || sourceBytes.length != artifact.sizeBytes()
                || !readReceipt.sha256().equals(sha256(sourceBytes))
                || !readReceipt.sha256().equals(artifact.sha256())) {
            return new CropRefused(SourceStatus.NOT_ADMITTED);
        }
        SourceStatus beforeDecode = revalidateLocalFrameRights(request, sourceVersion);
        if (beforeDecode != SourceStatus.ADMITTED) return new CropRefused(beforeDecode);
        final BufferedImage frame;
        try {
            frame = BoundedImageDecoder.decode(sourceBytes);
        } catch (RuntimeException undecodable) {
            // Non-image sources are refused here, never approximated as still images.
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
        SourceStatus beforeExposure = revalidateLocalFrameRights(request, sourceVersion);
        if (beforeExposure != SourceStatus.ADMITTED) return new CropRefused(beforeExposure);
        return new ResolvedCrop(png, "image/png", readReceipt.sha256(),
                request.ptsUs(), frame.getWidth(), frame.getHeight());
    }

    private CropOutcome resolveVideo(CropRequest request, ArtifactVersion sourceVersion, Roi roi,
                                     MediaArtifact artifact) {
        String extension = videoExtension(artifact.fileName());
        if (extension == null) return new CropRefused(SourceStatus.NOT_ADMITTED);
        Path workspace = null;
        try {
            workspace = Files.createTempDirectory("media-vision-source-");
            setOwnerOnly(workspace);
            Path input = workspace.resolve("source." + extension);
            final long contentSize;
            final String contentSha;
            final Optional<ArtifactContentReadReceipt> receipt;
            try (BoundedFileOutputStream content = new BoundedFileOutputStream(input, MAX_VIDEO_SOURCE_BYTES)) {
                receipt = port.copyArtifactContent(request.tenantId(), request.principalId(),
                        request.sourceArtifactId(), sourceVersion, content, MAX_VIDEO_SOURCE_BYTES);
                contentSize = content.size();
                contentSha = content.sha256();
            }
            if (receipt.isEmpty() || contentSize == 0) return new CropRefused(SourceStatus.NOT_ADMITTED);
            ArtifactContentReadReceipt readReceipt = receipt.get();
            if (!readReceipt.version().equals(sourceVersion) || readReceipt.bytesCopied() != contentSize
                    || !readReceipt.sha256().equals(contentSha)
                    || contentSize != artifact.sizeBytes()
                    || !readReceipt.sha256().equals(artifact.sha256())) {
                return new CropRefused(SourceStatus.NOT_ADMITTED);
            }
            SourceStatus beforeDecode = revalidateLocalFrameRights(request, sourceVersion);
            if (beforeDecode != SourceStatus.ADMITTED) return new CropRefused(beforeDecode);
            int ordinal = Integer.parseInt(request.frameId());
            Path output = workspace.resolve("frames");
            List<ExtractedFrame> frames = videoFrameExtractor.extractFrames(input, output,
                    ExtractionConfig.builder().sourceFrameNumber(ordinal).format("bmp").build());
            FrameSelection selection = selectExactVideoFrame(frames, ordinal, request.ptsUs());
            if (selection.status() == FrameSelectionStatus.UNKNOWN_TIMESTAMP
                    || selection.status() == FrameSelectionStatus.INVALID_REQUEST
                    || selection.status() == FrameSelectionStatus.AMBIGUOUS) {
                return new CropRefused(SourceStatus.NOT_ADMITTED);
            }
            if (selection.status() != FrameSelectionStatus.FOUND) return new CropRefused(SourceStatus.NOT_ADMITTED);
            byte[] frameBytes = Files.readAllBytes(selection.frame().getPath());
            if (frameBytes.length == 0 || frameBytes.length > MAX_SOURCE_BYTES) {
                return new CropRefused(SourceStatus.NOT_ADMITTED);
            }
            BufferedImage frame = BoundedImageDecoder.decode(frameBytes);
            if (request.frameWidth() != frame.getWidth() || request.frameHeight() != frame.getHeight()
                    || (long) roi.x() + roi.width() > frame.getWidth()
                    || (long) roi.y() + roi.height() > frame.getHeight()) {
                return new CropRefused(SourceStatus.NOT_ADMITTED);
            }
            byte[] png = encodeCrop(frame, roi);
            if (png == null) return new CropRefused(SourceStatus.UNAVAILABLE);
            if (png.length == 0 || png.length > MAX_CROP_BYTES) return new CropRefused(SourceStatus.NOT_ADMITTED);
            String frameSha = sha256(frameBytes);
            String cropSha = sha256(png);
            VideoFrameBinding binding = new VideoFrameBinding(request.tenantId(), request.principalId(),
                    request.sourceArtifactId(), sourceVersion.value(), readReceipt.sha256(),
                    artifactLocalEpoch(sourceVersion, VIDEO_STREAM_SELECTOR),
                    VIDEO_STREAM_SELECTOR, ordinal,
                    selection.frame().getSourceTimestamp().pts(),
                    selection.frame().getSourceTimestamp().timeBaseNumerator(),
                    selection.frame().getSourceTimestamp().timeBaseDenominator(), frame.getWidth(), frame.getHeight(),
                    roi, frameSha, cropSha);
            SourceStatus beforeExposure = revalidateLocalFrameRights(request, sourceVersion);
            if (beforeExposure != SourceStatus.ADMITTED) return new CropRefused(beforeExposure);
            return new ResolvedCrop(png, "image/png", frameSha, request.ptsUs(),
                    frame.getWidth(), frame.getHeight(), binding);
        } catch (ContentLimitExceededException oversized) {
            return new CropRefused(SourceStatus.NOT_ADMITTED);
        } catch (IOException | RuntimeException failure) {
            return new CropRefused(SourceStatus.UNAVAILABLE);
        } finally {
            // Never disclose a crop when source cleanup could not be confirmed.
            if (workspace != null && !deleteTree(workspace)) return new CropRefused(SourceStatus.UNAVAILABLE);
        }
    }

    private static FrameSelection selectExactVideoFrame(List<ExtractedFrame> frames, int ordinal, long ptsUs) {
        if (frames == null || frames.isEmpty()) {
            return new FrameSelection(FrameSelectionStatus.NOT_FOUND, null);
        }
        if (frames.size() != 1 || frames.get(0) == null || frames.get(0).getFrameNumber() != ordinal) {
            return new FrameSelection(FrameSelectionStatus.AMBIGUOUS, null);
        }
        SourceMediaTimestamp timestamp = frames.get(0).getSourceTimestamp();
        if (!timestamp.isKnown()) return new FrameSelection(FrameSelectionStatus.UNKNOWN_TIMESTAMP, null);
        return VideoFrameExtractor.selectExactFrameAtUs(frames, ordinal, ptsUs);
    }

    /** Stable local extraction lineage; not a source clock epoch supplied by a provider. */
    private static String artifactLocalEpoch(ArtifactVersion sourceVersion, String streamSelector) {
        String identity = "media-vision-artifact-epoch-v1\0" + sourceVersion.value() + "\0"
                + streamSelector;
        return "artifact-local:" + sha256(identity.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private static boolean artifactIdentityMatches(MediaArtifact artifact, CropRequest request,
                                                    ArtifactVersion expectedVersion) {
        return artifact.tenantId().equals(request.tenantId())
                && artifact.principalId().equals(request.principalId())
                && artifact.artifactId().equals(request.sourceArtifactId())
                && artifact.version().equals(expectedVersion);
    }

    private SourceStatus revalidateLocalFrameRights(CropRequest request, ArtifactVersion sourceVersion) {
        AuthenticatedPrincipal principal = request.authenticatedPrincipal();
        if (!trustedPrincipalMatches(principal, request.tenantId(), request.principalId())) {
            return SourceStatus.NOT_ADMITTED;
        }
        final com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision decision;
        try {
            decision = port.resolveSourceAuthorization(request.tenantId(), request.principalId(),
                    request.sourceArtifactId(), sourceVersion, JobType.VISION, request.purposeRef(), principal);
        } catch (RuntimeException unavailable) {
            return SourceStatus.UNAVAILABLE;
        }
        if (decision == null || decision.status() == null) return SourceStatus.UNAVAILABLE;
        if (decision.status() != com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED) {
            return decision.status() == com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.UNAVAILABLE
                    ? SourceStatus.UNAVAILABLE : SourceStatus.NOT_ADMITTED;
        }
        var evidence = decision.evidence();
        String expectedSha = sourceVersion.value().substring("sha256:".length());
        if (!evidence.tenantId().equals(request.tenantId())
                || !evidence.principalId().equals(request.principalId())
                || !evidence.artifactId().equals(request.sourceArtifactId())
                || !evidence.sourceVersion().equals(sourceVersion)
                || !evidence.sourceSha256().equals(expectedSha)
                || !evidence.operation().equalsIgnoreCase(JobType.VISION.name())
                || !evidence.purpose().equalsIgnoreCase(request.purposeRef())
                || !evidence.currentAt(Clock.systemUTC())) {
            return SourceStatus.NOT_ADMITTED;
        }
        return SourceStatus.ADMITTED;
    }

    private static boolean trustedPrincipalMatches(AuthenticatedPrincipal principal,
                                                   String tenantId, String principalId) {
        return principal != null && principal.tenantId().equals(tenantId)
                && principal.principalId().equals(principalId);
    }

    private static boolean isVideoArtifact(MediaArtifact artifact) {
        return artifact.contentType().toLowerCase(java.util.Locale.ROOT).startsWith("video/")
                && videoExtension(artifact.fileName()) != null;
    }

    private static boolean isStillImageArtifact(MediaArtifact artifact) {
        return artifact.contentType().toLowerCase(java.util.Locale.ROOT).startsWith("image/")
                && videoExtension(artifact.fileName()) == null;
    }

    private static boolean isCanonicalFrameOrdinal(String value) {
        if (value == null || !value.matches("0|[1-9][0-9]{0,7}")) return false;
        try { return Integer.parseInt(value) <= 10_000_000; }
        catch (NumberFormatException malformed) { return false; }
    }

    private static String videoExtension(String fileName) {
        if (fileName == null) return null;
        int dot = fileName.lastIndexOf('.');
        if (dot < 0 || dot == fileName.length() - 1) return null;
        String extension = fileName.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
        return Set.of("mp4", "mov", "mkv", "avi", "webm").contains(extension) ? extension : null;
    }

    private static byte[] encodeCrop(BufferedImage frame, Roi roi) throws IOException {
        BufferedImage cropped = frame.getSubimage(roi.x(), roi.y(), roi.width(), roi.height());
        ByteArrayOutputStream encoded = new ByteArrayOutputStream();
        return ImageIO.write(cropped, "png", encoded) ? encoded.toByteArray() : null;
    }

    private static void setOwnerOnly(Path directory) throws IOException {
        try {
            Files.setPosixFilePermissions(directory, Set.of(PosixFilePermission.OWNER_READ,
                    PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        } catch (UnsupportedOperationException ignored) {
            // The extractor independently rejects unsupported/private workspace layouts.
        }
    }

    private static boolean deleteTree(Path root) {
        boolean clean = true;
        try (var paths = Files.walk(root)) {
            for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) {
                try { Files.deleteIfExists(path); } catch (IOException failure) { clean = false; }
            }
        } catch (IOException ignored) { }
        return clean && !Files.exists(root);
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

    private static final class BoundedFileOutputStream extends OutputStream {
        private final OutputStream delegate;
        private final long maximumBytes;
        private final MessageDigest digest;
        private long size;

        private BoundedFileOutputStream(Path path, long maximumBytes) throws IOException {
            this.maximumBytes = maximumBytes;
            try {
                digest = MessageDigest.getInstance("SHA-256");
            } catch (NoSuchAlgorithmException impossible) {
                throw new IllegalStateException("SHA-256 is required by the Java runtime", impossible);
            }
            try {
                Files.createFile(path, PosixFilePermissions.asFileAttribute(Set.of(
                        PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)));
            } catch (UnsupportedOperationException unsupported) {
                Files.createFile(path);
            }
            delegate = Files.newOutputStream(path, StandardOpenOption.WRITE);
        }

        @Override public void write(int value) throws IOException {
            requireCapacity(1);
            delegate.write(value);
            digest.update((byte) value);
            size++;
        }

        @Override public void write(byte[] bytes, int offset, int length) throws IOException {
            Objects.checkFromIndexSize(offset, length, bytes.length);
            requireCapacity(length);
            delegate.write(bytes, offset, length);
            digest.update(bytes, offset, length);
            size += length;
        }

        private void requireCapacity(int length) throws ContentLimitExceededException {
            if (length > maximumBytes - size) throw new ContentLimitExceededException();
        }

        private long size() { return size; }
        private String sha256() { return HexFormat.of().formatHex(digest.digest()); }
        @Override public void close() throws IOException { delegate.close(); }
    }

    private static final class ContentLimitExceededException extends IOException {
        private ContentLimitExceededException() {
            super("Artifact content exceeded the bounded source read limit");
        }
    }
}
