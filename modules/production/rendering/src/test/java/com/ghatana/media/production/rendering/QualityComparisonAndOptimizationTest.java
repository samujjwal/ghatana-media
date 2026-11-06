package com.ghatana.media.production.rendering;

import org.junit.jupiter.api.Test;

import java.util.AbstractList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static com.ghatana.media.production.rendering.QualityComparisonAndOptimization.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class QualityComparisonAndOptimizationTest {
    private static final String OPERATION = "media.optimize.video.lossless-profile";
    private static final TimeBase TB = new TimeBase(1, 30);
    private static final Budget BUDGET = new Budget(100, 300, 4);

    @Test
    void authorizedAlignedReferenceProducesGoldenPsnrSsimAndImprovementDisposition() {
        Revision source = revision("source", "v1", "a", 40);
        Revision candidate = revision("candidate", "v1", "b", 25);
        Revision reference = revision("reference", "v7", "c", 20);
        Run run = run(source, List.of(candidate), reference, allowed("src"), allowed("ref"), 1, BUDGET);

        assertThat(run.status()).isEqualTo(RunStatus.COMPLETED);
        CandidateComparison comparison = run.report().orElseThrow().comparisons().getFirst();
        assertThat(comparison.psnr().algorithm()).isEqualTo("RGB8_SAMPLE_PSNR_V1");
        assertThat(comparison.psnr().status()).isEqualTo(MetricStatus.MEASURED);
        assertThat(comparison.psnr().value().orElseThrow()).isCloseTo(34.1514, org.assertj.core.data.Offset.offset(0.001));
        assertThat(comparison.ssim().algorithm()).isEqualTo("GLOBAL_SRGB_LUMA_SSIM_V1");
        assertThat(comparison.ssim().value().orElseThrow()).isCloseTo(0.9758, org.assertj.core.data.Offset.offset(0.001));
        assertThat(comparison.disposition()).isEqualTo(QualityDisposition.IMPROVED);
        assertThat(comparison.heuristics().meanAbsoluteSourceDelta()).isEqualTo(15.0);
        assertThat(run.report().orElseThrow().reference()).contains(reference.id());
    }

    @Test
    void exactCandidateReferenceMatchBeatsFiniteSourcePsnr() {
        Revision source = revision("source", "v1", "a", 40);
        Revision exact = revision("candidate", "v1", "b", 20);
        Revision reference = revision("reference", "v7", "c", 20);
        CandidateComparison comparison = run(source, List.of(exact), reference, allowed("src"), allowed("ref"), 1, BUDGET)
                .report().orElseThrow().comparisons().getFirst();

        assertThat(comparison.psnr().status()).isEqualTo(MetricStatus.EXACT_MATCH);
        assertThat(comparison.psnr().value()).isEmpty();
        assertThat(comparison.disposition()).isEqualTo(QualityDisposition.IMPROVED);
    }

    @Test
    void absentOrUnalignedReferenceLeavesMeasuredMetricsUnavailableAndNoImprovementClaim() {
        Revision source = revision("source", "v1", "a", 40);
        Revision candidate = revision("candidate", "v1", "b", 25);
        Run noReference = run(source, List.of(candidate), null, allowed("src"), null, 1, BUDGET);
        CandidateComparison noReferenceResult = noReference.report().orElseThrow().comparisons().getFirst();
        assertThat(noReferenceResult.psnr().status()).isEqualTo(MetricStatus.UNAVAILABLE);
        assertThat(noReferenceResult.ssim().status()).isEqualTo(MetricStatus.UNAVAILABLE);
        assertThat(noReferenceResult.disposition()).isEqualTo(QualityDisposition.UNAVAILABLE);
        assertThat(noReference.report().orElseThrow().referenceUnavailableReason()).contains(UnavailableReason.NO_REFERENCE);

        Revision offTimebase = new Revision(referenceId("reference", "v7", "c"), new TimeBase(1, 24), frames(20));
        Run unaligned = run(source, List.of(candidate), offTimebase, allowed("src"), allowed("ref"), 1, BUDGET);
        CandidateComparison unalignedResult = unaligned.report().orElseThrow().comparisons().getFirst();
        assertThat(unalignedResult.psnr().status()).isEqualTo(MetricStatus.UNAVAILABLE);
        assertThat(unalignedResult.disposition()).isEqualTo(QualityDisposition.UNAVAILABLE);
        assertThat(unaligned.report().orElseThrow().referenceUnavailableReason()).contains(UnavailableReason.REFERENCE_NOT_ALIGNED);
    }

    @Test
    void invalidFrameBudgetAndAttemptBoundsAreRejected() {
        assertThatThrownBy(() -> new RgbFrame(0, 1, 1, 0, new byte[2]))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("length");
        assertThatThrownBy(() -> new RgbFrame(0, 2_049, 1, 0, new byte[3]))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("dimensions");
        assertThatThrownBy(() -> new Budget(MAX_PIXELS + 1, MAX_BYTES, 1))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("maxPixels");
        assertThatThrownBy(() -> new Budget(100, MAX_BYTES + 1, 1))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("maxBytes");
        assertThatThrownBy(() -> new Budget(100, 300, MAX_ATTEMPTS + 1))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("maxAttempts");

        Revision source = revision("source", "v1", "a", 40);
        CandidatePort port = port(List.of(revision("candidate", "v1", "b", 25)));
        assertThatThrownBy(() -> runOptimization(source, port, 1, new Budget(2, 300, 1), null, null))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("declared pixel/byte budget");
        assertThatThrownBy(() -> runOptimization(source, port, 1, new Budget(5, 300, 1), null, null))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("aggregate pixel/byte budget");
        assertThatThrownBy(() -> runOptimization(source, port, 1, new Budget(100, 17, 1), null, null))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("aggregate pixel/byte budget");
        assertThatThrownBy(() -> runOptimization(source, port, 2, new Budget(100, 300, 1), null, null))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("attempts");
    }

    @Test
    void oversizedFrameListIsRejectedBeforeCopyingOrTraversal() {
        List<RgbFrame> oversized = new AbstractList<>() {
            @Override public RgbFrame get(int index) {
                throw new AssertionError("oversized frame list must be rejected before traversal");
            }
            @Override public int size() { return MAX_FRAMES + 1; }
        };

        assertThatThrownBy(() -> new Revision(referenceId("source", "v1", "a"), TB, oversized))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("frame count");
    }

    @Test
    void repeatedAttemptsAreBoundedRetainedAndReportIsDeterministic() {
        Revision source = revision("source", "v1", "a", 40);
        List<Revision> candidates = List.of(revision("candidate", "v1", "b", 25), revision("candidate", "v2", "d", 28));
        Revision reference = revision("reference", "v7", "c", 20);
        Run first = run(source, candidates, reference, allowed("src"), allowed("ref"), 2, BUDGET);
        Run second = run(source, candidates, reference, allowed("src"), allowed("ref"), 2, BUDGET);

        assertThat(first.attemptsUsed()).isEqualTo(2);
        assertThat(first.retainedRevisions()).extracting(revision -> revision.id().versionId())
                .containsExactly("v1", "v1", "v2");
        assertThat(first.report().orElseThrow().reportSha256()).isEqualTo(second.report().orElseThrow().reportSha256());
        assertThat(first.report().orElseThrow().comparisons()).hasSize(2);

        Revision restored = undo(first, source.id());
        assertThat(restored.id()).isEqualTo(source.id());
        assertThat(restored.frames().getFirst().rgb()).containsExactly(source.frames().getFirst().rgb());
    }

    @Test
    void sourceRightsRevocationSuppressesReportAndCandidatePortEffects() {
        Revision source = revision("source", "v1", "a", 40);
        AtomicInteger calls = new AtomicInteger();
        AtomicInteger attempts = new AtomicInteger();
        CandidatePort port = new CandidatePort() {
            @Override public boolean supports(String operationId) { return true; }
            @Override public OptimizationAttempt optimize(String op, Revision src, int attempt, Budget budget) {
                attempts.incrementAndGet(); return OptimizationAttempt.available(revision("candidate", "v1", "b", 25));
            }
        };
        Run revoked = optimize(OPERATION, source, (id, purpose) -> calls.incrementAndGet() <= 2
                        ? allowed("src") : new AuthorityDecision(AuthorityStatus.DENIED, ""),
                port, 1, BUDGET, Optional.empty(), null, null);

        assertThat(revoked.status()).isEqualTo(RunStatus.NOT_ADMITTED);
        assertThat(revoked.reason()).contains(BlockReason.SOURCE_REVOKED);
        assertThat(revoked.report()).isEmpty();
        assertThat(attempts).hasValue(1);
        assertThat(revoked.attemptsUsed()).isEqualTo(1);
    }

    @Test
    void sourceRightsAreRecheckedBeforeEachAttemptAndAttemptCountTracksActualCalls() {
        Revision source = revision("source", "v1", "a", 40);
        AtomicInteger rightsChecks = new AtomicInteger();
        AtomicInteger calls = new AtomicInteger();
        CandidatePort port = new CandidatePort() {
            @Override public boolean supports(String operationId) { return true; }
            @Override public OptimizationAttempt optimize(String op, Revision src, int attempt, Budget budget) {
                calls.incrementAndGet();
                return OptimizationAttempt.available(revision("candidate", "v" + attempt, attempt == 1 ? "b" : "d", 25));
            }
        };
        Run revoked = optimize(OPERATION, source, (id, purpose) -> rightsChecks.incrementAndGet() <= 2
                        ? allowed("src") : new AuthorityDecision(AuthorityStatus.DENIED, ""),
                port, 2, BUDGET, Optional.empty(), null, null);

        assertThat(calls).hasValue(1);
        assertThat(rightsChecks).hasValue(3);
        assertThat(revoked.status()).isEqualTo(RunStatus.NOT_ADMITTED);
        assertThat(revoked.reason()).contains(BlockReason.SOURCE_REVOKED);
        assertThat(revoked.report()).isEmpty();
        assertThat(revoked.retainedRevisions()).isEmpty();
        assertThat(revoked.attemptsUsed()).isEqualTo(1);
    }

    @Test
    void referenceRevocationRemovesReferenceMetricsAndUnsupportedOptimizationIsRefused() {
        Revision source = revision("source", "v1", "a", 40);
        Revision candidate = revision("candidate", "v1", "b", 25);
        Revision reference = revision("reference", "v7", "c", 20);
        AtomicInteger refCalls = new AtomicInteger();
        Run revoked = optimize(OPERATION, source, (id, purpose) -> allowed("src"), port(List.of(candidate)), 1,
                BUDGET, Optional.of(new ReferenceRequest(reference.id(), "quality-reference")),
                (id, purpose) -> refCalls.incrementAndGet() == 1 ? allowed("ref")
                        : new AuthorityDecision(AuthorityStatus.DENIED, ""), id -> reference);
        CandidateComparison comparison = revoked.report().orElseThrow().comparisons().getFirst();
        assertThat(comparison.psnr().status()).isEqualTo(MetricStatus.UNAVAILABLE);
        assertThat(comparison.disposition()).isEqualTo(QualityDisposition.UNAVAILABLE);
        assertThat(revoked.report().orElseThrow().reference()).isEmpty();

        Run unsupported = runOptimization(source, new CandidatePort() {
            @Override public boolean supports(String operationId) { return false; }
            @Override public OptimizationAttempt optimize(String op, Revision src, int attempt, Budget budget) {
                throw new AssertionError("unsupported operation must not execute");
            }
        }, 1, BUDGET, null, null);
        assertThat(unsupported.status()).isEqualTo(RunStatus.NOT_ADMITTED);
        assertThat(unsupported.reason()).contains(BlockReason.CANDIDATE_PORT_UNSUPPORTED);
        assertThat(unsupported.report()).isEmpty();
    }

    @Test
    void missingOrUnavailableCandidatePortIsNotReportedAsSuccessfulOptimization() {
        Revision source = revision("source", "v1", "a", 40);
        Run missing = runOptimization(source, null, 1, BUDGET, null, null);
        assertThat(missing.status()).isEqualTo(RunStatus.UNAVAILABLE);
        assertThat(missing.reason()).contains(BlockReason.CANDIDATE_PORT_UNAVAILABLE);
        assertThat(missing.report()).isEmpty();

        CandidatePort unavailable = new CandidatePort() {
            @Override public boolean supports(String operationId) { return true; }
            @Override public OptimizationAttempt optimize(String op, Revision src, int attempt, Budget budget) {
                return OptimizationAttempt.unavailable();
            }
        };
        Run noOutput = runOptimization(source, unavailable, 1, BUDGET, null, null);
        assertThat(noOutput.status()).isEqualTo(RunStatus.UNAVAILABLE);
        assertThat(noOutput.reason()).contains(BlockReason.CANDIDATE_UNAVAILABLE);
        assertThat(noOutput.report()).isEmpty();
        assertThat(noOutput.attemptsUsed()).isEqualTo(1);

        CandidatePort throwsDuringAttempt = new CandidatePort() {
            @Override public boolean supports(String operationId) { return true; }
            @Override public OptimizationAttempt optimize(String op, Revision src, int attempt, Budget budget) {
                throw new IllegalStateException("candidate worker unavailable");
            }
        };
        Run thrown = runOptimization(source, throwsDuringAttempt, 1, BUDGET, null, null);
        assertThat(thrown.status()).isEqualTo(RunStatus.UNAVAILABLE);
        assertThat(thrown.attemptsUsed()).isEqualTo(1);
        assertThat(thrown.report()).isEmpty();

        Revision firstCandidate = revision("candidate", "v1", "b", 25);
        AtomicInteger attempts = new AtomicInteger();
        CandidatePort partial = new CandidatePort() {
            @Override public boolean supports(String operationId) { return true; }
            @Override public OptimizationAttempt optimize(String op, Revision src, int attempt, Budget budget) {
                attempts.incrementAndGet();
                return attempt == 1 ? OptimizationAttempt.available(firstCandidate) : OptimizationAttempt.unavailable();
            }
        };
        Run partialRun = runOptimization(source, partial, 2, BUDGET, null, null);
        assertThat(partialRun.status()).isEqualTo(RunStatus.UNAVAILABLE);
        assertThat(partialRun.report()).isEmpty();
        assertThat(partialRun.retainedRevisions()).containsExactly(source, firstCandidate);
        assertThat(partialRun.attemptsUsed()).isEqualTo(2);
    }

    private static Run run(Revision source, List<Revision> candidates, Revision reference,
            AuthorityDecision sourceDecision, AuthorityDecision referenceDecision, int attempts, Budget budget) {
        Optional<ReferenceRequest> request = reference == null ? Optional.empty()
                : Optional.of(new ReferenceRequest(reference.id(), "quality-reference"));
        return optimize(OPERATION, source, (id, purpose) -> sourceDecision, port(candidates), attempts, budget,
                request, referenceDecision == null ? null : (id, purpose) -> referenceDecision,
                reference == null ? null : id -> reference);
    }

    private static Run runOptimization(Revision source, CandidatePort port, int attempts, Budget budget,
            RightsAuthority referenceRights, ReferenceReader referenceReader) {
        return optimize(OPERATION, source, (id, purpose) -> allowed("src"), port, attempts, budget,
                Optional.empty(), referenceRights, referenceReader);
    }

    private static CandidatePort port(List<Revision> candidates) {
        return new CandidatePort() {
            @Override public boolean supports(String operationId) { return OPERATION.equals(operationId); }
            @Override public OptimizationAttempt optimize(String operationId, Revision source, int attempt, Budget budget) {
                return OptimizationAttempt.available(candidates.get(attempt - 1));
            }
        };
    }

    private static Revision revision(String artifact, String version, String marker, int value) {
        return new Revision(referenceId(artifact, version, marker), TB, frames(value));
    }

    private static RevisionId referenceId(String artifact, String version, String marker) {
        return new RevisionId("tenant-1", "principal-1", artifact, version, marker.repeat(64));
    }

    private static List<RgbFrame> frames(int value) {
        return List.of(new RgbFrame(0, 1, 1, 0, new byte[] {(byte) value, (byte) value, (byte) value}),
                new RgbFrame(1, 1, 1, 1, new byte[] {(byte) value, (byte) value, (byte) value}),
                new RgbFrame(2, 1, 1, 2, new byte[] {(byte) value, (byte) value, (byte) value}));
    }

    private static AuthorityDecision allowed(String id) { return new AuthorityDecision(AuthorityStatus.ALLOWED, id); }
}
