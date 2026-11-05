package com.ghatana.media.production.rendering;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.OptionalDouble;

/** Bounded temporal RGB frame candidate processor; it does not decode or encode video. */
public final class TemporalVideoRestoration {
    public static final String OPERATION_ID = "media.enhance.video.temporal-denoise";
    public static final String PROFILE_ID = "TEMPORAL_MEDIAN_3FRAME_RGB8_V1";
    public static final int MAX_FRAME_DIMENSION = 2_048;
    public static final int MAX_FRAMES = 64;
    public static final long MAX_TOTAL_PIXELS = 16_000_000L;
    public static final long MAX_TOTAL_RGB_BYTES = 64L * 1024 * 1024;
    private static final String SHA256 = "^[a-fA-F0-9]{64}$";
    private static final String SSIM_ALGORITHM = "GLOBAL_SRGB_LUMA_SSIM_V1";
    private static final String PSNR_ALGORITHM = "RGB8_SAMPLE_PSNR_V1";

    private TemporalVideoRestoration() {}

    public enum AuthorityStatus { ALLOWED, DENIED, UNAVAILABLE }
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
            tenantId = requiredText(tenantId, "tenantId", 255);
            principalId = requiredText(principalId, "principalId", 255);
            artifactId = opaqueId(artifactId, "artifactId", 128);
            versionId = opaqueId(versionId, "versionId", 128);
            sha256 = requiredText(sha256, "sha256", 64).toLowerCase(java.util.Locale.ROOT);
            if (!sha256.matches(SHA256)) throw invalid("sha256 must be a 64-character SHA-256 hex digest");
            purposeRef = requiredText(purposeRef, "purposeRef", 256);
            Objects.requireNonNull(rightsEvidenceRefs, "rightsEvidenceRefs");
            if (rightsEvidenceRefs.isEmpty() || rightsEvidenceRefs.size() > 32) {
                throw invalid("rightsEvidenceRefs must contain between 1 and 32 references");
            }
            rightsEvidenceRefs = rightsEvidenceRefs.stream()
                    .map(value -> requiredText(value, "rightsEvidenceRef", 256)).distinct().toList();
            if (rightsEvidenceRefs.isEmpty()) throw invalid("rightsEvidenceRefs must be unique");
            policyDecisionRef = requiredText(policyDecisionRef, "policyDecisionRef", 384);
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

    public record RestorationRequest(String requestId, ArtifactBinding source) {
        public RestorationRequest {
            requestId = opaqueId(requestId, "requestId", 128);
            Objects.requireNonNull(source, "source");
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
            decisionId = decisionId == null ? "" : decisionId.trim();
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
            if (presentationTicks < 0) throw invalid("presentationTicks must be non-negative");
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
            if (frames.size() < 3 || frames.size() > MAX_FRAMES) {
                throw invalid("temporal denoising requires between 3 and 64 frames");
            }
            frames = List.copyOf(frames);
            Frame first = frames.getFirst();
            long pixels = 0;
            long previousPts = -1;
            for (int index = 0; index < frames.size(); index++) {
                Frame frame = Objects.requireNonNull(frames.get(index), "frames[]");
                if (frame.frameIndex() != index) throw invalid("frame indexes must be contiguous and ordered from zero");
                if (frame.presentationTicks() <= previousPts) throw invalid("frame PTS values must strictly increase");
                previousPts = frame.presentationTicks();
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
            Objects.requireNonNull(roi, "roi");
            Objects.requireNonNull(rgb, "rgb");
            rgb = rgb.clone();
            if (!sha256(rgb).equals(frameSha256)) throw invalid("candidate frame digest mismatch");
        }
        @Override public byte[] rgb() { return rgb.clone(); }
    }

