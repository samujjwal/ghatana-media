package com.ghatana.media.production.rendering;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.OptionalDouble;

/** Bounded temporal RGB frame candidate processor; it does not decode or encode video. */
public final class TemporalVideoRestoration {
    public static final String OPERATION_ID = "media.enhance.video.temporal-denoise";
    public static final String PROFILE_ID = "TEMPORAL_MEDIAN_3FRAME_RGB8_V1";
    public static final String UNSHARP_OPERATION_ID = "media.enhance.video.unsharp-mask";
    public static final String COLOR_OPERATION_ID = "media.enhance.video.rgb-adjustment";
    public static final String UNSHARP_PROFILE_ID = "ROI_BOX_UNSHARP_RGB8_V1";
    public static final String COLOR_PROFILE_ID = "ROI_LINEAR_RGB_ADJUSTMENT_V1";
    public static final int MAX_FRAME_DIMENSION = 2_048;
    public static final int MAX_FRAMES = 64;
    public static final long MAX_TOTAL_PIXELS = 16_000_000L;
    public static final long MAX_TOTAL_RGB_BYTES = 64L * 1024 * 1024;
    private static final String SHA256 = "^[a-fA-F0-9]{64}$";
    private static final String SSIM_ALGORITHM = "GLOBAL_SRGB_LUMA_SSIM_V1";
    private static final String PSNR_ALGORITHM = "RGB8_SAMPLE_PSNR_V1";
    private static final String REFERENCE_METRICS_ALGORITHM = SSIM_ALGORITHM + "+" + PSNR_ALGORITHM;

    private TemporalVideoRestoration() {}

    public enum AuthorityStatus { ALLOWED, DENIED, UNAVAILABLE }
    public enum FilterOperation { TEMPORAL_MEDIAN, UNSHARP_MASK, RGB_COLOR_ADJUSTMENT }
    public enum Outcome { COMPLETED, NOT_ADMITTED, UNAVAILABLE }
    public enum MetricStatus { MEASURED, EXACT_REFERENCE_MATCH, UNAVAILABLE }
    public enum MetricUnavailableReason {
        REFERENCE_NOT_SUPPLIED, REFERENCE_NOT_ADMITTED, REFERENCE_AUTHORITY_UNAVAILABLE, REFERENCE_UNAVAILABLE
    }
    public enum Reason { SOURCE_RIGHTS_DENIED, SOURCE_AUTHORITY_UNAVAILABLE, SOURCE_REVOKED_OR_UNKNOWN,
        REFERENCE_RIGHTS_DENIED, REFERENCE_AUTHORITY_UNAVAILABLE, SOURCE_READ_UNAVAILABLE,
        REFERENCE_READ_UNAVAILABLE }

    /** Exact source and policy identity required by the capability input contract. */
    public record ArtifactBinding(
            String tenantId,
            String principalId,
            String artifactId,
            String versionId,
            String sha256,
            String purposeRef,
            List<String> rightsEvidenceRefs,
            String policyDecisionRef) {
        public ArtifactBinding {
            tenantId = exactText(tenantId, "tenantId", 255);
            principalId = exactText(principalId, "principalId", 255);
            artifactId = opaqueId(artifactId, "artifactId", 128);
            versionId = opaqueId(versionId, "versionId", 128);
            sha256 = exactText(sha256, "sha256", 64).toLowerCase(java.util.Locale.ROOT);
            if (!sha256.matches(SHA256)) throw invalid("sha256 must be a 64-character SHA-256 hex digest");
            purposeRef = exactText(purposeRef, "purposeRef", 256);
            Objects.requireNonNull(rightsEvidenceRefs, "rightsEvidenceRefs");
            rightsEvidenceRefs = boundedListCopy(rightsEvidenceRefs, 1, 32,
                    "rightsEvidenceRefs must contain between 1 and 32 references");
            rightsEvidenceRefs = rightsEvidenceRefs.stream()
                    .map(value -> exactText(value, "rightsEvidenceRef", 256)).distinct().toList();
            if (rightsEvidenceRefs.isEmpty()) throw invalid("rightsEvidenceRefs must be unique");
            policyDecisionRef = exactText(policyDecisionRef, "policyDecisionRef", 384);
        }
    }

    /** A second source used solely as a quality reference; it needs its own authority decision. */
    public record ReferenceBinding(
            String tenantId,
            String principalId,
            String artifactId,
            String versionId,
            String sha256,
            String purposeRef,
            List<String> rightsEvidenceRefs,
            String policyDecisionRef) {
        public ReferenceBinding {
            var normalized = new ArtifactBinding(tenantId, principalId, artifactId, versionId, sha256,
                    purposeRef, rightsEvidenceRefs, policyDecisionRef);
            tenantId = normalized.tenantId();
            principalId = normalized.principalId();
            artifactId = normalized.artifactId();
            versionId = normalized.versionId();
            sha256 = normalized.sha256();
            purposeRef = normalized.purposeRef();
            rightsEvidenceRefs = normalized.rightsEvidenceRefs();
            policyDecisionRef = normalized.policyDecisionRef();
        }
    }

