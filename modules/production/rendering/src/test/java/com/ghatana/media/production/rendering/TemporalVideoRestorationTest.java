package com.ghatana.media.production.rendering;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static com.ghatana.media.production.rendering.TemporalVideoRestoration.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TemporalVideoRestorationTest {
    private static final String SOURCE_SHA = "a".repeat(64);
    private static final String REF_SHA = "b".repeat(64);
    private static final TimeBase TIME_BASE = new TimeBase(1, 30);

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
        assertThatThrownBy(() -> new Frame(0, 0, 2_049, 1, new Roi(0, 0, 1, 1), new byte[3]))
                .isInstanceOf(InvalidRestorationInputException.class).hasMessageContaining("dimensions");
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

    private static Frame frame(int index, long pts, byte[] rgb, Roi roi) {
        return new Frame(index, pts, rgb.length == 6 ? 2 : 1, 1, roi, rgb);
    }

    private static byte[][] cloneFrames(byte[][] frames) {
        return java.util.Arrays.stream(frames).map(byte[]::clone).toArray(byte[][]::new);
    }
}
