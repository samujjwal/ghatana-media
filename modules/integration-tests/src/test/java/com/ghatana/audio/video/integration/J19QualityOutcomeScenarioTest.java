package com.ghatana.audio.video.integration;

import com.ghatana.media.production.rendering.QualityComparisonAndOptimization;
import com.ghatana.media.production.rendering.QualityComparisonAndOptimization.Budget;
import com.ghatana.media.production.rendering.QualityComparisonAndOptimization.CandidatePort;
import com.ghatana.media.production.rendering.QualityComparisonAndOptimization.OptimizationAttempt;
import com.ghatana.media.production.rendering.QualityComparisonAndOptimization.Revision;
import com.ghatana.media.production.rendering.QualityComparisonAndOptimization.RevisionId;
import com.ghatana.media.production.rendering.QualityComparisonAndOptimization.RgbFrame;
import com.ghatana.media.production.rendering.QualityComparisonAndOptimization.Run;
import com.ghatana.media.production.rendering.QualityComparisonAndOptimization.RunStatus;
import com.ghatana.media.production.rendering.QualityComparisonAndOptimization.TimeBase;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static com.ghatana.media.production.rendering.QualityComparisonAndOptimization.*;
import static org.assertj.core.api.Assertions.assertThat;

/** Fixture-only J-19 outcome path; no decoder, provider, project store, or quality claim. */
class J19QualityOutcomeScenarioTest {
    private static final String OPERATION = "media.optimize.video.lossless-profile";
    private static final TimeBase TIME_BASE = new TimeBase(1, 30);
    private static final Budget BOUNDS = new Budget(100, 300, 2);

    @Test
    void deniedSourceRightsBlockBeforeCandidateDispatch() {
        Revision source = revision("source", "v1", "a", 40);
        AtomicInteger candidateCalls = new AtomicInteger();
        CandidatePort candidate = new CandidatePort() {
            @Override public boolean supports(String operationId) { return true; }
            @Override public OptimizationAttempt optimize(String operationId, Revision input, int attempt, Budget budget) {
                candidateCalls.incrementAndGet();
                return OptimizationAttempt.available(revision("candidate", "v2", "b", 25));
            }
        };

        Run denied = optimize(OPERATION, source, (id, purpose) -> new AuthorityDecision(AuthorityStatus.DENIED,
                "fixture-source-rights-denied"), candidate, 1, BOUNDS, Optional.empty(), null, null);

        assertThat(denied.status()).isEqualTo(RunStatus.NOT_ADMITTED);
        assertThat(denied.reason()).contains(BlockReason.SOURCE_DENIED);
        assertThat(denied.report()).isEmpty();
        assertThat(denied.retainedRevisions()).isEmpty();
        assertThat(denied.attemptsUsed()).isZero();
        assertThat(candidateCalls).hasValue(0);
    }

    @Test
    void unknownSourceRightsHoldBeforeCandidateDispatch() {
        Revision source = revision("source", "v1", "a", 40);
        AtomicInteger candidateCalls = new AtomicInteger();
        CandidatePort candidate = new CandidatePort() {
            @Override public boolean supports(String operationId) { return true; }
            @Override public OptimizationAttempt optimize(String operationId, Revision input, int attempt, Budget budget) {
                candidateCalls.incrementAndGet();
                return OptimizationAttempt.available(revision("candidate", "v2", "b", 25));
            }
        };

        Run held = optimize(OPERATION, source, (id, purpose) -> new AuthorityDecision(AuthorityStatus.UNAVAILABLE,
                "fixture-source-rights-unknown"), candidate, 1, BOUNDS, Optional.empty(), null, null);

        assertThat(held.status()).isEqualTo(RunStatus.UNAVAILABLE);
        assertThat(held.reason()).contains(BlockReason.SOURCE_AUTHORITY_UNAVAILABLE);
        assertThat(held.report()).isEmpty();
        assertThat(held.retainedRevisions()).isEmpty();
        assertThat(held.attemptsUsed()).isZero();
        assertThat(candidateCalls).hasValue(0);
    }

    @Test
    void ambiguousSecondAttemptRetainsOnlyExactRevisionsAndPreservesSourceUndoPath() {
        Revision source = revision("source", "v1", "a", 40);
        Revision candidate = revision("candidate", "v2", "b", 25);
        Revision reference = revision("reference", "v7", "c", 20);

        // This completed fixture report demonstrates the exact reversible baseline
        // revision independently from the later ambiguous optimization attempt.
        CandidatePort successful = new CandidatePort() {
            @Override public boolean supports(String operationId) { return true; }
            @Override public OptimizationAttempt optimize(String operationId, Revision input, int attempt, Budget budget) {
                return OptimizationAttempt.available(candidate);
            }
        };
        Run completed = optimize(OPERATION, source, (id, purpose) -> allowed("fixture-source-rights"), successful,
                1, BOUNDS, Optional.of(new ReferenceRequest(reference.id(), "quality-comparison")),
                (id, purpose) -> allowed("fixture-reference-rights"), id -> reference);
        assertThat(completed.status()).isEqualTo(RunStatus.COMPLETED);
        assertThat(undo(completed, source.id())).isEqualTo(source);

        AtomicInteger dispatches = new AtomicInteger();
        CandidatePort ambiguousOnSecondAttempt = new CandidatePort() {
            @Override public boolean supports(String operationId) { return true; }
            @Override public OptimizationAttempt optimize(String operationId, Revision input, int attempt, Budget budget) {
                dispatches.incrementAndGet();
                if (attempt == 1) return OptimizationAttempt.available(candidate);
                // The fixture models an unknown completion after dispatch. It does
                // not assert that an external provider actually changed media.
                throw new IllegalStateException("synthetic outcome unknown");
            }
        };

        Run unknown = optimize(OPERATION, source, (id, purpose) -> allowed("fixture-source-rights"),
                ambiguousOnSecondAttempt, 2, BOUNDS, Optional.empty(), null, null);

        assertThat(dispatches).hasValue(2);
        assertThat(unknown.status()).isEqualTo(RunStatus.UNAVAILABLE);
        assertThat(unknown.reason()).contains(BlockReason.CANDIDATE_UNAVAILABLE);
        assertThat(unknown.report()).isEmpty();
        assertThat(unknown.attemptsUsed()).isEqualTo(2);
        assertThat(unknown.retainedRevisions()).containsExactly(source, candidate);
        assertThat(unknown.retainedRevisions()).extracting(revision -> revision.id())
                .containsExactly(source.id(), candidate.id());
        assertThat(completed.report().orElseThrow().comparisons()).hasSize(1);
        // The completed report's undo target remains the exact original source;
        // the ambiguous candidate is not promoted into that report or undo path.
        assertThat(undo(completed, source.id()).id()).isEqualTo(source.id());
    }

    private static AuthorityDecision allowed(String decisionId) {
        return new AuthorityDecision(AuthorityStatus.ALLOWED, decisionId);
    }

    private static Revision revision(String artifact, String version, String digestSeed, int value) {
        RevisionId id = new RevisionId("fixture-tenant", "fixture-principal", artifact, version,
                digestSeed.repeat(64));
        RgbFrame frame = new RgbFrame(0, 2, 2, 0, new byte[] {
                (byte) value, (byte) value, (byte) value,
                (byte) value, (byte) value, (byte) value,
                (byte) value, (byte) value, (byte) value,
                (byte) value, (byte) value, (byte) value
        });
        return new Revision(id, TIME_BASE, List.of(frame));
    }
}