    /** Immutable, caller-versioned local filter parameters. Parameter identity is content-derived. */
    public record FilterParameters(FilterOperation operation, String version, double amount,
            double redGain, double greenGain, double blueGain,
            int redOffset, int greenOffset, int blueOffset) {
        public FilterParameters {
            Objects.requireNonNull(operation, "operation");
            version = opaqueId(version, "parameter version", 128);
            if (!Double.isFinite(amount) || !Double.isFinite(redGain)
                    || !Double.isFinite(greenGain) || !Double.isFinite(blueGain)) {
                throw invalid("filter parameters must be finite");
            }
            switch (operation) {
                case TEMPORAL_MEDIAN -> {
                    if (amount != 0 || redGain != 1 || greenGain != 1 || blueGain != 1
                            || redOffset != 0 || greenOffset != 0 || blueOffset != 0) {
                        throw invalid("temporal median does not accept numeric filter parameters");
                    }
                }
                case UNSHARP_MASK -> {
                    if (amount < 0 || amount > 2 || redGain != 1 || greenGain != 1 || blueGain != 1
                            || redOffset != 0 || greenOffset != 0 || blueOffset != 0) {
                        throw invalid("unsharp amount must be 0..2 and color controls must be identity values");
                    }
                }
                case RGB_COLOR_ADJUSTMENT -> {
                    if (amount != 0 || redGain < 0 || redGain > 4 || greenGain < 0 || greenGain > 4
                            || blueGain < 0 || blueGain > 4 || redOffset < -255 || redOffset > 255
                            || greenOffset < -255 || greenOffset > 255 || blueOffset < -255 || blueOffset > 255) {
                        throw invalid("RGB gains must be 0..4 and offsets must be -255..255");
                    }
                }
            }
        }

        public static FilterParameters temporalMedian() {
            return new FilterParameters(FilterOperation.TEMPORAL_MEDIAN, "1", 0, 1, 1, 1, 0, 0, 0);
        }
        public static FilterParameters unsharpMask(String version, double amount) {
            return new FilterParameters(FilterOperation.UNSHARP_MASK, version, amount, 1, 1, 1, 0, 0, 0);
        }
        public static FilterParameters rgbAdjustment(String version, double redGain, double greenGain,
                double blueGain, int redOffset, int greenOffset, int blueOffset) {
            return new FilterParameters(FilterOperation.RGB_COLOR_ADJUSTMENT, version, 0,
                    redGain, greenGain, blueGain, redOffset, greenOffset, blueOffset);
        }

        public String operationId() {
            return switch (operation) {
                case TEMPORAL_MEDIAN -> OPERATION_ID;
                case UNSHARP_MASK -> UNSHARP_OPERATION_ID;
                case RGB_COLOR_ADJUSTMENT -> COLOR_OPERATION_ID;
            };
        }
        public String profileId() {
            return switch (operation) {
                case TEMPORAL_MEDIAN -> PROFILE_ID;
                case UNSHARP_MASK -> UNSHARP_PROFILE_ID;
                case RGB_COLOR_ADJUSTMENT -> COLOR_PROFILE_ID;
            };
        }
        public String parameterSha256() {
            String canonical = operation.name() + "\n" + version + "\n" + Double.toHexString(amount) + "\n"
                    + Double.toHexString(redGain) + "\n" + Double.toHexString(greenGain) + "\n"
                    + Double.toHexString(blueGain) + "\n" + redOffset + "\n" + greenOffset + "\n" + blueOffset;
            return sha256(canonical.getBytes(StandardCharsets.UTF_8));
        }
    }

    public record RestorationRequest(String requestId, ArtifactBinding source, FilterParameters filter) {
        public RestorationRequest(String requestId, ArtifactBinding source) {
            this(requestId, source, FilterParameters.temporalMedian());
        }
        public RestorationRequest {
            requestId = opaqueId(requestId, "requestId", 128);
            Objects.requireNonNull(source, "source");
            Objects.requireNonNull(filter, "filter");
        }
    }

    public record ReferenceRequest(String requestId, ArtifactBinding reference) {
        public ReferenceRequest {
            requestId = opaqueId(requestId, "requestId", 128);
            Objects.requireNonNull(reference, "reference");
        }
    }

    public record AuthorityDecision(AuthorityStatus status, String decisionId) {
        public AuthorityDecision {
            Objects.requireNonNull(status, "status");
            decisionId = decisionId == null ? "" : decisionId;
            if (!decisionId.isEmpty() && !decisionId.equals(decisionId.strip())) {
                throw invalid("authority decision id must be exact and have no surrounding whitespace");
            }
            if (status == AuthorityStatus.ALLOWED && decisionId.isBlank()) {
                throw invalid("an ALLOWED authority decision requires its exact decision id");
            }
        }
    }

    /** Must recheck current rights at each call; no caller asserted rights are accepted by this API. */
    @FunctionalInterface
    public interface SourceRightsAuthority {
        AuthorityDecision check(ArtifactBinding binding, String operationId);
    }

    @FunctionalInterface
    public interface ReferenceRightsAuthority {
        AuthorityDecision check(ArtifactBinding binding, String purposeRef);
    }

    /** Host decoder adapter; this module consumes only exact-version decoded RGB frames. */
    @FunctionalInterface
    public interface DecodedFrameSource {
        DecodedFrameSequence readExact(ArtifactBinding source);
    }

    /** Host reference adapter; it is called only after the reference rights check allows access. */
    @FunctionalInterface
    public interface DecodedReferenceSource {
        DecodedFrameSequence readExact(ArtifactBinding reference);
    }

    public record TimeBase(int numerator, int denominator) {
        public TimeBase {
            if (numerator < 1 || numerator > 1_000_000 || denominator < 1 || denominator > 1_000_000) {
                throw invalid("timeBase must be a positive bounded rational");
            }
        }
    }

    /** Explicit coordinates; full-frame processing is represented by an explicit full-frame ROI. */
    public record Roi(int x, int y, int width, int height) {
        public Roi {
            if (x < 0 || y < 0 || width < 1 || height < 1) throw invalid("ROI origin and dimensions are invalid");
        }
    }

    /** Defensively copied RGB8 frame. frameSha256 covers the decoded pixel payload only. */
    public record Frame(int frameIndex, long presentationTicks, int width, int height,
            Roi roi, byte[] rgb, String frameSha256) {
        public Frame(int frameIndex, long presentationTicks, int width, int height, Roi roi, byte[] rgb) {
            this(frameIndex, presentationTicks, width, height, roi, rgb, sha256(rgb));
        }

        public Frame {
            if (frameIndex < 0 || frameIndex >= MAX_FRAMES) throw invalid("frameIndex is outside the bounded sequence");
            if (width < 1 || width > MAX_FRAME_DIMENSION || height < 1 || height > MAX_FRAME_DIMENSION) {
                throw invalid("frame dimensions exceed the RGB8 bounds");
            }
            Objects.requireNonNull(roi, "roi");
            if ((long) roi.x() + roi.width() > width || (long) roi.y() + roi.height() > height) {
                throw invalid("ROI is outside the frame bounds");
            }
            Objects.requireNonNull(rgb, "rgb");
            long expectedLength = (long) width * height * 3;
            if (expectedLength > MAX_TOTAL_RGB_BYTES || rgb.length != expectedLength) {
                throw invalid("RGB8 payload length does not match the bounded frame dimensions");
            }
            rgb = rgb.clone();
            frameSha256 = requiredText(frameSha256, "frameSha256", 64).toLowerCase(java.util.Locale.ROOT);
            if (!frameSha256.matches(SHA256) || !sha256(rgb).equals(frameSha256)) {
                throw invalid("frameSha256 does not match the decoded RGB8 payload");
            }
        }

        @Override public byte[] rgb() { return rgb.clone(); }
    }

