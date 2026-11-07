package com.ghatana.media.production.rendering;

import org.junit.jupiter.api.Test;

import java.util.AbstractList;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import java.security.MessageDigest;
import java.util.HexFormat;

import static com.ghatana.media.production.rendering.TemporalVideoRestoration.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TemporalVideoRestorationTest {
    private static final String SOURCE_SHA = "a".repeat(64);
    private static final String REF_SHA = "b".repeat(64);
    private static final TimeBase TIME_BASE = new TimeBase(1, 30);

    @Test
    void authorityDecisionIdentityRejectsWhitespaceInsteadOfNormalizingRightsEvidence() {
        assertThatThrownBy(() -> new AuthorityDecision(AuthorityStatus.ALLOWED, " decision-v1 "))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("exact");
        assertThatThrownBy(() -> new AuthorityDecision(AuthorityStatus.DENIED, " denied-decision "))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("exact");
        assertThat(new AuthorityDecision(AuthorityStatus.ALLOWED, "decision-v1").decisionId())
                .isEqualTo("decision-v1");
    }

    @Test
    void artifactBindingRejectsOuterWhitespaceInsteadOfChangingIdentityOrRightsReferences() {
        assertThatThrownBy(() -> new ArtifactBinding(" tenant-a", "principal-a", "source", "v3", SOURCE_SHA,
                "purpose:preserve-video", List.of("rights:video"), "policy:source:v3"))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("tenantId");
        assertThatThrownBy(() -> new ArtifactBinding("tenant-a", "principal-a ", "source", "v3", SOURCE_SHA,
                "purpose:preserve-video", List.of("rights:video"), "policy:source:v3"))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("principalId");
        assertThatThrownBy(() -> new ArtifactBinding("tenant-a", "principal-a", "source", "v3", " " + SOURCE_SHA,
                "purpose:preserve-video", List.of("rights:video"), "policy:source:v3"))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("sha256");
        assertThatThrownBy(() -> new ArtifactBinding("tenant-a", "principal-a", "source", "v3", SOURCE_SHA,
                "purpose:preserve-video ", List.of("rights:video"), "policy:source:v3"))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("purposeRef");
        assertThatThrownBy(() -> new ArtifactBinding("tenant-a", "principal-a", "source", "v3", SOURCE_SHA,
                "purpose:preserve-video", List.of(" rights:video"), "policy:source:v3"))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("rightsEvidenceRef");
        assertThatThrownBy(() -> new ArtifactBinding("tenant-a", "principal-a", "source", "v3", SOURCE_SHA,
                "purpose:preserve-video", List.of("rights:video"), "policy:source:v3 "))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("policyDecisionRef");
        assertThatThrownBy(() -> new ArtifactBinding("\u00a0", "principal-a", "source", "v3", SOURCE_SHA,
                "purpose:preserve-video", List.of("rights:video"), "policy:source:v3"))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("tenantId");
        assertThatThrownBy(() -> new ArtifactBinding("\u2003tenant-a", "principal-a", "source", "v3", SOURCE_SHA,
                "purpose:preserve-video", List.of("rights:video"), "policy:source:v3"))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("tenantId");
    }

    @Test
    void boundedCallerListsUseIteratorAndDoNotConsumeOverLimitItem() {
        AtomicInteger rightsConsumed = new AtomicInteger();
        List<String> rights = new ArrayList<>();
        for (int i = 0; i < 33; i++) rights.add("rights:" + i);
        assertThatThrownBy(() -> new ArtifactBinding("tenant-a", "principal-a", "source", "v3", SOURCE_SHA,
                "purpose:preserve-video", deceptiveList(rights, rightsConsumed), "policy:source:v3"))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("between 1 and 32");
        assertThat(rightsConsumed).hasValue(32);

        AtomicInteger framesConsumed = new AtomicInteger();
        List<Frame> frames = new ArrayList<>();
        for (int i = 0; i < MAX_FRAMES + 1; i++) {
            frames.add(i == MAX_FRAMES ? null : frame(i, i, new byte[] {1, 2, 3}, new Roi(0, 0, 1, 1)));
        }
        assertThatThrownBy(() -> new DecodedFrameSequence("source", "v3", SOURCE_SHA, TIME_BASE,
                deceptiveList(frames, framesConsumed)))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("between 3 and 64");
        assertThat(framesConsumed).hasValue(MAX_FRAMES);

        Candidate baseline = TemporalVideoRestoration.restore(request(), (binding, operation) ->
                allowed("source-decision-v3"), binding -> sequence(SOURCE_SHA, stableFrames(),
                new Roi(0, 0, 1, 1)), Optional.empty(), null, null).candidate().orElseThrow();
        List<CandidateFrame> candidateFrames = new ArrayList<>();
        for (int i = 0; i < MAX_FRAMES + 1; i++) {
            candidateFrames.add(i == MAX_FRAMES ? null : candidateFrame(i, i, new Roi(0, 0, 1, 1),
                    new byte[] {1, 2, 3, 4, 5, 6}));
        }
        AtomicInteger candidateFramesConsumed = new AtomicInteger();
        assertThatThrownBy(() -> candidateWith(baseline, deceptiveList(candidateFrames, candidateFramesConsumed)))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("between 3 and 64");
        assertThat(candidateFramesConsumed).hasValue(MAX_FRAMES);
    }

    private static <T> List<T> deceptiveList(List<T> values, AtomicInteger consumed) {
        return new AbstractList<>() {
            @Override public T get(int index) { return values.get(index); }
            @Override public int size() { return 1; }
            @Override public Iterator<T> iterator() {
                Iterator<T> delegate = values.iterator();
                return new Iterator<>() {
                    @Override public boolean hasNext() { return delegate.hasNext(); }
                    @Override public T next() { consumed.incrementAndGet(); return delegate.next(); }
                };
            }
        };
    }

    @Test
    void temporalMedianProducesAlignedCandidateAndExactReferenceMetricsWithoutClaimingImprovement() {
        byte[][] pixels = {
                {(byte) 0, 0, 0, 21, 22, 23},
                {(byte) 255, (byte) 255, (byte) 255, 31, 32, 33},
                {(byte) 0, 0, 0, 41, 42, 43},
        };
        byte[][] original = cloneFrames(pixels);
        DecodedFrameSequence input = sequence(SOURCE_SHA, pixels, new Roi(0, 0, 1, 1));
        byte[][] referencePixels = {
                {(byte) 0, 0, 0, 70, 71, 72},
                {(byte) 0, 0, 0, 80, 81, 82},
                {(byte) 0, 0, 0, 90, 91, 92},
        };
        DecodedFrameSequence reference = sequence(REF_SHA, referencePixels, new Roi(0, 0, 1, 1), "reference", "v7");
        AtomicInteger referenceReads = new AtomicInteger();

        Result result = TemporalVideoRestoration.restore(request(), (binding, operation) -> allowed("source-decision-v3"),
                binding -> input,
                Optional.of(referenceRequest()), binding -> {
                    referenceReads.incrementAndGet();
                    return reference;
                }, (binding, purpose) -> allowed("reference-decision-v2"));

        assertThat(result.outcome()).isEqualTo(Outcome.COMPLETED);
        Candidate candidate = result.candidate().orElseThrow();
        assertThat(candidate.lineage().operationId()).isEqualTo(OPERATION_ID);
        assertThat(candidate.lineage().profileId()).isEqualTo(PROFILE_ID);
        assertThat(candidate.lineage().sourceVersionId()).isEqualTo("v3");
        assertThat(candidate.lineage().sourceRightsDecisionId()).isEqualTo("source-decision-v3");
        assertThat(candidate.frames()).hasSize(3);
        assertThat(candidate.frames()).extracting(CandidateFrame::frameIndex).containsExactly(0, 1, 2);
        assertThat(candidate.frames()).extracting(CandidateFrame::presentationTicks).containsExactly(0L, 1L, 2L);
        assertThat(candidate.frames()).allSatisfy(frame -> assertThat(frame.width()).isEqualTo(2));
        assertThat(candidate.frames().get(1).rgb()).containsExactly((byte) 0, (byte) 0, (byte) 0, 31, 32, 33);
        assertThat(candidate.dimensionsPreserved()).isTrue();
        assertThat(candidate.timingPreserved()).isTrue();
        assertThat(candidate.sourcePixelsPreservedOutsideRoi()).isTrue();
        assertThat(candidate.improvementClaimed()).isFalse();
        assertThat(candidate.sourceDelta().comparedSamples()).isEqualTo(9);
        assertThat(candidate.sourceDelta().changedSamples()).isEqualTo(3);
        assertThat(candidate.sourceDelta().maximumAbsoluteChange()).isEqualTo(255);
        assertThat(candidate.sourceDelta().meanAbsoluteChange()).isEqualTo(85.0);
        assertThat(candidate.referenceMetrics().status()).isEqualTo(MetricStatus.EXACT_REFERENCE_MATCH);
        assertThat(candidate.referenceMetrics().psnr().status()).isEqualTo(MetricStatus.EXACT_REFERENCE_MATCH);
        assertThat(candidate.referenceMetrics().psnr().finiteDb()).isEmpty();
        assertThat(candidate.referenceMetrics().globalLumaSsim().orElseThrow()).isEqualTo(1.0);
        assertThat(candidate.referenceMetrics().referenceArtifactId()).isEqualTo("reference");
        assertThat(referenceReads).hasValue(1);
        for (int index = 0; index < pixels.length; index++) {
            assertThat(pixels[index]).containsExactly(original[index]);
        }
    }

    @Test
    void deterministicImpulseNoiseReferencePreservesVariablePtsAndRationalTimebase() {
        Roi roi = new Roi(0, 0, 1, 1);
        TimeBase sourceTimeBase = new TimeBase(1_001, 30_000);
        byte[][] sourcePixels = {
                {32, 64, 96, 101, 102, 103},
                {(byte) 250, (byte) 255, (byte) 255, 111, 112, 113},
                {32, 64, 96, 121, 122, 123},
        };
        List<Frame> sourceFrames = List.of(
                new Frame(0, 0, 2, 1, roi, sourcePixels[0]),
                new Frame(1, 1_001, 2, 1, roi, sourcePixels[1]),
                new Frame(2, 3_003, 2, 1, roi, sourcePixels[2]));
        DecodedFrameSequence source = new DecodedFrameSequence("source", "v3", SOURCE_SHA,
                sourceTimeBase, sourceFrames);
        byte[][] referencePixels = {
                {32, 64, 96, 0, 0, 0},
                {32, 64, 96, 0, 0, 0},
                {32, 64, 96, 0, 0, 0},
        };
        List<Frame> referenceFrames = List.of(
                new Frame(0, 0, 2, 1, roi, referencePixels[0]),
                new Frame(1, 1_001, 2, 1, roi, referencePixels[1]),
                new Frame(2, 3_003, 2, 1, roi, referencePixels[2]));
        DecodedFrameSequence reference = new DecodedFrameSequence("reference", "v7", REF_SHA,
                sourceTimeBase, referenceFrames);

        Candidate candidate = TemporalVideoRestoration.restore(request(),
                (binding, operation) -> allowed("source-decision-v3"), binding -> source,
                Optional.of(referenceRequest()), binding -> reference,
                (binding, purpose) -> allowed("reference-decision-v2")).candidate().orElseThrow();

        assertThat(candidate.timeBase()).isEqualTo(sourceTimeBase);
        assertThat(candidate.frames()).extracting(CandidateFrame::frameIndex).containsExactly(0, 1, 2);
        assertThat(candidate.frames()).extracting(CandidateFrame::presentationTicks).containsExactly(0L, 1_001L, 3_003L);
        assertThat(candidate.frames()).allSatisfy(frame ->
                assertThat(frame.rgb()).contains((byte) 32, (byte) 64, (byte) 96));
        assertThat(candidate.frames().get(1).rgb()).containsExactly((byte) 32, (byte) 64, (byte) 96, 111, 112, 113);
        assertThat(candidate.referenceMetrics().status()).isEqualTo(MetricStatus.EXACT_REFERENCE_MATCH);
        assertThat(candidate.referenceMetrics().psnr().finiteDb()).isEmpty();
        assertThat(candidate.referenceMetrics().globalLumaSsim().orElseThrow()).isEqualTo(1.0);
        assertThat(candidate.sourceDelta().changedSamples()).isEqualTo(3);
        assertThat(candidate.improvementClaimed()).isFalse();
    }

    @Test
    void nearUniformReferenceComparisonKeepsSmallLumaVarianceFinite() {
        int width = 512;
        int height = 512;
        Roi roi = new Roi(0, 0, width, height);
        byte[] sourcePixels = new byte[width * height * 3];
        byte[] referencePixels = new byte[sourcePixels.length];
        for (int pixel = 0; pixel < width * height; pixel++) {
            byte value = (byte) ((pixel & 1) == 0 ? 127 : 128);
            int offset = pixel * 3;
            sourcePixels[offset] = value;
            sourcePixels[offset + 1] = value;
            sourcePixels[offset + 2] = value;
            referencePixels[offset] = 127;
            referencePixels[offset + 1] = 127;
            referencePixels[offset + 2] = 127;
        }
        List<Frame> sourceFrames = List.of(
                new Frame(0, 0, width, height, roi, sourcePixels),
                new Frame(1, 1, width, height, roi, sourcePixels),
                new Frame(2, 2, width, height, roi, sourcePixels));
        List<Frame> referenceFrames = List.of(
                new Frame(0, 0, width, height, roi, referencePixels),
                new Frame(1, 1, width, height, roi, referencePixels),
                new Frame(2, 2, width, height, roi, referencePixels));
        DecodedFrameSequence source = new DecodedFrameSequence("source", "v3", SOURCE_SHA, TIME_BASE, sourceFrames);
        DecodedFrameSequence reference = new DecodedFrameSequence("reference", "v7", REF_SHA, TIME_BASE, referenceFrames);

        Candidate candidate = TemporalVideoRestoration.restore(request(),
                (binding, operation) -> allowed("source-decision-v3"), binding -> source,
                Optional.of(referenceRequest()), binding -> reference,
                (binding, purpose) -> allowed("reference-decision-v2")).candidate().orElseThrow();

        double ssim = candidate.referenceMetrics().globalLumaSsim().orElseThrow();
        assertThat(candidate.referenceMetrics().status()).isEqualTo(MetricStatus.MEASURED);
        assertThat(ssim).isFinite().isGreaterThan(0.99).isLessThan(1.0);
        assertThat(candidate.improvementClaimed()).isFalse();
    }

    @Test
    void referenceComparisonRejectsDifferentRationalTimebase() {
        DecodedFrameSequence source = sequence(SOURCE_SHA, stableFrames(), new Roi(0, 0, 1, 1));
        Roi roi = new Roi(0, 0, 1, 1);
        DecodedFrameSequence reference = new DecodedFrameSequence("reference", "v7", REF_SHA,
                new TimeBase(1, 24), List.of(
                        new Frame(0, 0, 1, 1, roi, new byte[] {10, 20, 30}),
                        new Frame(1, 1, 1, 1, roi, new byte[] {10, 20, 30}),
                        new Frame(2, 2, 1, 1, roi, new byte[] {10, 20, 30})));

        assertThatThrownBy(() -> TemporalVideoRestoration.restore(request(),
                (binding, operation) -> allowed("source-decision-v3"), binding -> source,
                Optional.of(referenceRequest()), binding -> reference,
                (binding, purpose) -> allowed("reference-decision-v2")))
                .isInstanceOf(InvalidRestorationInputException.class)
                .hasMessageContaining("align exactly");
    }

    @Test
    void unsharpMaskUsesDocumentedRgbRoundingAndAuthorizedReferenceMetrics() {
        Roi roi = new Roi(0, 0, 3, 1);
        TimeBase timeBase = new TimeBase(1, 30);
        byte[][] sourcePixels = {{0, 0, 0, 100, 100, 100, 0, 0, 0},
                {0, 0, 0, 100, 100, 100, 0, 0, 0}, {0, 0, 0, 100, 100, 100, 0, 0, 0}};
        DecodedFrameSequence source = sequenceWithTimeBase("source", "v3", SOURCE_SHA, sourcePixels, roi, timeBase);
        byte[][] expectedPixels = {{0, 0, 0, (byte) 167, (byte) 167, (byte) 167, 0, 0, 0},
                {0, 0, 0, (byte) 167, (byte) 167, (byte) 167, 0, 0, 0},
                {0, 0, 0, (byte) 167, (byte) 167, (byte) 167, 0, 0, 0}};
        DecodedFrameSequence reference = sequenceWithTimeBase("reference", "v7", REF_SHA,
                expectedPixels, roi, timeBase);
        byte[][] original = cloneFrames(sourcePixels);
        AtomicInteger checked = new AtomicInteger();
        RestorationRequest request = request(FilterParameters.unsharpMask("noise-profile-v2", 1.0));

        Candidate candidate = TemporalVideoRestoration.restore(request, (binding, operation) -> {
                    assertThat(operation).isEqualTo(UNSHARP_OPERATION_ID);
                    checked.incrementAndGet();
                    return allowed("source-decision-v3");
                }, binding -> source,
                Optional.of(referenceRequest()), binding -> reference,
                (binding, purpose) -> allowed("reference-decision-v2")).candidate().orElseThrow();

        for (int index = 0; index < expectedPixels.length; index++) {
            assertThat(candidate.frames().get(index).rgb()).containsExactly(expectedPixels[index]);
        }
        assertThat(candidate.lineage().operationId()).isEqualTo(UNSHARP_OPERATION_ID);
        assertThat(candidate.lineage().profileId()).isEqualTo(UNSHARP_PROFILE_ID);
        assertThat(candidate.lineage().parameterVersion()).isEqualTo("noise-profile-v2");
        assertThat(candidate.lineage().parameterSha256()).matches("[a-f0-9]{64}");
        assertThat(candidate.lineage().outputDisclosure()).contains("Math.round", "clamp to [0,255]");
        assertThat(candidate.referenceMetrics().status()).isEqualTo(MetricStatus.EXACT_REFERENCE_MATCH);
        assertThat(candidate.improvementClaimed()).isFalse();
        assertThat(candidate.clippedSamples()).isEqualTo(18);
        assertThat(candidate.clippedMagnitude()).isEqualTo(594);
        assertThat(checked).hasValue(3);
        for (int index = 0; index < sourcePixels.length; index++) {
            assertThat(sourcePixels[index]).containsExactly(original[index]);
        }
    }

    @Test
    void rgbAdjustmentRoundsClipsAndPreservesPixelsOutsideRoi() {
        Roi roi = new Roi(0, 0, 1, 1);
        byte[][] sourcePixels = {{(byte) 200, 10, 20, 70, 80, 90},
                {(byte) 200, 10, 20, 71, 81, 91}, {(byte) 200, 10, 20, 72, 82, 92}};
        byte[][] original = cloneFrames(sourcePixels);
        DecodedFrameSequence source = sequence(SOURCE_SHA, sourcePixels, roi);
        FilterParameters parameters = FilterParameters.rgbAdjustment("grade-v4", 2.0, 1.25, 0.5, 0, 0, 0);
        Candidate candidate = TemporalVideoRestoration.restore(request(parameters),
                (binding, operation) -> {
                    assertThat(operation).isEqualTo(COLOR_OPERATION_ID);
                    return allowed("source-decision-v3");
                }, binding -> source, Optional.empty(), null, null).candidate().orElseThrow();

        assertThat(candidate.frames().getFirst().rgb())
                .containsExactly((byte) 255, (byte) 13, (byte) 10, 70, 80, 90);
        assertThat(candidate.frames()).extracting(CandidateFrame::presentationTicks).containsExactly(0L, 1L, 2L);
        assertThat(candidate.lineage().parameterVersion()).isEqualTo("grade-v4");
        assertThat(candidate.lineage().outputDisclosure()).contains("gain/offset", "clamp to [0,255]");
        assertThat(candidate.sourceDelta().maximumAbsoluteChange()).isEqualTo(55);
        assertThat(candidate.clippedSamples()).isEqualTo(3);
        assertThat(candidate.clippedMagnitude()).isEqualTo(435);
        assertThat(candidate.referenceMetrics().status()).isEqualTo(MetricStatus.UNAVAILABLE);
        assertThat(candidate.improvementClaimed()).isFalse();
        for (int index = 0; index < sourcePixels.length; index++) {
            assertThat(sourcePixels[index]).containsExactly(original[index]);
        }
    }

    @Test
    void identityProfilesAreNoOpAndInvalidOrUnboundedProfilesAreRejected() {
        DecodedFrameSequence source = sequence(SOURCE_SHA, stableFrames(), new Roi(0, 0, 1, 1));
        Candidate noOp = TemporalVideoRestoration.restore(request(
                        FilterParameters.rgbAdjustment("identity-v1", 1, 1, 1, 0, 0, 0)),
                (binding, operation) -> allowed("source-decision-v3"), binding -> source,
                Optional.empty(), null, null).candidate().orElseThrow();
        assertThat(noOp.frames().getFirst().rgb()).containsExactly((byte) 10, (byte) 20, (byte) 30);
        assertThat(noOp.sourceDelta().changedSamples()).isZero();
        assertThat(noOp.clippedSamples()).isZero();
        assertThat(noOp.clippedMagnitude()).isZero();
        Candidate zeroAmount = TemporalVideoRestoration.restore(request(FilterParameters.unsharpMask("zero-v1", 0)),
                (binding, operation) -> allowed("source-decision-v3"), binding -> source,
                Optional.empty(), null, null).candidate().orElseThrow();
        assertThat(zeroAmount.sourceDelta().changedSamples()).isZero();
        assertThat(zeroAmount.clippedSamples()).isZero();
        assertThat(noOp.improvementClaimed()).isFalse();

        assertThatThrownBy(() -> FilterParameters.unsharpMask("unbounded", 2.01))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("unsharp amount");
        assertThatThrownBy(() -> FilterParameters.unsharpMask("nan", Double.NaN))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("finite");
        assertThatThrownBy(() -> FilterParameters.rgbAdjustment("invalid-gain", 4.01, 1, 1, 0, 0, 0))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("RGB gains");
        assertThatThrownBy(() -> FilterParameters.rgbAdjustment("invalid-offset", 1, 1, 1, 0, 0, 256))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("offsets");
    }

    @Test
    void selectedFilterAuthorizationIsCheckedBeforeReadingSourceFrames() {
        DecodedFrameSequence source = sequence(SOURCE_SHA, stableFrames(), new Roi(0, 0, 1, 1));
        AtomicInteger reads = new AtomicInteger();
        Result denied = TemporalVideoRestoration.restore(request(FilterParameters.unsharpMask("mask-v1", 0.75)),
                (binding, operation) -> {
                    assertThat(operation).isEqualTo(UNSHARP_OPERATION_ID);
                    return new AuthorityDecision(AuthorityStatus.DENIED, "");
                }, binding -> {
                    reads.incrementAndGet();
                    return source;
                }, Optional.empty(), null, null);

        assertThat(denied.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(denied.candidate()).isEmpty();
        assertThat(reads).hasValue(0);
    }

    @Test
    void measuredReferenceReportsFinitePsnrAndGlobalLumaSsim() {
        byte[][] sourcePixels = {{0, 0, 0}, {100, 100, 100}, {0, 0, 0}};
        byte[][] referencePixels = {{10, 10, 10}, {10, 10, 10}, {10, 10, 10}};
        DecodedFrameSequence source = sequence(SOURCE_SHA, sourcePixels, new Roi(0, 0, 1, 1));
        DecodedFrameSequence reference = sequence(REF_SHA, referencePixels,
                new Roi(0, 0, 1, 1), "reference", "v7");

        Candidate candidate = TemporalVideoRestoration.restore(request(), (binding, operation) -> allowed("source-decision-v3"),
                binding -> source,
                Optional.of(referenceRequest()), binding -> reference,
                (binding, purpose) -> allowed("reference-decision-v2")).candidate().orElseThrow();

        ReferenceMetrics metrics = candidate.referenceMetrics();
        assertThat(metrics.status()).isEqualTo(MetricStatus.MEASURED);
        assertThat(metrics.algorithm()).contains("GLOBAL_SRGB_LUMA_SSIM_V1", "RGB8_SAMPLE_PSNR_V1");
        assertThat(metrics.psnr().finiteDb()).isPresent();
        assertThat(metrics.psnr().finiteDb().orElseThrow()).isBetween(20.0, 40.0);
        assertThat(metrics.globalLumaSsim()).isPresent();
        assertThat(metrics.globalLumaSsim().orElseThrow()).isBetween(0.0, 1.0);
    }

    @Test
    void noReferenceExplicitlyReportsMetricsUnavailable() {
        DecodedFrameSequence source = sequence(SOURCE_SHA, stableFrames(), new Roi(0, 0, 1, 1));
        Candidate candidate = TemporalVideoRestoration.restore(request(), (binding, operation) -> allowed("source-decision-v3"),
                binding -> source, Optional.empty(), null, null).candidate().orElseThrow();

        assertThat(candidate.referenceMetrics().status()).isEqualTo(MetricStatus.UNAVAILABLE);
        assertThat(candidate.referenceMetrics().unavailableReason())
                .contains(MetricUnavailableReason.REFERENCE_NOT_SUPPLIED);
        assertThat(candidate.referenceMetrics().psnr().finiteDb()).isEmpty();
        assertThat(candidate.improvementClaimed()).isFalse();
    }

    @Test
    void referenceMetricsRejectUnavailableOrInvalidValuesMasqueradingAsMeasurements() {
        Psnr unavailablePsnr = new Psnr(MetricStatus.UNAVAILABLE, java.util.OptionalDouble.empty());
        assertThatThrownBy(() -> new Psnr(MetricStatus.MEASURED, java.util.OptionalDouble.of(-0.01)))
                .isInstanceOf(InvalidRestorationInputException.class)
                .hasMessageContaining("finite and non-negative");
        assertThat(new Psnr(MetricStatus.MEASURED, java.util.OptionalDouble.of(0.0)).finiteDb().orElseThrow())
                .isEqualTo(0.0);
        assertThatThrownBy(() -> new ReferenceMetrics(MetricStatus.UNAVAILABLE, "reference", "v7", REF_SHA,
                "RGB8_SAMPLE_PSNR_V1", unavailablePsnr, java.util.OptionalDouble.empty(),
                java.util.Optional.of(MetricUnavailableReason.REFERENCE_UNAVAILABLE)))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("unavailable reference metrics");

        assertThatThrownBy(() -> new ReferenceMetrics(MetricStatus.MEASURED, "reference", "v7", REF_SHA,
                "RGB8_SAMPLE_PSNR_V1", new Psnr(MetricStatus.MEASURED, java.util.OptionalDouble.of(20.0)),
                java.util.OptionalDouble.of(Double.NaN), java.util.Optional.empty()))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("finite measurements");

        assertThatThrownBy(() -> new ReferenceMetrics(MetricStatus.EXACT_REFERENCE_MATCH, "reference", "v7", REF_SHA,
                "RGB8_SAMPLE_PSNR_V1", new Psnr(MetricStatus.EXACT_REFERENCE_MATCH,
                        java.util.OptionalDouble.empty()), java.util.OptionalDouble.of(0.9), java.util.Optional.empty()))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("infinite PSNR omission");
    }

    @Test
    void sourceDenialOrUnknownPreventsPixelReadAndCandidateDisclosure() {
        DecodedFrameSequence source = sequence(SOURCE_SHA, stableFrames(), new Roi(0, 0, 1, 1));
        AtomicInteger reads = new AtomicInteger();
        Result denied = TemporalVideoRestoration.restore(request(), (binding, operation) ->
                        new AuthorityDecision(AuthorityStatus.DENIED, ""), binding -> {
                    reads.incrementAndGet();
                    return source;
                }, Optional.empty(), null, null);

        assertThat(denied.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(denied.reason()).contains(Reason.SOURCE_RIGHTS_DENIED);
        assertThat(denied.candidate()).isEmpty();
        assertThat(reads).hasValue(0);

        Result noAuthority = TemporalVideoRestoration.restore(request(), null, binding -> {
            reads.incrementAndGet();
            return source;
        }, Optional.empty(), null, null);
        assertThat(noAuthority.outcome()).isEqualTo(Outcome.UNAVAILABLE);
        assertThat(noAuthority.reason()).contains(Reason.SOURCE_AUTHORITY_UNAVAILABLE);
        assertThat(reads).hasValue(0);

        Result unknown = TemporalVideoRestoration.restore(request(), (binding, operation) ->
                        new AuthorityDecision(AuthorityStatus.UNAVAILABLE, ""), binding -> {
                    reads.incrementAndGet();
                    return source;
                }, Optional.empty(), null, null);
        assertThat(unknown.outcome()).isEqualTo(Outcome.UNAVAILABLE);
        assertThat(unknown.candidate()).isEmpty();
        assertThat(reads).hasValue(0);
    }

    @Test
    void sourceRevocationAfterDecodeSuppressesComputedCandidate() {
        DecodedFrameSequence source = sequence(SOURCE_SHA, stableFrames(), new Roi(0, 0, 1, 1));
        AtomicInteger checks = new AtomicInteger();
        Result result = TemporalVideoRestoration.restore(request(), (binding, operation) -> checks.incrementAndGet() == 1
                        ? allowed("source-decision-v3") : new AuthorityDecision(AuthorityStatus.DENIED, ""),
                binding -> source, Optional.empty(), null, null);

        assertThat(checks).hasValue(2);
        assertThat(result.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(result.reason()).contains(Reason.SOURCE_REVOKED_OR_UNKNOWN);
        assertThat(result.candidate()).isEmpty();
    }

    @Test
    void deniedReferenceIsNotReadAndCannotBecomeAQualityClaim() {
        DecodedFrameSequence source = sequence(SOURCE_SHA, stableFrames(), new Roi(0, 0, 1, 1));
        AtomicInteger referenceReads = new AtomicInteger();
        Candidate candidate = TemporalVideoRestoration.restore(request(), (binding, operation) -> allowed("source-decision-v3"),
                binding -> source,
                Optional.of(referenceRequest()), binding -> {
                    referenceReads.incrementAndGet();
                    return sequence(REF_SHA, stableFrames(), new Roi(0, 0, 1, 1), "reference", "v7");
                }, (binding, purpose) -> new AuthorityDecision(AuthorityStatus.DENIED, ""))
                .candidate().orElseThrow();

        assertThat(referenceReads).hasValue(0);
        assertThat(candidate.referenceMetrics().status()).isEqualTo(MetricStatus.UNAVAILABLE);
        assertThat(candidate.referenceMetrics().unavailableReason()).contains(MetricUnavailableReason.REFERENCE_NOT_ADMITTED);
        assertThat(candidate.improvementClaimed()).isFalse();
    }

    @Test
    void sourceRevisionCannotBeReusedAsItsOwnQualityReference() {
        DecodedFrameSequence source = sequence(SOURCE_SHA, stableFrames(), new Roi(0, 0, 1, 1));
        ArtifactBinding sameRevision = new ArtifactBinding("tenant-a", "principal-a", "source", "v3", SOURCE_SHA,
                "purpose:quality-evaluation", List.of("rights:source:v3"), "policy:quality:v3");
        AtomicInteger referenceChecks = new AtomicInteger();
        AtomicInteger referenceReads = new AtomicInteger();

        Candidate candidate = TemporalVideoRestoration.restore(request(),
                (binding, operation) -> allowed("source-decision-v3"),
                binding -> source,
                Optional.of(new ReferenceRequest("reference-read-self", sameRevision)),
                binding -> {
                    referenceReads.incrementAndGet();
                    return source;
                },
                (binding, purpose) -> {
                    referenceChecks.incrementAndGet();
                    return allowed("reference-decision-v3");
                }).candidate().orElseThrow();

        assertThat(referenceChecks).hasValue(0);
        assertThat(referenceReads).hasValue(0);
        assertThat(candidate.referenceMetrics().status()).isEqualTo(MetricStatus.UNAVAILABLE);
        assertThat(candidate.referenceMetrics().unavailableReason())
                .contains(MetricUnavailableReason.REFERENCE_NOT_ADMITTED);
        assertThat(candidate.referenceMetrics().psnr().finiteDb()).isEmpty();
        assertThat(candidate.referenceMetrics().globalLumaSsim()).isEmpty();
        assertThat(candidate.improvementClaimed()).isFalse();
    }

    @Test
    void missingReferencePortsAreReportedUnavailableWithoutAQualityClaim() {
        DecodedFrameSequence source = sequence(SOURCE_SHA, stableFrames(), new Roi(0, 0, 1, 1));
        Candidate candidate = TemporalVideoRestoration.restore(request(), (binding, operation) -> allowed("source-decision-v3"),
                binding -> source, Optional.of(referenceRequest()), null, null).candidate().orElseThrow();

        assertThat(candidate.referenceMetrics().status()).isEqualTo(MetricStatus.UNAVAILABLE);
        assertThat(candidate.referenceMetrics().unavailableReason())
                .contains(MetricUnavailableReason.REFERENCE_AUTHORITY_UNAVAILABLE);
        assertThat(candidate.improvementClaimed()).isFalse();
    }

    @Test
    void referenceReadFailureAbstainsFromMetricsAndKeepsCompletedCandidateUnclaimed() {
        DecodedFrameSequence source = sequence(SOURCE_SHA, stableFrames(), new Roi(0, 0, 1, 1));

        Result result = TemporalVideoRestoration.restore(request(),
                (binding, operation) -> allowed("source-decision-v3"),
                binding -> source,
                Optional.of(referenceRequest()), binding -> {
                    throw new IllegalStateException("reference decoder unavailable");
                },
                (binding, purpose) -> allowed("reference-decision-v2"));

        assertThat(result.outcome()).isEqualTo(Outcome.COMPLETED);
        Candidate candidate = result.candidate().orElseThrow();
        assertThat(candidate.frames()).hasSize(3);
        assertThat(candidate.referenceMetrics().status()).isEqualTo(MetricStatus.UNAVAILABLE);
        assertThat(candidate.referenceMetrics().unavailableReason())
                .contains(MetricUnavailableReason.REFERENCE_UNAVAILABLE);
        assertThat(candidate.referenceMetrics().psnr().finiteDb()).isEmpty();
        assertThat(candidate.referenceMetrics().globalLumaSsim()).isEmpty();
        assertThat(candidate.improvementClaimed()).isFalse();
    }

    @Test
    void sourceReaderMustReturnExactRequestedVersionAndDigest() {
        DecodedFrameSequence wrong = sequence(REF_SHA, stableFrames(), new Roi(0, 0, 1, 1), "source", "v3");
        assertThatThrownBy(() -> TemporalVideoRestoration.restore(request(), (binding, operation) -> allowed("source-decision-v3"),
                binding -> wrong, Optional.empty(), null, null))
                .isInstanceOf(InvalidRestorationInputException.class)
                .hasMessageContaining("exact requested source artifact version");
    }

    @Test
    void malformedAndUnboundedFramesAreRejected() {
        assertThatThrownBy(() -> new Frame(0, 0, 2, 1, new Roi(0, 0, 2, 1), new byte[5]))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("payload length");
        assertThatThrownBy(() -> new Frame(0, 0, 2, 1, new Roi(1, 0, 2, 1), new byte[6]))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("ROI is outside");
        assertThatThrownBy(() -> new Frame(0, 0, 1, 1, new Roi(0, 0, 1, 1), new byte[3], "f".repeat(64)))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("frameSha256");
        assertThatThrownBy(() -> new TimeBase(0, 1))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("timeBase");
        assertThatThrownBy(() -> new TimeBase(1_000_001, 1))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("timeBase");
        assertThatThrownBy(() -> new TimeBase(1, 1_000_001))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("timeBase");
        assertThatThrownBy(() -> new Frame(0, 0, 2_049, 1, new Roi(0, 0, 1, 1), new byte[3]))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("dimensions");
    }

    @Test
    void candidateFrameRejectsMalformedPublicValues() {
        byte[] rgb = {1, 2, 3};
        String digest = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
        assertThatThrownBy(() -> new CandidateFrame(-1, 0, 1, 1,
                new Roi(0, 0, 1, 1), rgb, digest))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("frameIndex");
        assertThatThrownBy(() -> new CandidateFrame(MAX_FRAMES, 0, 1, 1,
                new Roi(0, 0, 1, 1), rgb, digest))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("frameIndex");
        assertThatThrownBy(() -> new CandidateFrame(0, -1, 1, 1,
                new Roi(0, 0, 1, 1), rgb, digest))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("presentationTicks");
        assertThatThrownBy(() -> new CandidateFrame(0, 0, MAX_FRAME_DIMENSION + 1, 1,
                new Roi(0, 0, 1, 1), rgb, digest))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("dimensions");
        assertThatThrownBy(() -> new CandidateFrame(0, 0, 1, 1,
                new Roi(1, 0, 1, 1), rgb, digest))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("ROI");
        assertThatThrownBy(() -> new CandidateFrame(0, 0, 2, 1,
                new Roi(0, 0, 1, 1), rgb, digest))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("payload length");
        assertThatThrownBy(() -> new CandidateFrame(0, 0, 1, 1,
                new Roi(0, 0, 1, 1), rgb, "not-a-digest"))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("digest");
    }

    @Test
    void candidateRejectsUnorderedOrStructurallyDriftingFrameLists() {
        Candidate valid = TemporalVideoRestoration.restore(request(),
                (binding, operation) -> allowed("source-decision-v3"),
                binding -> sequence(SOURCE_SHA, stableFrames(), new Roi(0, 0, 1, 1)),
                Optional.empty(), null, null).candidate().orElseThrow();

        assertThatThrownBy(() -> candidateWith(valid, List.of()))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("between 3 and 64");
        List<CandidateFrame> reordered = new ArrayList<>(valid.frames());
        reordered.set(1, reordered.get(2));
        assertThatThrownBy(() -> candidateWith(valid, reordered))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("contiguous and ordered");

        List<CandidateFrame> duplicatePts = new ArrayList<>(valid.frames());
        CandidateFrame original = duplicatePts.get(1);
        duplicatePts.set(1, new CandidateFrame(1, 0, original.width(), original.height(), original.roi(),
                original.rgb(), original.frameSha256()));
        assertThatThrownBy(() -> candidateWith(valid, duplicatePts))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("PTS");

        // A candidate cannot mix dimensions/ROI across frames, even if each frame is individually valid.
        byte[] widePixels = {10, 20, 30, 10, 20, 30};
        List<CandidateFrame> changedRoi = List.of(
                candidateFrame(0, 0, new Roi(0, 0, 2, 1), widePixels),
                candidateFrame(1, 1, new Roi(0, 0, 1, 1), widePixels),
                candidateFrame(2, 2, new Roi(0, 0, 2, 1), widePixels));
        assertThatThrownBy(() -> candidateWith(valid, changedRoi))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("dimensions and ROI");
    }

    @Test
    void candidateRejectsFramePayloadThatDoesNotMatchTheLineageDigest() {
        Candidate valid = TemporalVideoRestoration.restore(request(),
                (binding, operation) -> allowed("source-decision-v3"),
                binding -> sequence(SOURCE_SHA, stableFrames(), new Roi(0, 0, 1, 1)),
                Optional.empty(), null, null).candidate().orElseThrow();
        List<CandidateFrame> changedFrames = new ArrayList<>(valid.frames());
        CandidateFrame original = changedFrames.getFirst();
        byte[] modifiedRgb = original.rgb();
        modifiedRgb[0] ^= 1;
        changedFrames.set(0, candidateFrame(original.frameIndex(), original.presentationTicks(),
                original.roi(), modifiedRgb));

        assertThatThrownBy(() -> candidateWith(valid, changedFrames))
                .isInstanceOf(InvalidRestorationInputException.class)
                .hasMessageContaining("lineage digest does not match");
    }

    @Test
    void candidateRejectsClippingMetricsOutsideTheSelectedFilterBounds() {
        Candidate temporal = TemporalVideoRestoration.restore(request(),
                (binding, operation) -> allowed("source-decision-v3"),
                binding -> sequence(SOURCE_SHA, stableFrames(), new Roi(0, 0, 1, 1)),
                Optional.empty(), null, null).candidate().orElseThrow();
        assertThatThrownBy(() -> candidateWith(temporal, temporal.frames(), 1, 1))
                .isInstanceOf(InvalidRestorationInputException.class)
                .hasMessageContaining("selected RGB8 filter bounds");
        assertThatThrownBy(() -> candidateWith(temporal, temporal.frames(), 0, 1))
                .isInstanceOf(InvalidRestorationInputException.class)
                .hasMessageContaining("selected RGB8 filter bounds");

        Candidate unsharp = TemporalVideoRestoration.restore(request(FilterParameters.unsharpMask("bounded-v1", 2)),
                (binding, operation) -> allowed("source-decision-v3"),
                binding -> sequence(SOURCE_SHA, stableFrames(), new Roi(0, 0, 1, 1)),
                Optional.empty(), null, null).candidate().orElseThrow();
        assertThatThrownBy(() -> candidateWith(unsharp, unsharp.frames(), 1, 511))
                .isInstanceOf(InvalidRestorationInputException.class)
                .hasMessageContaining("selected RGB8 filter bounds");
        assertThatThrownBy(() -> candidateWith(unsharp, unsharp.frames(), 2, 1))
                .isInstanceOf(InvalidRestorationInputException.class)
                .hasMessageContaining("selected RGB8 filter bounds");
    }

    @Test
    void sourceDeltaRejectsNumericallyInconsistentSummaryFields() {
        assertThatThrownBy(() -> new SourceDelta(9, 1, 0.0, 1))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("numerically inconsistent");
        assertThatThrownBy(() -> new SourceDelta(9, 3, 0.1, 1))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("numerically inconsistent");
        assertThatThrownBy(() -> new SourceDelta(9, 1, 2.0, 1))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("numerically inconsistent");
        assertThatThrownBy(() -> new SourceDelta(9, 3, 1.0 / 3.0, 3))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("numerically inconsistent");
        assertThatThrownBy(() -> new SourceDelta(9, 2, 1.0, 2))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("numerically inconsistent");

        assertThat(new SourceDelta(9, 3, 1.0 / 3.0, 1).meanAbsoluteChange()).isEqualTo(1.0 / 3.0);
        assertThat(new SourceDelta(9, 3, 5.0 / 9.0, 3).meanAbsoluteChange()).isEqualTo(5.0 / 9.0);
        assertThat(new SourceDelta(9, 1, 255.0 / 9.0, 255).maximumAbsoluteChange()).isEqualTo(255);
    }

    private static CandidateFrame candidateFrame(int index, long pts, Roi roi, byte[] pixels) {
        try {
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(pixels));
            return new CandidateFrame(index, pts, pixels.length / 3, 1, roi, pixels, digest);
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
    }

    private static Candidate candidateWith(Candidate source, List<CandidateFrame> frames) {
        return candidateWith(source, frames, source.clippedSamples(), source.clippedMagnitude());
    }

    private static Candidate candidateWith(Candidate source, List<CandidateFrame> frames,
            long clippedSamples, long clippedMagnitude) {
        return new Candidate(frames, source.timeBase(), source.lineage(), source.sourceDelta(),
                source.referenceMetrics(), clippedSamples, clippedMagnitude,
                true, true, true, false);
    }

    @Test
    void sequenceRejectsFrameOrderTimestampAndRoiDrift() {
        assertThatThrownBy(() -> new DecodedFrameSequence("source", "v3", SOURCE_SHA, TIME_BASE,
                List.of(frame(0, 0, new byte[] {0, 0, 0}, new Roi(0, 0, 1, 1)),
                        frame(1, 0, new byte[] {0, 0, 0}, new Roi(0, 0, 1, 1)),
                        frame(2, 2, new byte[] {0, 0, 0}, new Roi(0, 0, 1, 1)))))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("PTS");
        assertThatThrownBy(() -> new DecodedFrameSequence("source", "v3", SOURCE_SHA, TIME_BASE,
                List.of(frame(0, 0, new byte[6], new Roi(0, 0, 1, 1)),
                        frame(1, 1, new byte[6], new Roi(0, 0, 1, 1)),
                        frame(2, 2, new byte[6], new Roi(1, 0, 1, 1)))))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("ROI");
    }

    @Test
    void sourceBytesAreDefensivelyCopiedAndOutputCannotChangeInput() {
        byte[] first = {10, 20, 30};
        Frame frame = frame(0, 0, first, new Roi(0, 0, 1, 1));
        first[0] = 99;
        assertThat(frame.rgb()).containsExactly((byte) 10, (byte) 20, (byte) 30);
        byte[] read = frame.rgb();
        read[1] = 88;
        assertThat(frame.rgb()).containsExactly((byte) 10, (byte) 20, (byte) 30);
    }

    private static RestorationRequest request() {
        return new RestorationRequest("request-1", sourceBinding());
    }

    private static RestorationRequest request(FilterParameters parameters) {
        return new RestorationRequest("request-1", sourceBinding(), parameters);
    }

    private static ArtifactBinding sourceBinding() {
        return new ArtifactBinding("tenant-a", "principal-a", "source", "v3", SOURCE_SHA,
                "purpose:preserve-video", List.of("rights:source:v3"), "policy:source:v3");
    }

    private static ReferenceRequest referenceRequest() {
        return new ReferenceRequest("reference-read-1", new ArtifactBinding("tenant-a", "principal-a",
                "reference", "v7", REF_SHA, "purpose:quality-evaluation",
                List.of("rights:reference:v7"), "policy:reference:v7"));
    }

    private static AuthorityDecision allowed(String id) { return new AuthorityDecision(AuthorityStatus.ALLOWED, id); }

    private static byte[][] stableFrames() {
        return new byte[][] {{10, 20, 30}, {10, 20, 30}, {10, 20, 30}};
    }

    private static DecodedFrameSequence sequence(String sha, byte[][] rgb, Roi roi) {
        return sequence(sha, rgb, roi, "source", "v3");
    }

    private static DecodedFrameSequence sequence(String sha, byte[][] rgb, Roi roi, String artifactId, String version) {
        List<Frame> frames = new ArrayList<>();
        for (int i = 0; i < rgb.length; i++) {
            frames.add(frame(i, i, rgb[i], roi));
        }
        return new DecodedFrameSequence(artifactId, version, sha, TIME_BASE, frames);
    }

    private static DecodedFrameSequence sequenceWithTimeBase(String artifactId, String version, String sha,
            byte[][] rgb, Roi roi, TimeBase timeBase) {
        List<Frame> frames = new ArrayList<>();
        long[] pts = {0, 1_001, 3_003};
        for (int i = 0; i < rgb.length; i++) {
            frames.add(new Frame(i, pts[i], 3, 1, roi, rgb[i]));
        }
        return new DecodedFrameSequence(artifactId, version, sha, timeBase, frames);
    }

    private static Frame frame(int index, long pts, byte[] rgb, Roi roi) {
        return new Frame(index, pts, rgb.length == 6 ? 2 : 1, 1, roi, rgb);
    }

    private static byte[][] cloneFrames(byte[][] frames) {
        return java.util.Arrays.stream(frames).map(byte[]::clone).toArray(byte[][]::new);
    }
}
