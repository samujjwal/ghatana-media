package com.ghatana.audio.video.integration;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.production.timeline.NotAdmittedStoryboardAuthority;
import com.ghatana.media.production.timeline.StoryboardPlanner;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/**
 * Source-free J-09 scenario boundary. The authored brief and storyboard are only a local draft
 * candidate; this fixture does not render media, persist a plan, or establish human review
 * approval.
 * Source bindings: PDP-0 {@code journey-catalog.yaml#journeys/@id=J-09}; PDP-3
 * {@code journey-contracts/create-review-and-deliver-from-a-brief.yaml}; durable storyboard and
 * reviewer authority stay {@code NOT_ADMITTED} until host-owned integrations exist.
 */
class BriefToReviewedMediaScenarioTest {
    private static final Actor CREATOR = new Actor("tenant-j09", "creator-j09");
    private static final Actor REVIEWER = new Actor("tenant-j09", "reviewer-j09");
    private static final SourceVersion SOURCE = new SourceVersion("source-j09", "version-3");

    @Test
    void exactBriefAndStoryboardCanBePreparedButMissingRightsStoreAndReviewerAuthorityFailClosed() {
        StoryboardPlanner planner = new StoryboardPlanner((actor, source, purpose) -> {
            assertThat(actor).isIn(CREATOR, REVIEWER);
            assertThat(source).isEqualTo(SOURCE);
            assertThat(purpose).isEqualTo("campaign-draft");
            return StoryboardPlanner.SourceDecision.ELIGIBLE;
        });
        StoryboardPlanner.AuthoredBrief brief = new StoryboardPlanner.AuthoredBrief(
                "brief-j09", "brief-v2", "campaign-draft", "A two-scene product story", List.of(SOURCE));
        StoryboardPlanner.AuthoredScene ending = scene("scene-ending", 1, 24, "Show the finished product");
        StoryboardPlanner.AuthoredScene opening = scene("scene-opening", 0, 0, "Introduce the product");

        StoryboardPlanner.ScenePlan plan = planner.prepare(CREATOR, "project-j09", "project-r7",
                "storyboard-j09", "edition-v1", brief, List.of(ending, opening));

        assertThat(plan.brief()).isEqualTo(brief);
        assertThat(plan.scenes()).extracting(StoryboardPlanner.PlannedScene::sceneId)
                .containsExactly("scene-opening", "scene-ending");
        assertThat(plan.exactSources()).containsExactly(SOURCE);
        assertThat(plan.state()).isEqualTo(StoryboardPlanner.EditionState.LOCAL_DRAFT);
        assertThat(plan.disposition()).isEqualTo(StoryboardPlanner.DraftDisposition.LOCAL_DRAFT_CANDIDATE);

        NotAdmittedStoryboardAuthority unavailable = new NotAdmittedStoryboardAuthority();
        assertThatThrownBy(() -> planner.save(CREATOR, plan, null, "save-j09", unavailable))
                .isInstanceOf(MediaCapabilityNotAdmittedException.class)
                .satisfies(error -> {
                    MediaCapabilityNotAdmittedException notAdmitted =
                            (MediaCapabilityNotAdmittedException) error;
                    assertThat(notAdmitted.reason())
                            .isEqualTo(MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED);
                    assertThat(notAdmitted.modality()).isEqualTo("STORYBOARD_PLAN_STORE");
                });

        // This controlled receipt is a fixture input only; it is not a persisted owner receipt.
        StoryboardPlanner.SavedPlan controlledFixture = new StoryboardPlanner.SavedPlan(
                plan, "fixture-only-not-an-owner-receipt");
        assertThatThrownBy(() -> planner.review(REVIEWER, controlledFixture, "project-r7",
                "review-j09", unavailable))
                .isInstanceOf(MediaCapabilityNotAdmittedException.class)
                .satisfies(error -> {
                    MediaCapabilityNotAdmittedException notAdmitted =
                            (MediaCapabilityNotAdmittedException) error;
                    assertThat(notAdmitted.reason())
                            .isEqualTo(MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED);
                    assertThat(notAdmitted.modality()).isEqualTo("STORYBOARD_REVIEW_AUTHORITY");
                });
        assertThat(controlledFixture.state()).isEqualTo(StoryboardPlanner.EditionState.PERSISTED_DRAFT);
    }

