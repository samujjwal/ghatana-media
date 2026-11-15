package com.ghatana.media.runtime;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * DEV_ONLY versioned artifact intake ledger (J-02). A lineage is an owner-scoped named sequence of immutable artifact
 * versions. Registering a finalised, digest-verified artifact appends the next version (recording the parent it revises
 * and the media probe of its bytes); registering content the lineage already holds deduplicates to the existing version.
 * The ledger is append-only and is never an authority for rights.
 */
public final class MediaArtifactVersionLedgerContracts {
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}");
    private static final Pattern VERSION = Pattern.compile("sha256:[0-9a-f]{64}");

    private MediaArtifactVersionLedgerContracts() { }

    /** One registered version of a lineage. {@code probeJson} is a canonical JSON object. */
    public record Version(String tenantId, String principalId, String lineageId, int versionNumber, String artifactId,
                          String artifactVersionId, String contentSha256, long sizeBytes,
                          String parentArtifactVersionId, String probeJson, Instant createdAt) {
        public Version {
            Objects.requireNonNull(tenantId, "tenantId");
            Objects.requireNonNull(principalId, "principalId");
            if (!ID.matcher(lineageId).matches()) throw new IllegalArgumentException("lineageId is not a valid opaque id");
            if (versionNumber < 1) throw new IllegalArgumentException("versionNumber must be positive");
            Objects.requireNonNull(artifactId, "artifactId");
            if (!VERSION.matcher(artifactVersionId).matches()) throw new IllegalArgumentException("artifactVersionId is invalid");
            if (sizeBytes < 1) throw new IllegalArgumentException("sizeBytes must be positive");
            if (parentArtifactVersionId != null && !VERSION.matcher(parentArtifactVersionId).matches()) {
                throw new IllegalArgumentException("parentArtifactVersionId is invalid");
            }
            Objects.requireNonNull(probeJson, "probeJson");
        }
    }

    /** {@code deduplicated} is true when the lineage already held this exact content and nothing was appended. */
    public record Registration(Version version, boolean deduplicated) { }

    /** The lineage exists but is owned by another principal (callers conceal this as "not found"). */
    public static final class LineageOwnershipException extends RuntimeException {
        public LineageOwnershipException() { super("lineage is not available to this principal", null, false, false); }
    }

    /**
     * A registered version that an erasure removed from its lineage. Versions are append-only, so the only way a version
     * leaves a lineage is erasure; this record is the durable audit of that removal.
     */
    public record Removal(String lineageId, int versionNumber, String artifactId, String artifactVersionId,
                          String erasureId, Instant erasedAt) {
        public Removal {
            Objects.requireNonNull(lineageId, "lineageId");
            Objects.requireNonNull(artifactId, "artifactId");
            Objects.requireNonNull(artifactVersionId, "artifactVersionId");
            Objects.requireNonNull(erasureId, "erasureId");
            Objects.requireNonNull(erasedAt, "erasedAt");
        }
    }

    public interface VersionLedger extends AutoCloseable {
        String ledgerId();

        boolean ready();

        /**
         * Atomically appends the artifact as the next version of the lineage (creating the lineage on first use), or
         * returns the existing version when the lineage already holds this exact content. Concurrent registrations
         * serialise on the (lineage, version number) key, so version numbers are gapless and unique.
         *
         * @throws LineageOwnershipException when another principal owns the lineage
         */
        Registration register(String tenantId, String principalId, String lineageId, String artifactId,
                              String artifactVersionId, String contentSha256, long sizeBytes, String probeJson);

        /** All versions in ascending order; empty when the lineage does not exist or belongs to another principal. */
        List<Version> versions(String tenantId, String principalId, String lineageId);

        /** The version holding {@code artifactVersionId} in the lineage, if registered. */
        Optional<Version> find(String tenantId, String principalId, String lineageId, String artifactVersionId);

        /**
         * Ids of this owner's lineages that hold the exact artifact version (usually zero or one). A review of an
         * artifact version uses it to learn whether a later version of the same lineage has superseded it.
         */
        List<String> lineagesHolding(String tenantId, String principalId, String artifactId, String artifactVersionId);

        /**
         * Versions of this owner's lineage that erasures removed, oldest erasure first. A removed version that was newer
         * than the current head means the head was restored by that erasure.
         */
        List<Removal> removals(String tenantId, String principalId, String lineageId);

        @Override void close();
    }

    public interface VersionLedgerFactory {
        String factoryId();

        VersionLedger createDevOnly(Map<String, String> environment);
    }
}
