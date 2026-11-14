package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationStore;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationStoreFactory;

import java.util.Locale;
import java.util.Map;

/**
 * Canonical (non-DEV) factory over the canonical Media PostgreSQL rights/consent tables. It only creates a store
 * when the operator explicitly sets {@code MEDIA_RIGHTS_AUTHORITY=postgresql}; the store reuses the canonical
 * runtime PostgreSQL datasource (the same shared state the artifact and job stores acquire), so no second
 * connection configuration exists. When that datasource is not configured the store is not ready and every
 * resolution is UNAVAILABLE (fail closed).
 */
public final class PostgresqlRightsStoreFactory implements AttestationStoreFactory {
    public static final String FACTORY_ID = "postgresql";
    public static final String SELECTOR = "MEDIA_RIGHTS_AUTHORITY";

    @Override public String factoryId() { return FACTORY_ID; }

    @Override public AttestationStore createCanonical(Map<String, String> environment) {
        String selected = environment.getOrDefault(SELECTOR, "").trim().toLowerCase(Locale.ROOT);
        if (!FACTORY_ID.equals(selected)) {
            throw new IllegalArgumentException(SELECTOR + " must be explicitly set to " + FACTORY_ID);
        }
        return new PostgresqlMediaRightsAttestationStore();
    }
}