    /** Exact decoded frame sequence and source lineage observed by the host adapter. */
    public record DecodedFrameSequence(
            String artifactId,
            String versionId,
            String artifactSha256,
            TimeBase timeBase,
            List<Frame> frames) {
        public DecodedFrameSequence {
            artifactId = opaqueId(artifactId, "sequence.artifactId", 128);
            versionId = opaqueId(versionId, "sequence.versionId", 128);
            artifactSha256 = requiredText(artifactSha256, "sequence.artifactSha256", 64).toLowerCase(java.util.Locale.ROOT);
            if (!artifactSha256.matches(SHA256)) throw invalid("sequence artifact SHA-256 is invalid");
            Objects.requireNonNull(timeBase, "timeBase");
            Objects.requireNonNull(frames, "frames");
            frames = boundedListCopy(frames, 3, MAX_FRAMES,
                    "temporal denoising requires between 3 and 64 frames");
            Frame first = frames.getFirst();
            long pixels = 0;
            long previousPts = 0;
            boolean hasPreviousPts = false;
            for (int index = 0; index < frames.size(); index++) {
                Frame frame = Objects.requireNonNull(frames.get(index), "frames[]");
                if (frame.frameIndex() != index) throw invalid("frame indexes must be contiguous and ordered from zero");
                if (hasPreviousPts && frame.presentationTicks() <= previousPts) throw invalid("frame PTS values must strictly increase");
                previousPts = frame.presentationTicks();
                hasPreviousPts = true;
                if (frame.width() != first.width() || frame.height() != first.height() || !frame.roi().equals(first.roi())) {
                    throw invalid("frame dimensions and ROI must remain identical within a sequence");
                }
                pixels = Math.addExact(pixels, (long) frame.width() * frame.height());
            }
            if (pixels > MAX_TOTAL_PIXELS || pixels * 3 > MAX_TOTAL_RGB_BYTES) {
                throw invalid("sequence exceeds the aggregate pixel or RGB byte budget");
            }
        }
    }

    public record CandidateFrame(int frameIndex, long presentationTicks, int width, int height,
            Roi roi, byte[] rgb, String frameSha256) {
        public CandidateFrame {
            if (frameIndex < 0 || frameIndex >= MAX_FRAMES) {
                throw invalid("candidate frameIndex is outside the bounded sequence");
            }
            if (width < 1 || width > MAX_FRAME_DIMENSION || height < 1 || height > MAX_FRAME_DIMENSION) {
                throw invalid("candidate frame dimensions exceed the RGB8 bounds");
            }
            Objects.requireNonNull(roi, "roi");
            if ((long) roi.x() + roi.width() > width || (long) roi.y() + roi.height() > height) {
                throw invalid("candidate ROI is outside the frame bounds");
            }
            Objects.requireNonNull(rgb, "rgb");
            long expectedLength = (long) width * height * 3;
            if (expectedLength > MAX_TOTAL_RGB_BYTES || rgb.length != expectedLength) {
                throw invalid("candidate RGB8 payload length does not match the bounded frame dimensions");
            }
            rgb = rgb.clone();
            frameSha256 = requiredText(frameSha256, "candidate frameSha256", 64).toLowerCase(java.util.Locale.ROOT);
            if (!frameSha256.matches(SHA256) || !sha256(rgb).equals(frameSha256)) {
                throw invalid("candidate frame digest mismatch");
            }
        }
        @Override public byte[] rgb() { return rgb.clone(); }
    }

    public record CandidateLineage(String operationId, String profileId, String methodVersion,
            String requestId, String sourceArtifactId, String sourceVersionId, String sourceSha256,
            String sourceRightsDecisionId, String parameterVersion, String parameterSha256,
            String candidateSha256, String outputDisclosure) {
        public CandidateLineage {
            boolean knownProfile = OPERATION_ID.equals(operationId) && PROFILE_ID.equals(profileId)
                    || UNSHARP_OPERATION_ID.equals(operationId) && UNSHARP_PROFILE_ID.equals(profileId)
                    || COLOR_OPERATION_ID.equals(operationId) && COLOR_PROFILE_ID.equals(profileId);
            if (!knownProfile) {
                throw invalid("candidate lineage must name the exact supported operation and profile");
            }
            methodVersion = requiredText(methodVersion, "methodVersion", 64);
            requestId = opaqueId(requestId, "requestId", 128);
            sourceArtifactId = opaqueId(sourceArtifactId, "sourceArtifactId", 128);
            sourceVersionId = opaqueId(sourceVersionId, "sourceVersionId", 128);
            sourceSha256 = requiredText(sourceSha256, "sourceSha256", 64).toLowerCase(java.util.Locale.ROOT);
            sourceRightsDecisionId = requiredText(sourceRightsDecisionId, "sourceRightsDecisionId", 256);
            parameterVersion = opaqueId(parameterVersion, "parameterVersion", 128);
            parameterSha256 = requiredText(parameterSha256, "parameterSha256", 64).toLowerCase(java.util.Locale.ROOT);
            candidateSha256 = requiredText(candidateSha256, "candidateSha256", 64).toLowerCase(java.util.Locale.ROOT);
            outputDisclosure = requiredText(outputDisclosure, "outputDisclosure", 512);
            if (!sourceSha256.matches(SHA256) || !parameterSha256.matches(SHA256) || !candidateSha256.matches(SHA256)) {
                throw invalid("lineage digests must be SHA-256 values");
            }
        }
    }

    /** Direct source A/B pixel delta, not a perceptual quality or improvement score. */
    public record SourceDelta(long comparedSamples, long changedSamples,
            double meanAbsoluteChange, int maximumAbsoluteChange) {
        public SourceDelta {
            if (comparedSamples < 1 || changedSamples < 0 || changedSamples > comparedSamples
                    || !Double.isFinite(meanAbsoluteChange) || meanAbsoluteChange < 0.0 || meanAbsoluteChange > 255.0
                    || maximumAbsoluteChange < 0 || maximumAbsoluteChange > 255) {
                throw invalid("source A/B delta is outside its valid bounds");
            }
            // One changed sample must equal the reported maximum; every other
            // changed sample contributes at least one. Conversely, no changed
            // sample can exceed that maximum. Check the fields together rather
            // than validating each summary independently.
            double minimumAbsoluteSum = changedSamples == 0 ? 0.0
                    : (double) (changedSamples - 1) + maximumAbsoluteChange;
            double maximumAbsoluteSum = (double) changedSamples * maximumAbsoluteChange;
            double minimumMean = minimumAbsoluteSum / comparedSamples;
            double maximumMean = maximumAbsoluteSum / comparedSamples;
            if (changedSamples == 0 && (maximumAbsoluteChange != 0 || meanAbsoluteChange != 0.0)
                    || changedSamples > 0 && maximumAbsoluteChange == 0
                    || meanAbsoluteChange < minimumMean || meanAbsoluteChange > maximumAbsoluteChange
                    || meanAbsoluteChange > maximumMean) {
                throw invalid("source A/B delta fields are numerically inconsistent");
            }
        }
    }

