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
                     "SELECT tenant_id,artifact_id,object_reference FROM media_artifacts "
                             + "WHERE expires_at<=? ORDER BY expires_at LIMIT ?")) {
            statement.setLong(1, now.toEpochMilli());
            statement.setInt(2, batchSize);
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    expired.add(new ArtifactDelete(
                            result.getString("tenant_id"),
                            result.getString("artifact_id"),
                            objectKey(result.getString("object_reference"))));
                }
            }
        } catch (SQLException failure) {
            throw databaseFailure("read expired Media artifacts", failure);
        }

        int deleted = 0;
        for (ArtifactDelete artifact : expired) {
            deleteObject(artifact.objectKey());
            try (Connection connection = state.connection();
                 PreparedStatement statement = connection.prepareStatement(
                         "DELETE FROM media_artifacts WHERE tenant_id=? AND artifact_id=? AND expires_at<=?")) {
                statement.setString(1, artifact.tenantId());
                statement.setString(2, artifact.artifactId());
                statement.setLong(3, now.toEpochMilli());
                deleted += statement.executeUpdate();
            } catch (SQLException failure) {
                throw databaseFailure("delete expired Media artifact metadata", failure);
            }
        }
        return deleted;
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
            List<String> objectKeys = uploadChunkKeys(upload);
            for (String key : objectKeys) deleteObject(key);
            try (Connection connection = state.connection()) {
                connection.setAutoCommit(false);
                try (PreparedStatement chunks = connection.prepareStatement(
                             "DELETE FROM media_upload_chunks WHERE tenant_id=? AND upload_id=?");
                     PreparedStatement uploads = connection.prepareStatement(
                             "DELETE FROM media_upload_sessions WHERE tenant_id=? AND upload_id=? AND expires_at<=?")) {
                    chunks.setString(1, upload.tenantId());
                    chunks.setString(2, upload.uploadId());
                    int removedChunks = chunks.executeUpdate();
                    uploads.setString(1, upload.tenantId());
                    uploads.setString(2, upload.uploadId());
                    uploads.setLong(3, now.toEpochMilli());
                    int removedUpload = uploads.executeUpdate();
                    connection.commit();
                    chunksDeleted += removedChunks;
                    uploadsDeleted += removedUpload;
                } catch (SQLException failure) {
                    try { connection.rollback(); } catch (SQLException rollbackFailure) { failure.addSuppressed(rollbackFailure); }
                    throw failure;
                }
            } catch (SQLException failure) {
                throw databaseFailure("delete expired Media upload", failure);
            }
        }
        return new UploadPurge(uploadsDeleted, chunksDeleted);
    }

    private List<String> uploadChunkKeys(UploadDelete upload) {
        List<String> keys = new ArrayList<>();
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
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
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "DELETE FROM media_processing_jobs WHERE status IN ('COMPLETED','FAILED','CANCELLED') "
                             + "AND completed_at IS NOT NULL AND completed_at<=?")) {
            statement.setLong(1, completedBefore.toEpochMilli());
            return statement.executeUpdate();
        } catch (SQLException failure) {
            throw databaseFailure("purge terminal Media jobs", failure);
        }
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

    private record ArtifactDelete(String tenantId, String artifactId, String objectKey) { }
    private record UploadDelete(String tenantId, String uploadId) { }
    private record UploadPurge(int uploads, int chunks) { }
}
