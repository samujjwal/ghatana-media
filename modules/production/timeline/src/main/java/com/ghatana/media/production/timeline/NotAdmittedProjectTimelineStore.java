package com.ghatana.media.production.timeline;

import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;

/** Explicit fail-closed store binding for hosts without an admitted durable timeline authority. */
public final class NotAdmittedProjectTimelineStore implements ProjectTimelineStore {
    private static MediaCapabilityNotAdmittedException unavailable() {
        return new MediaCapabilityNotAdmittedException(
                MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED, "PROJECT_TIMELINE_STORE",
                "durable single-writer project revision storage is not wired");
    }

    @Override public Created create(Actor actor, String workspaceId, String title, String requestId,
                                   String projectId, String initialRevisionId) {
        requireCreateProjectRequestId(requestId);
        throw unavailable();
    }

    @Override public Project project(Actor actor, String projectId) { throw unavailable(); }

    @Override public Revision revision(Actor actor, String projectId, String revisionId) { throw unavailable(); }

    @Override public Revision commit(Actor actor, String projectId, String expectedHeadRevisionId,
                                     String newRevisionId, java.util.List<TimelineSnapshot> timelines) {
        throw unavailable();
    }
}
