package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaPrivacyMaintenance;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;

import java.net.URI;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * PostgreSQL/S3 physical retention authority for the canonical Media Runtime state provider.
 *
 * <p>Each cycle is bounded. Blob deletion occurs before metadata deletion so a database row never
 * disappears while its referenced object is knowingly retained. Failed object deletion fails the
 * cycle closed and leaves metadata available for retry/audit.
 *
 * @doc.type class
 * @doc.purpose Delete expired Media blobs, upload chunks, and terminal runtime metadata
 * @doc.layer product
 * @doc.pattern Provider, Maintenance
 */
public final class PostgresqlMediaPrivacyMaintenance implements MediaPrivacyMaintenance {
    private static final int DEFAULT_BATCH_SIZE = 250;
    private static final Duration DEFAULT_JOB_RETENTION = Duration.ofDays(90);
    private static final Duration DEFAULT_STREAM_RETENTION = Duration.ofDays(90);
    private static final Duration STALE_FINALIZATION_GRACE = Duration.ofMinutes(15);

    private final MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
    private final int batchSize;
    private final Duration jobRetention;
    private final Duration streamRetention;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    public PostgresqlMediaPrivacyMaintenance() {
        this(System.getenv());
    }

    PostgresqlMediaPrivacyMaintenance(Map<String, String> environment) {
        batchSize = integer(environment, "MEDIA_PRIVACY_PURGE_BATCH_SIZE", DEFAULT_BATCH_SIZE, 1, 10_000);
        jobRetention = durationDays(environment, "MEDIA_JOB_RETENTION_DAYS", DEFAULT_JOB_RETENTION, 1, 3650);
        streamRetention = durationDays(environment, "MEDIA_STREAM_RETENTION_DAYS", DEFAULT_STREAM_RETENTION, 1, 3650);
    }

    @Override public String maintenanceId() { return "postgresql-s3-privacy-maintenance"; }
    @Override public boolean ready() { return !closed.get() && state.ready(); }
    @Override public boolean productionEligible() { return ready() && state.productionEligible(); }

    @Override
    public PurgeReport purgeExpired(Instant now) {
        ensureOpen();
        Instant effectiveNow = java.util.Objects.requireNonNull(now, "now");
        int artifacts = purgeArtifacts(effectiveNow);
        UploadPurge uploads = purgeUploads(effectiveNow);
        int jobs = purgeJobs(effectiveNow.minus(jobRetention));
        int streams = purgeStreams(effectiveNow.minus(streamRetention));
        return new PurgeReport(
                artifacts,
                uploads.uploads(),
                uploads.chunks(),
                jobs,
                streams,
                Map.of(
                        "maintenanceId", maintenanceId(),
                        "boundedBatchSize", batchSize,
                        "executedAt", effectiveNow.toString()));
    }

