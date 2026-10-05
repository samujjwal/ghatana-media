package com.ghatana.media.launcher;

import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.Set;

/**
 * Typed standalone Media Runtime configuration.
 *
 * @doc.type record
 * @doc.purpose Represent Media Runtime Config values
 * @doc.layer product
 * @doc.pattern Configuration
 */
public record MediaRuntimeConfig(
        boolean runtimeEnabled,
        String profile,
        int httpPort,
        int maximumBodyBytes,
        int maximumChunkBytes,
        long maximumArtifactBytes,
        Duration jobTimeout,
        int maximumConcurrentJobs,
        String artifactStoreId,
        String jobStoreId,
        boolean localStoresEnabled,
        boolean localProviderEnabled,
        Path localStorageRoot) {

    private static final Set<String> SUPPORTED_PROFILES = Set.of(
            "local", "dev", "development", "test", "ci", "staging", "production", "sovereign");

    public MediaRuntimeConfig {
        profile = required(profile, "profile").toLowerCase(java.util.Locale.ROOT);
        if (!SUPPORTED_PROFILES.contains(profile)) {
            throw new IllegalArgumentException(
                    "Unsupported Media Runtime profile '" + profile + "'; supported profiles: "
                            + SUPPORTED_PROFILES);
        }
        artifactStoreId = canonicalOptional(artifactStoreId);
        jobStoreId = canonicalOptional(jobStoreId);
        localStorageRoot = java.util.Objects.requireNonNull(localStorageRoot, "localStorageRoot")
                .toAbsolutePath().normalize();
        if (httpPort < 1 || httpPort > 65_535) throw new IllegalArgumentException("MEDIA_HTTP_PORT must be between 1 and 65535");
        if (maximumBodyBytes < 1 || maximumBodyBytes > 32 * 1024 * 1024) {
            throw new IllegalArgumentException("MEDIA_MAX_BODY_BYTES must be between 1 and 33554432");
        }
        if (maximumChunkBytes < 1 || maximumChunkBytes > maximumBodyBytes) {
            throw new IllegalArgumentException("MEDIA_MAX_CHUNK_BYTES must be positive and not exceed MEDIA_MAX_BODY_BYTES");
        }
        if (maximumArtifactBytes < maximumChunkBytes || maximumArtifactBytes > 1_099_511_627_776L) {
            throw new IllegalArgumentException(
                    "MEDIA_MAX_ARTIFACT_BYTES must be at least MEDIA_MAX_CHUNK_BYTES and at most 1099511627776");
        }
        if (jobTimeout == null || jobTimeout.isZero() || jobTimeout.isNegative()
                || jobTimeout.compareTo(Duration.ofHours(24)) > 0) {
            throw new IllegalArgumentException("MEDIA_JOB_TIMEOUT_MS must be between 1 and 86400000");
        }
        if (maximumConcurrentJobs < 1 || maximumConcurrentJobs > 10_000) {
            throw new IllegalArgumentException("MEDIA_MAX_CONCURRENT_JOBS must be between 1 and 10000");
        }
        boolean productionLike = productionLike(profile);
        if (productionLike && !runtimeEnabled) {
            throw new IllegalArgumentException("Production-like Media Runtime cannot be disabled");
        }
        if (productionLike && (localStoresEnabled || localProviderEnabled)) {
            throw new IllegalArgumentException("Production-like Media Runtime cannot use local stores or provider");
        }
        if (productionLike && (artifactStoreId.isBlank() || jobStoreId.isBlank())) {
            throw new IllegalArgumentException(
                    "MEDIA_ARTIFACT_STORE_ID and MEDIA_JOB_STORE_ID are required for production-like profiles");
        }
    }

    public static MediaRuntimeConfig fromEnvironment(Map<String, String> environment) {
        java.util.Objects.requireNonNull(environment, "environment");
        return new MediaRuntimeConfig(
                bool(environment, "MEDIA_RUNTIME_ENABLED", false),
                environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT", environment.getOrDefault("MEDIA_PROFILE", "local")),
                integer(environment, "MEDIA_HTTP_PORT", 8093),
                integer(environment, "MEDIA_MAX_BODY_BYTES", 8 * 1024 * 1024),
                integer(environment, "MEDIA_MAX_CHUNK_BYTES", 4 * 1024 * 1024),
                longValue(environment, "MEDIA_MAX_ARTIFACT_BYTES", 10L * 1024 * 1024 * 1024),
                Duration.ofMillis(longValue(environment, "MEDIA_JOB_TIMEOUT_MS", 900_000L)),
                integer(environment, "MEDIA_MAX_CONCURRENT_JOBS", 64),
                environment.getOrDefault("MEDIA_ARTIFACT_STORE_ID", ""),
                environment.getOrDefault("MEDIA_JOB_STORE_ID", ""),
                bool(environment, "MEDIA_LOCAL_STORES_ENABLED", false),
                bool(environment, "MEDIA_LOCAL_PROVIDER_ENABLED", false),
                Path.of(environment.getOrDefault("MEDIA_LOCAL_STORAGE_ROOT", "build/media-runtime-local")));
    }

    public boolean productionLike() {
        return productionLike(profile);
    }

    private static boolean productionLike(String profile) {
        return "production".equals(profile) || "staging".equals(profile) || "sovereign".equals(profile);
    }

    private static boolean bool(Map<String, String> environment, String key, boolean fallback) {
        String value = environment.get(key);
        if (value == null || value.isBlank()) return fallback;
        if ("true".equalsIgnoreCase(value)) return true;
        if ("false".equalsIgnoreCase(value)) return false;
        throw new IllegalArgumentException(key + " must be true or false");
    }
    private static int integer(Map<String, String> environment, String key, int fallback) {
        long value = longValue(environment, key, fallback);
        if (value > Integer.MAX_VALUE || value < Integer.MIN_VALUE) {
            throw new IllegalArgumentException(key + " exceeds integer range");
        }
        return (int) value;
    }
    private static long longValue(Map<String, String> environment, String key, long fallback) {
        try { return Long.parseLong(environment.getOrDefault(key, Long.toString(fallback)).trim()); }
        catch (NumberFormatException failure) { throw new IllegalArgumentException(key + " must be an integer", failure); }
    }
    private static String canonicalOptional(String value) {
        return value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
    }
    private static String required(String value, String field) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(field + " is required");
        return value.trim();
    }
}
