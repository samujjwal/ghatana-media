package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.ManagedProjectTimelineStore;
import com.ghatana.media.runtime.MediaDevProjectTimelineStoreFactory;

import java.util.Map;

/** Explicit local factory; never selected by the canonical Media runtime. */
public final class PostgresqlDevProjectTimelineStoreFactory implements MediaDevProjectTimelineStoreFactory {
    @Override public String factoryId() { return "postgresql-dev-project-timeline"; }

    @Override public ManagedProjectTimelineStore createDevOnly(Map<String, String> environment) {
        return new PostgresqlProjectTimelineStore(PostgresqlDevProjectTimelinePersistenceState.create(environment));
    }
}
