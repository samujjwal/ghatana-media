package com.ghatana.media.provider.aws;

import tools.jackson.core.type.TypeReference;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus;
import software.amazon.awssdk.core.ResponseBytes;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.model.AbortMultipartUploadRequest;
import software.amazon.awssdk.services.s3.model.CompleteMultipartUploadRequest;
import software.amazon.awssdk.services.s3.model.CompletedMultipartUpload;
import software.amazon.awssdk.services.s3.model.CompletedPart;
import software.amazon.awssdk.services.s3.model.CreateMultipartUploadRequest;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.ServerSideEncryption;
import software.amazon.awssdk.services.s3.model.UploadPartRequest;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Savepoint;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Durable resumable Media artifact store using PostgreSQL metadata and S3 bytes.
 *
 * @doc.type class
 * @doc.purpose Provide S3 Postgresql Media Artifact Store behavior
 * @doc.layer product
 * @doc.pattern Repository
 */
public final class S3PostgresqlMediaArtifactStore implements MediaArtifactStore {
    private static final int MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
    private static final long FINALIZATION_STALE_MILLIS = Duration.ofMinutes(15).toMillis();
    private static final long DEDUP_RETENTION_TOLERANCE_MILLIS = Duration.ofMinutes(1).toMillis();

    private final MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
    private final AtomicBoolean closed = new AtomicBoolean(false);

    @Override public String storeId() { return "s3-postgresql"; }