    public record Psnr(MetricStatus status, OptionalDouble finiteDb) {
        public Psnr {
            Objects.requireNonNull(status, "status");
            Objects.requireNonNull(finiteDb, "finiteDb");
            if (status == MetricStatus.MEASURED && (finiteDb.isEmpty() || !Double.isFinite(finiteDb.getAsDouble())
                    || finiteDb.getAsDouble() < 0.0)) {
                throw invalid("measured RGB8 PSNR must be finite and non-negative");
            }
            if (status != MetricStatus.MEASURED && finiteDb.isPresent()) {
                throw invalid("PSNR dB is available only for a finite measured result");
            }
        }
    }

    public record ReferenceMetrics(MetricStatus status, String referenceArtifactId, String referenceVersionId,
            String referenceSha256, String algorithm, Psnr psnr, OptionalDouble globalLumaSsim,
            Optional<MetricUnavailableReason> unavailableReason) {
        public ReferenceMetrics {
            Objects.requireNonNull(status, "status");
            referenceArtifactId = referenceArtifactId == null ? "" : referenceArtifactId;
            referenceVersionId = referenceVersionId == null ? "" : referenceVersionId;
            referenceSha256 = referenceSha256 == null ? "" : referenceSha256;
            algorithm = algorithm == null ? "" : algorithm;
            Objects.requireNonNull(psnr, "psnr");
            Objects.requireNonNull(globalLumaSsim, "globalLumaSsim");
            Objects.requireNonNull(unavailableReason, "unavailableReason");
            if (status == MetricStatus.UNAVAILABLE) {
                if (unavailableReason.isEmpty() || psnr.status() != MetricStatus.UNAVAILABLE
                        || psnr.finiteDb().isPresent() || globalLumaSsim.isPresent()
                        || !referenceArtifactId.isEmpty() || !referenceVersionId.isEmpty()
                        || !referenceSha256.isEmpty() || !algorithm.isEmpty()) {
                    throw invalid("unavailable reference metrics must not expose measurements or reference identity");
                }
            } else {
                if (unavailableReason.isPresent() || referenceArtifactId.isBlank() || referenceVersionId.isBlank()
                        || !referenceSha256.matches(SHA256)
                        || globalLumaSsim.isEmpty() || !Double.isFinite(globalLumaSsim.getAsDouble())
                        || globalLumaSsim.getAsDouble() < -1.0 || globalLumaSsim.getAsDouble() > 1.0
                        || psnr.status() != status) {
                    throw invalid("available reference metrics require aligned reference identity and finite measurements");
                }
                if (status == MetricStatus.EXACT_REFERENCE_MATCH
                        && (psnr.finiteDb().isPresent() || globalLumaSsim.getAsDouble() != 1.0)) {
                    throw invalid("exact reference matches use infinite PSNR omission and SSIM 1.0");
                }
                if (!REFERENCE_METRICS_ALGORITHM.equals(algorithm)) {
                    throw invalid("available reference metrics require the supported algorithm");
                }
            }
        }
        static ReferenceMetrics unavailable(MetricUnavailableReason reason) {
            return new ReferenceMetrics(MetricStatus.UNAVAILABLE, "", "", "", "",
                    new Psnr(MetricStatus.UNAVAILABLE, OptionalDouble.empty()), OptionalDouble.empty(), Optional.of(reason));
        }
    }

    public record Candidate(List<CandidateFrame> frames, TimeBase timeBase, CandidateLineage lineage,
            SourceDelta sourceDelta, ReferenceMetrics referenceMetrics, long clippedSamples,
            long clippedMagnitude,
            boolean dimensionsPreserved, boolean timingPreserved,
            boolean sourcePixelsPreservedOutsideRoi, boolean improvementClaimed) {
        public Candidate {
            Objects.requireNonNull(frames, "frames");
            frames = boundedListCopy(frames, 3, MAX_FRAMES,
                    "candidate must contain between 3 and 64 ordered frames");
            Objects.requireNonNull(timeBase, "timeBase");
            Objects.requireNonNull(lineage, "lineage");
            Objects.requireNonNull(sourceDelta, "sourceDelta");
            Objects.requireNonNull(referenceMetrics, "referenceMetrics");
            CandidateFrame first = Objects.requireNonNull(frames.getFirst(), "candidate.frames[]");
            long pixels = 0;
            long roiSamples = 0;
            long previousPts = 0;
            boolean hasPreviousPts = false;
            for (int index = 0; index < frames.size(); index++) {
                CandidateFrame frame = Objects.requireNonNull(frames.get(index), "candidate.frames[]");
                if (frame.frameIndex() != index) {
                    throw invalid("candidate frame indexes must be contiguous and ordered from zero");
                }
                if (hasPreviousPts && frame.presentationTicks() <= previousPts) {
                    throw invalid("candidate PTS values must strictly increase");
                }
                previousPts = frame.presentationTicks();
                hasPreviousPts = true;
                if (frame.width() != first.width() || frame.height() != first.height()
                        || !frame.roi().equals(first.roi())) {
                    throw invalid("candidate dimensions and ROI must remain identical within a sequence");
                }
                pixels = Math.addExact(pixels, (long) frame.width() * frame.height());
                roiSamples = Math.addExact(roiSamples,
                        Math.multiplyExact(Math.multiplyExact((long) frame.roi().width(), frame.roi().height()), 3L));
            }
            if (pixels > MAX_TOTAL_PIXELS || pixels * 3 > MAX_TOTAL_RGB_BYTES) {
                throw invalid("candidate exceeds the aggregate pixel or RGB byte budget");
            }
            if (sourceDelta.comparedSamples() != roiSamples) {
                throw invalid("source A/B delta sample count must cover exactly the candidate ROI RGB samples");
            }
            String expectedCandidateSha256 = candidateDigest(timeBase, frames, lineage.profileId(),
                    lineage.parameterVersion(), lineage.parameterSha256());
            if (!lineage.candidateSha256().equals(expectedCandidateSha256)) {
                throw invalid("candidate lineage digest does not match its frame, PTS, timebase, and ROI data");
            }
            if (clippedSamples < 0 || clippedSamples > sourceDelta.comparedSamples() || clippedMagnitude < 0) {
                throw invalid("clipped sample count is outside the compared ROI sample bound");
            }
            long maximumClippedMagnitudePerSample = switch (lineage.profileId()) {
                case PROFILE_ID -> 0L; // A median of RGB8 samples cannot leave the RGB8 range.
                case UNSHARP_PROFILE_ID -> 510L; // amount <= 2 and both sample and ROI blur are in [0,255].
                case COLOR_PROFILE_ID -> 1_020L; // gain <= 4 and offset <= 255.
                default -> throw invalid("candidate lineage names an unsupported filter profile");
            };
            if (clippedSamples == 0 && clippedMagnitude != 0
                    || maximumClippedMagnitudePerSample == 0 && clippedSamples != 0
                    || clippedSamples > 0 && clippedMagnitude < clippedSamples
                    || maximumClippedMagnitudePerSample > 0 && clippedSamples > 0
                            && (clippedMagnitude / clippedSamples > maximumClippedMagnitudePerSample
                                    || clippedMagnitude / clippedSamples == maximumClippedMagnitudePerSample
                                            && clippedMagnitude % clippedSamples != 0)) {
                throw invalid("clipped magnitude is inconsistent with the selected RGB8 filter bounds");
            }
            if (!dimensionsPreserved || !timingPreserved || !sourcePixelsPreservedOutsideRoi || improvementClaimed) {
                throw invalid("candidate must preserve source structure and cannot claim quality improvement");
            }
        }
    }

