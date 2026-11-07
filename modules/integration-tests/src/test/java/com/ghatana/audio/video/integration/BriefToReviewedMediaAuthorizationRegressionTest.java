package com.ghatana.audio.video.integration;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.production.timeline.StoryboardPlanner;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/**
 * J-09 owner-authorization regression. PDP-1 binds storyboard plan writes to the authenticated
 * actor and its source-rights context; a different principal must not reach rights recheck or the
 * append authority. This is a local authorization boundary fixture, not reviewer approval.
 */
class BriefToReviewedMediaAuthorizationRegressionTest {
    private static final Actor OWNER = new Actor("tenant-j09-auth", "owner-j09");
    private static final Actor IMPERSONATOR = new Actor("tenant-j09-auth", "other-principal-j09");
    private static final SourceVersion SOURCE = new SourceVersion("source-j09-auth", "version-11");

    @Test
    void anotherPrincipalCannotSaveOwnersDraftOrTriggerRightsAndAppendEffects() {
        AtomicInteger rightsChecks = new AtomicInteger();
        AtomicInteger appendCalls = new AtomicInteger();
        StoryboardPlanner planner = new StoryboardPlanner((actor, source, purpose) -> {
            rightsChecks.incrementAndGet();
            assertThat(actor).isEqualTo(OWNER);
            assertThat(source).isEqualTo(SOURCE);
            return StoryboardPlanner.SourceDecision.ELIGIBLE;
        });
        StoryboardPlanner.AuthoredBrief brief = new StoryboardPlanner.AuthoredBrief(
                "brief-j09-auth", "brief-v1", "campaign-draft", "A source-bound brief", List.of(SOURCE));
        RationalTime start = new RationalTime(0, 24, 1, Clock.STORY);
        RationalTime duration = new RationalTime(24, 24, 1, Clock.STORY);
        StoryboardPlanner.AuthoredScene scene = new StoryboardPlanner.AuthoredScene(
                "scene-j09-auth", 0, "Introduce source", start, duration,
                List.of(new StoryboardPlanner.ShotInput("shot-j09-auth", 0, "Opening", start, duration,
                        List.of(SOURCE))));
        StoryboardPlanner.ScenePlan plan = planner.prepare(OWNER, "project-j09-auth", "project-r1",
                "storyboard-j09-auth", "edition-v1", brief, List.of(scene));

        assertThatThrownBy(() -> planner.save(IMPERSONATOR, plan, null, "save-j09-auth",
                (actor, candidate, expectedHead, expectedParent, requestId) -> {
                    appendCalls.incrementAndGet();
                    return new StoryboardPlanner.SavedPlan(candidate, "fixture-receipt");
                }))
                .isInstanceOf(ProjectAccessDeniedException.class);

        assertThat(rightsChecks).hasValue(1); // only draft preparation checked current rights
        assertThat(appendCalls).hasValue(0);
    }
}
