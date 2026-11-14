package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationStore;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationStoreFactory;

import java.util.Locale;
import java.util.Map;

/**
 * Explicit DEV_ONLY factory over the canonical PostgreSQL rights/consent tables (V036 of the canonical runtime
 * schema); never selected by the canonical Media runtime on its own.
 */
public final class PostgresqlDevRightsStoreFactory implements AttestationStoreFactory {
    @Override public String factoryId() { return "postgresql-dev-rights"; }

    @Override public AttestationStore createDevOnly(Map<String, String> environment) {
        String profile = environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "")).trim().toLowerCase(Locale.ROOT);
        if (!"dev".equals(profile)
                || !"true".equalsIgnoreCase(environment.getOrDefault("MEDIA_DEV_IDENTITY_ENABLED", "false"))
                || !"true".equalsIgnoreCase(environment.getOrDefault("MEDIA_RIGHTS_DEV_ENABLED", "false"))) {
            throw new IllegalArgumentException(
                    "DEV_ONLY rights storage requires profile=dev, MEDIA_DEV_IDENTITY_ENABLED=true, and MEDIA_RIGHTS_DEV_ENABLED=true");
        }
        return new PostgresqlMediaRightsAttestationStore();
    }
}
