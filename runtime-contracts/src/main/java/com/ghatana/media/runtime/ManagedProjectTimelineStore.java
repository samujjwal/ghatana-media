package com.ghatana.media.runtime;

import java.util.List;

/** A project timeline store whose local development resources are owned by its host runtime. */
public interface ManagedProjectTimelineStore extends MediaProjectTimelineContracts.ProjectTimelineStore, AutoCloseable {
    @Override MediaProjectTimelineContracts.Revision replayCommand(
            MediaProjectTimelineContracts.Actor actor, String projectId, String canonicalOperationRef,
            String requestId, String requestFingerprint);
    @Override MediaProjectTimelineContracts.Revision commitCommand(
            MediaProjectTimelineContracts.Actor actor, String projectId, String expectedHeadRevisionId,
            String canonicalOperationRef, String requestId, String requestFingerprint, String newRevisionId,
            List<MediaProjectTimelineContracts.TimelineSnapshot> timelines);
    @Override
    void close();
}
