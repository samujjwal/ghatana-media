package com.ghatana.audio.video.integration;

import static com.ghatana.media.production.rendering.MultitrackRenderPlanner.*;
import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;
import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.production.timeline.NotAdmittedStoryboardAuthority;
import com.ghatana.media.production.timeline.StoryboardPlanner;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Source-free J-09 boundary: a versioned local storyboard can describe a render candidate, but
 * absent codec admission it creates no output artifact and cannot be mistaken for reviewed media.
 */
class BriefToReviewedMediaRenderBoundaryTest {
    private static final Actor CREATOR = new Actor("tenant-j09-boundary", "creator-j09-boundary");
    private static final Actor REVIEWER = new Actor("tenant-j09-boundary", "reviewer-j09-boundary");
    private static final SourceVersion SOURCE = new SourceVersion("source-j09-boundary", "version-7");
    // Stable fixture digest only; this test never reads or renders source bytes.
    private static final String FIXTURE_SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    @Test
    void exactStoryboardVersionsReachRenderPlanButCannotBecomeOutputOrReviewReceiptWithoutAdmission() {
        StoryboardPlanner planner = new StoryboardPlanner((actor, source, purpose) -> {
            assertThat(actor).isIn(CREATOR, REVIEWER);
            assertThat(source).isEqualTo(SOURCE);
            assertThat(purpose).isEqualTo("campaign-draft");
            return StoryboardPlanner.SourceDecision.ELIGIBLE;
        });
        StoryboardPlanner.AuthoredBrief brief = new StoryboardPlanner.AuthoredBrief(
                "brief-j09-boundary", "brief-v4", "campaign-draft", "Show the product clearly", List.of(SOURCE));
        StoryboardPlanner.AuthoredScene scene = new StoryboardPlanner.AuthoredScene(
                "scene-j09-boundary", 0, "Introduce the exact source", story(0), story(1), List.of(
                        new StoryboardPlanner.ShotInput("shot-j09-boundary", 0, "Opening shot", story(0), story(1),
                                List.of(SOURCE))));
        StoryboardPlanner.ScenePlan storyboard = planner.prepare(CREATOR, "project-j09-boundary", "project-r12",
                "storyboard-j09-boundary", "edition-v3", brief, List.of(scene));

        assertThat(storyboard.brief().semanticVersion()).isEqualTo("brief-v4");
        assertThat(storyboard.semanticVersion()).isEqualTo("edition-v3");
        assertThat(storyboard.exactSources()).containsExactly(SOURCE);

        StoryboardPlanner.PlannedShot shot = storyboard.scenes().getFirst().shots().getFirst();
        MultitrackRenderPlanner.Graph renderGraph = new MultitrackRenderPlanner.Graph(
                List.of(new MultitrackRenderPlanner.Clip("clip-j09-boundary", Modality.VIDEO,
                        SOURCE.artifactId(), SOURCE.artifactVersionId(), FIXTURE_SHA256,
                        new Time(0, 1), new Time(0, 1), new Time(1, 1), List.of(new Time(0, 1)))),
                List.of(), List.of(), 1_048_576);
        PlanResult renderPlan = MultitrackRenderPlanner.plan(renderGraph);

        assertThat(shot.exactSources()).containsExactly(SOURCE);
        assertThat(renderPlan.outcome()).isEqualTo(Outcome.PLAN_READY);
        assertThat(renderPlan.plan().canonicalManifest())
                .contains("source-j09-boundary|version-7|");

        PlanResult render = MultitrackRenderPlanner.execute(renderPlan.plan(), null);
        assertThat(render.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(render.reason()).isEqualTo(Reason.CODEC_PIPELINE_NOT_ADMITTED);
        assertThat(render.plan()).isNull();

        // A controlled receipt is only a fixture to reach the review boundary; no render output exists.
        StoryboardPlanner.SavedPlan fixtureOnly = new StoryboardPlanner.SavedPlan(storyboard,
                "fixture-only-not-a-durable-plan-receipt");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> planner.review(REVIEWER, fixtureOnly,
                        "project-r12", "review-j09-boundary", new NotAdmittedStoryboardAuthority()))
                .isInstanceOf(MediaCapabilityNotAdmittedException.class)
                .satisfies(error -> {
                    MediaCapabilityNotAdmittedException unavailable =
                            (MediaCapabilityNotAdmittedException) error;
                    assertThat(unavailable.reason()).isEqualTo(MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED);
                    assertThat(unavailable.modality()).isEqualTo("STORYBOARD_REVIEW_AUTHORITY");
                });
        assertThat(fixtureOnly.state()).isEqualTo(StoryboardPlanner.EditionState.PERSISTED_DRAFT);
    }

    private static RationalTime story(long seconds) {
        return new RationalTime(seconds * 24, 24, 1, Clock.STORY);
    }
}
