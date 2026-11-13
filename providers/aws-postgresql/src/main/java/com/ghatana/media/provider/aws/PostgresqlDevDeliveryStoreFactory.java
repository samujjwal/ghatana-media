package com.ghatana.media.provider.aws;

import com.ghatana.media.production.delivery.DeliveryOperationStore;
import com.ghatana.media.production.delivery.MediaDevDeliveryStoreFactory;

import java.util.Locale;
import java.util.Map;

/**
 * Explicit DEV_ONLY factory over the canonical PostgreSQL delivery ledger (migrations V031/V032 of the
 * canonical runtime schema); never selected by the canonical Media runtime.
 */
public final class PostgresqlDevDeliveryStoreFactory implements MediaDevDeliveryStoreFactory {
    @Override public String factoryId() { return "postgresql-dev-delivery"; }

    @Override public DeliveryOperationStore createDevOnly(Map<String, String> environment) {
        String profile = environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "")).trim().toLowerCase(Locale.ROOT);
        if (!"dev".equals(profile)
                || !"true".equalsIgnoreCase(environment.getOrDefault("MEDIA_DEV_IDENTITY_ENABLED", "false"))
                || !"true".equalsIgnoreCase(environment.getOrDefault("MEDIA_DELIVERY_DEV_ENABLED", "false"))) {
            throw new IllegalArgumentException(
                    "DEV_ONLY delivery storage requires profile=dev, MEDIA_DEV_IDENTITY_ENABLED=true, and MEDIA_DELIVERY_DEV_ENABLED=true");
        }
        return new PostgresqlMediaDeliveryOperationStore();
    }
}
