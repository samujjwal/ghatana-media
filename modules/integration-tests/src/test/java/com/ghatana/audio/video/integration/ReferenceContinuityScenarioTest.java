package com.ghatana.audio.video.integration;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import static com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceVersion;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.production.timeline.ReferenceGuidedScenePlanner;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/**
 * Source-free J-10 scenario checks. In-memory authority decisions are synthetic test inputs;
 * this scenario does not establish real rights, identity preservation, or provider effects.
 */
class ReferenceContinuityScenarioTest {
    private static final Actor ACTOR = new Actor("tenant-j10", "creator-j10");
    private static final String PURPOSE = "source-conditioned-scene";
    private static final String D1 = "1111111111111111111111111111111111111111111111111111111111111111";
    private static final String D2 = "2222222222222222222222222222222222222222222222222222222222222222";
    private static final String D3 = "3333333333333333333333333333333333333333333333333333333333333333";
    private static final String D4 = "4444444444444444444444444444444444444444444444444444444444444444";
    private static final SourceVersion PROMPT_VERSION = new SourceVersion("prompt-j10", "v3");
    private static final SourceVersion REFERENCE_VERSION = new SourceVersion("reference-j10", "v8");
    private static final SourceVersion TEMPLATE_VERSION = new SourceVersion("template-j10", "v2");
    private static final SourceVersion CONTINUITY_VERSION = new SourceVersion("continuity-j10", "v5");

    @Test
    void rightsDenialBlocksAuthoredCandidateBeforeAnyGenerationPortCanRun() {
        RecordingAuthority authority = new RecordingAuthority();
        authority.deniedSource = REFERENCE_VERSION;
        AtomicInteger providerCalls = new AtomicInteger();
        ReferenceGuidedScenePlanner planner = planner(authority, providerCalls);

        assertThatThrownBy(() -> planner.prepare(ACTOR, request(continuity("blue"))))
                .isInstanceOf(ReferenceGuidedScenePlanner.SourceRightsDeniedException.class);

        assertThat(authority.inspected).extracting(source -> source.source()).contains(REFERENCE_VERSION);
        assertThat(providerCalls).hasValue(0);
    }

    @Test
    void unknownReferenceAuthorityBlocksPreparationBeforeAnyGenerationPortCanRun() {
        RecordingAuthority authority = new RecordingAuthority();
        authority.unknownSource = REFERENCE_VERSION;
        AtomicInteger providerCalls = new AtomicInteger();
        ReferenceGuidedScenePlanner planner = planner(authority, providerCalls);

        assertThatThrownBy(() -> planner.prepare(ACTOR, request(continuity("blue"))))
                .isInstanceOf(ReferenceGuidedScenePlanner.SourceAuthorityUnavailableException.class);

        assertThat(authority.inspected).extracting(source -> source.source()).contains(REFERENCE_VERSION);
        assertThat(providerCalls).hasValue(0);
    }

    @Test
    void sourceVersionBecomingStaleAfterPreparationBlocksDispatch() {
        RecordingAuthority authority = new RecordingAuthority();
        AtomicInteger providerCalls = new AtomicInteger();
        ReferenceGuidedScenePlanner planner = new ReferenceGuidedScenePlanner(authority,
                new ReferenceGuidedScenePlanner.ModelProvider() {
                    @Override public boolean admitted() { return true; }
                    @Override public ReferenceGuidedScenePlanner.ModelResult generate(
                            ReferenceGuidedScenePlanner.Candidate candidate) {
                        providerCalls.incrementAndGet();
                        return new ReferenceGuidedScenePlanner.ModelOutput("fixture-output", "v1", D1);
                    }
                });

        ReferenceGuidedScenePlanner.Candidate candidate = planner.prepare(ACTOR, request(continuity("blue")));
        authority.staleSource = REFERENCE_VERSION;

        assertThatThrownBy(() -> planner.generateWithModel(candidate))
                .isInstanceOf(ReferenceGuidedScenePlanner.StaleSourceVersionException.class);

        assertThat(authority.inspected).hasSize(7);
        assertThat(authority.inspected.subList(4, 7)).extracting(ReferenceGuidedScenePlanner.BoundSource::source)
                .containsExactly(CONTINUITY_VERSION, PROMPT_VERSION, REFERENCE_VERSION);
        assertThat(providerCalls).hasValue(0);
    }

