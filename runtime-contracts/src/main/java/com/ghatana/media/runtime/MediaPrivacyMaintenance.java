package com.ghatana.media.runtime;

import java.time.Instant;
import java.util.Map;

/**
 * Service-owned provider boundary for physical Media retention and erasure maintenance.
 *
 * <p>This contract is intentionally about durable deletion rather than logical filtering. A
 * production provider must delete expired governed metadata and referenced blob/chunk bytes, and
 * report bounded counts without returning content or sensitive identifiers.
 *
 * @doc.type interface
 * @doc.purpose Physically enforce Media retention and erasure on production stores
 * @doc.layer product
 * @doc.pattern SPI, ServiceLoader, Maintenance
 */
public interface MediaPrivacyMaintenance extends AutoCloseable {
    String maintenanceId();

    boolean ready();

    boolean productionEligible();

    /** Executes one bounded maintenance cycle at the supplied deterministic clock instant. */
    PurgeReport purgeExpired(Instant now);

    @Override
    default void close() { }

    record PurgeReport(
            int artifactsDeleted,
            int uploadsDeleted,
            int chunksDeleted,
            int jobsDeleted,
            int streamsDeleted,
            Map<String, Object> metadata) {
        public PurgeReport {
            if (artifactsDeleted < 0 || uploadsDeleted < 0 || chunksDeleted < 0
                    || jobsDeleted < 0 || streamsDeleted < 0) {
                throw new IllegalArgumentException("purge counts must not be negative");
            }
            metadata = Map.copyOf(metadata == null ? Map.of() : metadata);
        }

        public int totalDeleted() {
            return artifactsDeleted + uploadsDeleted + chunksDeleted + jobsDeleted + streamsDeleted;
        }
    }
}
