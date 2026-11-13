package com.ghatana.media.production.review;

import java.util.Map;

/** ServiceLoader SPI for an explicitly enabled, isolated DEV_ONLY durable review store. */
public interface DevReviewStoreFactory {
    String factoryId();

    /** Creates a store only for a verified local development configuration. */
    ManagedReviewStore createDevOnly(Map<String, String> environment);
}
