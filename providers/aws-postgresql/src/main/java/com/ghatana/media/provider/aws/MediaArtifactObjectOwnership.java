package com.ghatana.media.provider.aws;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.HexFormat;

/** Shared tenant-bound S3 object namespace checks for Media artifact admission and deletion. */
final class MediaArtifactObjectOwnership {
    private static final int TENANT_MUTATION_LOCK_NAMESPACE = 0x4d454449;

    private MediaArtifactObjectOwnership() { }

    static String tenantOwnedArtifactKey(
            String reference, String bucket, String finalizedNamespace, String derivedNamespace,
            String tenantId, String artifactId, String sha256) {
        String key = key(reference, bucket);
        String tenantSegment = opaque(tenantId) + "/";
        if (key.startsWith(finalizedNamespace + tenantSegment)) return key;
        String expectedDerived = derivedNamespace + opaque(tenantId) + "/"
                + opaque(artifactId) + "/" + sha256;
        if (!key.equals(expectedDerived)) {
            throw new SecurityException("Media artifact object key is outside its tenant-owned namespace");
        }
        return key;
    }

    static String tenantOwnedDerivedKey(
            String reference, String bucket, String derivedNamespace,
            String tenantId, String artifactId, String sha256) {
        String key = key(reference, bucket);
        String expected = derivedNamespace + opaque(tenantId) + "/" + opaque(artifactId) + "/" + sha256;
        if (!key.equals(expected)) {
            throw new SecurityException(
                    "Derived Media object key is outside its tenant, artifact, and version namespace");
        }
        return key;
    }

    static String opaque(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8))).substring(0, 32);
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    /** Serialize artifact-tree mutation and deletion across Media processes sharing PostgreSQL. */
    static void lockTenantMutation(Connection connection, String tenantId) throws SQLException {
        if (!"PostgreSQL".equalsIgnoreCase(connection.getMetaData().getDatabaseProductName())) return;
        try (PreparedStatement lock = connection.prepareStatement("SELECT pg_advisory_xact_lock(?,?)")) {
            lock.setInt(1, TENANT_MUTATION_LOCK_NAMESPACE);
            // Hash collisions only serialize unrelated tenants; they cannot weaken isolation.
            lock.setInt(2, tenantId.hashCode());
            lock.execute();
        }
    }

    private static String key(String referenceValue, String bucket) {
        if (referenceValue == null || referenceValue.isBlank()) {
            throw new SecurityException("Media artifact object reference is missing");
        }
        URI reference;
        try {
            reference = URI.create(referenceValue);
        } catch (IllegalArgumentException malformed) {
            throw new SecurityException("Media artifact object reference is malformed", malformed);
        }
        if (!"s3".equalsIgnoreCase(reference.getScheme()) || !bucket.equals(reference.getHost())
                || reference.getPort() != -1 || reference.getUserInfo() != null
                || reference.getQuery() != null || reference.getFragment() != null) {
            throw new SecurityException("Media artifact object reference is outside the configured S3 bucket");
        }
        String rawPath = reference.getRawPath();
        if (rawPath == null || rawPath.length() < 2 || !rawPath.startsWith("/")
                || rawPath.indexOf('%') >= 0) {
            throw new SecurityException("Media artifact object reference has no object key");
        }
        return rawPath.substring(1);
    }
}