    private int purgeArtifacts(Instant now) {
        List<ArtifactDelete> expired = new ArrayList<>();
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT tenant_id,artifact_id FROM media_artifacts "
                             + "WHERE expires_at<=? AND legal_hold=FALSE ORDER BY expires_at LIMIT ?")) {
            statement.setLong(1, now.toEpochMilli());
            statement.setInt(2, batchSize);
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    expired.add(new ArtifactDelete(
                            result.getString("tenant_id"),
                            result.getString("artifact_id")));
                }
            }
        } catch (SQLException failure) {
            throw databaseFailure("read expired Media artifacts", failure);
        }

        int deleted = 0;
        for (ArtifactDelete artifact : expired) {
            deleted += purgeArtifactTree(artifact.tenantId(), artifact.artifactId(), now.toEpochMilli(), true);
        }
        return deleted;
    }

    /** Deletes derived descendants with their source so no derived bytes outlive their lineage. */
    private int purgeArtifactTree(String tenantId, String rootArtifactId, long now, boolean requireExpiredRoot) {
        LinkedHashMap<String, ArtifactNode> tree = new LinkedHashMap<>();
        collectArtifactTree(tenantId, rootArtifactId, tree);
        ArtifactNode root = tree.get(rootArtifactId);
        if (root == null || root.legalHold()
                || requireExpiredRoot && root.expiresAt() > now
                || tree.values().stream().anyMatch(ArtifactNode::legalHold)) return 0;

        // Delete all bytes before metadata. A failure leaves every row and lineage available for retry.
        List<ArtifactNode> reverse;
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                // Lock every lineage row before touching bytes so a concurrent retention renewal
                // or legal-hold change commits first and is re-evaluated under the lock.
                List<ArtifactNode> locked = new ArrayList<>();
                for (ArtifactNode node : tree.values()) {
                    String objectKey;
                    try (PreparedStatement lock = connection.prepareStatement(
                            "SELECT object_reference FROM media_artifacts "
                                    + "WHERE tenant_id=? AND artifact_id=? FOR UPDATE")) {
                        lock.setString(1, tenantId); lock.setString(2, node.artifactId());
                        try (ResultSet result = lock.executeQuery()) {
                            if (!result.next()) continue;
                            objectKey = objectKey(result.getString(1));
                        }
                    }
                    try (PreparedStatement recheck = connection.prepareStatement(
                            "SELECT legal_hold,expires_at FROM media_artifacts "
                                    + "WHERE tenant_id=? AND artifact_id=?")) {
                        recheck.setString(1, tenantId); recheck.setString(2, node.artifactId());
                        try (ResultSet result = recheck.executeQuery()) {
                            if (!result.next()) continue;
                            locked.add(new ArtifactNode(node.artifactId(), objectKey,
                                    result.getBoolean(1), result.getLong(2)));
                        }
                    }
                }
                ArtifactNode lockedRoot = locked.stream()
                        .filter(node -> node.artifactId().equals(rootArtifactId)).findFirst().orElse(null);
                if (lockedRoot == null || lockedRoot.legalHold()
                        || requireExpiredRoot && lockedRoot.expiresAt() > now
                        || locked.stream().anyMatch(ArtifactNode::legalHold)) {
                    connection.commit();
                    return 0;
                }
                for (ArtifactNode node : locked) deleteObject(node.objectKey());
                reverse = new ArrayList<>(locked);
                java.util.Collections.reverse(reverse);
                for (ArtifactNode node : locked) {
                    try (PreparedStatement transcripts = connection.prepareStatement(
                            "DELETE FROM media_transcript_revisions WHERE tenant_id=? AND source_artifact_id=?")) {
                        transcripts.setString(1, tenantId); transcripts.setString(2, node.artifactId());
                        transcripts.executeUpdate();
                    }
                    try (PreparedStatement lineage = connection.prepareStatement(
                            "DELETE FROM media_artifact_lineage WHERE tenant_id=? "
                                    + "AND (source_artifact_id=? OR derived_artifact_id=?)")) {
                        lineage.setString(1, tenantId); lineage.setString(2, node.artifactId());
                        lineage.setString(3, node.artifactId()); lineage.executeUpdate();
                    }
                }
                int removed = 0;
                for (ArtifactNode node : reverse) {
                    try (PreparedStatement artifact = connection.prepareStatement(
                            "DELETE FROM media_artifacts WHERE tenant_id=? AND artifact_id=? AND legal_hold=FALSE"
                                    + (node.artifactId().equals(rootArtifactId) && requireExpiredRoot
                                            ? " AND expires_at<=?" : ""))) {
                        artifact.setString(1, tenantId); artifact.setString(2, node.artifactId());
                        if (node.artifactId().equals(rootArtifactId) && requireExpiredRoot) artifact.setLong(3, now);
                        removed += artifact.executeUpdate();
                    }
                }
                connection.commit();
                return removed;
            } catch (SQLException failure) {
                try { connection.rollback(); } catch (SQLException rollbackFailure) { failure.addSuppressed(rollbackFailure); }
                throw failure;
            }
        } catch (SQLException failure) {
            throw databaseFailure("purge expired Media artifact lineage", failure);
        }
    }

    private void collectArtifactTree(String tenantId, String artifactId, Map<String, ArtifactNode> tree) {
        if (tree.containsKey(artifactId)) return;
        try (Connection connection = state.connection(); PreparedStatement artifact = connection.prepareStatement(
                "SELECT object_reference,legal_hold,expires_at FROM media_artifacts WHERE tenant_id=? AND artifact_id=?")) {
            artifact.setString(1, tenantId); artifact.setString(2, artifactId);
            try (ResultSet result = artifact.executeQuery()) {
                if (!result.next()) return;
                tree.put(artifactId, new ArtifactNode(artifactId, objectKey(result.getString(1)),
                        result.getBoolean(2), result.getLong(3)));
            }
            try (PreparedStatement children = connection.prepareStatement(
                    "SELECT derived_artifact_id FROM media_artifact_lineage WHERE tenant_id=? AND source_artifact_id=?")) {
                children.setString(1, tenantId); children.setString(2, artifactId);
                try (ResultSet rows = children.executeQuery()) {
                    List<String> ids = new ArrayList<>();
                    while (rows.next()) ids.add(rows.getString(1));
                    for (String child : ids) collectArtifactTree(tenantId, child, tree);
                }
            }
        } catch (SQLException failure) {
            throw databaseFailure("read derived Media artifact lineage", failure);
        }
    }

    private UploadPurge purgeUploads(Instant now) {
        List<UploadDelete> expired = new ArrayList<>();
        long staleFinalizingBefore = now.minus(STALE_FINALIZATION_GRACE).toEpochMilli();
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT tenant_id,upload_id FROM media_upload_sessions "
                             + "WHERE expires_at<=? AND (status<>'FINALIZING' OR finalization_started_at<=?) "
                             + "ORDER BY expires_at LIMIT ?")) {
            statement.setLong(1, now.toEpochMilli());
            statement.setLong(2, staleFinalizingBefore);
            statement.setInt(3, batchSize);
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    expired.add(new UploadDelete(result.getString("tenant_id"), result.getString("upload_id")));
                }
            }
        } catch (SQLException failure) {
            throw databaseFailure("read expired Media uploads", failure);
        }

        int uploadsDeleted = 0;
        int chunksDeleted = 0;
        for (UploadDelete upload : expired) {
            try (Connection connection = state.connection()) {
                try {
                    connection.setAutoCommit(false);
                    long expiresAt;
                    String status;
                    Long finalizationStartedAt;
                    try (PreparedStatement lock = connection.prepareStatement(
                            "SELECT expires_at,status,finalization_started_at FROM media_upload_sessions "
                                    + "WHERE tenant_id=? AND upload_id=? FOR UPDATE")) {
                        lock.setString(1, upload.tenantId());
                        lock.setString(2, upload.uploadId());
                        try (ResultSet result = lock.executeQuery()) {
                            if (!result.next()) {
                                connection.commit();
                                continue;
                            }
                            expiresAt = result.getLong("expires_at");
                            status = result.getString("status");
                            finalizationStartedAt = result.getObject("finalization_started_at") == null
                                    ? null : result.getLong("finalization_started_at");
                        }
                    }
                    boolean staleFinalization = "FINALIZING".equals(status)
                            && finalizationStartedAt != null
                            && finalizationStartedAt <= staleFinalizingBefore;
                    if (expiresAt > now.toEpochMilli()
                            || ("FINALIZING".equals(status) && !staleFinalization)) {
                        connection.commit();
                        continue;
                    }

                    // The row lock fences append/finalization while chunk objects and their
                    // metadata are removed. Renewal or active finalization that wins first is
                    // rechecked above and leaves all chunk bytes intact.
                    List<String> objectKeys = uploadChunkKeys(connection, upload);
                    for (String key : objectKeys) deleteObject(key);
                    int removedChunks;
                    try (PreparedStatement chunks = connection.prepareStatement(
                            "DELETE FROM media_upload_chunks WHERE tenant_id=? AND upload_id=?")) {
                        chunks.setString(1, upload.tenantId());
                        chunks.setString(2, upload.uploadId());
                        removedChunks = chunks.executeUpdate();
                    }
                    int removedUpload;
                    try (PreparedStatement remove = connection.prepareStatement(
                            "DELETE FROM media_upload_sessions WHERE tenant_id=? AND upload_id=? "
                                    + "AND expires_at<=? "
                                    + "AND (status<>'FINALIZING' OR finalization_started_at<=?)")) {
                        remove.setString(1, upload.tenantId());
                        remove.setString(2, upload.uploadId());
                        remove.setLong(3, now.toEpochMilli());
                        remove.setLong(4, staleFinalizingBefore);
                        removedUpload = remove.executeUpdate();
                    }
                    connection.commit();
                    chunksDeleted += removedChunks;
                    uploadsDeleted += removedUpload;
                } catch (SQLException | RuntimeException failure) {
                    try { connection.rollback(); } catch (SQLException rollbackFailure) { failure.addSuppressed(rollbackFailure); }
                    throw failure;
                }
            } catch (SQLException failure) {
                throw databaseFailure("delete expired Media upload", failure);
            }
        }
        return new UploadPurge(uploadsDeleted, chunksDeleted);
    }

    private List<String> uploadChunkKeys(Connection connection, UploadDelete upload) {
        List<String> keys = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement(
                     "SELECT object_key FROM media_upload_chunks WHERE tenant_id=? AND upload_id=? ORDER BY chunk_index")) {
            statement.setString(1, upload.tenantId());
            statement.setString(2, upload.uploadId());
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) keys.add(result.getString("object_key"));
            }
            return List.copyOf(keys);
        } catch (SQLException failure) {
            throw databaseFailure("read expired Media upload chunks", failure);
        }
    }

    private int purgeJobs(Instant completedBefore) {
        // Preserve OUTCOME_UNKNOWN rows because their request identity still fences replay.
        List<JobDelete> candidates = new ArrayList<>();
        try (Connection connection = state.connection(); PreparedStatement jobs = connection.prepareStatement(
                "SELECT tenant_id,job_id FROM media_processing_jobs WHERE status IN ('COMPLETED','FAILED','CANCELLED') "
                        + "AND completed_at IS NOT NULL AND completed_at<=?")) {
            jobs.setLong(1, completedBefore.toEpochMilli());
            try (ResultSet rows = jobs.executeQuery()) {
                while (rows.next()) candidates.add(new JobDelete(rows.getString(1), rows.getString(2)));
            }
        } catch (SQLException failure) {
            throw databaseFailure("purge terminal Media jobs", failure);
        }
        int deleted = 0;
        for (JobDelete job : candidates) {
            List<String> derivedRoots = new ArrayList<>();
            try (Connection connection = state.connection(); PreparedStatement lineage = connection.prepareStatement(
                    "SELECT derived_artifact_id FROM media_artifact_lineage WHERE tenant_id=? AND job_id=?")) {
                lineage.setString(1, job.tenantId()); lineage.setString(2, job.jobId());
                try (ResultSet rows = lineage.executeQuery()) {
                    while (rows.next()) derivedRoots.add(rows.getString(1));
                }
            } catch (SQLException failure) {
                throw databaseFailure("read job-derived Media artifacts", failure);
            }
            for (String derived : derivedRoots) purgeArtifactTree(job.tenantId(), derived, Long.MAX_VALUE, false);
            try (Connection connection = state.connection()) {
                connection.setAutoCommit(false);
                try {
                    // A legal-held derived artifact preserves its job/lineage until the hold is released.
                    try (PreparedStatement check = connection.prepareStatement(
                            "SELECT 1 FROM media_artifact_lineage WHERE tenant_id=? AND job_id=?")) {
                        check.setString(1, job.tenantId()); check.setString(2, job.jobId());
                        try (ResultSet row = check.executeQuery()) {
                            if (row.next()) { connection.rollback(); continue; }
                        }
                    }
                    try (PreparedStatement transcripts = connection.prepareStatement(
                            "DELETE FROM media_transcript_revisions WHERE tenant_id=? AND job_id=?");
                         PreparedStatement lineage = connection.prepareStatement(
                                 "DELETE FROM media_artifact_lineage WHERE tenant_id=? AND job_id=?");
                         PreparedStatement attempts = connection.prepareStatement(
                                 "DELETE FROM media_processing_attempts WHERE tenant_id=? AND job_id=?");
                         PreparedStatement delete = connection.prepareStatement(
                                 "DELETE FROM media_processing_jobs WHERE tenant_id=? AND job_id=? "
                                         + "AND status IN ('COMPLETED','FAILED','CANCELLED') AND completed_at<=?")) {
                        transcripts.setString(1, job.tenantId()); transcripts.setString(2, job.jobId());
                        transcripts.executeUpdate();
                        lineage.setString(1, job.tenantId()); lineage.setString(2, job.jobId());
                        lineage.executeUpdate();
                        attempts.setString(1, job.tenantId()); attempts.setString(2, job.jobId());
                        attempts.executeUpdate();
                        delete.setString(1, job.tenantId()); delete.setString(2, job.jobId());
                        delete.setLong(3, completedBefore.toEpochMilli()); deleted += delete.executeUpdate();
                    }
                    connection.commit();
                } catch (SQLException failure) {
                    try { connection.rollback(); } catch (SQLException rollbackFailure) { failure.addSuppressed(rollbackFailure); }
                    throw failure;
                }
            } catch (SQLException failure) {
                throw databaseFailure("purge terminal Media job children", failure);
            }
        }
        return deleted;
    }

    private int purgeStreams(Instant closedBefore) {
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "DELETE FROM media_stream_sessions WHERE state IN ('CLOSED','FAILED') "
                             + "AND closed_at IS NOT NULL AND closed_at<=?")) {
            statement.setLong(1, closedBefore.toEpochMilli());
            return statement.executeUpdate();
        } catch (SQLException failure) {
            throw databaseFailure("purge terminal Media stream sessions", failure);
        }
    }

    private void deleteObject(String objectKey) {
        if (objectKey == null || objectKey.isBlank()) return;
        state.s3().deleteObject(DeleteObjectRequest.builder()
                .bucket(state.bucket())
                .key(objectKey)
                .build());
    }

    private String objectKey(String objectReference) {
        URI reference = URI.create(objectReference);
        if (!"s3".equalsIgnoreCase(reference.getScheme())
                || reference.getHost() == null
                || !state.bucket().equals(reference.getHost())) {
            throw new IllegalStateException("Media artifact object reference is outside the configured S3 bucket");
        }
        String path = reference.getPath();
        if (path == null || path.isBlank() || "/".equals(path)) {
            throw new IllegalStateException("Media artifact object reference has no object key");
        }
        return path.startsWith("/") ? path.substring(1) : path;
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("Media privacy maintenance is closed");
        if (!state.ready()) throw new IllegalStateException("Media privacy maintenance state is unavailable");
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }

    private static int integer(Map<String, String> environment, String key, int fallback, int min, int max) {
        try {
            int value = Integer.parseInt(environment.getOrDefault(key, Integer.toString(fallback)).trim());
            if (value < min || value > max) throw new IllegalArgumentException(key + " must be between " + min + " and " + max);
            return value;
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException(key + " must be an integer", failure);
        }
    }

    private static Duration durationDays(
            Map<String, String> environment, String key, Duration fallback, int minDays, int maxDays) {
        String raw = environment.get(key);
        if (raw == null || raw.isBlank()) return fallback;
        try {
            int days = Integer.parseInt(raw.trim());
            if (days < minDays || days > maxDays) {
                throw new IllegalArgumentException(key + " must be between " + minDays + " and " + maxDays + " days");
            }
            return Duration.ofDays(days);
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException(key + " must be an integer number of days", failure);
        }
    }

    private static IllegalStateException databaseFailure(String operation, SQLException failure) {
        return new IllegalStateException("Unable to " + operation, failure);
    }

    private record ArtifactDelete(String tenantId, String artifactId) { }
    private record ArtifactNode(String artifactId, String objectKey, boolean legalHold, long expiresAt) { }
    private record JobDelete(String tenantId, String jobId) { }
    private record UploadDelete(String tenantId, String uploadId) { }
    private record UploadPurge(int uploads, int chunks) { }
}
