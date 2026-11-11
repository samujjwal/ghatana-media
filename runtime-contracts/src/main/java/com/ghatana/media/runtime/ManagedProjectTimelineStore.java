package com.ghatana.media.runtime;

/** A project timeline store whose local development resources are owned by its host runtime. */
public interface ManagedProjectTimelineStore extends MediaProjectTimelineContracts.ProjectTimelineStore, AutoCloseable {
    @Override
    void close();
}