    public record Result(Outcome outcome, Optional<Candidate> candidate, Optional<Reason> reason) {
        public Result {
            Objects.requireNonNull(outcome, "outcome");
            Objects.requireNonNull(candidate, "candidate");
            Objects.requireNonNull(reason, "reason");
            if (outcome == Outcome.COMPLETED && (candidate.isEmpty() || reason.isPresent())) {
                throw invalid("completed result must contain a candidate and no block reason");
            }
            if (outcome != Outcome.COMPLETED && (candidate.isPresent() || reason.isEmpty())) {
                throw invalid("blocked result must contain a reason and no candidate");
            }
        }
        static Result blocked(Outcome outcome, Reason reason) { return new Result(outcome, Optional.empty(), Optional.of(reason)); }
    }

    public static Result restore(
            RestorationRequest request,
            SourceRightsAuthority sourceAuthority,
            DecodedFrameSource source,
            Optional<ReferenceRequest> referenceRequest,
            DecodedReferenceSource referenceSource,
            ReferenceRightsAuthority referenceAuthority) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(referenceRequest, "referenceRequest");
        if (sourceAuthority == null) {
            return Result.blocked(Outcome.UNAVAILABLE, Reason.SOURCE_AUTHORITY_UNAVAILABLE);
        }
        if (source == null) {
            return Result.blocked(Outcome.UNAVAILABLE, Reason.SOURCE_READ_UNAVAILABLE);
        }
        ArtifactBinding sourceBinding = request.source();
        AuthorityDecision sourceDecision = checkSource(sourceAuthority, sourceBinding, request.filter().operationId());
        if (sourceDecision.status() != AuthorityStatus.ALLOWED) {
            return blockedSource(sourceDecision.status());
        }

        final DecodedFrameSequence original;
        try {
            original = Objects.requireNonNull(source.readExact(sourceBinding), "source frame sequence");
        } catch (RuntimeException readFailure) {
            return Result.blocked(Outcome.UNAVAILABLE, Reason.SOURCE_READ_UNAVAILABLE);
        }
        verifySequenceBinding(original, sourceBinding);
        FilterOutput filtered = applyFilter(original, request.filter());
        List<CandidateFrame> restored = filtered.frames();
        AuthorityDecision sourceBeforeReference = checkSource(sourceAuthority, sourceBinding, request.filter().operationId());
        if (sourceBeforeReference.status() != AuthorityStatus.ALLOWED
                || !sourceBeforeReference.decisionId().equals(sourceDecision.decisionId())) {
            return Result.blocked(sourceBeforeReference.status() == AuthorityStatus.UNAVAILABLE
                    ? Outcome.UNAVAILABLE : Outcome.NOT_ADMITTED, Reason.SOURCE_REVOKED_OR_UNKNOWN);
        }

        ReferenceMetrics metrics = ReferenceMetrics.unavailable(MetricUnavailableReason.REFERENCE_NOT_SUPPLIED);
        ArtifactBinding referenceBinding = null;
        AuthorityDecision referenceDecision = null;
        if (referenceRequest.isPresent() && (referenceSource == null || referenceAuthority == null)) {
            metrics = ReferenceMetrics.unavailable(MetricUnavailableReason.REFERENCE_AUTHORITY_UNAVAILABLE);
        } else if (referenceRequest.isPresent()) {
            referenceBinding = referenceRequest.orElseThrow().reference();
            if (sameImmutableRevision(referenceBinding, sourceBinding)) {
                // A source compared with itself can produce perfect scores, but
                // that is not evidence about restoration quality.
                metrics = ReferenceMetrics.unavailable(MetricUnavailableReason.REFERENCE_NOT_ADMITTED);
            } else if (!referenceBinding.tenantId().equals(sourceBinding.tenantId())
                    || !referenceBinding.principalId().equals(sourceBinding.principalId())) {
                metrics = ReferenceMetrics.unavailable(MetricUnavailableReason.REFERENCE_NOT_ADMITTED);
            } else {
                try {
                    referenceDecision = Objects.requireNonNull(
                            referenceAuthority.check(referenceBinding, referenceBinding.purposeRef()), "reference decision");
                } catch (RuntimeException authorityFailure) {
                    metrics = ReferenceMetrics.unavailable(MetricUnavailableReason.REFERENCE_AUTHORITY_UNAVAILABLE);
                }
                if (referenceDecision != null && referenceDecision.status() == AuthorityStatus.DENIED) {
                    metrics = ReferenceMetrics.unavailable(MetricUnavailableReason.REFERENCE_NOT_ADMITTED);
                } else if (referenceDecision != null && referenceDecision.status() == AuthorityStatus.UNAVAILABLE) {
                    metrics = ReferenceMetrics.unavailable(MetricUnavailableReason.REFERENCE_AUTHORITY_UNAVAILABLE);
                } else if (referenceDecision != null && referenceDecision.status() == AuthorityStatus.ALLOWED) {
                    try {
                        DecodedFrameSequence reference = Objects.requireNonNull(
                                referenceSource.readExact(referenceBinding), "reference frame sequence");
                        verifySequenceBinding(reference, referenceBinding);
                        metrics = compare(restored, original, reference, referenceBinding);
                    } catch (InvalidRestorationInputException invalidReference) {
                        throw invalidReference;
                    } catch (RuntimeException referenceUnavailable) {
                        metrics = ReferenceMetrics.unavailable(MetricUnavailableReason.REFERENCE_UNAVAILABLE);
                    }
                }
            }
        }

