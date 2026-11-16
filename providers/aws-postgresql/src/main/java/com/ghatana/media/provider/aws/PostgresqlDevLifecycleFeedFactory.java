package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.Feed;
import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.FeedFactory;

import java.util.Locale;
import java.util.Map;

/** Explicit DEV_ONLY factory over the canonical PostgreSQL schema (V043); never selected by the canonical runtime. */
public final class PostgresqlDevLifecycleFeedFactory implements FeedFactory {
    public static final String FACTORY_ID = "postgresql-dev-lifecycle-feed";

    @Override public String factoryId() { return FACTORY_ID; }

    @Override public Feed createDevOnly(Map<String, String> environment) {
        String profile = environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "")).trim().toLowerCase(Locale.ROOT);
        if (!"dev".equals(profile)
                || !"true".equalsIgnoreCase(environment.getOrDefault("MEDIA_DEV_IDENTITY_ENABLED", "false"))) {
            throw new IllegalArgumentException(
                    "DEV_ONLY lifecycle feed requires profile=dev and MEDIA_DEV_IDENTITY_ENABLED=true");
        }
        return new PostgresqlMediaDevLifecycleFeed();
    }
}
