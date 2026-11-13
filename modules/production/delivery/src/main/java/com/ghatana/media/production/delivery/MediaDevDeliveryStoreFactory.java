package com.ghatana.media.production.delivery;

import java.util.Map;

/**
 * ServiceLoader SPI for the explicitly enabled DEV_ONLY hosted export. It lives beside
 * {@link DeliveryOperationStore} because that port is not visible to runtime-contracts.
 * The returned store may also implement {@link AutoCloseable}; the host closes it.
 */
public interface MediaDevDeliveryStoreFactory {
    String factoryId();

    /** Creates a durable store only for a verified local development configuration. */
    DeliveryOperationStore createDevOnly(Map<String, String> environment);
}