        AuthorityDecision current = checkSource(sourceAuthority, sourceBinding, request.filter().operationId());
        if (current.status() != AuthorityStatus.ALLOWED || !current.decisionId().equals(sourceDecision.decisionId())) {
            return Result.blocked(current.status() == AuthorityStatus.UNAVAILABLE
                    ? Outcome.UNAVAILABLE : Outcome.NOT_ADMITTED, Reason.SOURCE_REVOKED_OR_UNKNOWN);
        }
        if (referenceBinding != null && referenceDecision != null && referenceDecision.status() == AuthorityStatus.ALLOWED) {
            final AuthorityDecision referenceCurrent;
            try {
                referenceCurrent = Objects.requireNonNull(
                        referenceAuthority.check(referenceBinding, referenceBinding.purposeRef()), "reference decision");
            } catch (RuntimeException authorityFailure) {
                metrics = ReferenceMetrics.unavailable(MetricUnavailableReason.REFERENCE_AUTHORITY_UNAVAILABLE);
                return completed(request, sourceBinding, sourceDecision, original, filtered, metrics);
            }
            if (referenceCurrent.status() != AuthorityStatus.ALLOWED
                    || !referenceCurrent.decisionId().equals(referenceDecision.decisionId())) {
                metrics = ReferenceMetrics.unavailable(referenceCurrent.status() == AuthorityStatus.DENIED
                        ? MetricUnavailableReason.REFERENCE_NOT_ADMITTED : MetricUnavailableReason.REFERENCE_AUTHORITY_UNAVAILABLE);
            }
        }
        return completed(request, sourceBinding, sourceDecision, original, filtered, metrics);
    }

    private static Result completed(RestorationRequest request, ArtifactBinding binding, AuthorityDecision decision,
            DecodedFrameSequence original, FilterOutput filtered, ReferenceMetrics metrics) {
        FilterParameters filter = request.filter();
        List<CandidateFrame> frames = filtered.frames();
        String candidateDigest = candidateDigest(original.timeBase(), frames, filter);
        CandidateLineage lineage = new CandidateLineage(filter.operationId(), filter.profileId(), "1", request.requestId(),
                binding.artifactId(), binding.versionId(), binding.sha256(), decision.decisionId(),
                filter.version(), filter.parameterSha256(), candidateDigest, disclosure(filter));
        Candidate candidate = new Candidate(frames, original.timeBase(), lineage,
                sourceDelta(original, frames), metrics, filtered.clippedSamples(), filtered.clippedMagnitude(),
                true, true, true, false);
        return new Result(Outcome.COMPLETED, Optional.of(candidate), Optional.empty());
    }

    private static AuthorityDecision checkSource(SourceRightsAuthority authority, ArtifactBinding binding, String operationId) {
        try {
            return Objects.requireNonNull(authority.check(binding, operationId), "source authority decision");
        } catch (RuntimeException unavailable) {
            return new AuthorityDecision(AuthorityStatus.UNAVAILABLE, "");
        }
    }

    private static Result blockedSource(AuthorityStatus status) {
        return Result.blocked(status == AuthorityStatus.UNAVAILABLE ? Outcome.UNAVAILABLE : Outcome.NOT_ADMITTED,
                status == AuthorityStatus.DENIED ? Reason.SOURCE_RIGHTS_DENIED : Reason.SOURCE_AUTHORITY_UNAVAILABLE);
    }

    private record FilterOutput(List<CandidateFrame> frames, long clippedSamples, long clippedMagnitude) {
        private FilterOutput { frames = List.copyOf(frames); }
    }

    private static FilterOutput applyFilter(DecodedFrameSequence sequence, FilterParameters filter) {
        if (filter.operation() == FilterOperation.TEMPORAL_MEDIAN) return new FilterOutput(temporalMedian(sequence), 0, 0);
        List<Frame> inputs = sequence.frames();
        ArrayList<CandidateFrame> outputs = new ArrayList<>(inputs.size());
        long clippedSamples = 0;
        long clippedMagnitude = 0;
        double[] gains = {filter.redGain(), filter.greenGain(), filter.blueGain()};
        int[] offsets = {filter.redOffset(), filter.greenOffset(), filter.blueOffset()};
        for (int index = 0; index < inputs.size(); index++) {
            Frame center = inputs.get(index);
            byte[] input = center.rgb();
            byte[] output = input.clone();
            Roi roi = center.roi();
            for (int y = roi.y(); y < roi.y() + roi.height(); y++) {
                for (int x = roi.x(); x < roi.x() + roi.width(); x++) {
                    int offset = (y * center.width() + x) * 3;
                    if (filter.operation() == FilterOperation.UNSHARP_MASK) {
                        for (int channel = 0; channel < 3; channel++) {
                            double blur = roiBoxBlur(input, center.width(), roi, x, y, channel);
                            int original = input[offset + channel] & 0xff;
                            long rounded = Math.round(original + filter.amount() * (original - blur));
                            if (rounded < 0 || rounded > 255) {
                                clippedSamples++;
                                clippedMagnitude += rounded < 0 ? -rounded : rounded - 255;
                            }
                            output[offset + channel] = (byte) clamp8(rounded);
                        }
                    } else {
                        for (int channel = 0; channel < 3; channel++) {
                            int original = input[offset + channel] & 0xff;
                            long rounded = Math.round(original * gains[channel] + offsets[channel]);
                            if (rounded < 0 || rounded > 255) {
                                clippedSamples++;
                                clippedMagnitude += rounded < 0 ? -rounded : rounded - 255;
                            }
                            output[offset + channel] = (byte) clamp8(rounded);
                        }
                    }
                }
            }
            outputs.add(new CandidateFrame(center.frameIndex(), center.presentationTicks(), center.width(),
                    center.height(), center.roi(), output, sha256(output)));
        }
        return new FilterOutput(outputs, clippedSamples, clippedMagnitude);
    }

    private static List<CandidateFrame> temporalMedian(DecodedFrameSequence sequence) {
        List<Frame> inputs = sequence.frames();
        ArrayList<CandidateFrame> outputs = new ArrayList<>(inputs.size());
        for (int index = 0; index < inputs.size(); index++) {
            Frame center = inputs.get(index);
            // Frames are immutable snapshots owned by this class. Read the private arrays
            // directly and clone only the output buffer; the public rgb() accessor remains defensive.
            byte[] centerBytes = center.rgb;
            byte[] output = centerBytes.clone();
            byte[] leftBytes = inputs.get(Math.max(0, index - 1)).rgb;
            byte[] rightBytes = inputs.get(Math.min(inputs.size() - 1, index + 1)).rgb;
            Roi roi = center.roi();
            for (int y = roi.y(); y < roi.y() + roi.height(); y++) {
                for (int x = roi.x(); x < roi.x() + roi.width(); x++) {
                    int offset = (y * center.width() + x) * 3;
                    for (int channel = 0; channel < 3; channel++) {
                        output[offset + channel] = (byte) median(leftBytes[offset + channel] & 0xff,
                                centerBytes[offset + channel] & 0xff, rightBytes[offset + channel] & 0xff);
                    }
                }
            }
            outputs.add(new CandidateFrame(center.frameIndex(), center.presentationTicks(), center.width(),
                    center.height(), center.roi(), output, sha256(output)));
        }
        return List.copyOf(outputs);
    }

    /** 3x3 RGB sample mean with edge coordinates clamped to the explicit ROI. */
    private static double roiBoxBlur(byte[] rgb, int width, Roi roi, int x, int y, int channel) {
        int sum = 0;
        for (int dy = -1; dy <= 1; dy++) {
            int sampleY = Math.max(roi.y(), Math.min(roi.y() + roi.height() - 1, y + dy));
            for (int dx = -1; dx <= 1; dx++) {
                int sampleX = Math.max(roi.x(), Math.min(roi.x() + roi.width() - 1, x + dx));
                sum += rgb[(sampleY * width + sampleX) * 3 + channel] & 0xff;
            }
        }
        return (double) sum / 9.0;
    }

    private static int clamp8(long value) { return (int) Math.max(0, Math.min(255, value)); }

    private static String disclosure(FilterParameters filter) {
        return switch (filter.operation()) {
            case TEMPORAL_MEDIAN -> "Applied a per-channel three-frame median. Frame order, dimensions, PTS, rational time base, source revision and pixels outside ROI were preserved. No deblur, color reconstruction, codec output or quality improvement is claimed.";
            case UNSHARP_MASK -> "Applied RGB8 ROI 3x3 box-blur unsharp mask: Java Math.round(original + amount*(original - blur)), then clamp to [0,255]. Math.round ties toward positive infinity; edge samples clamp within ROI; clipped sample count and magnitude are reported separately. No codec output or quality improvement is claimed.";
            case RGB_COLOR_ADJUSTMENT -> "Applied caller-versioned per-channel RGB8 gain/offset: Java Math.round(sample*gain + offset), then clamp to [0,255]. Math.round ties toward positive infinity; clipped sample count and magnitude are reported separately. No automatic color inference, codec output or quality improvement is claimed.";
        };
    }

    private static ReferenceMetrics compare(List<CandidateFrame> candidate, DecodedFrameSequence source,
            DecodedFrameSequence reference, ArtifactBinding referenceBinding) {
        if (!source.timeBase().equals(reference.timeBase()) || candidate.size() != reference.frames().size()) {
            throw invalid("reference frame sequence must align exactly with candidate time base and frame count");
        }
        long squaredError = 0;
        long sampleCount = 0;
        double meanA = 0;
        double meanB = 0;
        double sumAA = 0;
        double sumBB = 0;
        double sumAB = 0;
        long lumaCount = 0;
        for (int i = 0; i < candidate.size(); i++) {
            CandidateFrame candidateFrame = candidate.get(i);
            Frame sourceFrame = source.frames().get(i);
            Frame referenceFrame = reference.frames().get(i);
            if (candidateFrame.frameIndex() != referenceFrame.frameIndex()
                    || candidateFrame.presentationTicks() != referenceFrame.presentationTicks()
                    || candidateFrame.width() != referenceFrame.width()
                    || candidateFrame.height() != referenceFrame.height()
                    || !candidateFrame.roi().equals(referenceFrame.roi())
                    || !candidateFrame.roi().equals(sourceFrame.roi())) {
                throw invalid("reference frames must match candidate index, PTS, dimensions, and ROI exactly");
            }
            byte[] actual = candidateFrame.rgb();
            byte[] expected = referenceFrame.rgb();
            Roi roi = candidateFrame.roi();
            for (int y = roi.y(); y < roi.y() + roi.height(); y++) {
                for (int x = roi.x(); x < roi.x() + roi.width(); x++) {
                    int offset = (y * candidateFrame.width() + x) * 3;
                    for (int channel = 0; channel < 3; channel++) {
                        int av = actual[offset + channel] & 0xff;
                        int bv = expected[offset + channel] & 0xff;
                        long error = av - bv;
                        squaredError = Math.addExact(squaredError, error * error);
                        sampleCount++;
                    }
                    double lumaA = luma(actual, offset);
                    double lumaB = luma(expected, offset);
                    lumaCount++;
                    double deltaA = lumaA - meanA;
                    double deltaB = lumaB - meanB;
                    meanA += deltaA / lumaCount;
                    meanB += deltaB / lumaCount;
                    sumAA += deltaA * (lumaA - meanA);
                    sumBB += deltaB * (lumaB - meanB);
                    sumAB += deltaA * (lumaB - meanB);
                }
            }
        }
        if (sampleCount == 0 || lumaCount == 0) throw invalid("reference comparison contains no ROI samples");
        double mse = (double) squaredError / sampleCount;
        boolean exact = squaredError == 0;
        OptionalDouble psnr = exact ? OptionalDouble.empty()
                : OptionalDouble.of(10.0 * Math.log10((255.0 * 255.0) / mse));
        double globalMeanA = meanA;
        double globalMeanB = meanB;
        double varianceA = Math.max(0.0, sumAA / lumaCount);
        double varianceB = Math.max(0.0, sumBB / lumaCount);
        double covariance = sumAB / lumaCount;
        double c1 = Math.pow(0.01 * 255.0, 2);
        double c2 = Math.pow(0.03 * 255.0, 2);
        double ssim = ((2 * globalMeanA * globalMeanB + c1) * (2 * covariance + c2))
                / ((globalMeanA * globalMeanA + globalMeanB * globalMeanB + c1) * (varianceA + varianceB + c2));
        if (!Double.isFinite(ssim)) throw invalid("reference SSIM calculation was not finite");
        return new ReferenceMetrics(exact ? MetricStatus.EXACT_REFERENCE_MATCH : MetricStatus.MEASURED,
                referenceBinding.artifactId(), referenceBinding.versionId(), referenceBinding.sha256(),
                REFERENCE_METRICS_ALGORITHM,
                new Psnr(exact ? MetricStatus.EXACT_REFERENCE_MATCH : MetricStatus.MEASURED, psnr),
                OptionalDouble.of(Math.max(-1.0, Math.min(1.0, ssim))), Optional.empty());
    }

    private static SourceDelta sourceDelta(DecodedFrameSequence source, List<CandidateFrame> candidate) {
        long comparedSamples = 0;
        long changedSamples = 0;
        long absoluteSum = 0;
        int maximum = 0;
        for (int index = 0; index < source.frames().size(); index++) {
            Frame before = source.frames().get(index);
            CandidateFrame after = candidate.get(index);
            byte[] left = before.rgb();
            byte[] right = after.rgb();
            Roi roi = before.roi();
            for (int y = roi.y(); y < roi.y() + roi.height(); y++) {
                for (int x = roi.x(); x < roi.x() + roi.width(); x++) {
                    int offset = (y * before.width() + x) * 3;
                    for (int channel = 0; channel < 3; channel++) {
                        int delta = Math.abs((left[offset + channel] & 0xff) - (right[offset + channel] & 0xff));
                        comparedSamples++;
                        if (delta != 0) changedSamples++;
                        absoluteSum += delta;
                        maximum = Math.max(maximum, delta);
                    }
                }
            }
        }
        return new SourceDelta(comparedSamples, changedSamples, (double) absoluteSum / comparedSamples, maximum);
    }

    private static int median(int a, int b, int c) {
        if (a > b) { int t = a; a = b; b = t; }
        if (b > c) { int t = b; b = c; c = t; }
        return Math.max(a, b);
    }

    private static double luma(byte[] rgb, int offset) {
        return 0.2126 * (rgb[offset] & 0xff)
                + 0.7152 * (rgb[offset + 1] & 0xff)
                + 0.0722 * (rgb[offset + 2] & 0xff);
    }

    private static void verifySequenceBinding(DecodedFrameSequence sequence, ArtifactBinding expected) {
        if (!sequence.artifactId().equals(expected.artifactId())
                || !sequence.versionId().equals(expected.versionId())
                || !sequence.artifactSha256().equals(expected.sha256())) {
            throw invalid("frame source did not return the exact requested source artifact version");
        }
    }

    private static boolean sameImmutableRevision(ArtifactBinding left, ArtifactBinding right) {
        return left.tenantId().equals(right.tenantId())
                && left.artifactId().equals(right.artifactId())
                && left.versionId().equals(right.versionId());
    }

    private static String candidateDigest(TimeBase timeBase, List<CandidateFrame> frames, FilterParameters filter) {
        return candidateDigest(timeBase, frames, filter.profileId(), filter.version(), filter.parameterSha256());
    }

    private static String candidateDigest(TimeBase timeBase, List<CandidateFrame> frames,
            String profileId, String parameterVersion, String parameterSha256) {
        MessageDigest digest = digest();
        digest.update((profileId + "\n" + parameterVersion + "\n" + parameterSha256 + "\n"
                + timeBase.numerator() + "/" + timeBase.denominator() + "\n")
                .getBytes(StandardCharsets.UTF_8));
        for (CandidateFrame frame : frames) {
            digest.update(ByteBuffer.allocate(Integer.BYTES + Long.BYTES + Integer.BYTES * 4)
                    .putInt(frame.frameIndex()).putLong(frame.presentationTicks()).putInt(frame.width())
                    .putInt(frame.height()).putInt(frame.roi().x()).putInt(frame.roi().y()).array());
            digest.update(ByteBuffer.allocate(Integer.BYTES * 2).putInt(frame.roi().width()).putInt(frame.roi().height()).array());
            digest.update(HexFormat.of().parseHex(frame.frameSha256()));
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    /** Copies from the actual iterator, checking the ceiling before consuming item ceiling + 1. */
    private static <T> List<T> boundedListCopy(List<T> input, int minimum, int maximum, String message) {
        ArrayList<T> copy = new ArrayList<>(Math.min(maximum, 16));
        Iterator<T> iterator = input.iterator();
        while (iterator.hasNext()) {
            if (copy.size() == maximum) throw invalid(message);
            copy.add(iterator.next());
        }
        if (copy.size() < minimum) throw invalid(message);
        return List.copyOf(copy);
    }

    private static String sha256(byte[] bytes) {
        Objects.requireNonNull(bytes, "bytes");
        return HexFormat.of().formatHex(digest().digest(bytes));
    }

    private static MessageDigest digest() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException("SHA-256 is required", impossible); }
    }

    private static String requiredText(String value, String field, int maximum) {
        Objects.requireNonNull(value, field);
        String trimmed = value.trim();
        if (trimmed.isEmpty() || value.codePoints().allMatch(TemporalVideoRestoration::isUnicodeWhitespace)
                || trimmed.length() > maximum || trimmed.chars().anyMatch(Character::isISOControl)) {
            throw invalid(field + " must be non-empty bounded printable text");
        }
        return trimmed;
    }

    private static String exactText(String value, String field, int maximum) {
        String text = requiredText(value, field, maximum);
        if (!value.equals(text) || hasOuterUnicodeWhitespace(value)) {
            throw invalid(field + " must not contain outer whitespace");
        }
        return text;
    }

    private static boolean hasOuterUnicodeWhitespace(String value) {
        return isUnicodeWhitespace(value.codePointAt(0))
                || isUnicodeWhitespace(value.codePointBefore(value.length()));
    }

    private static boolean isUnicodeWhitespace(int codePoint) {
        return Character.isWhitespace(codePoint) || Character.isSpaceChar(codePoint);
    }

    private static String opaqueId(String value, String field, int maximum) {
        String text = requiredText(value, field, maximum);
        if (!text.matches("[A-Za-z0-9][A-Za-z0-9._:+-]*")) throw invalid(field + " must be an opaque identifier");
        return text;
    }

    private static InvalidRestorationInputException invalid(String message) {
        return new InvalidRestorationInputException(message);
    }

    public static final class InvalidRestorationInputException extends IllegalArgumentException {
        private static final long serialVersionUID = 1L;
        public InvalidRestorationInputException(String message) { super(message); }
    }
}
