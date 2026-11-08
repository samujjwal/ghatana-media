package com.ghatana.media.production.rendering;

import org.junit.jupiter.api.Test;

import java.util.AbstractList;
import java.util.ArrayList;
import java.util.Iterator;
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
    void authorityDecisionIdentityRejectsWhitespaceInsteadOfNormalizingRightsEvidence() {
        assertThatThrownBy(() -> new AuthorityDecision(AuthorityStatus.ALLOWED, " decision-v1 "))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("exact");
        assertThatThrownBy(() -> new AuthorityDecision(AuthorityStatus.DENIED, " denied-decision "))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("exact");
        assertThat(new AuthorityDecision(AuthorityStatus.ALLOWED, "decision-v1").decisionId())
                .isEqualTo("decision-v1");
    }

    @Test
    void referencePurposeAndProtocolTokensRejectSurroundingWhitespaceInsteadOfNormalizing() {
        Revision source = revision("source", "v1", "a", 40);
        AtomicInteger rightsChecks = new AtomicInteger();

        assertThatThrownBy(() -> new ReferenceRequest(source.id(), " quality-reference "))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("surrounding whitespace");
        assertThatThrownBy(() -> new Metric(" RGB8_SAMPLE_PSNR_V1 ", MetricStatus.UNAVAILABLE,
                java.util.OptionalDouble.empty()))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("surrounding whitespace");
        assertThatThrownBy(() -> optimize(" " + OPERATION, source, (id, purpose) -> {
            rightsChecks.incrementAndGet();
            return allowed("source-rights");
        }, port(List.of(revision("candidate", "v1", "b", 25))), 1, BUDGET,
                Optional.empty(), null, null))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("surrounding whitespace");
        assertThat(rightsChecks).hasValue(0);
    }

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
    void sourceOrCandidateCannotBeReusedAsItsOwnQualityReference() {
        Revision source = revision("source", "v1", "a", 40);
        Revision candidate = revision("candidate", "v1", "b", 25);
        for (Revision aliasedReference : List.of(source, candidate)) {
            AtomicInteger rightsChecks = new AtomicInteger();
            AtomicInteger referenceReads = new AtomicInteger();
            Run run = optimize(OPERATION, source, (id, purpose) -> allowed("src"), port(List.of(candidate)), 1,
                    BUDGET, Optional.of(new ReferenceRequest(aliasedReference.id(), "quality-reference")),
                    (id, purpose) -> {
                        rightsChecks.incrementAndGet();
                        return allowed("ref");
                    }, id -> {
                        referenceReads.incrementAndGet();
                        return aliasedReference;
                    });

            Report report = run.report().orElseThrow();
            CandidateComparison comparison = report.comparisons().getFirst();
            assertThat(report.reference()).isEmpty();
            assertThat(report.referenceUnavailableReason()).contains(UnavailableReason.REFERENCE_UNAVAILABLE);
            assertThat(comparison.psnr().status()).isEqualTo(MetricStatus.UNAVAILABLE);
            assertThat(comparison.ssim().status()).isEqualTo(MetricStatus.UNAVAILABLE);
            assertThat(comparison.disposition()).isEqualTo(QualityDisposition.UNAVAILABLE);
            assertThat(rightsChecks).hasValue(0);
            assertThat(referenceReads).hasValue(0);
        }
    }

    @Test
    void j19LocalScenarioReportsBoundedReversibleComparisonAndFailsClosedOnUnknownAuthority() {
        // These synthetic RGB8 samples exercise the local contract only. They are not
        // decoded media, independently authored quality evidence, or production output.
        Revision source = revision("source", "v1", "a", 40);
        Revision candidate = revision("candidate", "v2", "b", 25);
        Revision reference = revision("reference", "v7", "c", 20);
        Budget declaredBounds = new Budget(100, 300, 2);

        Run first = run(source, List.of(candidate), reference, allowed("source-rights-v1"),
                allowed("reference-rights-v1"), 1, declaredBounds);
        Run replay = run(source, List.of(candidate), reference, allowed("source-rights-v1"),
                allowed("reference-rights-v1"), 1, declaredBounds);

        assertThat(first.status()).isEqualTo(RunStatus.COMPLETED);
        Report report = first.report().orElseThrow();
        assertThat(report.source()).isEqualTo(source.id());
        assertThat(report.retainedRevisions()).containsExactly(source.id(), candidate.id());
        assertThat(report.reference()).contains(reference.id());
        assertThat(report.budget()).isEqualTo(declaredBounds);
        assertThat(report.attemptsUsed()).isEqualTo(1);
        assertThat(report.reportSha256()).isEqualTo(replay.report().orElseThrow().reportSha256());
        CandidateComparison comparison = report.comparisons().getFirst();
        assertThat(comparison.candidate()).isEqualTo(candidate.id());
        assertThat(comparison.psnr().algorithm()).isEqualTo("RGB8_SAMPLE_PSNR_V1");
        assertThat(comparison.psnr().value().orElseThrow()).isCloseTo(34.1514,
                org.assertj.core.data.Offset.offset(0.001));
        assertThat(comparison.ssim().algorithm()).isEqualTo("GLOBAL_SRGB_LUMA_SSIM_V1");
        assertThat(comparison.ssim().value().orElseThrow()).isCloseTo(0.9758,
                org.assertj.core.data.Offset.offset(0.001));
        assertThat(comparison.disposition()).isEqualTo(QualityDisposition.IMPROVED);
        assertThat(undo(first, source.id())).isEqualTo(source);

        AtomicInteger candidateCalls = new AtomicInteger();
        CandidatePort candidatePort = new CandidatePort() {
            @Override public boolean supports(String operationId) { return true; }
            @Override public OptimizationAttempt optimize(String operationId, Revision input, int attempt, Budget bounds) {
                candidateCalls.incrementAndGet();
                return OptimizationAttempt.available(candidate);
            }
        };
        Run denied = optimize(OPERATION, source,
                (id, purpose) -> new AuthorityDecision(AuthorityStatus.DENIED, ""),
                candidatePort, 1, declaredBounds, Optional.empty(), null, null);
        Run authorityUnknown = optimize(OPERATION, source, null, candidatePort, 1,
                declaredBounds, Optional.empty(), null, null);

        assertThat(denied.status()).isEqualTo(RunStatus.NOT_ADMITTED);
        assertThat(denied.reason()).contains(BlockReason.SOURCE_DENIED);
        assertThat(denied.report()).isEmpty();
        assertThat(authorityUnknown.status()).isEqualTo(RunStatus.UNAVAILABLE);
        assertThat(authorityUnknown.reason()).contains(BlockReason.SOURCE_AUTHORITY_UNAVAILABLE);
        assertThat(authorityUnknown.report()).isEmpty();
        assertThat(candidateCalls).hasValue(0);
    }

    @Test
    void reportAndRunResultListsHonorAttemptBoundsBeforeCopying() {
        Revision source = revision("source", "v1", "a", 40);
        Revision candidate = revision("candidate", "v1", "b", 25);
        Run valid = run(source, List.of(candidate), null, allowed("src"), null, 1, BUDGET);
        Report report = valid.report().orElseThrow();
        assertThat(report.retainedRevisions()).containsExactly(source.id(), candidate.id());
        assertThat(report.comparisons()).hasSize(1);

        AtomicInteger retainedReads = new AtomicInteger();
        assertThatThrownBy(() -> new Report(report.status(), report.blockReason(), report.operationId(),
                report.budget(), report.attemptsUsed(), report.source(), report.sourceRightsDecisionId(),
                oversizedWithoutTraversal(retainedReads), report.reference(), report.referenceRightsDecisionId(),
                report.referenceUnavailableReason(), report.comparisons(), report.reportSha256()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("report retained revisions exceed the attempt bound");
        assertThat(retainedReads).hasValue(0);

        AtomicInteger comparisonReads = new AtomicInteger();
        assertThatThrownBy(() -> new Report(report.status(), report.blockReason(), report.operationId(),
                report.budget(), report.attemptsUsed(), report.source(), report.sourceRightsDecisionId(),
                report.retainedRevisions(), report.reference(), report.referenceRightsDecisionId(),
                report.referenceUnavailableReason(), oversizedWithoutTraversal(comparisonReads),
                report.reportSha256()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("report comparisons exceed the attempt bound");
        assertThat(comparisonReads).hasValue(0);

        AtomicInteger runReads = new AtomicInteger();
        assertThatThrownBy(() -> new Run(RunStatus.UNAVAILABLE,
                Optional.of(BlockReason.CANDIDATE_UNAVAILABLE), Optional.empty(),
                oversizedWithoutTraversal(runReads), 0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("run retained revisions exceed the attempt bound");
        assertThat(runReads).hasValue(0);

        AtomicInteger observedReads = new AtomicInteger();
        assertThatThrownBy(() -> new Run(RunStatus.UNAVAILABLE,
                Optional.of(BlockReason.CANDIDATE_UNAVAILABLE), Optional.empty(),
                iteratorExceedingDeclaredSize(source, observedReads, 2), 0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("run retained revisions exceed the attempt bound");
        assertThat(observedReads).hasValue(1);
    }

    @Test
    void completedRunRequiresMatchingCompletedReport() {
        assertThatThrownBy(() -> new Run(RunStatus.COMPLETED, Optional.empty(), Optional.empty(), List.of(), 0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("completed run requires a report");

        Revision source = revision("source", "v1", "a", 40);
        Revision candidate = revision("candidate", "v1", "b", 25);
        Report completedReport = run(source, List.of(candidate), null, allowed("src"), null, 1, BUDGET)
                .report().orElseThrow();
        assertThatThrownBy(() -> new Run(RunStatus.UNAVAILABLE, Optional.empty(), Optional.of(completedReport),
                List.of(source), 1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("blocked run requires a reason");

        Revision otherSource = revision("other-source", "v1", "c", 40);
        assertThatThrownBy(() -> new Run(RunStatus.COMPLETED, Optional.empty(), Optional.of(completedReport),
                List.of(otherSource, candidate), 1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("retained revisions must match its report");
    }

    @Test
    void reportRequiresComparisonRowsToMatchRetainedCandidatesInAttemptOrder() {
        Revision source = revision("source", "v1", "a", 40);
        Revision candidate = revision("candidate", "v1", "b", 25);
        Report report = run(source, List.of(candidate), null, allowed("src"), null, 1, BUDGET)
                .report().orElseThrow();
        CandidateComparison comparison = report.comparisons().getFirst();
        CandidateComparison mismatched = new CandidateComparison(
                revision("other-candidate", "v1", "c", 20).id(), comparison.psnr(), comparison.ssim(),
                comparison.heuristics(), comparison.disposition());

        assertThatThrownBy(() -> new Report(report.status(), report.blockReason(), report.operationId(),
                report.budget(), report.attemptsUsed(), report.source(), report.sourceRightsDecisionId(),
                report.retainedRevisions(), report.reference(), report.referenceRightsDecisionId(),
                report.referenceUnavailableReason(), List.of(mismatched), report.reportSha256()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("comparison candidates must match retained revisions in attempt order");

        assertThatThrownBy(() -> new Report(report.status(), report.blockReason(), report.operationId(),
                report.budget(), report.attemptsUsed(), revision("other-source", "v1", "d", 40).id(),
                report.sourceRightsDecisionId(), report.retainedRevisions(), report.reference(),
                report.referenceRightsDecisionId(), report.referenceUnavailableReason(), report.comparisons(),
                report.reportSha256()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("retained revisions must start with source");
    }

    @Test
    void reportRejectsComparisonRowsSwappedAcrossMultipleAttempts() {
        Revision source = revision("source", "v1", "a", 40);
        Revision firstCandidate = revision("candidate", "v1", "b", 25);
        Revision secondCandidate = revision("candidate", "v2", "d", 28);
        Report report = run(source, List.of(firstCandidate, secondCandidate), null,
                allowed("src"), null, 2, BUDGET).report().orElseThrow();
        List<CandidateComparison> comparisons = report.comparisons();

        assertThatThrownBy(() -> new Report(report.status(), report.blockReason(), report.operationId(),
                report.budget(), report.attemptsUsed(), report.source(), report.sourceRightsDecisionId(),
                report.retainedRevisions(), report.reference(), report.referenceRightsDecisionId(),
                report.referenceUnavailableReason(), List.of(comparisons.get(1), comparisons.get(0)),
                report.reportSha256()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("comparison candidates must match retained revisions in attempt order");
    }

    @Test
    void reportReferenceAndRightsFieldsMustDescribeOneConsistentAuthorityOutcome() {
        Revision source = revision("source", "v1", "a", 40);
        Revision candidate = revision("candidate", "v1", "b", 25);
        Report withoutReference = run(source, List.of(candidate), null, allowed("src"), null, 1, BUDGET)
                .report().orElseThrow();
        RevisionId foreignReference = new RevisionId("other-tenant", "principal", "reference", "v1",
                "c".repeat(64));

        assertThatThrownBy(() -> new Report(withoutReference.status(), withoutReference.blockReason(),
                withoutReference.operationId(), withoutReference.budget(), withoutReference.attemptsUsed(),
                withoutReference.source(), withoutReference.sourceRightsDecisionId(),
                withoutReference.retainedRevisions(), Optional.of(foreignReference),
                withoutReference.referenceRightsDecisionId(), withoutReference.referenceUnavailableReason(),
                withoutReference.comparisons(), withoutReference.reportSha256()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("reference must match the source tenant and principal");

        assertThatThrownBy(() -> new Report(withoutReference.status(), withoutReference.blockReason(),
                withoutReference.operationId(), withoutReference.budget(), withoutReference.attemptsUsed(),
                withoutReference.source(), withoutReference.sourceRightsDecisionId(),
                withoutReference.retainedRevisions(), Optional.of(revision("reference", "v1", "c", 20).id()),
                "", withoutReference.referenceUnavailableReason(), withoutReference.comparisons(),
                withoutReference.reportSha256()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("available report reference requires an exact rights decision");

        assertThatThrownBy(() -> new Report(withoutReference.status(), withoutReference.blockReason(),
                withoutReference.operationId(), withoutReference.budget(), withoutReference.attemptsUsed(),
                withoutReference.source(), withoutReference.sourceRightsDecisionId(),
                withoutReference.retainedRevisions(), Optional.empty(), "forged-reference-rights",
                withoutReference.referenceUnavailableReason(), withoutReference.comparisons(),
                withoutReference.reportSha256()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unavailable report reference requires a reason");

        assertThatThrownBy(() -> new Report(withoutReference.status(), withoutReference.blockReason(),
                withoutReference.operationId(), withoutReference.budget(), withoutReference.attemptsUsed(),
                withoutReference.source(), "", withoutReference.retainedRevisions(),
                withoutReference.reference(), withoutReference.referenceRightsDecisionId(),
                withoutReference.referenceUnavailableReason(), withoutReference.comparisons(),
                withoutReference.reportSha256()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("exact source rights decision id");
    }

    @Test
    void reportRejectsChangedIdentityWithStaleDigestAndBlockedStatus() {
        Revision source = revision("source", "v1", "a", 40);
        Revision candidate = revision("candidate", "v1", "b", 25);
        Report report = run(source, List.of(candidate), null, allowed("source-rights-v1"), null, 1, BUDGET)
                .report().orElseThrow();

        assertThatThrownBy(() -> new Report(report.status(), report.blockReason(), report.operationId(),
                report.budget(), report.attemptsUsed(), report.source(), "forged-source-rights-v2",
                report.retainedRevisions(), report.reference(), report.referenceRightsDecisionId(),
                report.referenceUnavailableReason(), report.comparisons(), report.reportSha256()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("report sha256 does not match report content");

        assertThatThrownBy(() -> new Report(RunStatus.UNAVAILABLE, Optional.of(BlockReason.SOURCE_REVOKED),
                report.operationId(), report.budget(), report.attemptsUsed(), report.source(),
                report.sourceRightsDecisionId(), report.retainedRevisions(), report.reference(),
                report.referenceRightsDecisionId(), report.referenceUnavailableReason(), report.comparisons(),
                report.reportSha256()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("quality report must be completed without a block reason");
    }

    @Test
    void reportComparisonMetricAvailabilityMustMatchAuthorizedReference() {
        Revision source = revision("source", "v1", "a", 40);
        Revision candidate = revision("candidate", "v1", "b", 25);
        Report withoutReference = run(source, List.of(candidate), null, allowed("src"), null, 1, BUDGET)
                .report().orElseThrow();
        CandidateComparison fabricatedImprovement = new CandidateComparison(candidate.id(),
                new Metric("RGB8_SAMPLE_PSNR_V1", MetricStatus.MEASURED, java.util.OptionalDouble.of(30)),
                new Metric("GLOBAL_SRGB_LUMA_SSIM_V1", MetricStatus.MEASURED, java.util.OptionalDouble.of(0.9)),
                withoutReference.comparisons().getFirst().heuristics(), QualityDisposition.IMPROVED);

        assertThatThrownBy(() -> new Report(withoutReference.status(), withoutReference.blockReason(),
                withoutReference.operationId(), withoutReference.budget(), withoutReference.attemptsUsed(),
                withoutReference.source(), withoutReference.sourceRightsDecisionId(),
                withoutReference.retainedRevisions(), withoutReference.reference(),
                withoutReference.referenceRightsDecisionId(), withoutReference.referenceUnavailableReason(),
                List.of(fabricatedImprovement), withoutReference.reportSha256()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("metric availability must match reference availability");

        Revision reference = revision("reference", "v7", "c", 20);
        Report withReference = run(source, List.of(candidate), reference, allowed("src"), allowed("ref"), 1, BUDGET)
                .report().orElseThrow();
        CandidateComparison unavailableComparison = new CandidateComparison(candidate.id(),
                new Metric("RGB8_SAMPLE_PSNR_V1", MetricStatus.UNAVAILABLE, java.util.OptionalDouble.empty()),
                new Metric("GLOBAL_SRGB_LUMA_SSIM_V1", MetricStatus.UNAVAILABLE, java.util.OptionalDouble.empty()),
                withReference.comparisons().getFirst().heuristics(), QualityDisposition.UNAVAILABLE);

        assertThatThrownBy(() -> new Report(withReference.status(), withReference.blockReason(),
                withReference.operationId(), withReference.budget(), withReference.attemptsUsed(),
                withReference.source(), withReference.sourceRightsDecisionId(),
                withReference.retainedRevisions(), withReference.reference(),
                withReference.referenceRightsDecisionId(), withReference.referenceUnavailableReason(),
                List.of(unavailableComparison), withReference.reportSha256()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("metric availability must match reference availability");
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
        assertThat(comparison.ssim().value()).hasValue(1.0);
        assertThat(comparison.disposition()).isEqualTo(QualityDisposition.IMPROVED);
    }

    @Test
    void candidateMustHaveDistinctExactImmutableRevisionIdentityFromSource() {
        Revision source = revision("source", "v1", "a", 40);
        Revision candidateWithSameIdentity = revision(source.id(), 25);

        assertThatThrownBy(() -> runOptimization(source, port(List.of(candidateWithSameIdentity)), 1, BUDGET,
                null, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("distinct exact immutable revision");
    }

    @Test
    void candidateComparisonCannotClaimImprovementWithoutPinnedMetrics() {
        RevisionId candidate = new RevisionId("tenant", "principal", "candidate", "v1", "a".repeat(64));
        Heuristics heuristics = new Heuristics(0, 0);
        Metric unavailablePsnr = new Metric("RGB8_SAMPLE_PSNR_V1", MetricStatus.UNAVAILABLE,
                java.util.OptionalDouble.empty());
        Metric unavailableSsim = new Metric("GLOBAL_SRGB_LUMA_SSIM_V1", MetricStatus.UNAVAILABLE,
                java.util.OptionalDouble.empty());
        Metric measuredPsnr = new Metric("RGB8_SAMPLE_PSNR_V1", MetricStatus.MEASURED,
                java.util.OptionalDouble.of(30));
        Metric measuredSsim = new Metric("GLOBAL_SRGB_LUMA_SSIM_V1", MetricStatus.MEASURED,
                java.util.OptionalDouble.of(0.9));

        assertThatThrownBy(() -> new CandidateComparison(candidate, unavailablePsnr, unavailableSsim,
                heuristics, QualityDisposition.IMPROVED))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("disposition must match measured metric availability");
        assertThatThrownBy(() -> new CandidateComparison(candidate, measuredPsnr, measuredSsim,
                heuristics, QualityDisposition.UNAVAILABLE))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("disposition must match measured metric availability");
        assertThatThrownBy(() -> new CandidateComparison(candidate,
                new Metric("UNQUALIFIED_METRIC", MetricStatus.MEASURED, java.util.OptionalDouble.of(99)),
                measuredSsim, heuristics, QualityDisposition.IMPROVED))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("pinned RGB8 PSNR and global SSIM algorithms");
        assertThatThrownBy(() -> new CandidateComparison(candidate, measuredPsnr,
                new Metric("GLOBAL_SRGB_LUMA_SSIM_V1", MetricStatus.EXACT_MATCH,
                        java.util.OptionalDouble.empty()), heuristics, QualityDisposition.NOT_IMPROVED))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("global SSIM is reported as a measured value");
        assertThatThrownBy(() -> new CandidateComparison(candidate,
                new Metric("RGB8_SAMPLE_PSNR_V1", MetricStatus.MEASURED,
                        java.util.OptionalDouble.of(-0.01)), measuredSsim, heuristics,
                QualityDisposition.NOT_IMPROVED))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("PSNR cannot be negative");
        assertThatThrownBy(() -> new CandidateComparison(candidate, measuredPsnr,
                new Metric("GLOBAL_SRGB_LUMA_SSIM_V1", MetricStatus.MEASURED,
                        java.util.OptionalDouble.of(1.0001)), heuristics, QualityDisposition.NOT_IMPROVED))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("SSIM must be within its bounded range");
        assertThatThrownBy(() -> new CandidateComparison(candidate, measuredPsnr,
                new Metric("GLOBAL_SRGB_LUMA_SSIM_V1", MetricStatus.MEASURED,
                        java.util.OptionalDouble.of(-1.0001)), heuristics, QualityDisposition.NOT_IMPROVED))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("SSIM must be within its bounded range");
        assertThatThrownBy(() -> new CandidateComparison(candidate,
                new Metric("RGB8_SAMPLE_PSNR_V1", MetricStatus.EXACT_MATCH, java.util.OptionalDouble.empty()),
                new Metric("GLOBAL_SRGB_LUMA_SSIM_V1", MetricStatus.MEASURED,
                        java.util.OptionalDouble.of(0.9999)), heuristics, QualityDisposition.NOT_IMPROVED))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("exact RGB8 PSNR match requires global SSIM of exactly 1.0");
    }

    @Test
    void framePixelsRemainIsolatedFromCallerMutation() {
        byte[] callerPixels = {10, 20, 30};
        RgbFrame frame = new RgbFrame(0, 1, 1, 0, callerPixels);
        callerPixels[0] = 99;
        byte[] exposedPixels = frame.rgb();
        exposedPixels[1] = 88;

        assertThat(frame.rgb()).containsExactly(10, 20, 30);
    }

    @Test
    void revisionPreservesSignedSourcePresentationTicksInOrder() {
        Revision revision = new Revision(referenceId("source", "v1", "a"), TB, List.of(
                new RgbFrame(0, 1, 1, Long.MIN_VALUE, new byte[] {1, 2, 3}),
                new RgbFrame(1, 1, 1, -1, new byte[] {4, 5, 6}),
                new RgbFrame(2, 1, 1, 0, new byte[] {7, 8, 9})));

        assertThat(revision.frames()).extracting(RgbFrame::presentationTicks)
                .containsExactly(Long.MIN_VALUE, -1L, 0L);
    }

    @Test
    void revisionIdentityRejectsWhitespaceNormalization() {
        assertThatThrownBy(() -> new RevisionId("tenant ", "principal", "artifact", "v1", "a".repeat(64)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("exact");
        assertThatThrownBy(() -> new RevisionId("tenant", "principal", "artifact", " v1", "a".repeat(64)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("exact");
        assertThatThrownBy(() -> new RevisionId("tenant", "principal", "artifact", "v1", " " + "a".repeat(64)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("surrounding whitespace");
        assertThatThrownBy(() -> new RevisionId("tenant", "principal", "artifact", "v1", "a".repeat(64) + " "))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("surrounding whitespace");
        assertThat(new RevisionId("tenant", "principal", "artifact", "v1", "A".repeat(64)).sha256())
                .isEqualTo("a".repeat(64));
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
    void underreportedFrameListIsRejectedBeforeTraversingPastTheFrameCap() {
        RgbFrame repeated = new RgbFrame(0, 1, 1, 0, new byte[] {1, 2, 3});
        List<RgbFrame> actualFrames = new ArrayList<>(java.util.Collections.nCopies(MAX_FRAMES + 1, repeated));
        AtomicInteger consumed = new AtomicInteger();
        List<RgbFrame> underreported = new AbstractList<>() {
            @Override public RgbFrame get(int index) { return actualFrames.get(index); }
            @Override public int size() { return 1; }
            @Override public Iterator<RgbFrame> iterator() {
                Iterator<RgbFrame> delegate = actualFrames.iterator();
                return new Iterator<>() {
                    @Override public boolean hasNext() { return delegate.hasNext(); }
                    @Override public RgbFrame next() {
                        consumed.incrementAndGet();
                        return delegate.next();
                    }
                };
            }
        };

        assertThatThrownBy(() -> new Revision(referenceId("source", "v1", "a"), TB, underreported))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("frame count");
        assertThat(consumed).hasValue(MAX_FRAMES);
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
        assertThatThrownBy(() -> undo(first, candidates.getFirst().id()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("exact source revision");
    }

    @Test
    void reportDigestDistinguishesRevisionTuplesContainingDelimiters() {
        // Both identities collapsed to the same pipe-delimited text before the
        // report encoder length-prefixed each source identity component.
        RevisionId firstId = new RevisionId("tenant|principal", "owner", "artifact", "v1", "a".repeat(64));
        RevisionId secondId = new RevisionId("tenant", "principal|owner", "artifact", "v1", "a".repeat(64));
        Revision firstSource = revision(firstId, 40);
        Revision secondSource = revision(secondId, 40);
        Revision firstCandidate = revision(new RevisionId(firstId.tenantId(), firstId.principalId(),
                "candidate", "v1", "b".repeat(64)), 40);
        Revision secondCandidate = revision(new RevisionId(secondId.tenantId(), secondId.principalId(),
                "candidate", "v1", "b".repeat(64)), 40);

        String firstDigest = run(firstSource, List.of(firstCandidate), null, allowed("src"), null, 1, BUDGET)
                .report().orElseThrow().reportSha256();
        String secondDigest = run(secondSource, List.of(secondCandidate), null, allowed("src"), null, 1, BUDGET)
                .report().orElseThrow().reportSha256();

        assertThat(firstDigest).isNotEqualTo(secondDigest);
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

    @Test
    void invalidAttemptCountFailsBeforeRightsOrCapabilityReads() {
        Revision source = revision("source", "v1", "a", 40);
        AtomicInteger rightsCalls = new AtomicInteger();
        AtomicInteger capabilityCalls = new AtomicInteger();
        CandidatePort port = new CandidatePort() {
            @Override public boolean supports(String operationId) {
                capabilityCalls.incrementAndGet();
                return true;
            }
            @Override public OptimizationAttempt optimize(String operationId, Revision input, int attempt, Budget budget) {
                throw new AssertionError("invalid attempt count must not dispatch");
            }
        };

        assertThatThrownBy(() -> optimize(OPERATION, source, (id, purpose) -> {
            rightsCalls.incrementAndGet();
            return allowed("source-rights");
        }, port, 0, BUDGET, Optional.empty(), null, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("attempt budget");

        assertThat(rightsCalls).hasValue(0);
        assertThat(capabilityCalls).hasValue(0);
    }

    @Test
    void candidateCapabilityProbeFailureReturnsTypedUnavailableWithoutDispatch() {
        Revision source = revision("source", "v1", "a", 40);
        AtomicInteger attempts = new AtomicInteger();
        CandidatePort unavailable = new CandidatePort() {
            @Override public boolean supports(String operationId) {
                throw new IllegalStateException("host detail must not escape");
            }
            @Override public OptimizationAttempt optimize(String operationId, Revision input, int attempt, Budget budget) {
                attempts.incrementAndGet();
                throw new AssertionError("capability failure must not dispatch");
            }
        };

        Run result = runOptimization(source, unavailable, 1, BUDGET, null, null);

        assertThat(result.status()).isEqualTo(RunStatus.UNAVAILABLE);
        assertThat(result.reason()).contains(BlockReason.CANDIDATE_PORT_UNAVAILABLE);
        assertThat(result.report()).isEmpty();
        assertThat(result.attemptsUsed()).isZero();
        assertThat(attempts).hasValue(0);
    }

    @Test
    void interruptedBeforeDispatchDoesNotStartOptimizationAndPreservesCompletedWork() {
        Revision source = revision("source", "v1", "a", 40);
        AtomicInteger rightsChecks = new AtomicInteger();
        AtomicInteger dispatches = new AtomicInteger();
        CandidatePort port = new CandidatePort() {
            @Override public boolean supports(String operationId) { return true; }
            @Override public OptimizationAttempt optimize(String operationId, Revision input, int attempt, Budget budget) {
                dispatches.incrementAndGet();
                throw new AssertionError("interrupted operation must not dispatch");
            }
        };
        boolean wasInterrupted = Thread.currentThread().isInterrupted();
        try {
            Run result = optimize(OPERATION, source, (id, purpose) -> {
                if (rightsChecks.incrementAndGet() == 2) Thread.currentThread().interrupt();
                return allowed("src");
            }, port, 1, BUDGET, Optional.empty(), null, null);

            assertThat(result.status()).isEqualTo(RunStatus.CANCELLED);
            assertThat(result.reason()).contains(BlockReason.CANCELLED);
            assertThat(result.report()).isEmpty();
            assertThat(result.retainedRevisions()).containsExactly(source);
            assertThat(result.attemptsUsed()).isZero();
            assertThat(dispatches).hasValue(0);
            assertThat(Thread.currentThread().isInterrupted()).isTrue();
        } finally {
            Thread.interrupted();
            if (wasInterrupted) Thread.currentThread().interrupt();
        }
    }

    @Test
    void cancellationRaisedByCandidateKeepsKnownRevisionButPreventsCompletedReport() {
        Revision source = revision("source", "v1", "a", 40);
        Revision candidate = revision("candidate", "v2", "b", 25);
        Revision reference = revision("reference", "v1", "c", 20);
        AtomicInteger referenceReads = new AtomicInteger();
        CandidatePort port = new CandidatePort() {
            @Override public boolean supports(String operationId) { return true; }
            @Override public OptimizationAttempt optimize(String operationId, Revision input,
                    int attempt, Budget budget) {
                Thread.currentThread().interrupt();
                return OptimizationAttempt.available(candidate);
            }
        };
        boolean wasInterrupted = Thread.currentThread().isInterrupted();
        try {
            Run result = optimize(OPERATION, source, (id, purpose) -> allowed("src"), port, 1, BUDGET,
                    Optional.of(new ReferenceRequest(reference.id(), "quality-reference")),
                    (id, purpose) -> allowed("ref"), id -> {
                        referenceReads.incrementAndGet();
                        return reference;
                    });

            assertThat(result.status()).isEqualTo(RunStatus.CANCELLED);
            assertThat(result.reason()).contains(BlockReason.CANCELLED);
            assertThat(result.report()).isEmpty();
            assertThat(result.retainedRevisions()).containsExactly(source, candidate);
            assertThat(result.attemptsUsed()).isEqualTo(1);
            assertThat(referenceReads).hasValue(0);
            assertThat(Thread.currentThread().isInterrupted()).isTrue();
        } finally {
            Thread.interrupted();
            if (wasInterrupted) Thread.currentThread().interrupt();
        }
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

    private static Revision revision(RevisionId id, int value) {
        return new Revision(id, TB, frames(value));
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

    private static <T> List<T> oversizedWithoutTraversal(AtomicInteger reads) {
        return new AbstractList<>() {
            @Override public T get(int index) {
                reads.incrementAndGet();
                throw new AssertionError("declared oversize list must be rejected before element access");
            }
            @Override public int size() { return Integer.MAX_VALUE; }
        };
    }

    private static <T> List<T> iteratorExceedingDeclaredSize(T value, AtomicInteger reads, int entries) {
        return new AbstractList<>() {
            @Override public T get(int index) { throw new AssertionError("custom iterator must be used"); }
            @Override public int size() { return 0; }
            @Override public Iterator<T> iterator() {
                return new Iterator<>() {
                    private int index;
                    @Override public boolean hasNext() { return index < entries; }
                    @Override public T next() {
                        reads.incrementAndGet();
                        index++;
                        return value;
                    }
                };
            }
        };
    }
}