    public record CandidateLineage(String operationId, String profileId, String methodVersion,
            String requestId, String sourceArtifactId, String sourceVersionId, String sourceSha256,
            String sourceRightsDecisionId, String candidateSha256, String outputDisclosure) {
        public CandidateLineage {
            if (!OPERATION_ID.equals(operationId) || !PROFILE_ID.equals(profileId)) {
                throw invalid("candidate lineage must name the exact supported operation and profile");
            }
            methodVersion = requiredText(methodVersion, "methodVersion", 64);
            requestId = opaqueId(requestId, "requestId", 128);
            sourceArtifactId = opaqueId(sourceArtifactId, "sourceArtifactId", 128);
            sourceVersionId = opaqueId(sourceVersionId, "sourceVersionId", 128);
            sourceSha256 = requiredText(sourceSha256, "sourceSha256", 64).toLowerCase(java.util.Locale.ROOT);
            sourceRightsDecisionId = requiredText(sourceRightsDecisionId, "sourceRightsDecisionId", 256);
            candidateSha256 = requiredText(candidateSha256, "candidateSha256", 64).toLowerCase(java.util.Locale.ROOT);
            outputDisclosure = requiredText(outputDisclosure, "outputDisclosure", 512);
            if (!sourceSha256.matches(SHA256) || !candidateSha256.matches(SHA256)) {
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
        }
    }

    public record Psnr(MetricStatus status, OptionalDouble finiteDb) {
        public Psnr {
            Objects.requireNonNull(status, "status");
            Objects.requireNonNull(finiteDb, "finiteDb");
            if (status == MetricStatus.MEASURED && (finiteDb.isEmpty() || !Double.isFinite(finiteDb.getAsDouble()))) {
                throw invalid("measured PSNR must be a finite value");
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
        }
        static ReferenceMetrics unavailable(MetricUnavailableReason reason) {
            return new ReferenceMetrics(MetricStatus.UNAVAILABLE, "", "", "", "",
                    new Psnr(MetricStatus.UNAVAILABLE, OptionalDouble.empty()), OptionalDouble.empty(), Optional.of(reason));
        }
    }

    public record Candidate(List<CandidateFrame> frames, TimeBase timeBase, CandidateLineage lineage,
            SourceDelta sourceDelta, ReferenceMetrics referenceMetrics, boolean dimensionsPreserved, boolean timingPreserved,
            boolean sourcePixelsPreservedOutsideRoi, boolean improvementClaimed) {
        public Candidate {
            frames = List.copyOf(Objects.requireNonNull(frames, "frames"));
            Objects.requireNonNull(timeBase, "timeBase");
            Objects.requireNonNull(lineage, "lineage");
            Objects.requireNonNull(sourceDelta, "sourceDelta");
            Objects.requireNonNull(referenceMetrics, "referenceMetrics");
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
        AuthorityDecision sourceDecision = checkSource(sourceAuthority, sourceBinding);
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
        List<CandidateFrame> restored = temporalMedian(original);
        AuthorityDecision sourceBeforeReference = checkSource(sourceAuthority, sourceBinding);
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
            if (!referenceBinding.tenantId().equals(sourceBinding.tenantId())
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

        AuthorityDecision current = checkSource(sourceAuthority, sourceBinding);
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
                return completed(request, sourceBinding, sourceDecision, original, restored, metrics);
            }
            if (referenceCurrent.status() != AuthorityStatus.ALLOWED
                    || !referenceCurrent.decisionId().equals(referenceDecision.decisionId())) {
                metrics = ReferenceMetrics.unavailable(referenceCurrent.status() == AuthorityStatus.DENIED
                        ? MetricUnavailableReason.REFERENCE_NOT_ADMITTED : MetricUnavailableReason.REFERENCE_AUTHORITY_UNAVAILABLE);
            }
        }
        return completed(request, sourceBinding, sourceDecision, original, restored, metrics);
    }

    private static Result completed(RestorationRequest request, ArtifactBinding binding, AuthorityDecision decision,
            DecodedFrameSequence original, List<CandidateFrame> frames, ReferenceMetrics metrics) {
        String candidateDigest = candidateDigest(original.timeBase(), frames);
        CandidateLineage lineage = new CandidateLineage(OPERATION_ID, PROFILE_ID, "1", request.requestId(),
                binding.artifactId(), binding.versionId(), binding.sha256(), decision.decisionId(), candidateDigest,
                "Only temporal median RGB8 denoising was produced; decoded pixels, dimensions, PTS, time base and explicit ROI were preserved. No deblur, color reconstruction, resolution increase, codec output, or subjective quality improvement is claimed.");
        Candidate candidate = new Candidate(frames, original.timeBase(), lineage,
                sourceDelta(original, frames), metrics, true, true, true, false);
        return new Result(Outcome.COMPLETED, Optional.of(candidate), Optional.empty());
    }

    private static AuthorityDecision checkSource(SourceRightsAuthority authority, ArtifactBinding binding) {
        try {
            return Objects.requireNonNull(authority.check(binding, OPERATION_ID), "source authority decision");
        } catch (RuntimeException unavailable) {
            return new AuthorityDecision(AuthorityStatus.UNAVAILABLE, "");
        }
    }

    private static Result blockedSource(AuthorityStatus status) {
        return Result.blocked(status == AuthorityStatus.UNAVAILABLE ? Outcome.UNAVAILABLE : Outcome.NOT_ADMITTED,
                status == AuthorityStatus.DENIED ? Reason.SOURCE_RIGHTS_DENIED : Reason.SOURCE_AUTHORITY_UNAVAILABLE);
    }

    private static List<CandidateFrame> temporalMedian(DecodedFrameSequence sequence) {
        List<Frame> inputs = sequence.frames();
        ArrayList<CandidateFrame> outputs = new ArrayList<>(inputs.size());
        for (int index = 0; index < inputs.size(); index++) {
            Frame center = inputs.get(index);
            byte[] output = center.rgb();
            Frame left = inputs.get(Math.max(0, index - 1));
            Frame right = inputs.get(Math.min(inputs.size() - 1, index + 1));
            byte[] leftBytes = left.rgb();
            byte[] centerBytes = center.rgb();
            byte[] rightBytes = right.rgb();
            Roi roi = center.roi();
            for (int y = roi.y(); y < roi.y() + roi.height(); y++) {
                for (int x = roi.x(); x < roi.x() + roi.width(); x++) {
                    int offset = (y * center.width() + x) * 3;
                    for (int channel = 0; channel < 3; channel++) {
                        int a = leftBytes[offset + channel] & 0xff;
                        int b = centerBytes[offset + channel] & 0xff;
                        int c = rightBytes[offset + channel] & 0xff;
                        output[offset + channel] = (byte) median(a, b, c);
                    }
                }
            }
            outputs.add(new CandidateFrame(center.frameIndex(), center.presentationTicks(), center.width(),
                    center.height(), center.roi(), output, sha256(output)));
        }
        return List.copyOf(outputs);
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
                    meanA += lumaA;
                    meanB += lumaB;
                    sumAA += lumaA * lumaA;
                    sumBB += lumaB * lumaB;
                    sumAB += lumaA * lumaB;
                    lumaCount++;
                }
            }
        }
        if (sampleCount == 0 || lumaCount == 0) throw invalid("reference comparison contains no ROI samples");
        double mse = (double) squaredError / sampleCount;
        boolean exact = squaredError == 0;
        OptionalDouble psnr = exact ? OptionalDouble.empty()
                : OptionalDouble.of(10.0 * Math.log10((255.0 * 255.0) / mse));
        double globalMeanA = meanA / lumaCount;
        double globalMeanB = meanB / lumaCount;
        double varianceA = Math.max(0.0, sumAA / lumaCount - globalMeanA * globalMeanA);
        double varianceB = Math.max(0.0, sumBB / lumaCount - globalMeanB * globalMeanB);
        double covariance = sumAB / lumaCount - globalMeanA * globalMeanB;
        double c1 = Math.pow(0.01 * 255.0, 2);
        double c2 = Math.pow(0.03 * 255.0, 2);
        double ssim = ((2 * globalMeanA * globalMeanB + c1) * (2 * covariance + c2))
                / ((globalMeanA * globalMeanA + globalMeanB * globalMeanB + c1) * (varianceA + varianceB + c2));
        if (!Double.isFinite(ssim)) throw invalid("reference SSIM calculation was not finite");
        return new ReferenceMetrics(exact ? MetricStatus.EXACT_REFERENCE_MATCH : MetricStatus.MEASURED,
                referenceBinding.artifactId(), referenceBinding.versionId(), referenceBinding.sha256(),
                SSIM_ALGORITHM + "+" + PSNR_ALGORITHM,
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

    private static String candidateDigest(TimeBase timeBase, List<CandidateFrame> frames) {
        MessageDigest digest = digest();
        digest.update((PROFILE_ID + "\n" + timeBase.numerator() + "/" + timeBase.denominator() + "\n")
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
        if (trimmed.isEmpty() || trimmed.length() > maximum || trimmed.chars().anyMatch(Character::isISOControl)) {
            throw invalid(field + " must be non-empty bounded printable text");
        }
        return trimmed;
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