    @Test
    void deniedSourceRightsPreventEvenLocalDraftPreparation() {
        AtomicInteger rightsCalls = new AtomicInteger();
        StoryboardPlanner planner = new StoryboardPlanner((actor, source, purpose) -> {
            rightsCalls.incrementAndGet();
            return StoryboardPlanner.SourceDecision.DENIED;
        });

        assertThatThrownBy(() -> planner.prepare(CREATOR, "project-j09", "project-r7", "storyboard-j09",
                "edition-v1", new StoryboardPlanner.AuthoredBrief("brief-j09", "brief-v2",
                        "campaign-draft", "A two-scene product story", List.of(SOURCE)),
                List.of(scene("scene-opening", 0, 0, "Introduce the product"))))
                .isInstanceOf(StoryboardPlanner.SourceRightsDeniedException.class);
        assertThat(rightsCalls).hasValue(1);
    }

    @Test
    void shotOutsideItsSceneIsRejectedBeforeSourceRightsAreInspected() {
        AtomicInteger rightsCalls = new AtomicInteger();
        StoryboardPlanner planner = new StoryboardPlanner((actor, source, purpose) -> {
            rightsCalls.incrementAndGet();
            return StoryboardPlanner.SourceDecision.ELIGIBLE;
        });
        assertThatThrownBy(() -> planner.prepare(CREATOR, "project-j09", "project-r7", "storyboard-j09",
                "edition-invalid-timing", new StoryboardPlanner.AuthoredBrief("brief-j09", "brief-v2",
                        "campaign-draft", "A bounded scene", List.of(SOURCE)), List.of(
                        new StoryboardPlanner.AuthoredScene("scene-j09", 0, "Bound the storyboard shot",
                                story(0), story(24), List.of(new StoryboardPlanner.ShotInput(
                                        "shot-outside-scene", 0, "Escapes parent scene",
                                        story(23), story(2), List.of(SOURCE)))))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("shot story interval must be contained by its scene");
        assertThat(rightsCalls).hasValue(0);
    }

    @Test
    void sourceRightsRevokedAfterDraftPreparationPreventTheOwnerAppend() {
        AtomicInteger rightsCalls = new AtomicInteger();
        AtomicInteger appendCalls = new AtomicInteger();
        StoryboardPlanner planner = new StoryboardPlanner((actor, source, purpose) ->
                rightsCalls.incrementAndGet() == 1
                        ? StoryboardPlanner.SourceDecision.ELIGIBLE
                        : StoryboardPlanner.SourceDecision.REVOKED);
        StoryboardPlanner.ScenePlan plan = planner.prepare(CREATOR, "project-j09", "project-r7",
                "storyboard-j09-revoked", "edition-v1",
                new StoryboardPlanner.AuthoredBrief("brief-j09", "brief-v2", "campaign-draft",
                        "A two-scene product story", List.of(SOURCE)),
                List.of(scene("scene-opening", 0, 0, "Introduce the product")));

        assertThatThrownBy(() -> planner.save(CREATOR, plan, null, "save-j09-revoked",
                (actor, candidate, expectedHead, expectedParent, requestId) -> {
                    appendCalls.incrementAndGet();
                    return new StoryboardPlanner.SavedPlan(candidate, "fixture-receipt");
                }))
                .isInstanceOf(StoryboardPlanner.SourceRightsDeniedException.class);

        assertThat(rightsCalls).hasValue(2);
        assertThat(appendCalls).hasValue(0);
    }

    private static StoryboardPlanner.AuthoredScene scene(String id, int order, long start, String intent) {
        return new StoryboardPlanner.AuthoredScene(id, order, intent, story(start), story(24),
                List.of(new StoryboardPlanner.ShotInput("shot-" + id, 0, intent,
                        story(start), story(24), List.of(SOURCE))));
    }

    private static RationalTime story(long seconds) {
        return new RationalTime(seconds * 24, 24, 1, Clock.STORY);
    }
}
