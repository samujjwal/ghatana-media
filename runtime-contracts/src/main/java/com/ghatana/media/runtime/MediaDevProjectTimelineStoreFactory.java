package com.ghatana.media.runtime;

import java.util.Map;

/** ServiceLoader SPI for an explicitly enabled, isolated DEV_ONLY project timeline store. */
public interface MediaDevProjectTimelineStoreFactory {
    String factoryId();

    /** Creates a store only for a verified local development configuration. */
    ManagedProjectTimelineStore createDevOnly(Map<String, String> environment);
}
