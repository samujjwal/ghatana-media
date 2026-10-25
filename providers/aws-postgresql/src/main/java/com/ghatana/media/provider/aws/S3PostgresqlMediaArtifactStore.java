package com.ghatana.media.provider.aws;

import tools.jackson.core.type.TypeReference;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactLineage;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanVerdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactScanner;
import com.ghatana.media.runtime.MediaRuntimeContracts.QuarantinedArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadBeginResult;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadCompletionResult;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus;
import com.ghatana.media.runtime.MediaUploadRequestFingerprint;
import software.amazon.awssdk.core.ResponseBytes;
import software.amazon.awssdk.core.ResponseInputStream;
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
import java.util.ServiceLoader;
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
    private static final String FORMAT_ADMISSION_PREDICATE =
            "AND (EXISTS (SELECT 1 FROM media_artifact_format_verifications verification "
                    + "WHERE verification.tenant_id=media_artifacts.tenant_id "
                    + "AND verification.artifact_id=media_artifacts.artifact_id "
                    + "AND verification.state='SIGNATURE_MATCH') "
                    + "OR EXISTS (SELECT 1 FROM media_artifact_lineage lineage "
                    + "WHERE lineage.tenant_id=media_artifacts.tenant_id "
                    + "AND lineage.derived_artifact_id=media_artifacts.artifact_id "
                    + "AND lineage.derived_version='sha256:' || media_artifacts.sha256 "
                    + "AND lineage.admission_status='CANDIDATE'))";

    private final MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
    private final MediaArtifactScanner scannerOverride;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    public S3PostgresqlMediaArtifactStore() { this(null); }

    S3PostgresqlMediaArtifactStore(MediaArtifactScanner scannerOverride) {
        this.scannerOverride = scannerOverride;
    }

    @Override public String storeId() { return "s3-postgresql"; }

    @Override
    public UploadSession begin(UploadRequest request, String idempotencyKey) {
        return beginWithDisposition(request, idempotencyKey).session();
    }

    @Override
    public UploadBeginResult beginWithDisposition(UploadRequest request, String idempotencyKey) {
        ensureOpen();
        java.util.Objects.requireNonNull(request, "request");
        require(idempotencyKey, "Idempotency-Key");
        if (idempotencyKey.length() > 255) throw new IllegalArgumentException("Idempotency-Key must not exceed 255 characters");
        String fingerprint = MediaUploadRequestFingerprint.compute(request);
        String uploadId = UUID.randomUUID().toString();
        Instant now = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.MILLIS);
        Instant expiresAt = now.plus(Duration.ofHours(1));
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                UploadRow existing = readUploadByIdempotencyKey(
                        connection, request.tenantId(), request.principalId(), idempotencyKey, true);
                if (existing != null) {
                    verifyUploadReplay(existing, fingerprint);
                    connection.commit();
                    return new UploadBeginResult(existing.session(), false);
                }
                try (PreparedStatement statement = connection.prepareStatement(
                        "INSERT INTO media_upload_sessions "
                                + "(tenant_id,upload_id,principal_id,file_name,content_type,expected_size_bytes,expected_sha256,"
                                + "classification,retention_millis,created_at,expires_at,bytes_received,next_chunk_index,"
                                + "status,metadata_json,artifact_id,updated_at,finalization_token,finalization_started_at,"
                                + "idempotency_key,request_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")) {
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
                    statement.setString(20, idempotencyKey);
                    statement.setString(21, fingerprint);
                    statement.executeUpdate();
                }
                connection.commit();
                return new UploadBeginResult(new UploadSession(
                        uploadId, request.tenantId(), request.principalId(), safeFileName(request.fileName()), request.contentType(),
                        request.expectedSizeBytes(), request.expectedSha256(), request.classification(),
                        now, expiresAt, 0L, 0, UploadStatus.OPEN, request.metadata()), true);
            } catch (SQLException | RuntimeException failure) {
                rollback(connection, failure);
                if (failure instanceof SQLException sql && duplicateKey(sql)) {
                    return new UploadBeginResult(
                            findConcurrentUploadReplay(request, idempotencyKey, fingerprint, sql), false);
                }
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("begin Media upload", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open Media upload transaction", failure);
        }
    }

    private UploadSession findConcurrentUploadReplay(
            UploadRequest request, String idempotencyKey, String fingerprint, SQLException conflict) {
        try (Connection connection = state.connection()) {
            UploadRow existing = readUploadByIdempotencyKey(
                    connection, request.tenantId(), request.principalId(), idempotencyKey, false);
            if (existing == null) throw conflict;
            verifyUploadReplay(existing, fingerprint);
            return existing.session();
        } catch (SQLException failure) {
            failure.addSuppressed(conflict);
            throw databaseFailure("resolve concurrent Media upload replay", failure);
        }
    }

    private static void verifyUploadReplay(UploadRow existing, String fingerprint) {
        if (existing.requestFingerprint() == null || existing.requestFingerprint().isBlank()) {
            throw new IllegalStateException("Legacy Media upload idempotency state has no request fingerprint");
        }
        if (!existing.requestFingerprint().equals(fingerprint)) {
            throw new IllegalArgumentException("Idempotency-Key was already used with a different upload request");
        }
    }

    @Override
    public UploadSession append(String tenantId, String principalId, String uploadId, int chunkIndex, byte[] bytes) {
        ensureOpen();
        require(tenantId, "tenantId");
        require(principalId, "principalId");
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
                if (current == null || !current.principalId().equals(principalId)
                        || current.status() != UploadStatus.OPEN) {
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
    public MediaArtifact complete(String tenantId, String principalId, String uploadId) {
        return completeWithDisposition(tenantId, principalId, uploadId).artifact();
    }

    @Override
    public UploadCompletionResult completeWithDisposition(String tenantId, String principalId, String uploadId) {
        ensureOpen();
        require(principalId, "principalId");
        FinalizationClaim claim = claimFinalization(tenantId, principalId, uploadId);
        if (claim.existingArtifact() != null) return new UploadCompletionResult(claim.existingArtifact(), false);

        String finalKey = artifactKey(tenantId, uploadId, claim.row().expectedSha256());
        String multipartId = null;
        boolean objectCompleted = false;
        boolean scanRejected = false;
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
            ByteArrayOutputStream signaturePrefix = new ByteArrayOutputStream(32);
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
                if (signaturePrefix.size() < 32) {
                    signaturePrefix.write(data, 0, Math.min(32 - signaturePrefix.size(), data.length));
                }
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
            MediaArtifactFormatVerifier.Verification verification = MediaArtifactFormatVerifier.verify(
                    claim.row().fileName(), claim.row().contentType(), signaturePrefix.toByteArray());
            if (!"SIGNATURE_MATCH".equals(verification.state())) {
                rejectFormatClaim(tenantId, uploadId, claim.token(), claim.row(), verification);
                throw new IllegalStateException("Uploaded format is not admitted: " + verification.state());
            }
            state.s3().completeMultipartUpload(CompleteMultipartUploadRequest.builder()
                    .bucket(state.bucket())
                    .key(finalKey)
                    .uploadId(multipartId)
                    .multipartUpload(CompletedMultipartUpload.builder().parts(completedParts).build())
                    .build());
            objectCompleted = true;
            QuarantinedArtifact quarantined = new QuarantinedArtifact(
                    tenantId, claim.row().principalId(), uploadId, actualDigest, totalBytes,
                    claim.row().contentType(), "s3://" + state.bucket() + "/" + finalKey);
            ArtifactScanDecision scan = scan(quarantined);
            if (scan.verdict() != ArtifactScanVerdict.CLEAN) {
                recordScanStatus(tenantId, uploadId, claim.token(), scan,
                        scan.verdict() == ArtifactScanVerdict.REJECT ? "REJECTED" : "UNAVAILABLE");
                if (scan.verdict() == ArtifactScanVerdict.REJECT) {
                    scanRejected = true;
                    markAborted(tenantId, uploadId, claim.token());
                    state.s3().deleteObject(DeleteObjectRequest.builder().bucket(state.bucket()).key(finalKey).build());
                }
                throw new IllegalStateException("Media artifact scan did not return a clean verdict: " + scan.verdict());
            }
            MediaArtifact artifact = persistArtifact(claim, finalKey, totalBytes, actualDigest, scan, verification);
            if (!artifact.objectReference().equals("s3://" + state.bucket() + "/" + finalKey)) {
                state.s3().deleteObject(DeleteObjectRequest.builder().bucket(state.bucket()).key(finalKey).build());
            }
            deleteChunks(chunks);
            return new UploadCompletionResult(artifact, true);
        } catch (RuntimeException failure) {
            if (objectCompleted && !scanRejected) recordScanStatus(tenantId, uploadId, claim.token(), null, "UNAVAILABLE");
            if (multipartId != null) {
                try {
                    state.s3().abortMultipartUpload(AbortMultipartUploadRequest.builder()
                            .bucket(state.bucket()).key(finalKey).uploadId(multipartId).build());
                } catch (RuntimeException abortFailure) {
                    failure.addSuppressed(abortFailure);
                }
            }
            if (!scanRejected) releaseFinalization(tenantId, uploadId, claim.token());
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
            if (objectCompleted && !scanRejected) recordScanStatus(tenantId, uploadId, claim.token(), null, "UNAVAILABLE");
            if (!scanRejected) releaseFinalization(tenantId, uploadId, claim.token());
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
                             + "WHERE tenant_id=? AND artifact_id=? AND expires_at>? AND scan_status='CLEAN' "
                             + FORMAT_ADMISSION_PREDICATE)) {
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

    @Override
    public MediaArtifact registerDerived(MediaArtifact derivedArtifact, ArtifactLineage lineage) {
        ensureOpen();
        java.util.Objects.requireNonNull(derivedArtifact, "derivedArtifact");
        java.util.Objects.requireNonNull(lineage, "lineage");
        if (!derivedArtifact.tenantId().equals(lineage.tenantId())) {
            throw new IllegalArgumentException("Derived artifact identity does not match lineage tenant");
        }
        // Current checks establish live source/job/consent state, but there is no authoritative
        // rights-decision/policy-version lookup yet. Persist provenance as a candidate only and
        // keep production derived-artifact admission closed until that authority is wired.
        if (state.productionEligible()) {
            throw new UnsupportedOperationException(
                    "Derived artifact rights and policy authority admission is pending");
        }
        try (Connection connection = state.connection()) {
            validateLineage(connection, derivedArtifact, lineage, false);
        } catch (SQLException failure) {
            throw databaseFailure("validate derived Media artifact lineage", failure);
        }
        verifyStoredObject(derivedArtifact.objectReference(), derivedArtifact.sizeBytes(), derivedArtifact.sha256());
        QuarantinedArtifact quarantined = new QuarantinedArtifact(
                derivedArtifact.tenantId(), derivedArtifact.principalId(), derivedArtifact.artifactId(),
                derivedArtifact.sha256(), derivedArtifact.sizeBytes(), derivedArtifact.contentType(),
                derivedArtifact.objectReference());
        ArtifactScanDecision scan;
        try {
            scan = scan(quarantined);
        } catch (RuntimeException scanFailure) {
            cleanupDerivedQuarantineObject(derivedArtifact.objectReference());
            throw scanFailure;
        }
        if (scan.verdict() != ArtifactScanVerdict.CLEAN) {
            cleanupDerivedQuarantineObject(derivedArtifact.objectReference());
            throw new IllegalStateException("Derived Media artifact scan did not return CLEAN: " + scan.verdict());
        }
        long now = System.currentTimeMillis();
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                validateLineage(connection, derivedArtifact, lineage, true);
                insertArtifact(connection, derivedArtifact, scan);
                try (PreparedStatement lineageInsert = connection.prepareStatement(
                        "INSERT INTO media_artifact_lineage (tenant_id,derived_artifact_id,derived_version,"
                                + "source_artifact_id,source_version,job_id,processing_profile,rights_decision_id,"
                                + "consent_decision_id,policy_version,admission_status,created_at) "
                                + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")) {
                    lineageInsert.setString(1, lineage.tenantId());
                    lineageInsert.setString(2, derivedArtifact.artifactId());
                    lineageInsert.setString(3, derivedArtifact.version().value());
                    lineageInsert.setString(4, lineage.sourceArtifactId());
                    lineageInsert.setString(5, lineage.sourceVersion().value());
                    lineageInsert.setString(6, lineage.jobId());
                    lineageInsert.setString(7, lineage.profileId());
                    lineageInsert.setString(8, lineage.rightsDecisionId());
                    lineageInsert.setString(9, lineage.consentDecisionId());
                    lineageInsert.setString(10, lineage.policyVersion());
                    lineageInsert.setString(11, "CANDIDATE");
                    lineageInsert.setLong(12, now);
                    lineageInsert.executeUpdate();
                }
                connection.commit();
                return derivedArtifact;
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("register derived Media artifact", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open derived Media artifact transaction", failure);
        }
    }

    private void validateLineage(
            Connection connection, MediaArtifact derived, ArtifactLineage lineage, boolean lock) throws SQLException {
        MediaArtifact source = artifactForUpdate(connection, lineage.tenantId(), lineage.sourceArtifactId());
        if (source == null || !source.version().equals(lineage.sourceVersion())) {
            throw new IllegalStateException("Derived artifact source version is missing or stale");
        }
        if (!source.principalId().equals(derived.principalId())) {
            throw new SecurityException("Derived artifact principal does not match its source artifact");
        }
        String suffix = lock ? " FOR UPDATE" : "";
        try (PreparedStatement job = connection.prepareStatement(
                "SELECT artifact_id,expected_artifact_version,provider_id,status FROM media_processing_jobs "
                        + "WHERE tenant_id=? AND job_id=?" + suffix)) {
            job.setString(1, lineage.tenantId());
            job.setString(2, lineage.jobId());
            try (ResultSet result = job.executeQuery()) {
                if (!result.next() || !lineage.sourceArtifactId().equals(result.getString(1))
                        || !lineage.sourceVersion().value().equals(result.getString(2))
                        || !lineage.profileId().equals(result.getString(3))
                        || !("RUNNING".equals(result.getString(4)) || "COMPLETED".equals(result.getString(4)))) {
                    throw new IllegalStateException("Derived artifact lineage does not match a current governed job");
                }
            }
        }
        try (PreparedStatement consent = connection.prepareStatement(
                "SELECT 1 FROM media_consents WHERE tenant_id=? AND consent_id=? AND principal_id=? "
                        + "AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)" + suffix)) {
            consent.setString(1, lineage.tenantId());
            consent.setString(2, lineage.consentDecisionId());
            consent.setString(3, derived.principalId());
            consent.setLong(4, System.currentTimeMillis());
            try (ResultSet result = consent.executeQuery()) {
                if (!result.next()) throw new SecurityException("Derived artifact consent is missing, revoked, or expired");
            }
        }
    }

    private void verifyStoredObject(String reference, long expectedSize, String expectedDigest) {
        String prefix = "s3://" + state.bucket() + "/";
        if (reference == null || !reference.startsWith(prefix) || reference.length() == prefix.length()) {
            throw new SecurityException("Artifact object reference is outside the configured Media bucket");
        }
        String key = reference.substring(prefix.length());
        try (ResponseInputStream<?> object = state.s3().getObject(GetObjectRequest.builder()
                .bucket(state.bucket()).key(key).build())) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            long total = 0;
            int read;
            while ((read = object.read(buffer)) != -1) {
                total = Math.addExact(total, read);
                digest.update(buffer, 0, read);
            }
            String actual = HexFormat.of().formatHex(digest.digest());
            if (total != expectedSize || !actual.equals(expectedDigest)) {
                throw new SecurityException("Artifact object bytes do not match the declared immutable version");
            }
        } catch (SecurityException failure) {
            throw failure;
        } catch (Exception failure) {
            throw new IllegalStateException("Unable to verify exact Media artifact object bytes", failure);
        }
    }

    /** Remove only private, store-owned derived quarantine objects; other keys remain caller-owned. */
    private void cleanupDerivedQuarantineObject(String reference) {
        String bucketPrefix = "s3://" + state.bucket() + "/";
        String ownedPrefix = state.key("quarantine/derived/");
        if (reference == null || !reference.startsWith(bucketPrefix)) return;
        String key = reference.substring(bucketPrefix.length());
        if (!key.startsWith(ownedPrefix)) return;
        try (Connection connection = state.connection();
             PreparedStatement referenceCheck = connection.prepareStatement(
                     "SELECT 1 FROM media_artifacts WHERE object_reference=?")) {
            referenceCheck.setString(1, reference);
            try (ResultSet result = referenceCheck.executeQuery()) {
                if (result.next()) return;
            }
            state.s3().deleteObject(DeleteObjectRequest.builder().bucket(state.bucket()).key(key).build());
        } catch (SQLException failure) {
            throw databaseFailure("check derived quarantine object ownership", failure);
        }
    }

    /**
     * Resolve the tenant-scoped artifact only when its stored digest is the caller's captured
     * version. Keep the comparison in SQL so the identity and version check share one read.
     */
    @Override
    public Optional<MediaArtifact> artifact(
            String tenantId, String artifactId, ArtifactVersion expectedVersion) {
        ensureOpen();
        require(tenantId, "tenantId");
        require(artifactId, "artifactId");
        java.util.Objects.requireNonNull(expectedVersion, "expectedVersion");
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT principal_id,file_name,content_type,size_bytes,sha256,object_reference,classification,"
                             + "created_at,expires_at,metadata_json FROM media_artifacts "
                             + "WHERE tenant_id=? AND artifact_id=? AND sha256=? AND expires_at>? AND scan_status='CLEAN' "
                             + FORMAT_ADMISSION_PREDICATE)) {
            statement.setString(1, tenantId);
            statement.setString(2, artifactId);
            statement.setString(3, expectedVersion.value().substring("sha256:".length()));
            statement.setLong(4, System.currentTimeMillis());
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? Optional.of(readArtifact(tenantId, artifactId, result)) : Optional.empty();
            }
        } catch (SQLException failure) {
            throw databaseFailure("read version-pinned Media artifact", failure);
        }
    }

    @Override public boolean durable() { return true; }
    @Override public boolean productionEligible() { return state.productionEligible(); }
    @Override public boolean ready() { return !closed.get() && state.ready(); }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) {
            try {
                if (scannerOverride != null) scannerOverride.close();
            } finally {
                state.release();
            }
        }
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

    private FinalizationClaim claimFinalization(String tenantId, String principalId, String uploadId) {
        String token = UUID.randomUUID().toString();
        long now = System.currentTimeMillis();
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                UploadRow row = lockUpload(connection, tenantId, uploadId);
                if (row == null || !row.principalId().equals(principalId)) {
                    throw new IllegalArgumentException("Upload session not found");
                }
                if (row.status() == UploadStatus.COMPLETED && row.artifactId() != null) {
                    MediaArtifact artifact = artifactForUpdate(connection, tenantId, row.artifactId());
                    if (artifact == null) {
                        throw new IllegalStateException("Completed Media artifact lacks an admitted signature state");
                    }
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
            FinalizationClaim claim, String finalKey, long totalBytes, String digest,
            ArtifactScanDecision scan, MediaArtifactFormatVerifier.Verification verification) {
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
                        connection, current, reference, totalBytes, digest, now, expiresAt, scan);
                recordFormatVerification(connection, tenantId, uploadId, artifact.artifactId(), current,
                        verification, now);
                try (PreparedStatement update = connection.prepareStatement(
                        "UPDATE media_upload_sessions SET status='COMPLETED',artifact_id=?,scan_status='CLEAN',"
                                + "scan_policy_version=?,scanner_id=?,scanned_at=?,updated_at=?,"
                                + "finalization_token=NULL,finalization_started_at=NULL "
                                + "WHERE tenant_id=? AND upload_id=? AND finalization_token=?")) {
                    update.setString(1, artifact.artifactId());
                    update.setString(2, scan.policyId() + "/" + scan.policyVersion());
                    update.setString(3, scan.scannerId() + "/" + scan.scannerVersion());
                    update.setLong(4, scan.evaluatedAt().toEpochMilli());
                    update.setLong(5, now);
                    update.setString(6, tenantId);
                    update.setString(7, uploadId);
                    update.setString(8, claim.token());
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

    private ArtifactScanDecision scan(QuarantinedArtifact artifact) {
        if (scannerOverride != null) {
            if (!scannerOverride.ready()
                    || state.productionEligible() && !scannerOverride.productionEligible()) {
                throw new IllegalStateException("Injected Media artifact scanner is not admitted");
            }
            ArtifactScanDecision decision = scannerOverride.scan(artifact);
            if (decision == null || !decision.matches(artifact, Instant.now())) {
                throw new SecurityException("Media artifact scanner returned an expired or mismatched attestation");
            }
            return decision;
        }
        List<MediaArtifactScanner> scanners = new ArrayList<>();
        for (ServiceLoader.Provider<MediaArtifactScanner> provider : ServiceLoader.load(MediaArtifactScanner.class).stream().toList()) {
            MediaArtifactScanner candidate = provider.get();
            if (candidate.ready() && (!state.productionEligible() || candidate.productionEligible())) {
                scanners.add(candidate);
            } else {
                candidate.close();
            }
        }
        if (scanners.size() != 1) {
            scanners.forEach(MediaArtifactScanner::close);
            throw new IllegalStateException(scanners.isEmpty()
                    ? "No ready Media artifact scanner is admitted"
                    : "Multiple ready Media artifact scanners are ambiguous");
        }
        MediaArtifactScanner scanner = scanners.getFirst();
        if (state.productionEligible() && !scanner.productionEligible()) {
            throw new IllegalStateException("Selected Media artifact scanner is not production eligible");
        }
        ArtifactScanDecision decision;
        try {
            decision = scanner.scan(artifact);
        } finally {
            scanner.close();
        }
        if (decision == null || !decision.matches(artifact, Instant.now())) {
            throw new SecurityException("Media artifact scanner returned an expired or mismatched attestation");
        }
        return decision;
    }

    private void recordScanStatus(
            String tenantId, String uploadId, String token, ArtifactScanDecision scan, String status) {
        String policy = scan == null ? null : scan.policyId() + "/" + scan.policyVersion();
        String scanner = scan == null ? null : scan.scannerId() + "/" + scan.scannerVersion();
        Long scannedAt = scan == null ? null : scan.evaluatedAt().toEpochMilli();
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "UPDATE media_upload_sessions SET scan_status=?,scan_policy_version=?,scanner_id=?,scanned_at=?,updated_at=? "
                             + "WHERE tenant_id=? AND upload_id=? AND finalization_token=?")) {
            statement.setString(1, status);
            statement.setString(2, policy);
            statement.setString(3, scanner);
            if (scannedAt == null) statement.setNull(4, java.sql.Types.BIGINT);
            else statement.setLong(4, scannedAt);
            statement.setLong(5, System.currentTimeMillis());
            statement.setString(6, tenantId);
            statement.setString(7, uploadId);
            statement.setString(8, token);
            statement.executeUpdate();
        } catch (SQLException failure) {
            throw databaseFailure("record Media artifact scan status", failure);
        }
    }

    /** Persist a deterministic signature rejection and abort the upload under the finalization token. */
    private void rejectFormatClaim(
            String tenantId, String uploadId, String token, UploadRow upload,
            MediaArtifactFormatVerifier.Verification verification) {
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                UploadRow current = lockUpload(connection, tenantId, uploadId);
                if (current == null || current.status() != UploadStatus.FINALIZING
                        || !token.equals(current.finalizationToken())) {
                    throw new IllegalStateException("Media upload finalization ownership changed");
                }
                long now = System.currentTimeMillis();
                recordFormatVerification(connection, tenantId, uploadId, null, upload, verification, now);
                try (PreparedStatement update = connection.prepareStatement(
                        "UPDATE media_upload_sessions SET status='ABORTED',finalization_token=NULL,"
                                + "finalization_started_at=NULL,updated_at=? "
                                + "WHERE tenant_id=? AND upload_id=? AND finalization_token=?")) {
                    update.setLong(1, now);
                    update.setString(2, tenantId);
                    update.setString(3, uploadId);
                    update.setString(4, token);
                    if (update.executeUpdate() != 1) {
                        throw new IllegalStateException("Media upload finalization ownership changed");
                    }
                }
                connection.commit();
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("persist Media format rejection", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open Media format rejection transaction", failure);
        }
    }

    private void recordFormatVerification(
            Connection connection, String tenantId, String uploadId, String artifactId, UploadRow upload,
            MediaArtifactFormatVerifier.Verification verification, long checkedAt) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "INSERT INTO media_artifact_format_verifications "
                        + "(tenant_id,upload_id,artifact_id,policy_version,state,claimed_file_name,"
                        + "claimed_content_type,detected_format,detail,checked_at) VALUES (?,?,?,?,?,?,?,?,?,?)")) {
            statement.setString(1, tenantId);
            statement.setString(2, uploadId);
            statement.setString(3, artifactId);
            statement.setString(4, MediaArtifactFormatVerifier.POLICY_VERSION);
            statement.setString(5, verification.state());
            statement.setString(6, upload.fileName());
            statement.setString(7, upload.contentType());
            statement.setString(8, verification.detectedFormat());
            statement.setString(9, verification.detail());
            statement.setLong(10, checkedAt);
            statement.executeUpdate();
        }
    }

    private MediaArtifact resolveOrInsertArtifact(
            Connection connection,
            UploadRow current,
            String reference,
            long totalBytes,
            String digest,
            long now,
            long expiresAt,
            ArtifactScanDecision scan) throws SQLException {
        MediaArtifact existing = artifactByHash(
                connection, current.tenantId(), digest, totalBytes, current, expiresAt);
        if (existing != null) return existing;

        MediaArtifact candidate = new MediaArtifact(
                current.tenantId(), current.principalId(), UUID.randomUUID().toString(), current.fileName(), current.contentType(),
                totalBytes, digest, reference, current.classification(), Instant.ofEpochMilli(now),
                Instant.ofEpochMilli(expiresAt), current.metadata());
        Savepoint deduplicationSavepoint = connection.setSavepoint("media_artifact_deduplication");
        try {
            insertArtifact(connection, candidate, scan);
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

    private UploadRow readUploadByIdempotencyKey(
            Connection connection, String tenantId, String principalId, String idempotencyKey, boolean lock)
            throws SQLException {
        String sql = "SELECT upload_id FROM media_upload_sessions "
                + "WHERE tenant_id=? AND principal_id=? AND idempotency_key=?"
                + (lock ? " FOR UPDATE" : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, tenantId);
            statement.setString(2, principalId);
            statement.setString(3, idempotencyKey);
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? readUpload(connection, tenantId, result.getString(1), false) : null;
            }
        }
    }

    private UploadRow readUpload(Connection connection, String tenantId, String uploadId, boolean lock)
            throws SQLException {
        String sql = "SELECT principal_id,file_name,content_type,expected_size_bytes,expected_sha256,classification,"
                + "retention_millis,created_at,expires_at,bytes_received,next_chunk_index,status,metadata_json,"
                + "artifact_id,finalization_token,finalization_started_at,idempotency_key,request_fingerprint "
                + "FROM media_upload_sessions "
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
                        result.getString("finalization_token"), finalizationStarted,
                        result.getString("idempotency_key"), result.getString("request_fingerprint"));
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

    private void insertArtifact(
            Connection connection, MediaArtifact artifact, ArtifactScanDecision scan) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "INSERT INTO media_artifacts "
                        + "(tenant_id,artifact_id,principal_id,file_name,content_type,size_bytes,sha256,object_reference,"
                        + "classification,created_at,expires_at,metadata_json,scan_status,scan_policy_version,scanner_id,scanned_at) "
                        + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'CLEAN',?,?,?)")) {
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
            statement.setString(13, scan.policyId() + "/" + scan.policyVersion());
            statement.setString(14, scan.scannerId() + "/" + scan.scannerVersion());
            statement.setLong(15, scan.evaluatedAt().toEpochMilli());
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
                        + "metadata_json,scan_status FROM media_artifacts WHERE tenant_id=? AND principal_id=? AND sha256=? AND size_bytes=? FOR UPDATE")) {
            statement.setString(1, tenantId);
            statement.setString(2, requested.principalId());
            statement.setString(3, digest);
            statement.setLong(4, size);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) return null;
                if (!"CLEAN".equals(result.getString("scan_status"))) {
                    throw new IllegalStateException("Existing byte-identical Media artifact is not currently scan-verified");
                }
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
                        + "expires_at,metadata_json,scan_status FROM media_artifacts WHERE tenant_id=? AND artifact_id=? "
                        + FORMAT_ADMISSION_PREDICATE + " FOR UPDATE")) {
            statement.setString(1, tenantId);
            statement.setString(2, artifactId);
            try (ResultSet result = statement.executeQuery()) {
                if (result.next()) {
                    if (!"CLEAN".equals(result.getString("scan_status"))) {
                        throw new IllegalStateException("Media source artifact has no clean scan attestation");
                    }
                    return Optional.of(readArtifact(tenantId, artifactId, result)).orElse(null);
                }
                return null;
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

    private String artifactKey(String tenantId, String uploadId, String digest) {
        // DB registration is the only publication boundary. Scanner-unavailable objects remain
        // under a private quarantine prefix and cannot be reached through artifact lookup.
        return state.key("quarantine/finalized/" + opaque(tenantId) + "/" + uploadId + "/" + digest);
    }

    private static String opaque(String value) {
        return sha256(value.getBytes(StandardCharsets.UTF_8)).substring(0, 32);
    }

    static String safeFileName(String value) {
        require(value, "fileName");
        // A display name is never a path. Reject both separator styles so this rule is stable
        // across hosts and does not turn traversal input into an apparently valid name.
        if (value.indexOf('/') >= 0 || value.indexOf('\\') >= 0 || value.equals(".") || value.equals("..")
                || value.indexOf('\0') >= 0 || value.indexOf(':') >= 0) {
            throw new IllegalArgumentException("fileName must be a plain file name without path components");
        }
        String normalized = value.replaceAll("[\\r\\n]", "_").trim();
        if (normalized.isBlank() || normalized.equals(".") || normalized.equals("..")) {
            throw new IllegalArgumentException("fileName is invalid");
        }
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
            Long finalizationStartedAt, String idempotencyKey, String requestFingerprint) {
        UploadSession session() {
            return new UploadSession(uploadId, tenantId, principalId, fileName, contentType, expectedSizeBytes,
                    expectedSha256, classification, Instant.ofEpochMilli(createdAt),
                    Instant.ofEpochMilli(expiresAt), bytesReceived, nextChunkIndex, status, metadata);
        }
        UploadRow withProgress(long bytes, int next) {
            return new UploadRow(tenantId, uploadId, principalId, fileName, contentType, expectedSizeBytes,
                    expectedSha256, classification, retentionMillis, createdAt, expiresAt, bytes, next,
                    status, metadata, artifactId, finalizationToken, finalizationStartedAt,
                    idempotencyKey, requestFingerprint);
        }
    }
}