    @Test
    void continuityConflictPreventsCandidateAndModelDispatch() {
        RecordingAuthority authority = new RecordingAuthority();
        AtomicInteger providerCalls = new AtomicInteger();
        ReferenceGuidedScenePlanner planner = planner(authority, providerCalls);

        assertThatThrownBy(() -> planner.prepare(ACTOR, request(continuity("red"))))
                .isInstanceOf(ReferenceGuidedScenePlanner.ContinuityConflictException.class)
                .satisfies(error -> assertThat(((ReferenceGuidedScenePlanner.ContinuityConflictException) error)
                        .conflicts()).containsExactly("wardrobe"));

        assertThat(authority.inspected).hasSize(4);
        assertThat(providerCalls).hasValue(0);
    }

    @Test
    void authorizedSyntheticInputsPrepareExactProvenanceButMissingProviderIsTypedUnavailable() {
        RecordingAuthority authority = new RecordingAuthority();
        AtomicInteger providerCalls = new AtomicInteger();
        ReferenceGuidedScenePlanner planner = planner(authority, providerCalls);

        ReferenceGuidedScenePlanner.Candidate candidate = planner.prepare(ACTOR, request(continuity("blue")));
        ReferenceGuidedScenePlanner.ModelResult result = planner.generateWithModel(candidate);

        assertThat(candidate.preparation())
                .isEqualTo(ReferenceGuidedScenePlanner.Preparation.AUTHORED_TEMPLATE_CANDIDATE);
        assertThat(candidate.provenance()).extracting(ReferenceGuidedScenePlanner.Provenance::source)
                .containsExactly(CONTINUITY_VERSION, PROMPT_VERSION, REFERENCE_VERSION, TEMPLATE_VERSION);
        assertThat(result).isEqualTo(new ReferenceGuidedScenePlanner.ModelUnavailable("NO_ADMITTED_PROVIDER"));
        assertThat(authority.inspected).hasSize(4);
        assertThat(providerCalls).hasValue(0);
    }

    @Test
    void admittedProviderWithoutTypedOutputCannotCreateContinuitySuccess() {
        RecordingAuthority authority = new RecordingAuthority();
        AtomicInteger providerCalls = new AtomicInteger();
        ReferenceGuidedScenePlanner.ModelProvider provider = new ReferenceGuidedScenePlanner.ModelProvider() {
            @Override public boolean admitted() { return true; }
            @Override public ReferenceGuidedScenePlanner.ModelResult generate(
                    ReferenceGuidedScenePlanner.Candidate candidate) {
                if (providerCalls.incrementAndGet() == 1) return null;
                throw new IllegalStateException("provider secret=must-not-escape");
            }
        };
        ReferenceGuidedScenePlanner planner = new ReferenceGuidedScenePlanner(authority, provider);
        ReferenceGuidedScenePlanner.Candidate candidate = planner.prepare(ACTOR, request(continuity("blue")));

        assertThat(candidate.provenance()).containsExactly(
                new ReferenceGuidedScenePlanner.Provenance("continuity-record", CONTINUITY_VERSION, D4),
                new ReferenceGuidedScenePlanner.Provenance("authored-prompt", PROMPT_VERSION, D1),
                new ReferenceGuidedScenePlanner.Provenance("reference-image", REFERENCE_VERSION, D2),
                new ReferenceGuidedScenePlanner.Provenance("authored-template", TEMPLATE_VERSION, D3));
        assertThat(candidate.priorContinuity().facts())
                .containsExactly(new ReferenceGuidedScenePlanner.ContinuityFact("wardrobe", "blue"));
        assertThat(candidate.continuityFacts())
                .containsExactly(new ReferenceGuidedScenePlanner.ContinuityFact("wardrobe", "blue"));
        assertThat(candidate.preparation())
                .isEqualTo(ReferenceGuidedScenePlanner.Preparation.AUTHORED_TEMPLATE_CANDIDATE);

        ReferenceGuidedScenePlanner.ModelResult missing = planner.generateWithModel(candidate);
        ReferenceGuidedScenePlanner.ModelResult thrown = planner.generateWithModel(candidate);

        assertThat(missing).isEqualTo(
                new ReferenceGuidedScenePlanner.ModelOutcomeUnknown("PROVIDER_RESULT_MISSING"));
        assertThat(thrown).isEqualTo(
                new ReferenceGuidedScenePlanner.ModelOutcomeUnknown("PROVIDER_OUTCOME_UNKNOWN"));
        assertThat(thrown.toString()).doesNotContain("provider secret");
        assertThat(missing).isNotInstanceOf(ReferenceGuidedScenePlanner.ModelOutput.class);
        assertThat(thrown).isNotInstanceOf(ReferenceGuidedScenePlanner.ModelOutput.class);
        assertThat(providerCalls).hasValue(2);
        assertThat(authority.inspected).hasSize(12);
        assertThat(authority.inspected.subList(8, 12)).extracting(ReferenceGuidedScenePlanner.BoundSource::source)
                .containsExactly(CONTINUITY_VERSION, PROMPT_VERSION, REFERENCE_VERSION, TEMPLATE_VERSION);
    }

