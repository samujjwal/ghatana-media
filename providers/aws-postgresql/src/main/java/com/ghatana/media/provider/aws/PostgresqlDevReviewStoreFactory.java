package com.ghatana.media.provider.aws;

import com.ghatana.media.production.review.DevReviewStoreFactory;
import com.ghatana.media.production.review.ManagedReviewStore;

import java.util.Map;

/** Explicit local factory over the isolated DEV_ONLY schema; never selected by the canonical Media runtime. */
public final class PostgresqlDevReviewStoreFactory implements DevReviewStoreFactory {
    @Override public String factoryId() { return "postgresql-dev-review"; }

    @Override public ManagedReviewStore createDevOnly(Map<String, String> environment) {
        return new PostgresqlReviewStore(PostgresqlDevProjectTimelinePersistenceState.create(environment));
    }
}
