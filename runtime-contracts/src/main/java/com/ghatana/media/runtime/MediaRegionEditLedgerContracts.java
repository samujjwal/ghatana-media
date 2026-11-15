package com.ghatana.media.runtime;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * DEV_ONLY compare-and-set version history of region edits (J-11). A lineage is an owner-scoped, append-only sequence
 * of immutable versions. Version 1 is the BASE (the user's video, never changed); every later version is either an
 * EDIT (a newly rendered artifact derived from the version before it) or an UNDO (a version whose content is the exact
 * artifact of an earlier version: its bytes and metadata are that artifact's, not a copy).
 *
 * <p>Appending names the head the caller saw ({@code expectedHead}); the append succeeds only when that is still the
 * head, atomically, so of several concurrent editors of the same base exactly one wins and the rest receive
 * {@link StaleHeadException} carrying the real head. A request id is unique inside a lineage: appending it again
 * returns the version it already produced.</p>
 */
public final class MediaRegionEditLedgerContracts {
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}");
    private static final Pattern VERSION = Pattern.compile("sha256:[0-9a-f]{64}");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");

    private MediaRegionEditLedgerContracts() { }

    public enum Kind { BASE, EDIT, UNDO }

    /** One version row. {@code detailJson} is a canonical JSON object describing the edit (never authoritative for rights). */
    public record Version(String tenantId, String principalId, String lineageId, int versionNumber, Kind kind,
                          String requestId, String artifactId, String artifactVersionId, String contentSha256,
                          long sizeBytes, String manifestArtifactId, String manifestArtifactVersionId,
                          Integer parentVersionNumber, Integer restoresVersionNumber, String detailJson,
                          Instant createdAt) {
        public Version {
            Objects.requireNonNull(tenantId, "tenantId");
            Objects.requireNonNull(principalId, "principalId");
            requireId(lineageId, "lineageId");
            if (versionNumber < 1) throw new IllegalArgumentException("versionNumber must be positive");
            Objects.requireNonNull(kind, "kind");
            requireId(requestId, "requestId");
            Objects.requireNonNull(artifactId, "artifactId");
            if (!VERSION.matcher(artifactVersionId).matches()) throw new IllegalArgumentException("artifactVersionId is invalid");
            if (!SHA256.matcher(contentSha256).matches()) throw new IllegalArgumentException("contentSha256 is invalid");
            if (sizeBytes < 1) throw new IllegalArgumentException("sizeBytes must be positive");
            if ((manifestArtifactId == null) != (manifestArtifactVersionId == null)) {
                throw new IllegalArgumentException("manifest artifact id and version go together");
            }
            switch (kind) {
                case BASE -> {
                    if (versionNumber != 1 || parentVersionNumber != null || restoresVersionNumber != null) {
                        throw new IllegalArgumentException("BASE is version 1 and has no parent");
                    }
                }
                case EDIT -> {
                    if (versionNumber < 2 || parentVersionNumber == null || parentVersionNumber != versionNumber - 1
                            || restoresVersionNumber != null || manifestArtifactId == null) {
                        throw new IllegalArgumentException("EDIT derives from the head and carries a manifest");
                    }
                }
                case UNDO -> {
                    if (versionNumber < 3 || parentVersionNumber == null || parentVersionNumber != versionNumber - 1
                            || restoresVersionNumber == null || restoresVersionNumber < 1
                            || restoresVersionNumber >= parentVersionNumber) {
                        throw new IllegalArgumentException("UNDO restores an earlier version than the head it undoes");
                    }
                }
            }
            Objects.requireNonNull(detailJson, "detailJson");
        }
    }

    /** What the caller appends; the ledger assigns the version number (expected head + 1). */
    public record Proposal(Kind kind, String requestId, String artifactId, String artifactVersionId, String contentSha256,
                           long sizeBytes, String manifestArtifactId, String manifestArtifactVersionId,
                           Integer restoresVersionNumber, String detailJson) {
        public Proposal {
            Objects.requireNonNull(kind, "kind");
            if (kind == Kind.BASE) throw new IllegalArgumentException("a BASE version is created with createLineage");
        }
    }

    /** {@code deduplicated} is true when the lineage already held this request and nothing was appended. */
    public record Appended(Version version, boolean deduplicated) { }

    /** The lineage already exists for a different artifact version or a different owner. */
    public static final class LineageExistsException extends RuntimeException {
        public LineageExistsException() { super("lineage already exists", null, false, false); }
    }

    /** The expected head is no longer the head. */
    public static final class StaleHeadException extends RuntimeException {
        private final int expected;
        private final int actual;
        public StaleHeadException(int expected, int actual) {
            super("expected head " + expected + " but the head is " + actual, null, false, false);
            this.expected = expected;
            this.actual = actual;
        }
        public int expected() { return expected; }
        public int actual() { return actual; }
    }

    public interface RegionEditLedger extends AutoCloseable {
        String ledgerId();

        boolean ready();

        /**
         * Creates the lineage with the BASE version, or returns the existing BASE when the same owner registers the same
         * artifact version again.
         *
         * @throws LineageExistsException when the lineage exists for another artifact version or another owner
         */
        Appended createLineage(String tenantId, String principalId, String lineageId, String requestId, String artifactId,
                               String artifactVersionId, String contentSha256, long sizeBytes, String detailJson);

        /**
         * Atomically appends the proposal as version {@code expectedHead + 1}, or returns the version this request id
         * already produced. Concurrent appenders of the same head serialise on the version number.
         *
         * @throws StaleHeadException when the head is not {@code expectedHead}
         * @throws IllegalStateException when the lineage does not exist for this owner
         */
        Appended append(String tenantId, String principalId, String lineageId, int expectedHead, Proposal proposal);

        /** All versions ascending; empty when the lineage does not exist or belongs to another principal. */
        List<Version> versions(String tenantId, String principalId, String lineageId);

        /** The version a request id produced in the lineage, if any. */
        default Optional<Version> byRequest(String tenantId, String principalId, String lineageId, String requestId) {
            return versions(tenantId, principalId, lineageId).stream()
                    .filter(version -> version.requestId().equals(requestId)).findFirst();
        }

        @Override void close();
    }

    public interface RegionEditLedgerFactory {
        String factoryId();

        RegionEditLedger createDevOnly(Map<String, String> environment);
    }

    private static void requireId(String value, String name) {
        if (value == null || !ID.matcher(value).matches()) throw new IllegalArgumentException(name + " is not a valid opaque id");
    }
}