    @Override
    public UploadSession begin(UploadRequest request) {
        ensureOpen();
        java.util.Objects.requireNonNull(request, "request");
        String uploadId = UUID.randomUUID().toString();
        Instant now = Instant.now();
        Instant expiresAt = now.plus(Duration.ofHours(1));
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "INSERT INTO media_upload_sessions "
                             + "(tenant_id,upload_id,principal_id,file_name,content_type,expected_size_bytes,expected_sha256,"
                             + "classification,retention_millis,created_at,expires_at,bytes_received,next_chunk_index,"
                             + "status,metadata_json,artifact_id,updated_at,finalization_token,finalization_started_at) "
                             + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")) {
            statement.setString(1, request.tenantId());
            statement.setString(2, uploadId);
            statement.setString(3, request.principalId());
            statement.setString(4, safeFileName(request.fileName()));
            statement.setString(5, request.contentType());
            statement.setLong(6, request.expectedSizeBytes());
            statement.setString(7, request.expectedSha256());
            statement.setString(8, request.classification());
            statement.setLong(9, request.retention().toMillis());
            statement.setLong(10, now.toEpochMilli());
            statement.setLong(11, expiresAt.toEpochMilli());
            statement.setLong(12, 0L);
            statement.setInt(13, 0);
            statement.setString(14, UploadStatus.OPEN.name());
            statement.setString(15, json(request.metadata()));
            statement.setNull(16, java.sql.Types.VARCHAR);
            statement.setLong(17, now.toEpochMilli());
            statement.setNull(18, java.sql.Types.VARCHAR);
            statement.setNull(19, java.sql.Types.BIGINT);
            statement.executeUpdate();
            return new UploadSession(
                    uploadId, request.tenantId(), request.principalId(), safeFileName(request.fileName()), request.contentType(),
                    request.expectedSizeBytes(), request.expectedSha256(), request.classification(),
                    now, expiresAt, 0L, 0, UploadStatus.OPEN, request.metadata());
        } catch (SQLException failure) {
            throw databaseFailure("begin Media upload", failure);
        }
    }

    @Override
    public UploadSession append(String tenantId, String uploadId, int chunkIndex, byte[] bytes) {
        ensureOpen();
        require(tenantId, "tenantId");
        require(uploadId, "uploadId");
        if (chunkIndex < 0) throw new IllegalArgumentException("chunkIndex must not be negative");
        if (bytes == null || bytes.length == 0) throw new IllegalArgumentException("chunk bytes are required");
        String digest = sha256(bytes);
        String objectKey = chunkKey(tenantId, uploadId, chunkIndex);
        boolean objectWritten = false;

        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                UploadRow current = lockUpload(connection, tenantId, uploadId);
                if (current == null || current.status() != UploadStatus.OPEN) {
                    throw new IllegalArgumentException("Open upload session not found");
                }
                if (current.expiresAt() <= System.currentTimeMillis()) {
                    markStatus(connection, tenantId, uploadId, UploadStatus.EXPIRED);
                    connection.commit();
                    throw new IllegalStateException("Upload session expired");
                }
                ChunkRow existing = chunk(connection, tenantId, uploadId, chunkIndex);
                if (existing != null) {
                    if (existing.sizeBytes() != bytes.length || !existing.sha256().equals(digest)) {
                        throw new IllegalStateException("Upload chunk index already exists with different content");
                    }
                    connection.commit();
                    return current.session();
                }
                if (chunkIndex != current.nextChunkIndex()) {
                    throw new IllegalArgumentException("Expected chunk index " + current.nextChunkIndex());
                }
                long total = Math.addExact(current.bytesReceived(), bytes.length);
                if (total > current.expectedSizeBytes()) {
                    throw new IllegalArgumentException("Upload exceeds expected size");
                }

                state.s3().putObject(PutObjectRequest.builder()
                                .bucket(state.bucket())
                                .key(objectKey)
                                .contentLength((long) bytes.length)
                                .serverSideEncryption(ServerSideEncryption.AES256)
                                .metadata(Map.of("sha256", digest))
                                .build(),
                        RequestBody.fromBytes(bytes));
                objectWritten = true;

                try (PreparedStatement insert = connection.prepareStatement(
                        "INSERT INTO media_upload_chunks "
                                + "(tenant_id,upload_id,chunk_index,object_key,size_bytes,sha256,created_at) "
                                + "VALUES (?,?,?,?,?,?,?)")) {
                    insert.setString(1, tenantId);
                    insert.setString(2, uploadId);
                    insert.setInt(3, chunkIndex);
                    insert.setString(4, objectKey);
                    insert.setLong(5, bytes.length);
                    insert.setString(6, digest);
                    insert.setLong(7, System.currentTimeMillis());
                    insert.executeUpdate();
                }
                try (PreparedStatement update = connection.prepareStatement(
                        "UPDATE media_upload_sessions SET bytes_received=?,next_chunk_index=?,updated_at=? "
                                + "WHERE tenant_id=? AND upload_id=? AND status='OPEN'")) {
                    update.setLong(1, total);
                    update.setInt(2, chunkIndex + 1);
                    update.setLong(3, System.currentTimeMillis());
                    update.setString(4, tenantId);
                    update.setString(5, uploadId);
                    if (update.executeUpdate() != 1) {
                        throw new IllegalStateException("Media upload changed concurrently");
                    }
                }
                connection.commit();
                objectWritten = false;
                return current.withProgress(total, chunkIndex + 1).session();
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (objectWritten) {
                    Optional<UploadSession> reconciled = reconcileFailedChunkWrite(
                            tenantId, uploadId, chunkIndex, objectKey, bytes.length, digest, failure);
                    if (reconciled.isPresent()) return reconciled.orElseThrow();
                }
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("append Media upload chunk", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open Media upload transaction", failure);
        }
    }

    @Override
    public MediaArtifact complete(String tenantId, String uploadId) {
        ensureOpen();
        FinalizationClaim claim = claimFinalization(tenantId, uploadId);
        if (claim.existingArtifact() != null) return claim.existingArtifact();

        String finalKey = artifactKey(tenantId, claim.row().expectedSha256());
        String multipartId = null;
        try {
            var create = state.s3().createMultipartUpload(CreateMultipartUploadRequest.builder()
                    .bucket(state.bucket())
                    .key(finalKey)
                    .contentType(claim.row().contentType())
                    .serverSideEncryption(ServerSideEncryption.AES256)
                    .metadata(Map.of(
                            "sha256", claim.row().expectedSha256(),
                            "classification", claim.row().classification()))
                    .build());
            multipartId = create.uploadId();
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            List<CompletedPart> completedParts = new ArrayList<>();
            ByteArrayOutputStream partBuffer = new ByteArrayOutputStream(MIN_MULTIPART_PART_BYTES * 2);
            long totalBytes = 0L;
            int partNumber = 1;
            List<ChunkRow> chunks = chunks(tenantId, uploadId);
            if (chunks.isEmpty()) throw new IllegalStateException("Upload has no chunks");
            for (ChunkRow chunk : chunks) {
                ResponseBytes<GetObjectResponse> object = state.s3().getObjectAsBytes(GetObjectRequest.builder()
                        .bucket(state.bucket()).key(chunk.objectKey()).build());
                byte[] data = object.asByteArray();
                if (data.length != chunk.sizeBytes() || !sha256(data).equals(chunk.sha256())) {
                    throw new IllegalStateException("Stored upload chunk failed integrity verification");
                }
                digest.update(data);
                totalBytes = Math.addExact(totalBytes, data.length);
                partBuffer.write(data);
                if (partBuffer.size() >= MIN_MULTIPART_PART_BYTES) {
                    completedParts.add(uploadPart(finalKey, multipartId, partNumber++, partBuffer.toByteArray()));
                    partBuffer.reset();
                }
            }
            if (partBuffer.size() > 0) {
                completedParts.add(uploadPart(finalKey, multipartId, partNumber, partBuffer.toByteArray()));
            }
            String actualDigest = HexFormat.of().formatHex(digest.digest());
            if (totalBytes != claim.row().expectedSizeBytes()) {
                throw new IllegalStateException("Upload size does not match expected size");
            }
            if (!actualDigest.equals(claim.row().expectedSha256())) {
                markAborted(tenantId, uploadId, claim.token());
                throw new IllegalStateException("Upload checksum does not match expected SHA-256");
            }
            state.s3().completeMultipartUpload(CompleteMultipartUploadRequest.builder()
                    .bucket(state.bucket())
                    .key(finalKey)
                    .uploadId(multipartId)
                    .multipartUpload(CompletedMultipartUpload.builder().parts(completedParts).build())
                    .build());
            MediaArtifact artifact = persistArtifact(claim, finalKey, totalBytes, actualDigest);
            deleteChunks(chunks);
            return artifact;
        } catch (RuntimeException failure) {
            if (multipartId != null) {
                try {
                    state.s3().abortMultipartUpload(AbortMultipartUploadRequest.builder()
                            .bucket(state.bucket()).key(finalKey).uploadId(multipartId).build());
                } catch (RuntimeException abortFailure) {
                    failure.addSuppressed(abortFailure);
                }
            }
            releaseFinalization(tenantId, uploadId, claim.token());
            throw failure;
        } catch (Exception failure) {
            RuntimeException wrapped = new IllegalStateException("Unable to finalize Media upload", failure);
            if (multipartId != null) {
                try {
                    state.s3().abortMultipartUpload(AbortMultipartUploadRequest.builder()
                            .bucket(state.bucket()).key(finalKey).uploadId(multipartId).build());
                } catch (RuntimeException abortFailure) {
                    wrapped.addSuppressed(abortFailure);
                }
            }
            releaseFinalization(tenantId, uploadId, claim.token());
            throw wrapped;
        }
    }

    @Override
    public Optional<UploadSession> upload(String tenantId, String uploadId) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            UploadRow row = readUpload(connection, tenantId, uploadId, false);
            return row == null ? Optional.empty() : Optional.of(row.session());
        } catch (SQLException failure) {
            throw databaseFailure("read Media upload", failure);
        }
    }

    @Override
    public Optional<MediaArtifact> artifact(String tenantId, String artifactId) {
        ensureOpen();
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT principal_id,file_name,content_type,size_bytes,sha256,object_reference,classification,"
                             + "created_at,expires_at,metadata_json FROM media_artifacts "
                             + "WHERE tenant_id=? AND artifact_id=? AND expires_at>?")) {
            statement.setString(1, tenantId);
            statement.setString(2, artifactId);
            statement.setLong(3, System.currentTimeMillis());
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? Optional.of(readArtifact(tenantId, artifactId, result)) : Optional.empty();
            }
        } catch (SQLException failure) {
            throw databaseFailure("read Media artifact", failure);
        }
    }

    @Override public boolean durable() { return true; }
    @Override public boolean productionEligible() { return state.productionEligible(); }
    @Override public boolean ready() { return !closed.get() && state.ready(); }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }

    private Optional<UploadSession> reconcileFailedChunkWrite(
            String tenantId,
            String uploadId,
            int chunkIndex,
            String objectKey,
            long sizeBytes,
            String digest,
            Exception primaryFailure) {
        try (Connection connection = state.connection()) {
            ChunkRow persisted = chunk(connection, tenantId, uploadId, chunkIndex);
            UploadRow upload = readUpload(connection, tenantId, uploadId, false);
            if (persisted != null) {
                boolean identityMatches = objectKey.equals(persisted.objectKey())
                        && sizeBytes == persisted.sizeBytes()
                        && digest.equals(persisted.sha256());
                boolean progressMatches = upload != null
                        && upload.nextChunkIndex() >= chunkIndex + 1;
                if (identityMatches && progressMatches) {
                    return Optional.of(upload.session());
                }
                primaryFailure.addSuppressed(new IllegalStateException(
                        "Media chunk write outcome is inconsistent after database failure"));
                return Optional.empty();
            }
            if (upload != null && upload.nextChunkIndex() > chunkIndex) {
                primaryFailure.addSuppressed(new IllegalStateException(
                        "Media upload progress advanced without persisted chunk metadata"));
                return Optional.empty();
            }
        } catch (SQLException | RuntimeException reconciliationFailure) {
            primaryFailure.addSuppressed(new IllegalStateException(
                    "Unable to reconcile Media chunk ownership after database failure",
                    reconciliationFailure));
            return Optional.empty();
        }

        try {
            state.s3().deleteObject(DeleteObjectRequest.builder()
                    .bucket(state.bucket())
                    .key(objectKey)
                    .build());
        } catch (RuntimeException cleanupFailure) {
            primaryFailure.addSuppressed(new IllegalStateException(
                    "Unable to remove unowned Media chunk after database rollback",
                    cleanupFailure));
        }
        return Optional.empty();
    }

    private FinalizationClaim claimFinalization(String tenantId, String uploadId) {
        String token = UUID.randomUUID().toString();
        long now = System.currentTimeMillis();
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                UploadRow row = lockUpload(connection, tenantId, uploadId);
                if (row == null) throw new IllegalArgumentException("Upload session not found");
                if (row.status() == UploadStatus.COMPLETED && row.artifactId() != null) {
                    MediaArtifact artifact = artifactForUpdate(connection, tenantId, row.artifactId());
                    connection.commit();
                    return new FinalizationClaim(row, token, artifact);
                }
                boolean stale = row.status() == UploadStatus.FINALIZING
                        && row.finalizationStartedAt() != null
                        && row.finalizationStartedAt() < now - FINALIZATION_STALE_MILLIS;
                if (row.status() != UploadStatus.OPEN && !stale) {
                    throw new IllegalStateException("Upload is not available for finalization: " + row.status());
                }
                if (row.expiresAt() <= now) {
                    markStatus(connection, tenantId, uploadId, UploadStatus.EXPIRED);
                    connection.commit();
                    throw new IllegalStateException("Upload session expired");
                }
                if (row.bytesReceived() != row.expectedSizeBytes()) {
                    throw new IllegalStateException("Upload size does not match expected size");
                }
                try (PreparedStatement update = connection.prepareStatement(
                        "UPDATE media_upload_sessions SET status='FINALIZING',finalization_token=?,"
                                + "finalization_started_at=?,updated_at=? WHERE tenant_id=? AND upload_id=?")) {
                    update.setString(1, token);
                    update.setLong(2, now);
                    update.setLong(3, now);
                    update.setString(4, tenantId);
                    update.setString(5, uploadId);
                    update.executeUpdate();
                }
                connection.commit();
                return new FinalizationClaim(row, token, null);
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("claim Media upload finalization", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open Media finalization transaction", failure);
        }
    }

    private MediaArtifact persistArtifact(
            FinalizationClaim claim, String finalKey, long totalBytes, String digest) {
        String tenantId = claim.row().tenantId();
        String uploadId = claim.row().uploadId();
        long now = System.currentTimeMillis();
        long expiresAt = Math.addExact(now, claim.row().retentionMillis());
        String reference = "s3://" + state.bucket() + "/" + finalKey;
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                UploadRow current = lockUpload(connection, tenantId, uploadId);
                if (current == null || current.status() != UploadStatus.FINALIZING
                        || !claim.token().equals(current.finalizationToken())) {
                    throw new IllegalStateException("Media upload finalization ownership changed");
                }
                MediaArtifact artifact = resolveOrInsertArtifact(
                        connection, current, reference, totalBytes, digest, now, expiresAt);
                try (PreparedStatement update = connection.prepareStatement(
                        "UPDATE media_upload_sessions SET status='COMPLETED',artifact_id=?,updated_at=?,"
                                + "finalization_token=NULL,finalization_started_at=NULL "
                                + "WHERE tenant_id=? AND upload_id=? AND finalization_token=?")) {
                    update.setString(1, artifact.artifactId());
                    update.setLong(2, now);
                    update.setString(3, tenantId);
                    update.setString(4, uploadId);
                    update.setString(5, claim.token());
                    if (update.executeUpdate() != 1) {
                        throw new IllegalStateException("Media upload finalization ownership changed");
                    }
                }
                connection.commit();
                return artifact;
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("persist Media artifact", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open Media artifact transaction", failure);
        }
    }

    private MediaArtifact resolveOrInsertArtifact(
            Connection connection,
            UploadRow current,
            String reference,
            long totalBytes,
            String digest,
            long now,
            long expiresAt) throws SQLException {
        MediaArtifact existing = artifactByHash(
                connection, current.tenantId(), digest, totalBytes, current, expiresAt);
        if (existing != null) return existing;

        MediaArtifact candidate = new MediaArtifact(
                current.tenantId(), current.principalId(), UUID.randomUUID().toString(), current.fileName(), current.contentType(),
                totalBytes, digest, reference, current.classification(), Instant.ofEpochMilli(now),
                Instant.ofEpochMilli(expiresAt), current.metadata());
        Savepoint deduplicationSavepoint = connection.setSavepoint("media_artifact_deduplication");
        try {
            insertArtifact(connection, candidate);
            return candidate;
        } catch (SQLException failure) {
            if (!duplicateKey(failure)) throw failure;
            connection.rollback(deduplicationSavepoint);
            MediaArtifact concurrent = artifactByHash(
                    connection, current.tenantId(), digest, totalBytes, current, expiresAt);
            if (concurrent == null) throw failure;
            return concurrent;
        }
    }

    private CompletedPart uploadPart(String key, String uploadId, int partNumber, byte[] bytes) {
        var response = state.s3().uploadPart(UploadPartRequest.builder()
                        .bucket(state.bucket()).key(key).uploadId(uploadId).partNumber(partNumber)
                        .contentLength((long) bytes.length).build(),
                RequestBody.fromBytes(bytes));
        return CompletedPart.builder().partNumber(partNumber).eTag(response.eTag()).build();
    }

    private List<ChunkRow> chunks(String tenantId, String uploadId) {
        List<ChunkRow> values = new ArrayList<>();
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT chunk_index,object_key,size_bytes,sha256 FROM media_upload_chunks "
                             + "WHERE tenant_id=? AND upload_id=? ORDER BY chunk_index")) {
            statement.setString(1, tenantId);
            statement.setString(2, uploadId);
            try (ResultSet result = statement.executeQuery()) {
                int expected = 0;
                while (result.next()) {
                    int index = result.getInt(1);
                    if (index != expected++) throw new IllegalStateException("Media upload chunk manifest is not contiguous");
                    values.add(new ChunkRow(index, result.getString(2), result.getLong(3), result.getString(4)));
                }
            }
            return List.copyOf(values);
        } catch (SQLException failure) {
            throw databaseFailure("read Media upload chunks", failure);
        }
    }

    private void deleteChunks(List<ChunkRow> chunks) {
        for (ChunkRow chunk : chunks) {
            try {
                state.s3().deleteObject(DeleteObjectRequest.builder()
                        .bucket(state.bucket()).key(chunk.objectKey()).build());
            } catch (RuntimeException ignored) {
                // Final artifact and metadata are already durable; lifecycle cleanup may retry orphan removal.
            }
        }
    }

    private UploadRow lockUpload(Connection connection, String tenantId, String uploadId) throws SQLException {
        return readUpload(connection, tenantId, uploadId, true);
    }

    private UploadRow readUpload(Connection connection, String tenantId, String uploadId, boolean lock)
            throws SQLException {
        String sql = "SELECT principal_id,file_name,content_type,expected_size_bytes,expected_sha256,classification,"
                + "retention_millis,created_at,expires_at,bytes_received,next_chunk_index,status,metadata_json,"
                + "artifact_id,finalization_token,finalization_started_at FROM media_upload_sessions "
                + "WHERE tenant_id=? AND upload_id=?" + (lock ? " FOR UPDATE" : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, tenantId);
            statement.setString(2, uploadId);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) return null;
                Long finalizationStarted = result.getObject("finalization_started_at") == null
                        ? null : result.getLong("finalization_started_at");
                return new UploadRow(
                        tenantId, uploadId, result.getString("principal_id"), result.getString("file_name"), result.getString("content_type"),
                        result.getLong("expected_size_bytes"), result.getString("expected_sha256"),
                        result.getString("classification"), result.getLong("retention_millis"),
                        result.getLong("created_at"), result.getLong("expires_at"),
                        result.getLong("bytes_received"), result.getInt("next_chunk_index"),
                        UploadStatus.valueOf(result.getString("status")),
                        objectMap(result.getString("metadata_json")), result.getString("artifact_id"),
                        result.getString("finalization_token"), finalizationStarted);
            }
        }
    }

    private ChunkRow chunk(Connection connection, String tenantId, String uploadId, int index)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT object_key,size_bytes,sha256 FROM media_upload_chunks "
                        + "WHERE tenant_id=? AND upload_id=? AND chunk_index=?")) {
            statement.setString(1, tenantId);
            statement.setString(2, uploadId);
            statement.setInt(3, index);
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? new ChunkRow(index, result.getString(1), result.getLong(2), result.getString(3)) : null;
            }
        }
    }

    private void insertArtifact(Connection connection, MediaArtifact artifact) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "INSERT INTO media_artifacts "
                        + "(tenant_id,artifact_id,principal_id,file_name,content_type,size_bytes,sha256,object_reference,"
                        + "classification,created_at,expires_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")) {
            statement.setString(1, artifact.tenantId());
            statement.setString(2, artifact.artifactId());
            statement.setString(3, artifact.principalId());
            statement.setString(4, artifact.fileName());
            statement.setString(5, artifact.contentType());
            statement.setLong(6, artifact.sizeBytes());
            statement.setString(7, artifact.sha256());
            statement.setString(8, artifact.objectReference());
            statement.setString(9, artifact.classification());
            statement.setLong(10, artifact.createdAt().toEpochMilli());
            statement.setLong(11, artifact.expiresAt().toEpochMilli());
            statement.setString(12, json(artifact.metadata()));
            statement.executeUpdate();
        }
    }

    private MediaArtifact artifactByHash(
            Connection connection,
            String tenantId,
            String digest,
            long size,
            UploadRow requested,
            long requiredExpiresAt) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT artifact_id,file_name,content_type,object_reference,classification,created_at,expires_at,"
                        + "metadata_json FROM media_artifacts WHERE tenant_id=? AND principal_id=? AND sha256=? AND size_bytes=? FOR UPDATE")) {
            statement.setString(1, tenantId);
            statement.setString(2, requested.principalId());
            statement.setString(3, digest);
            statement.setLong(4, size);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) return null;
                MediaArtifact existing = new MediaArtifact(
                        tenantId, requested.principalId(), result.getString("artifact_id"), result.getString("file_name"),
                        result.getString("content_type"), size, digest, result.getString("object_reference"),
                        result.getString("classification"), Instant.ofEpochMilli(result.getLong("created_at")),
                        Instant.ofEpochMilli(result.getLong("expires_at")),
                        objectMap(result.getString("metadata_json")));
                List<String> conflicts = new ArrayList<>();
                if (!existing.fileName().equals(requested.fileName())) conflicts.add("fileName");
                if (!existing.contentType().equals(requested.contentType())) conflicts.add("contentType");
                if (!existing.classification().equals(requested.classification())) conflicts.add("classification");
                if (!existing.purpose().equals(requested.session().purpose())) conflicts.add("purpose");
                if (!existing.metadata().equals(requested.metadata())) conflicts.add("metadata");
                if (existing.expiresAt().toEpochMilli() + DEDUP_RETENTION_TOLERANCE_MILLIS
                        < requiredExpiresAt) conflicts.add("retention");
                if (!conflicts.isEmpty()) {
                    throw new IllegalStateException(
                            "Media artifact byte identity conflicts with governed metadata: "
                                    + String.join(",", conflicts));
                }
                return existing;
            }
        }
    }

    private MediaArtifact artifactForUpdate(Connection connection, String tenantId, String artifactId)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT principal_id,file_name,content_type,size_bytes,sha256,object_reference,classification,created_at,"
                        + "expires_at,metadata_json FROM media_artifacts WHERE tenant_id=? AND artifact_id=? FOR UPDATE")) {
            statement.setString(1, tenantId);
            statement.setString(2, artifactId);
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? readArtifact(tenantId, artifactId, result) : null;
            }
        }
    }

    private MediaArtifact readArtifact(String tenantId, String artifactId, ResultSet result) throws SQLException {
        return new MediaArtifact(
                tenantId, result.getString("principal_id"), artifactId, result.getString("file_name"), result.getString("content_type"),
                result.getLong("size_bytes"), result.getString("sha256"), result.getString("object_reference"),
                result.getString("classification"), Instant.ofEpochMilli(result.getLong("created_at")),
                Instant.ofEpochMilli(result.getLong("expires_at")), objectMap(result.getString("metadata_json")));
    }

    private void markStatus(Connection connection, String tenantId, String uploadId, UploadStatus status)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "UPDATE media_upload_sessions SET status=?,updated_at=? WHERE tenant_id=? AND upload_id=?")) {
            statement.setString(1, status.name());
            statement.setLong(2, System.currentTimeMillis());
            statement.setString(3, tenantId);
            statement.setString(4, uploadId);
            statement.executeUpdate();
        }
    }

    private void markAborted(String tenantId, String uploadId, String token) {
        updateFinalizationState(tenantId, uploadId, token, UploadStatus.ABORTED);
    }

    private void releaseFinalization(String tenantId, String uploadId, String token) {
        updateFinalizationState(tenantId, uploadId, token, UploadStatus.OPEN);
    }

    private void updateFinalizationState(
            String tenantId, String uploadId, String token, UploadStatus status) {
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "UPDATE media_upload_sessions SET status=?,finalization_token=NULL,"
                             + "finalization_started_at=NULL,updated_at=? "
                             + "WHERE tenant_id=? AND upload_id=? AND finalization_token=?")) {
            statement.setString(1, status.name());
            statement.setLong(2, System.currentTimeMillis());
            statement.setString(3, tenantId);
            statement.setString(4, uploadId);
            statement.setString(5, token);
            statement.executeUpdate();
        } catch (SQLException failure) {
            throw databaseFailure("release Media upload finalization", failure);
        }
    }

    private String chunkKey(String tenantId, String uploadId, int index) {
        return state.key("uploads/" + opaque(tenantId) + "/" + uploadId + "/chunks/" + index);
    }

    private String artifactKey(String tenantId, String digest) {
        return state.key("artifacts/" + opaque(tenantId) + "/" + digest);
    }

    private static String opaque(String value) {
        return sha256(value.getBytes(StandardCharsets.UTF_8)).substring(0, 32);
    }

    static String safeFileName(String value) {
        // Treat both common path separators as separators regardless of the OS
        // running the service. Path.of(...).getFileName() only recognizes the
        // host platform's separator (for example, Linux does not split '\\').
        java.nio.file.Path fileName = java.nio.file.Path.of(value.replace('\\', '/')).getFileName();
        if (fileName == null) throw new IllegalArgumentException("fileName is invalid");
        String normalized = fileName.toString().replaceAll("[\\r\\n]", "_");
        if (normalized.isBlank()) throw new IllegalArgumentException("fileName is invalid");
        return normalized;
    }

    private String json(Object value) {
        try { return state.mapper().writeValueAsString(value); }
        catch (Exception failure) { throw new IllegalArgumentException("Media metadata is not serializable", failure); }
    }

    private Map<String, Object> objectMap(String json) {
        try { return state.mapper().readValue(json, new TypeReference<>() { }); }
        catch (Exception failure) { throw new IllegalStateException("Stored Media metadata is malformed", failure); }
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("Media artifact store is closed");
        if (!state.configured()) throw new IllegalStateException("Media AWS/PostgreSQL providers are not configured");
    }

    private static boolean duplicateKey(SQLException failure) {
        return "23505".equals(failure.getSQLState());
    }

    private static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (Exception failure) { throw new IllegalStateException("SHA-256 is unavailable", failure); }
    }

    private static void require(String value, String field) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(field + " is required");
    }

    private static void rollback(Connection connection, Exception failure) {
        try { connection.rollback(); } catch (SQLException rollbackFailure) { failure.addSuppressed(rollbackFailure); }
    }

    private static IllegalStateException databaseFailure(String operation, SQLException failure) {
        return new IllegalStateException("Unable to " + operation, failure);
    }

    private record ChunkRow(int index, String objectKey, long sizeBytes, String sha256) { }
    private record FinalizationClaim(UploadRow row, String token, MediaArtifact existingArtifact) { }
    private record UploadRow(
            String tenantId, String uploadId, String principalId, String fileName, String contentType,
            long expectedSizeBytes, String expectedSha256, String classification, long retentionMillis,
            long createdAt, long expiresAt, long bytesReceived, int nextChunkIndex, UploadStatus status,
            Map<String, Object> metadata, String artifactId, String finalizationToken,
            Long finalizationStartedAt) {
        UploadSession session() {
            return new UploadSession(uploadId, tenantId, principalId, fileName, contentType, expectedSizeBytes,
                    expectedSha256, classification, Instant.ofEpochMilli(createdAt),
                    Instant.ofEpochMilli(expiresAt), bytesReceived, nextChunkIndex, status, metadata);
        }
        UploadRow withProgress(long bytes, int next) {
            return new UploadRow(tenantId, uploadId, principalId, fileName, contentType, expectedSizeBytes,
                    expectedSha256, classification, retentionMillis, createdAt, expiresAt, bytes, next,
                    status, metadata, artifactId, finalizationToken, finalizationStartedAt);
        }
    }
}