    private static ReferenceGuidedScenePlanner planner(RecordingAuthority authority, AtomicInteger providerCalls) {
        return new ReferenceGuidedScenePlanner(authority, new ReferenceGuidedScenePlanner.ModelProvider() {
            @Override public boolean admitted() { return false; }
            @Override public ReferenceGuidedScenePlanner.ModelResult generate(
                    ReferenceGuidedScenePlanner.Candidate candidate) {
                providerCalls.incrementAndGet();
                throw new AssertionError("unadmitted provider must not be called");
            }
        });
    }

    private static ReferenceGuidedScenePlanner.Request request(
            ReferenceGuidedScenePlanner.ContinuitySnapshot continuity) {
        var source = new ReferenceGuidedScenePlanner.BoundSource("authored-prompt", PROMPT_VERSION, D1);
        var reference = new ReferenceGuidedScenePlanner.BoundSource("reference-image", REFERENCE_VERSION, D2);
        var templateSource = new ReferenceGuidedScenePlanner.BoundSource("authored-template", TEMPLATE_VERSION, D3);
        var template = new ReferenceGuidedScenePlanner.Template("template-j10", "v2", "Authored scene",
                List.of(new ReferenceGuidedScenePlanner.ContinuityFact("wardrobe", "blue")),
                List.of(templateSource));
        return new ReferenceGuidedScenePlanner.Request("project-j10", "scene-j10", "revision-12", PURPOSE, 10,
                new ReferenceGuidedScenePlanner.Prompt("A quiet harbor at dawn", source), List.of(reference),
                template, continuity);
    }

    private static ReferenceGuidedScenePlanner.ContinuitySnapshot continuity(String wardrobe) {
        return new ReferenceGuidedScenePlanner.ContinuitySnapshot("continuity-j10", "v5",
                List.of(new ReferenceGuidedScenePlanner.ContinuityFact("wardrobe", wardrobe)),
                List.of(new ReferenceGuidedScenePlanner.BoundSource("continuity-record", CONTINUITY_VERSION, D4)));
    }

    private static final class RecordingAuthority implements ReferenceGuidedScenePlanner.CurrentSourceAuthority {
        private final List<ReferenceGuidedScenePlanner.BoundSource> inspected = new ArrayList<>();
        private SourceVersion deniedSource;
        private SourceVersion unknownSource;
        private SourceVersion staleSource;

        @Override
        public ReferenceGuidedScenePlanner.Decision inspect(Actor actor,
                ReferenceGuidedScenePlanner.BoundSource source, String purpose) {
            assertThat(actor).isEqualTo(ACTOR);
            assertThat(purpose).isEqualTo(PURPOSE);
            inspected.add(source);
            if (source.source().equals(staleSource)) return ReferenceGuidedScenePlanner.Decision.STALE;
            if (source.source().equals(unknownSource)) return ReferenceGuidedScenePlanner.Decision.UNKNOWN;
            return source.source().equals(deniedSource)
                    ? ReferenceGuidedScenePlanner.Decision.DENIED
                    : ReferenceGuidedScenePlanner.Decision.ELIGIBLE;
        }
    }
}
