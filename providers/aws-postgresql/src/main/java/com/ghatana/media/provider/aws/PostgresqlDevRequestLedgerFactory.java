package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRequestLedgerContracts.RequestLedger;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.RequestLedgerFactory;

import java.util.Locale;
import java.util.Map;

/**
 * Explicit DEV_ONLY factory over the canonical PostgreSQL request-ledger table (V038 of the canonical runtime
 * schema); it reuses the canonical runtime datasource and is never selected by the canonical Media runtime.
 */
public final class PostgresqlDevRequestLedgerFactory implements RequestLedgerFactory {
    public static final String FACTORY_ID = "postgresql-dev-request-ledger";

    @Override public String factoryId() { return FACTORY_ID; }

    @Override public RequestLedger createDevOnly(Map<String, String> environment) {
        String profile = environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "")).trim().toLowerCase(Locale.ROOT);
        if (!"dev".equals(profile)
                || !"true".equalsIgnoreCase(environment.getOrDefault("MEDIA_DEV_IDENTITY_ENABLED", "false"))) {
            throw new IllegalArgumentException(
                    "DEV_ONLY request ledger storage requires profile=dev and MEDIA_DEV_IDENTITY_ENABLED=true");
        }
        return new PostgresqlMediaRequestLedger();
    }
}
