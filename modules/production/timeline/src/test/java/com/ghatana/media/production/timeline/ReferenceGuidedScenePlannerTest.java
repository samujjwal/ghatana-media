package com.ghatana.media.production.timeline;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import static com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceVersion;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class ReferenceGuidedScenePlannerTest {
    private static final Actor ACTOR = new Actor("tenant-1", "creator-1");
    private static final SourceVersion PROMPT_VERSION = new SourceVersion("prompt", "v7");
    private static final SourceVersion IMAGE_VERSION = new SourceVersion("image", "v3");
    private static final SourceVersion TEMPLATE_VERSION = new SourceVersion("template", "v2");
    private static final SourceVersion CONTINUITY_VERSION = new SourceVersion("continuity", "v5");
    private static final String D1 = "1111111111111111111111111111111111111111111111111111111111111111";
    private static final String D2 = "2222222222222222222222222222222222222222222222222222222222222222";
    private static final String D3 = "3333333333333333333333333333333333333333333333333333333333333333";
    private static final String D4 = "4444444444444444444444444444444444444444444444444444444444444444";

    @Test
    void unauthorizedExactReferenceIsRejectedAndRightsPortReceivesVersionDigestAndPurpose() {
        Authority authority = new Authority();
        ReferenceGuidedScenePlanner planner = planner(authority, unavailableProvider());
        var request = request(List.of(source("reference-image", IMAGE_VERSION, D2)),
                template(List.of(fact("wardrobe", "blue"))), continuity(List.of(fact("wardrobe", "blue"))));
        authority.set(IMAGE_VERSION, D2, ReferenceGuidedScenePlanner.Decision.REVOKED);

        assertThatThrownBy(() -> planner.prepare(ACTOR, request))
                .isInstanceOf(ReferenceGuidedScenePlanner.SourceRightsDeniedException.class);
        assertThat(authority.observed).contains(new Seen(IMAGE_VERSION, D2, "source-conditioned-scene"));
    }

    @Test
    void candidateBindsEveryPromptReferenceTemplateAndContinuitySourceToExactVersionAndDigest() {
        Authority authority = new Authority();
        var request = request(List.of(source("reference-image", IMAGE_VERSION, D2)),
                template(List.of(fact("wardrobe", "blue"))), continuity(List.of(fact("wardrobe", "blue"))));

        var candidate = planner(authority, unavailableProvider()).prepare(ACTOR, request);

        assertThat(candidate.provenance()).containsExactly(
                provenance("continuity-record", CONTINUITY_VERSION, D4), provenance("reference-image", IMAGE_VERSION, D2),
                provenance("authored-prompt", PROMPT_VERSION, D1), provenance("authored-template", TEMPLATE_VERSION, D3));
        assertThat(authority.observed).containsExactlyInAnyOrder(
                new Seen(PROMPT_VERSION, D1, "source-conditioned-scene"),
                new Seen(IMAGE_VERSION, D2, "source-conditioned-scene"),
                new Seen(TEMPLATE_VERSION, D3, "source-conditioned-scene"),
                new Seen(CONTINUITY_VERSION, D4, "source-conditioned-scene"));
        assertThat(candidate.expectedProjectRevisionId()).isEqualTo("head-12");
    }

    @Test
    void deterministicSeedAndProvenanceDoNotDependOnReferenceInputOrder() {
        Authority authority = new Authority();
        var planner = planner(authority, unavailableProvider());
        var first = request(List.of(source("ref-b", new SourceVersion("asset-b", "v1"), D2),
                        source("ref-a", new SourceVersion("asset-a", "v8"), D3)),
                template(List.of(fact("wardrobe", "blue"))), continuity(List.of(fact("wardrobe", "blue"))));
        var reordered = request(List.of(source("ref-a", new SourceVersion("asset-a", "v8"), D3),
                        source("ref-b", new SourceVersion("asset-b", "v1"), D2)),
                template(List.of(fact("wardrobe", "blue"))), continuity(List.of(fact("wardrobe", "blue"))));

        var candidate1 = planner.prepare(ACTOR, first);
        var candidate2 = planner.prepare(ACTOR, reordered);

        assertThat(candidate1.deterministicSeed()).matches("[0-9a-f]{64}").isEqualTo(candidate2.deterministicSeed());
        assertThat(candidate1.provenance()).isEqualTo(candidate2.provenance());
        assertThat(candidate1.authoredScene()).isEqualTo("A composed authored scene");
        assertThat(candidate1.authoredPrompt()).isEqualTo("A quiet harbor at dawn");
        assertThat(candidate1.preparation()).isEqualTo(ReferenceGuidedScenePlanner.Preparation.AUTHORED_TEMPLATE_CANDIDATE);
    }

    @Test
    void deterministicSeedBindsPriorContinuitySnapshotFacts() {
        Authority authority = new Authority();
        var planner = planner(authority, unavailableProvider());
        var template = template(List.of(fact("wardrobe", "blue")));
        var first = request(List.of(source("reference-image", IMAGE_VERSION, D2)), template,
                continuity(List.of(fact("wardrobe", "blue"), fact("weather", "morning"))));
        var changedSnapshot = new ReferenceGuidedScenePlanner.ContinuitySnapshot("continuity-1", "v5",
                List.of(fact("wardrobe", "blue"), fact("weather", "evening")),
                List.of(source("continuity-record", CONTINUITY_VERSION, D4)));
        var second = new ReferenceGuidedScenePlanner.Request(first.projectId(), first.sceneId(),
                first.expectedProjectRevisionId(), first.purpose(), first.seedInput(), first.prompt(),
                first.references(), first.template(), changedSnapshot);

        var firstCandidate = planner.prepare(ACTOR, first);
        var secondCandidate = planner.prepare(ACTOR, second);

        assertThat(firstCandidate.deterministicSeed()).isNotEqualTo(secondCandidate.deterministicSeed());
    }

    @Test
    void mismatchOrMissingContinuityFactBlocksCandidate() {
        var planner = planner(new Authority(), unavailableProvider());
        var request = request(List.of(source("reference-image", IMAGE_VERSION, D2)),
                template(List.of(fact("wardrobe", "blue"), fact("character", "Mara"))),
                continuity(List.of(fact("wardrobe", "red"))));

        assertThatThrownBy(() -> planner.prepare(ACTOR, request))
                .isInstanceOf(ReferenceGuidedScenePlanner.ContinuityConflictException.class)
                .satisfies(error -> assertThat(((ReferenceGuidedScenePlanner.ContinuityConflictException) error)
                        .conflicts()).containsExactly("character", "wardrobe"));
    }

    @Test
    void modelPathReturnsTypedUnavailableWithoutCallingUnadmittedProvider() {
        AtomicInteger calls = new AtomicInteger();
        ReferenceGuidedScenePlanner.ModelProvider provider = new ReferenceGuidedScenePlanner.ModelProvider() {
            @Override public boolean admitted() { return false; }
            @Override public ReferenceGuidedScenePlanner.ModelResult generate(ReferenceGuidedScenePlanner.Candidate candidate) {
                calls.incrementAndGet();
                return new ReferenceGuidedScenePlanner.ModelOutput("must-not-run", "v1", D1);
            }
        };
        var candidate = planner(new Authority(), provider).prepare(ACTOR,
                request(List.of(source("reference-image", IMAGE_VERSION, D2)),
                        template(List.of(fact("wardrobe", "blue"))), continuity(List.of(fact("wardrobe", "blue")))));

        assertThat(planner(new Authority(), provider).generateWithModel(candidate))
                .isEqualTo(new ReferenceGuidedScenePlanner.ModelUnavailable("NO_ADMITTED_PROVIDER"));
        assertThat(calls).hasValue(0);
    }

    @Test
    void admittedModelDispatchRechecksEveryExactSourceAndStopsAfterRightsRevocation() {
        Authority authority = new Authority();
        AtomicInteger calls = new AtomicInteger();
        ReferenceGuidedScenePlanner.ModelProvider provider = new ReferenceGuidedScenePlanner.ModelProvider() {
            @Override public boolean admitted() { return true; }
            @Override public ReferenceGuidedScenePlanner.ModelResult generate(ReferenceGuidedScenePlanner.Candidate candidate) {
                calls.incrementAndGet();
                return new ReferenceGuidedScenePlanner.ModelOutput("generated", "v1", D1);
            }
        };
        var planner = planner(authority, provider);
        var candidate = planner.prepare(ACTOR, request(List.of(source("reference-image", IMAGE_VERSION, D2)),
                template(List.of(fact("wardrobe", "blue"))), continuity(List.of(fact("wardrobe", "blue")))));
        authority.set(IMAGE_VERSION, D2, ReferenceGuidedScenePlanner.Decision.REVOKED);

        assertThatThrownBy(() -> planner.generateWithModel(candidate))
                .isInstanceOf(ReferenceGuidedScenePlanner.SourceRightsDeniedException.class);
        assertThat(authority.observed).hasSize(6);
        assertThat(authority.observed.subList(4, 6)).containsExactly(
                new Seen(CONTINUITY_VERSION, D4, "source-conditioned-scene"),
                new Seen(IMAGE_VERSION, D2, "source-conditioned-scene"));
        assertThat(calls).hasValue(0);
    }

    @Test
    void unknownRightsOnDispatchRecheckStopsBeforeModelCall() {
        Authority authority = new Authority();
        AtomicInteger calls = new AtomicInteger();
        var provider = new ReferenceGuidedScenePlanner.ModelProvider() {
            @Override public boolean admitted() { return true; }
            @Override public ReferenceGuidedScenePlanner.ModelResult generate(ReferenceGuidedScenePlanner.Candidate candidate) {
                calls.incrementAndGet();
                return new ReferenceGuidedScenePlanner.ModelOutput("generated", "v1", D1);
            }
        };
        var planner = planner(authority, provider);
        var candidate = planner.prepare(ACTOR, request(List.of(source("reference-image", IMAGE_VERSION, D2)),
                template(List.of(fact("wardrobe", "blue"))), continuity(List.of(fact("wardrobe", "blue")))));
        authority.set(PROMPT_VERSION, D1, ReferenceGuidedScenePlanner.Decision.UNKNOWN);

        assertThatThrownBy(() -> planner.generateWithModel(candidate))
                .isInstanceOf(ReferenceGuidedScenePlanner.SourceAuthorityUnavailableException.class);
        assertThat(calls).hasValue(0);
    }

    @Test
    void staleSourceAndMalformedDigestFailClosed() {
        Authority authority = new Authority();
        authority.set(IMAGE_VERSION, D2, ReferenceGuidedScenePlanner.Decision.STALE);
        var planner = planner(authority, unavailableProvider());
        var request = request(List.of(source("reference-image", IMAGE_VERSION, D2)),
                template(List.of(fact("wardrobe", "blue"))), continuity(List.of(fact("wardrobe", "blue"))));
        assertThatThrownBy(() -> planner.prepare(ACTOR, request))
                .isInstanceOf(ReferenceGuidedScenePlanner.StaleSourceVersionException.class);
        assertThatThrownBy(() -> source("bad", IMAGE_VERSION, "not-a-digest"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static ReferenceGuidedScenePlanner planner(Authority authority, ReferenceGuidedScenePlanner.ModelProvider provider) {
        return new ReferenceGuidedScenePlanner(authority, provider);
    }

    private static ReferenceGuidedScenePlanner.ModelProvider unavailableProvider() {
        return new ReferenceGuidedScenePlanner.ModelProvider() {
            @Override public boolean admitted() { return false; }
            @Override public ReferenceGuidedScenePlanner.ModelResult generate(ReferenceGuidedScenePlanner.Candidate candidate) {
                throw new AssertionError("unadmitted provider must not be called");
            }
        };
    }

    private static ReferenceGuidedScenePlanner.Request request(List<ReferenceGuidedScenePlanner.BoundSource> refs,
            ReferenceGuidedScenePlanner.Template template, ReferenceGuidedScenePlanner.ContinuitySnapshot continuity) {
        return new ReferenceGuidedScenePlanner.Request("project-1", "scene-1", "head-12", "source-conditioned-scene", 42,
                new ReferenceGuidedScenePlanner.Prompt("A quiet harbor at dawn",
                        source("authored-prompt", PROMPT_VERSION, D1)), refs, template, continuity);
    }

    private static ReferenceGuidedScenePlanner.Template template(List<ReferenceGuidedScenePlanner.ContinuityFact> facts) {
        return new ReferenceGuidedScenePlanner.Template("template-1", "v2", "A composed authored scene", facts,
                List.of(source("authored-template", TEMPLATE_VERSION, D3)));
    }

    private static ReferenceGuidedScenePlanner.ContinuitySnapshot continuity(List<ReferenceGuidedScenePlanner.ContinuityFact> facts) {
        return new ReferenceGuidedScenePlanner.ContinuitySnapshot("continuity-1", "v5", facts,
                List.of(source("continuity-record", CONTINUITY_VERSION, D4)));
    }

    private static ReferenceGuidedScenePlanner.ContinuityFact fact(String key, String value) {
        return new ReferenceGuidedScenePlanner.ContinuityFact(key, value);
    }

    private static ReferenceGuidedScenePlanner.BoundSource source(String role, SourceVersion version, String digest) {
        return new ReferenceGuidedScenePlanner.BoundSource(role, version, digest);
    }

    private static ReferenceGuidedScenePlanner.Provenance provenance(String role, SourceVersion version, String digest) {
        return new ReferenceGuidedScenePlanner.Provenance(role, version, digest);
    }

    private record Seen(SourceVersion source, String digest, String purpose) { }

    private static final class Authority implements ReferenceGuidedScenePlanner.CurrentSourceAuthority {
        private final Map<Seen, ReferenceGuidedScenePlanner.Decision> overrides = new HashMap<>();
        private final List<Seen> observed = new ArrayList<>();
        void set(SourceVersion source, String digest, ReferenceGuidedScenePlanner.Decision decision) {
            overrides.put(new Seen(source, digest, "source-conditioned-scene"), decision);
        }
        @Override public ReferenceGuidedScenePlanner.Decision inspect(Actor actor,
                ReferenceGuidedScenePlanner.BoundSource source, String purpose) {
            Seen seen = new Seen(source.source(), source.sha256(), purpose);
            observed.add(seen);
            return overrides.getOrDefault(seen, ReferenceGuidedScenePlanner.Decision.ELIGIBLE);
        }
    }
}
