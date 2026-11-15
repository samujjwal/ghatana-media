package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaErasureContracts.ErasureAuthority;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureAuthorityFactory;

import java.time.Clock;
import java.util.Locale;
import java.util.Map;

/**
 * Explicit DEV_ONLY factory over the canonical PostgreSQL/S3 runtime state (V039). It also opens the isolated DEV_ONLY
 * review schema when that is configured, so review records that point at erased versions are erased too. Never selected
 * by the canonical Media runtime.
 */
public final class PostgresqlDevErasureAuthorityFactory implements ErasureAuthorityFactory {
    public static final String FACTORY_ID = "postgresql-dev-erasure";
    /** When true, hold, release and erase need an identity-provider verified principal (a production-like gate). */
    public static final String ENV_REQUIRE_OIDC = "MEDIA_DEV_ERASURE_REQUIRE_OIDC";

    @Override public String factoryId() { return FACTORY_ID; }

    @Override public ErasureAuthority createDevOnly(Map<String, String> environment) {
        String profile = environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "")).trim().toLowerCase(Locale.ROOT);
        if (!"dev".equals(profile)
                || !"true".equalsIgnoreCase(environment.getOrDefault("MEDIA_DEV_IDENTITY_ENABLED", "false"))) {
            throw new IllegalArgumentException(
                    "DEV_ONLY erasure storage requires profile=dev and MEDIA_DEV_IDENTITY_ENABLED=true");
        }
        PostgresqlDevProjectTimelinePersistenceState review = null;
        if (!environment.getOrDefault("MEDIA_PROJECT_TIMELINE_POSTGRES_JDBC_URL", "").isBlank()) {
            review = PostgresqlDevProjectTimelinePersistenceState.create(environment);
        }
        boolean requireOidc = "true".equalsIgnoreCase(environment.getOrDefault(ENV_REQUIRE_OIDC, "false"));
        return new PostgresqlMediaErasureAuthority(MediaAwsPostgresqlRuntimeState.acquire(), review,
                Clock.systemUTC(), requireOidc);
    }
}
