package com.ghatana.media.production.timeline;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class StoryboardPlannerTest {
    private static final Actor OWNER = new Actor("tenant-a", "principal-a");
    private static final SourceVersion SOURCE_A = new SourceVersion("artifact-a", "version-4");
    private static final SourceVersion SOURCE_B = new SourceVersion("artifact-b", "version-2");

    @Test
    void preparationIsRepeatableHonorsDeclaredSceneShotOrderAndRetainsExactStoryTimeAndSources() {
        CountingRights rights = new CountingRights();
        StoryboardPlanner planner = new StoryboardPlanner(rights);
        StoryboardPlanner.AuthoredBrief brief = brief(List.of(SOURCE_B));
        StoryboardPlanner.AuthoredScene laterOrder = scene("a-scene", 1, 0, List.of(
                shot("a-shot", 1, 2, List.of(SOURCE_A)),
                shot("z-shot", 0, 5, List.of(SOURCE_B))));
        StoryboardPlanner.AuthoredScene firstOrder = scene("z-scene", 0, 12, List.of(
                shot("a-shot-2", 1, 15, List.of()), shot("z-shot-2", 0, 18, List.of(SOURCE_A))));

        StoryboardPlanner.ScenePlan first = planner.prepare(OWNER, "project-1", "head-8", "plan-1", "v1",
                brief, List.of(laterOrder, firstOrder));
        StoryboardPlanner.ScenePlan repeated = planner.prepare(OWNER, "project-1", "head-8", "plan-1", "v1",
                brief, List.of(firstOrder, laterOrder));

        assertThat(first).isEqualTo(repeated);
        assertThat(first.scenes()).extracting(StoryboardPlanner.PlannedScene::sceneId)
                .containsExactly("z-scene", "a-scene");
        assertThat(first.scenes().getFirst().shots()).extracting(StoryboardPlanner.PlannedShot::shotId)
                .containsExactly("z-shot-2", "a-shot-2");
        assertThat(first.scenes().get(1).shots()).extracting(StoryboardPlanner.PlannedShot::shotId)
                .containsExactly("z-shot", "a-shot");
        assertThat(first.scenes().getFirst().storyStart()).isEqualTo(story(12));
        assertThat(first.scenes().get(1).storyStart()).isEqualTo(story(0));
        assertThat(first.scenes().get(1).shots().getFirst().storyStart()).isEqualTo(story(5));
        assertThat(first.exactSources()).containsExactly(SOURCE_A, SOURCE_B);
        assertThat(first.disposition()).isEqualTo(StoryboardPlanner.DraftDisposition.LOCAL_DRAFT_CANDIDATE);
        assertThat(first.state()).isEqualTo(StoryboardPlanner.EditionState.LOCAL_DRAFT);
        assertThat(rights.calls()).isEqualTo(4); // unique source refs per prepare: A and B
    }

    @Test
    void reviewIsASeparateImmutableReceiptForTheExactSavedEditionAndRechecksRights() {
        CountingRights rights = new CountingRights();
        StoryboardPlanner planner = new StoryboardPlanner(rights);
        StoryboardPlanner.ScenePlan plan = planner.prepare(OWNER, "project-1", "head-6", "plan-review", "v1",
                brief(List.of(SOURCE_B)), List.of(scene("scene", 0, 0,
                        List.of(shot("shot", 0, 0, List.of(SOURCE_A))))));
        StoryboardPlanner.SavedPlan saved = planner.save(OWNER, plan, null, "save-review", new MutableAuthority("head-6"));
        AtomicInteger reviewCalls = new AtomicInteger();
        StoryboardPlanner.ScenePlanReviewAuthority reviewAuthority = (reviewer, exact, revision, request) -> {
            reviewCalls.incrementAndGet();
            assertThat(exact).isEqualTo(saved);
            assertThat(revision).isEqualTo("head-6");
            assertThat(request).isEqualTo("review-1");
            return new StoryboardPlanner.ReviewedPlan(exact, reviewer, revision, "review-receipt-1",
                    StoryboardPlanner.EditionState.REVIEWED);
        };

        assertThatThrownBy(() -> planner.review(OWNER, saved, "head-stale", "review-stale", reviewAuthority))
                .isInstanceOf(StoryboardPlanner.ScenePlanConflictException.class);
        assertThat(reviewCalls).hasValue(0);
        StoryboardPlanner.ReviewedPlan reviewed = planner.review(OWNER, saved, "head-6", "review-1", reviewAuthority);
        assertThat(reviewed.state()).isEqualTo(StoryboardPlanner.EditionState.REVIEWED);
        assertThat(reviewed.savedPlan()).isSameAs(saved);
        assertThat(reviewed.reviewReceipt()).isEqualTo("review-receipt-1");
        assertThat(saved.state()).isEqualTo(StoryboardPlanner.EditionState.PERSISTED_DRAFT);
        assertThat(reviewCalls).hasValue(1);

        rights.decision(SOURCE_A, StoryboardPlanner.SourceDecision.REVOKED);
        assertThatThrownBy(() -> planner.review(OWNER, saved, "head-6", "review-2", reviewAuthority))
                .isInstanceOf(StoryboardPlanner.SourceRightsDeniedException.class);
        assertThat(reviewCalls).hasValue(1);
    }

    @Test
    void freshRightsAreRecheckedAtAppendAndMissingStaleRevokedOrUnknownSourcesFailClosed() {
        CountingRights rights = new CountingRights();
        StoryboardPlanner planner = new StoryboardPlanner(rights);
        StoryboardPlanner.ScenePlan plan = planner.prepare(OWNER, "project-1", "head-1", "plan-2", "v1",
                brief(List.of()), List.of(scene("scene", 0, 0, List.of(shot("shot", 0, 0, List.of(SOURCE_A))))));
        MutableAuthority authority = new MutableAuthority("head-1");
        planner.save(OWNER, plan, null, "save-1", authority);
        assertThat(rights.calls()).isEqualTo(2); // once for candidate preparation and once immediately before append

        rights.decision(SOURCE_A, StoryboardPlanner.SourceDecision.MISSING);
        assertThatThrownBy(() -> planner.prepare(OWNER, "project-1", "head-1", "plan-missing", "v1",
                brief(List.of()), List.of(scene("scene-missing", 0, 0, List.of(shot("shot-missing", 0, 0, List.of(SOURCE_A)))))))
                .isInstanceOf(StoryboardPlanner.SourceReferenceMissingException.class);
        rights.decision(SOURCE_A, StoryboardPlanner.SourceDecision.STALE);
        assertThatThrownBy(() -> planner.prepare(OWNER, "project-1", "head-1", "plan-stale", "v1",
                brief(List.of()), List.of(scene("scene-stale", 0, 0, List.of(shot("shot-stale", 0, 0, List.of(SOURCE_A)))))))
                .isInstanceOf(StoryboardPlanner.StaleSourceVersionException.class);
        rights.decision(SOURCE_A, StoryboardPlanner.SourceDecision.REVOKED);
        assertThatThrownBy(() -> planner.prepare(OWNER, "project-1", "head-1", "plan-revoked", "v1",
                brief(List.of()), List.of(scene("scene-revoked", 0, 0, List.of(shot("shot-revoked", 0, 0, List.of(SOURCE_A)))))))
                .isInstanceOf(StoryboardPlanner.SourceRightsDeniedException.class);
        rights.decision(SOURCE_A, StoryboardPlanner.SourceDecision.UNKNOWN);
        assertThatThrownBy(() -> planner.prepare(OWNER, "project-1", "head-1", "plan-unknown", "v1",
                brief(List.of()), List.of(scene("scene-unknown", 0, 0, List.of(shot("shot-unknown", 0, 0, List.of(SOURCE_A)))))))
                .isInstanceOf(StoryboardPlanner.SourceAuthorityUnavailableException.class);
    }

    @Test
    void revokedOrUnknownSourceBetweenPreparationAndSaveBlocksAppend() {
        CountingRights rights = new CountingRights();
        StoryboardPlanner planner = new StoryboardPlanner(rights);
        StoryboardPlanner.ScenePlan plan = planner.prepare(OWNER, "project-1", "head-revoke", "plan-revoke", "v1",
                brief(List.of()), List.of(scene("scene", 0, 0,
                        List.of(shot("shot", 0, 0, List.of(SOURCE_A))))));
        MutableAuthority authority = new MutableAuthority("head-revoke");

        rights.decision(SOURCE_A, StoryboardPlanner.SourceDecision.REVOKED);
        assertThatThrownBy(() -> planner.save(OWNER, plan, null, "save-revoked", authority))
                .isInstanceOf(StoryboardPlanner.SourceRightsDeniedException.class);
        assertThat(authority.saved).isEmpty();

        rights.decision(SOURCE_A, StoryboardPlanner.SourceDecision.UNKNOWN);
        assertThatThrownBy(() -> planner.save(OWNER, plan, null, "save-unknown", authority))
                .isInstanceOf(StoryboardPlanner.SourceAuthorityUnavailableException.class);
        assertThat(authority.saved).isEmpty();
    }

    @Test
    void forgedAppendReceiptForAnotherEditionIsRejected() {
        StoryboardPlanner planner = new StoryboardPlanner(new CountingRights());
        StoryboardPlanner.ScenePlan plan = planner.prepare(OWNER, "project-1", "head-receipt", "plan-receipt", "v1",
                brief(List.of()), List.of(scene("scene", 0, 0,
                        List.of(shot("shot", 0, 0, List.of())))));
        StoryboardPlanner.ScenePlan other = planner.prepare(OWNER, "project-1", "head-receipt", "plan-other", "v1",
                brief(List.of()), List.of(scene("other-scene", 0, 0,
                        List.of(shot("other-shot", 0, 0, List.of())))));
        StoryboardPlanner.ScenePlanAuthority forged = (actor, requested, head, parent, requestId) ->
                new StoryboardPlanner.SavedPlan(other, "controlled-test-receipt");

        assertThatThrownBy(() -> planner.save(OWNER, plan, null, "save-forged", forged))
                .isInstanceOf(StoryboardPlanner.ScenePlanAuthorityProtocolException.class)
                .hasMessageContaining("exact draft edition");
    }

    @Test
    void missingDurablePlanAndReviewAuthoritiesFailClosed() {
        StoryboardPlanner planner = new StoryboardPlanner(new CountingRights());
        StoryboardPlanner.ScenePlan plan = planner.prepare(OWNER, "project-1", "head-unavailable", "plan-unavailable", "v1",
                brief(List.of()), List.of(scene("scene", 0, 0,
                        List.of(shot("shot", 0, 0, List.of())))));
        NotAdmittedStoryboardAuthority unavailable = new NotAdmittedStoryboardAuthority();

        assertThatThrownBy(() -> planner.save(OWNER, plan, null, "save-unavailable", unavailable))
                .isInstanceOf(com.ghatana.media.runtime.MediaCapabilityNotAdmittedException.class)
                .satisfies(error -> {
                    var notAdmitted = (com.ghatana.media.runtime.MediaCapabilityNotAdmittedException) error;
                    assertThat(notAdmitted.reason()).isEqualTo(
                            com.ghatana.media.runtime.MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED);
                    assertThat(notAdmitted.modality()).isEqualTo("STORYBOARD_PLAN_STORE");
                });

        StoryboardPlanner.SavedPlan saved = new StoryboardPlanner.SavedPlan(plan, "controlled-owner-receipt");
        assertThatThrownBy(() -> planner.review(OWNER, saved, "head-unavailable", "review-unavailable", unavailable))
                .isInstanceOf(com.ghatana.media.runtime.MediaCapabilityNotAdmittedException.class)
                .satisfies(error -> assertThat(((com.ghatana.media.runtime.MediaCapabilityNotAdmittedException) error)
                        .modality()).isEqualTo("STORYBOARD_REVIEW_AUTHORITY"));
    }

    @Test
    void staleProjectHeadPlanParentAndDuplicateVersionAreConflictsWithoutReplacingPriorEdition() {
        StoryboardPlanner planner = new StoryboardPlanner(new CountingRights());
        MutableAuthority authority = new MutableAuthority("head-3");
        StoryboardPlanner.ScenePlan first = planner.prepare(OWNER, "project-1", "head-3", "plan-3", "v1",
                brief(List.of()), List.of(scene("scene-1", 0, 0, List.of(shot("shot-1", 0, 0, List.of())))));
        StoryboardPlanner.SavedPlan saved = planner.save(OWNER, first, null, "save-2", authority);
        assertThat(saved.plan().semanticVersion()).isEqualTo("v1");
        assertThatThrownBy(() -> planner.save(OWNER, first, null, "save-3", authority))
                .isInstanceOf(StoryboardPlanner.DuplicateScenePlanVersionException.class);

        StoryboardPlanner.ScenePlan successor = planner.prepare(OWNER, "project-1", "head-3", "plan-3", "v2",
                brief(List.of()), List.of(scene("scene-2", 0, 1, List.of(shot("shot-2", 0, 1, List.of())))));
        assertThatThrownBy(() -> planner.save(OWNER, successor, "wrong-parent", "save-4", authority))
                .isInstanceOf(StoryboardPlanner.ScenePlanConflictException.class)
                .hasMessageContaining("plan parent");

        authority.projectHead = "head-4";
        assertThatThrownBy(() -> planner.save(OWNER, successor, "v1", "save-5", authority))
                .isInstanceOf(StoryboardPlanner.ScenePlanConflictException.class)
                .hasMessageContaining("project head");
        assertThat(authority.saved).containsKey("plan-3/v1");
        assertThat(authority.saved).doesNotContainKey("plan-3/v2");
    }

    @Test
    void ownerSceneReferenceLimitIsEnforcedBeforeRightsOrAuthorityEffects() {
        CountingRights rights = new CountingRights();
        StoryboardPlanner planner = new StoryboardPlanner(rights);
        List<StoryboardPlanner.AuthoredScene> withinLimit = java.util.stream.IntStream.range(0, 256)
                .mapToObj(index -> scene("scene-" + index, index, index,
                        List.of(shot("shot-" + index, 0, index, List.of()))))
                .toList();

        StoryboardPlanner.ScenePlan plan = planner.prepare(OWNER, "project-1", "head-limit", "plan-limit", "v1",
                brief(List.of(SOURCE_A)), withinLimit);
        assertThat(plan.scenes()).hasSize(256);
        assertThat(rights.calls()).isEqualTo(1);

        List<StoryboardPlanner.AuthoredScene> overLimit = java.util.stream.IntStream.range(0, 257)
                .mapToObj(index -> scene("over-scene-" + index, index, index,
                        List.of(shot("over-shot-" + index, 0, index, List.of()))))
                .toList();
        assertThatThrownBy(() -> planner.prepare(OWNER, "project-1", "head-limit", "plan-over", "v1",
                brief(List.of(SOURCE_A)), overLimit))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("256 scene-reference limit");
        assertThat(rights.calls()).isEqualTo(1);
    }

    @Test
    void ownerSceneReferenceLimitUsesBoundedIteratorRatherThanUntrustedListSize() {
        CountingRights rights = new CountingRights();
        StoryboardPlanner planner = new StoryboardPlanner(rights);
        List<StoryboardPlanner.AuthoredScene> actual = java.util.stream.IntStream.range(0, 257)
                .mapToObj(index -> scene("dishonest-scene-" + index, index, index,
                        List.of(shot("dishonest-shot-" + index, 0, index, List.of()))))
                .toList();
        List<StoryboardPlanner.AuthoredScene> inaccurateSize = new java.util.AbstractList<>() {
            @Override public StoryboardPlanner.AuthoredScene get(int index) { return actual.get(index); }
            @Override public int size() { return 1; }
            @Override public java.util.Iterator<StoryboardPlanner.AuthoredScene> iterator() {
                return actual.iterator();
            }
        };

        assertThatThrownBy(() -> planner.prepare(OWNER, "project-1", "head-limit", "plan-inaccurate-size", "v1",
                brief(List.of(SOURCE_A)), inaccurateSize))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("256 scene-reference limit");
        assertThat(rights.calls()).isZero();
    }

    @Test
    void directScenePlanConstructionRejectsDeclaredOversizeBeforeIteration() {
        AtomicInteger iteratorCalls = new AtomicInteger();
        List<StoryboardPlanner.PlannedScene> oversized = new java.util.AbstractList<>() {
            @Override public StoryboardPlanner.PlannedScene get(int index) { return plannedScene(index); }
            @Override public int size() { return StoryboardPlanner.MAX_SCENES + 1; }
            @Override public java.util.Iterator<StoryboardPlanner.PlannedScene> iterator() {
                iteratorCalls.incrementAndGet();
                return List.<StoryboardPlanner.PlannedScene>of().iterator();
            }
        };

        assertThatThrownBy(() -> directPlan(oversized))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("256 scene-reference limit");
        assertThat(iteratorCalls).hasValue(0);
    }

    @Test
    void directScenePlanConstructionBoundsUnderreportedIteratorAtItem257() {
        List<StoryboardPlanner.PlannedScene> actual = java.util.stream.IntStream.range(0, 257)
                .mapToObj(StoryboardPlannerTest::plannedScene).toList();
        AtomicInteger consumed = new AtomicInteger();
        List<StoryboardPlanner.PlannedScene> underreported = new java.util.AbstractList<>() {
            @Override public StoryboardPlanner.PlannedScene get(int index) { return actual.get(index); }
            @Override public int size() { return 1; }
            @Override public java.util.Iterator<StoryboardPlanner.PlannedScene> iterator() {
                java.util.Iterator<StoryboardPlanner.PlannedScene> delegate = actual.iterator();
                return new java.util.Iterator<>() {
                    @Override public boolean hasNext() { return delegate.hasNext(); }
                    @Override public StoryboardPlanner.PlannedScene next() {
                        consumed.incrementAndGet();
                        return delegate.next();
                    }
                };
            }
        };

        assertThatThrownBy(() -> directPlan(underreported))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("256 scene-reference limit");
        assertThat(consumed).hasValue(StoryboardPlanner.MAX_SCENES);
    }

    @Test
    void directScenePlanConstructionPreservesNormalPlanAndStableSort() {
        StoryboardPlanner.ScenePlan plan = directPlan(List.of(plannedScene(1), plannedScene(0)));

        assertThat(plan.scenes()).extracting(StoryboardPlanner.PlannedScene::sceneId)
                .containsExactly("planned-scene-0", "planned-scene-1");
        assertThat(plan.exactSources()).isEmpty();
    }

    @Test
    void storyboardSaveRequestIdsFollowOwnerActionWireShapeAndReviewRequiresAnIdentity() {
        StoryboardPlanner planner = new StoryboardPlanner(new CountingRights());
        StoryboardPlanner.ScenePlan plan = planner.prepare(OWNER, "project-1", "head-request", "plan-request", "v1",
                brief(List.of()), List.of(scene("scene", 0, 0,
                        List.of(shot("shot", 0, 0, List.of())))));
        AtomicInteger saveCalls = new AtomicInteger();
        StoryboardPlanner.ScenePlanAuthority saveAuthority = (actor, requested, head, parent, requestId) -> {
            saveCalls.incrementAndGet();
            return new StoryboardPlanner.SavedPlan(requested, "receipt-" + requestId);
        };

        for (String invalid : List.of(":starts-with-punctuation", "contains spaces", "x".repeat(129))) {
            assertThatThrownBy(() -> planner.save(OWNER, plan, null, invalid, saveAuthority))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("owner-action format");
        }
        assertThat(saveCalls).hasValue(0);
        assertThat(planner.save(OWNER, plan, null, "save:owner-action.v1_1", saveAuthority).ownerReceipt())
                .isEqualTo("receipt-save:owner-action.v1_1");
        assertThat(saveCalls).hasValue(1);

        StoryboardPlanner.SavedPlan saved = new StoryboardPlanner.SavedPlan(plan, "existing-receipt");
        AtomicInteger reviewCalls = new AtomicInteger();
        StoryboardPlanner.ScenePlanReviewAuthority reviewAuthority = (reviewer, exact, revision, requestId) -> {
            reviewCalls.incrementAndGet();
            return new StoryboardPlanner.ReviewedPlan(exact, reviewer, revision, "review-" + requestId,
                    StoryboardPlanner.EditionState.REVIEWED);
        };
        assertThatThrownBy(() -> planner.review(OWNER, saved, "head-request", " ", reviewAuthority))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("owner-action format");
        assertThatThrownBy(() -> planner.review(OWNER, saved, "head-request", ":starts-with-punctuation", reviewAuthority))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("owner-action format");
        assertThatThrownBy(() -> planner.review(OWNER, saved, "head-request", "r".repeat(129), reviewAuthority))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("owner-action format");
        assertThat(reviewCalls).hasValue(0);
        assertThat(reviewCalls).hasValue(0);
        assertThat(planner.review(OWNER, saved, "head-request", "review:owner-action.v1", reviewAuthority)
                .reviewReceipt()).isEqualTo("review-review:owner-action.v1");
        assertThat(reviewCalls).hasValue(1);
    }

    @Test
    void malformedOrDuplicateSceneAndShotIdentitiesAndNonStoryTimeAreRejected() {
        StoryboardPlanner planner = new StoryboardPlanner(new CountingRights());
        StoryboardPlanner.AuthoredScene first = scene("scene-1", 0, 0, List.of(shot("shot-1", 0, 0, List.of())));
        StoryboardPlanner.AuthoredScene duplicateShot = scene("scene-2", 1, 3, List.of(shot("shot-1", 0, 3, List.of())));
        assertThatThrownBy(() -> planner.prepare(OWNER, "project-1", "head-1", "plan-4", "v1",
                brief(List.of()), List.of(first, duplicateShot)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("duplicate storyboard shot");
        assertThatThrownBy(() -> new StoryboardPlanner.ShotInput("bad-time", 0, "intent",
                new RationalTime(0, 24, 1, Clock.SOURCE_PRESENTATION),
                new RationalTime(1, 24, 1, Clock.STORY), List.of()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("story-clock");
    }

    @Test
    void authoredShotIntervalsMustStayInsideTheirScene() {
        assertThatThrownBy(() -> new StoryboardPlanner.AuthoredScene("scene", 0, "scene intent",
                story(10), story(5), List.of(shot("before", 0, 9, List.of()))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("contained by its scene");
        assertThatThrownBy(() -> new StoryboardPlanner.AuthoredScene("scene", 0, "scene intent",
                story(10), story(5), List.of(shot("after", 0, 15, List.of()))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("contained by its scene");

        // Mixed exact rates are compared as rational story time, without rounding to frame ticks.
        assertThat(new StoryboardPlanner.AuthoredScene("scene", 0, "scene intent",
                story(10), story(5), List.of(new StoryboardPlanner.ShotInput("inside", 0, "shot intent",
                        new RationalTime(21, 2, 1, Clock.STORY), new RationalTime(1, 2, 1, Clock.STORY), List.of()))))
                .isNotNull();

        // The immutable planned value is also a public construction boundary; callers must not
        // bypass the authored-input interval check and then persist an invalid plan.
        assertThatThrownBy(() -> new StoryboardPlanner.PlannedScene("planned", 0, "scene intent",
                story(10), story(5), List.of(new StoryboardPlanner.PlannedShot("outside", 0, "shot intent",
                        story(9), story(1), List.of()))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("planned shot story interval must be contained by its scene");
        assertThat(new StoryboardPlanner.PlannedScene("planned", 0, "scene intent", story(10), story(5),
                List.of(new StoryboardPlanner.PlannedShot("inside", 0, "shot intent",
                        new RationalTime(21, 2, 1, Clock.STORY), new RationalTime(1, 2, 1, Clock.STORY), List.of()))))
                .isNotNull();
    }

    private static StoryboardPlanner.AuthoredBrief brief(List<SourceVersion> refs) {
        return new StoryboardPlanner.AuthoredBrief("brief-1", "b1", "personal-project", "An authored story", refs);
    }

    private static StoryboardPlanner.ScenePlan directPlan(List<StoryboardPlanner.PlannedScene> scenes) {
        return new StoryboardPlanner.ScenePlan("tenant-a", "principal-a", "project-1", "plan-1", "v1",
                "head-1", brief(List.of()), scenes, List.of(), StoryboardPlanner.DraftDisposition.LOCAL_DRAFT_CANDIDATE);
    }

    private static StoryboardPlanner.PlannedScene plannedScene(int index) {
        return new StoryboardPlanner.PlannedScene("planned-scene-" + index, index, "scene intent",
                story(index), story(20), List.of(new StoryboardPlanner.PlannedShot("planned-shot-" + index,
                0, "shot intent", story(index), story(1), List.of())));
    }

    private static StoryboardPlanner.AuthoredScene scene(String id, int order, long startSeconds,
                                                          List<StoryboardPlanner.ShotInput> shots) {
        return new StoryboardPlanner.AuthoredScene(id, order, "scene intent", story(startSeconds), story(20), shots);
    }

    private static StoryboardPlanner.ShotInput shot(String id, int order, long startSeconds, List<SourceVersion> refs) {
        return new StoryboardPlanner.ShotInput(id, order, "shot intent", story(startSeconds), story(1), refs);
    }

    private static RationalTime story(long seconds) {
        return new RationalTime(seconds * 24, 24, 1, Clock.STORY);
    }

    private static final class CountingRights implements StoryboardPlanner.CurrentSourceRights {
        private final Map<SourceVersion, StoryboardPlanner.SourceDecision> decisions = new HashMap<>();
        private final AtomicInteger calls = new AtomicInteger();
        @Override public StoryboardPlanner.SourceDecision inspect(Actor actor, SourceVersion source, String purpose) {
            calls.incrementAndGet();
            return decisions.getOrDefault(source, StoryboardPlanner.SourceDecision.ELIGIBLE);
        }
        void decision(SourceVersion source, StoryboardPlanner.SourceDecision decision) { decisions.put(source, decision); }
        int calls() { return calls.get(); }
    }

    private static final class MutableAuthority implements StoryboardPlanner.ScenePlanAuthority {
        private String projectHead;
        private String planHead;
        private final Map<String, StoryboardPlanner.ScenePlan> saved = new HashMap<>();
        private MutableAuthority(String projectHead) { this.projectHead = projectHead; }

        @Override public StoryboardPlanner.SavedPlan append(Actor actor, StoryboardPlanner.ScenePlan plan,
                String expectedProjectHeadRevisionId, String expectedParentSemanticVersion, String requestId) {
            if (!projectHead.equals(expectedProjectHeadRevisionId)) {
                throw new StoryboardPlanner.ScenePlanConflictException("project head changed before append");
            }
            String key = plan.scenePlanId() + "/" + plan.semanticVersion();
            if (saved.containsKey(key)) throw new StoryboardPlanner.DuplicateScenePlanVersionException();
            if (!Objects.equals(planHead, expectedParentSemanticVersion)) {
                throw new StoryboardPlanner.ScenePlanConflictException("plan parent changed before append");
            }
            saved.put(key, plan);
            planHead = plan.semanticVersion();
            return new StoryboardPlanner.SavedPlan(plan, "receipt-" + requestId);
        }
    }
}
