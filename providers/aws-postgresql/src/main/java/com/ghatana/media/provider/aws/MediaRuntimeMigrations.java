package com.ghatana.media.provider.aws;

import java.util.Locale;

/**
 * Flyway locations of the canonical Media runtime schema. {@code db/media-runtime} holds the vendor-neutral
 * migrations that also run on the H2 lineage fixture. {@code db/media-runtime-vendor/<vendor>} holds migrations
 * that need vendor features (PostgreSQL triggers, plpgsql); the vendor directory is chosen explicitly from the
 * JDBC URL because Flyway has no vendor placeholder. Every vendor directory carries the same version numbers so
 * the lineage is identical; vendors without the feature carry an explicit no-op at that version.
 */
public final class MediaRuntimeMigrations {
    public static final String COMMON_LOCATION = "classpath:db/media-runtime";
    public static final String POSTGRESQL = "postgresql";
    public static final String H2 = "h2";

    private MediaRuntimeMigrations() { }

    public static String vendorLocation(String vendor) { return "classpath:db/media-runtime-vendor/" + vendor; }

    public static String[] locations(String vendor) { return new String[] {COMMON_LOCATION, vendorLocation(vendor)}; }

    /** {@code postgresql} for PostgreSQL URLs, {@code h2} for H2 URLs; anything else is refused. */
    public static String vendorOf(String jdbcUrl) {
        String url = jdbcUrl == null ? "" : jdbcUrl.trim().toLowerCase(Locale.ROOT);
        if (url.startsWith("jdbc:postgresql:")) return POSTGRESQL;
        if (url.startsWith("jdbc:h2:")) return H2;
        throw new IllegalArgumentException("unsupported Media runtime database vendor");
    }

    public static String[] locationsFor(String jdbcUrl) { return locations(vendorOf(jdbcUrl)); }
}
