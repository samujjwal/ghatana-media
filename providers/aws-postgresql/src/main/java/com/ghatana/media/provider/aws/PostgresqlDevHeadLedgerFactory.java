package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaHeadLedgerContracts.HeadLedger;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.HeadLedgerFactory;

import java.util.Locale;
import java.util.Map;

/** Explicit DEV_ONLY factory over the canonical PostgreSQL schema (V041); never selected by the canonical runtime. */
public final class PostgresqlDevHeadLedgerFactory implements HeadLedgerFactory {
    public static final String FACTORY_ID = "postgresql-dev-head-ledger";

    @Override public String factoryId() { return FACTORY_ID; }

    @Override public HeadLedger createDevOnly(Map<String, String> environment) {
        String profile = environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "")).trim().toLowerCase(Locale.ROOT);
        if (!"dev".equals(profile)
                || !"true".equalsIgnoreCase(environment.getOrDefault("MEDIA_DEV_IDENTITY_ENABLED", "false"))) {
            throw new IllegalArgumentException(
                    "DEV_ONLY head ledger requires profile=dev and MEDIA_DEV_IDENTITY_ENABLED=true");
        }
        return new PostgresqlMediaHeadLedger();
    }
}
