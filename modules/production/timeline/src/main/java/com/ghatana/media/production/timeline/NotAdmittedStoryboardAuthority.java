package com.ghatana.media.production.timeline;

import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;

/** Explicit zero-effect binding when no durable, host-owned storyboard authority is admitted. */
public final class NotAdmittedStoryboardAuthority implements StoryboardPlanner.ScenePlanAuthority,
        StoryboardPlanner.ScenePlanReviewAuthority {

    @Override
    public StoryboardPlanner.SavedPlan append(Actor actor, StoryboardPlanner.ScenePlan plan,
            String expectedProjectHeadRevisionId, String expectedParentSemanticVersion, String requestId) {
        throw unavailable("STORYBOARD_PLAN_STORE", "durable storyboard edition CAS is not wired");
    }

    @Override
    public StoryboardPlanner.ReviewedPlan appendReview(Actor reviewer, StoryboardPlanner.SavedPlan exactEdition,
            String expectedProjectRevisionId, String requestId) {
        throw unavailable("STORYBOARD_REVIEW_AUTHORITY", "host-owned reviewer authorization and receipt are not wired");
    }

    private static MediaCapabilityNotAdmittedException unavailable(String modality, String detail) {
        return new MediaCapabilityNotAdmittedException(
                MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED, modality, detail);
    }
}
