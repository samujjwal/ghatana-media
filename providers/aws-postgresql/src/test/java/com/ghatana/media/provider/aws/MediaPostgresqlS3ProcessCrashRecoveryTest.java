package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import com.ghatana.media.runtime.MediaUploadRequestFingerprint;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.ListObjectsV2Request;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.core.sync.RequestBody;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.HexFormat;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** IP-06 S3/PostgreSQL object and metadata crash boundary, isolated to disposable test services. */
@Testcontainers(disabledWithoutDocker = true)
class MediaPostgresqlS3ProcessCrashRecoveryTest {
    private static final int ADVISORY_LOCK_CLASS = 802406;
    private static final int ADVISORY_LOCK_ID = 6;

    @Test
    void childDeathAfterS3MultipartFinalizeBeforeArtifactMetadataRecoversOnSameKey(@TempDir Path tempDir)
            throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-s3-finalize-crash-" + runId;
        String prefix = "ip06/finalize-crash/" + runId;
        String tenant = "tenant-ip06-finalize-crash-" + runId;
        String principal = "principal-ip06-finalize-crash-" + runId;
        String application = "media-ip06-s3-finalize-crash-" + runId;
        byte[] bytes = wav(("ip06-s3-finalize-crash-source:" + runId).getBytes(StandardCharsets.UTF_8));
        String digest = sha256(bytes);
        String sourceArtifactId = "source-" + runId;
        String sourceVersion = "sha256:" + digest;
        UploadRequest request = new UploadRequest(tenant, principal, "source.wav", "audio/wav", bytes.length,
                digest, "RESTRICTED", Duration.ofDays(7),
                Map.of("sourceArtifactId", sourceArtifactId, "sourceVersion", sourceVersion));
        String fingerprint = MediaUploadRequestFingerprint.compute(request);
        Map<String, String> environment = environment(bucket, prefix);
        Path payloadFile = tempDir.resolve("finalize-crash-source.wav");
        Path finalizedMarker = tempDir.resolve("s3-finalized.marker");
        Path workerLog = tempDir.resolve("s3-finalize-worker.log");
        Files.write(payloadFile, bytes);
        createBucket(bucket);

        String uploadId;
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore()) {
            UploadSession upload = store.begin(request, "ip06-finalize-crash-" + runId);
            uploadId = upload.uploadId();
            store.append(tenant, principal, uploadId, 0, bytes);
        }

        String finalKey = prefix + "/quarantine/finalized/" + opaque(tenant) + "/" + uploadId + "/" + digest;
        String stagedKey = prefix + "/uploads/" + opaque(tenant) + "/" + uploadId + "/chunks/0";
        try {
            Process child = startWorker(environment, application, finalizedMarker, workerLog,
                    "complete-after-s3-finalize", payloadFile, tenant, principal, uploadId);
            try {
                awaitMarker(child, finalizedMarker, "S3_FINALIZED", workerLog);
                assertThat(objectExists(bucket, finalKey)).isTrue();
                byte[] remotelyFinalized = getObject(bucket, finalKey);
                assertThat(remotelyFinalized).containsExactly(bytes);
                assertThat(sha256(remotelyFinalized)).isEqualTo(digest);

                // The child is blocked immediately after LocalStack's successful S3 response,
                // before complete() can scan or commit artifact metadata.
                try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
                     S3PostgresqlMediaArtifactStore observer = new S3PostgresqlMediaArtifactStore()) {
                    assertThat(artifactIdForUpload(tenant, uploadId)).isNull();
                    assertThat(tenantArtifactCount(tenant)).isZero();
                    UploadSession pending = observer.upload(tenant, uploadId).orElseThrow();
                    assertThat(pending.status().name()).isEqualTo("FINALIZING");
                    assertThat(pending.status().name()).isNotEqualTo("COMPLETED");
                    assertThat(objectExists(bucket, stagedKey)).isTrue();
                }
                child.destroyForcibly();
                assertThat(child.waitFor(15, TimeUnit.SECONDS)).isTrue();
            } finally {
                if (child.isAlive()) child.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
            }

            // Force the durable finalization lease stale using this isolated database so recovery
            // is deterministic and does not wait the production 15-minute lease interval.
            try (Connection connection = databaseConnection(); var update = connection.prepareStatement(
                    "UPDATE media_upload_sessions SET finalization_started_at=? WHERE tenant_id=? AND upload_id=?")) {
                update.setLong(1, System.currentTimeMillis() - Duration.ofMinutes(16).toMillis());
                update.setString(2, tenant);
                update.setString(3, uploadId);
                assertThat(update.executeUpdate()).isEqualTo(1);
            }

            // A new provider lifecycle on the same PostgreSQL and S3 state performs the same-key
            // retry and verifies one tenant/source/digest/object-parity checked artifact.
            try (AutoCloseable restartedLifecycle = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
                 S3PostgresqlMediaArtifactStore restarted = new S3PostgresqlMediaArtifactStore()) {
                assertThat(artifactIdForUpload(tenant, uploadId)).isNull();
                assertThat(restarted.upload(tenant, uploadId).orElseThrow().status().name())
                        .isEqualTo("FINALIZING");
                MediaArtifact recovered = restarted.complete(tenant, principal, uploadId);
                String artifactId = recovered.artifactId();
                assertThat(artifactIdForUpload(tenant, uploadId)).isEqualTo(artifactId);
                assertThat(recovered.tenantId()).isEqualTo(tenant);
                assertThat(recovered.principalId()).isEqualTo(principal);
                assertThat(recovered.sha256()).isEqualTo(digest);
                assertThat(recovered.sizeBytes()).isEqualTo(bytes.length);
                assertThat(recovered.metadata()).containsEntry("sourceArtifactId", sourceArtifactId)
                        .containsEntry("sourceVersion", sourceVersion);
                assertThat(objectKey(recovered.objectReference())).isEqualTo(finalKey);
                assertThat(restarted.artifact(tenant, artifactId)).contains(recovered);
                assertThat(restarted.artifact("wrong-tenant-" + runId, artifactId)).isEmpty();
                assertThat(artifactCount(tenant, artifactId)).isEqualTo(1);
                byte[] stored = getObject(bucket, finalKey);
                assertThat(stored).containsExactly(bytes);
                assertThat(sha256(stored)).isEqualTo(digest);
                assertThat(requestFingerprint(tenant, uploadId)).isEqualTo(fingerprint);
                assertThat(objectExists(bucket, stagedKey)).isFalse();
            }
        } finally {
            deleteBucketObjects(bucket);
        }
    }

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void childDeathAcrossObjectMetadataBoundaryRecoversOneTenantBoundArtifact(@TempDir Path tempDir)
            throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-s3-" + runId;
        String prefix = "ip06/" + runId;
        String tenant = "tenant-ip06-" + runId;
        String principal = "principal-ip06-" + runId;
        String uploadApplication = "media-ip06-s3-upload-" + runId;
        String completeApplication = "media-ip06-s3-complete-" + runId;
        byte[] bytes = wav(("ip06-s3-source:" + runId).getBytes(StandardCharsets.UTF_8));
        String digest = sha256(bytes);
        String sourceArtifactId = "source-" + runId;
        String sourceVersion = "sha256:" + digest;
        UploadRequest request = new UploadRequest(tenant, principal, "source.wav", "audio/wav", bytes.length,
                digest, "RESTRICTED", Duration.ofDays(7),
                Map.of("sourceArtifactId", sourceArtifactId, "sourceVersion", sourceVersion));
        String fingerprint = MediaUploadRequestFingerprint.compute(request);
        Map<String, String> environment = environment(bucket, prefix);
        Path payloadFile = tempDir.resolve("source.wav");
        Files.write(payloadFile, bytes);
        Path appendMarker = tempDir.resolve("append.marker");
        Path appendLog = tempDir.resolve("append.log");
        Path committedAppendMarker = tempDir.resolve("append-committed.marker");
        Path committedAppendLog = tempDir.resolve("append-committed.log");
        Path completeMarker = tempDir.resolve("complete.marker");
        Path completeLog = tempDir.resolve("complete.log");

        createBucket(bucket);
        UploadSession upload;
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore()) {
            upload = store.begin(request, "ip06-upload-" + runId);
            installChunkInsertFence();
            try (Connection advisoryLock = databaseConnection()) {
                advisoryLock.setAutoCommit(true);
                try (var lock = advisoryLock.prepareStatement("SELECT pg_advisory_lock(?,?)")) {
                    lock.setInt(1, ADVISORY_LOCK_CLASS);
                    lock.setInt(2, ADVISORY_LOCK_ID);
                    lock.execute();
                }

                Process interruptedAppend = startWorker(environment, uploadApplication, appendMarker, appendLog,
                        "append", payloadFile, tenant, principal, upload.uploadId());
                try {
                    awaitMarker(interruptedAppend, appendMarker, "READY", appendLog);
                    awaitLockWait(uploadApplication, appendLog);
                    String chunkKey = prefix + "/uploads/" + opaque(tenant) + "/" + upload.uploadId() + "/chunks/0";
                    assertThat(objectExists(bucket, chunkKey)).isTrue();
                    interruptedAppend.destroyForcibly();
                    assertThat(interruptedAppend.waitFor(15, TimeUnit.SECONDS)).isTrue();
                    assertThat(readChunkCount(tenant, upload.uploadId())).isZero();
                    UploadSession notCommitted = store.upload(tenant, upload.uploadId()).orElseThrow();
                    assertThat(notCommitted.bytesReceived()).isZero();
                    assertThat(notCommitted.nextChunkIndex()).isZero();
                    // The staged object is unowned: no committed chunk or artifact can expose it.
                    assertThat(artifactIdForUpload(tenant, upload.uploadId())).isNull();
                    // Keep the orphan in S3. The same-key append below must safely replace/reuse
                    // it, commit exactly one chunk, and completion must remove the staged key.
                } finally {
                    if (interruptedAppend.isAlive()) interruptedAppend.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
                    try (var unlock = advisoryLock.prepareStatement("SELECT pg_advisory_unlock(?,?)")) {
                        unlock.setInt(1, ADVISORY_LOCK_CLASS);
                        unlock.setInt(2, ADVISORY_LOCK_ID);
                        unlock.execute();
                    }
                }
            } finally {
                dropChunkInsertFence();
            }

            // Commit the chunk in a child, then kill it after its DB commit but before the test
            // process receives an acknowledgement. A replay must resolve the exact same receipt.
            Process lostAppendAck = startWorker(environment, uploadApplication, committedAppendMarker,
                    committedAppendLog, "append", payloadFile, tenant, principal, upload.uploadId());
            try {
                awaitMarker(lostAppendAck, committedAppendMarker, "COMMITTED", committedAppendLog);
                lostAppendAck.destroyForcibly();
                assertThat(lostAppendAck.waitFor(15, TimeUnit.SECONDS)).isTrue();
            } finally {
                if (lostAppendAck.isAlive()) lostAppendAck.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
            }

            Process lostCompleteAck = startWorker(environment, completeApplication, completeMarker,
                    completeLog, "complete", payloadFile, tenant, principal, upload.uploadId());
            try {
                awaitMarker(lostCompleteAck, completeMarker, "COMMITTED", completeLog);
                lostCompleteAck.destroyForcibly();
                assertThat(lostCompleteAck.waitFor(15, TimeUnit.SECONDS)).isTrue();
            } finally {
                if (lostCompleteAck.isAlive()) lostCompleteAck.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
            }
        }

        // New provider lifecycle after all child JVMs are dead: database and object bytes are
        // independently read back, and same-key retries converge on one exact artifact.
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore restarted = new S3PostgresqlMediaArtifactStore()) {
            UploadSession recoveredUpload = restarted.upload(tenant, upload.uploadId()).orElseThrow();
            assertThat(recoveredUpload.status().name()).isEqualTo("COMPLETED");
            assertThat(recoveredUpload.bytesReceived()).isEqualTo(bytes.length);
            assertThat(readChunkCount(tenant, upload.uploadId())).isEqualTo(1);
            String stagedChunkKey = prefix + "/uploads/" + opaque(tenant) + "/" + upload.uploadId() + "/chunks/0";
            assertThat(objectExists(bucket, stagedChunkKey)).isFalse();
            assertThat(requestFingerprint(tenant, upload.uploadId())).isEqualTo(fingerprint);

            String artifactId = artifactIdForUpload(tenant, upload.uploadId());
            MediaArtifact recovered = restarted.artifact(tenant, artifactId).orElseThrow();
            assertThat(recovered.tenantId()).isEqualTo(tenant);
            assertThat(recovered.principalId()).isEqualTo(principal);
            assertThat(recovered.sha256()).isEqualTo(digest);
            assertThat(recovered.sizeBytes()).isEqualTo(bytes.length);
            assertThat(recovered.metadata()).containsEntry("sourceArtifactId", sourceArtifactId)
                    .containsEntry("sourceVersion", sourceVersion);
            String objectKey = objectKey(recovered.objectReference());
            byte[] storedBytes = getObject(bucket, objectKey);
            assertThat(storedBytes).containsExactly(bytes);
            assertThat(sha256(storedBytes)).isEqualTo(digest);
            assertThat(restarted.artifact("wrong-tenant-" + runId, artifactId)).isEmpty();
            assertThat(artifactCount(tenant, artifactId)).isEqualTo(1);

            MediaArtifact replay = restarted.complete(tenant, principal, upload.uploadId());
            assertThat(replay).isEqualTo(recovered);
            assertThat(artifactCount(tenant, artifactId)).isEqualTo(1);

            // A corrupted manifest must not direct replay cleanup at another object's key.
            String foreignKey = prefix + "/uploads/foreign-tenant/foreign-upload/chunks/0";
            putObject(bucket, foreignKey, bytes);
            updateChunkObjectKey(tenant, upload.uploadId(), 0, foreignKey);
            assertThat(restarted.complete(tenant, principal, upload.uploadId())).isEqualTo(recovered);
            assertThat(objectExists(bucket, foreignKey)).isTrue();
            updateChunkObjectKey(tenant, upload.uploadId(), 0, stagedChunkKey);

            // Simulate a leftover staged object after commit. An exact completion replay retries
            // cleanup without creating another artifact or changing the request fingerprint.
            putObject(bucket, stagedChunkKey, bytes);
            assertThat(objectExists(bucket, stagedChunkKey)).isTrue();
            assertThat(restarted.complete(tenant, principal, upload.uploadId())).isEqualTo(recovered);
            assertThat(objectExists(bucket, stagedChunkKey)).isFalse();
            assertThat(artifactCount(tenant, artifactId)).isEqualTo(1);
            assertThat(requestFingerprint(tenant, upload.uploadId())).isEqualTo(fingerprint);
        } finally {
            dropChunkInsertFenceIfPresent();
            deleteBucketObjects(bucket);
        }
    }

    @Test
    void completionRejectsTamperedChunkKeyBeforeReadingOrPublishingForeignObject() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-s3-manifest-" + runId;
        String prefix = "ip06/manifest/" + runId;
        String tenant = "tenant-ip06-manifest-" + runId;
        String principal = "principal-ip06-manifest-" + runId;
        byte[] bytes = wav(("manifest-key-source:" + runId).getBytes(StandardCharsets.UTF_8));
        String digest = sha256(bytes);
        Map<String, String> environment = environment(bucket, prefix);
        createBucket(bucket);

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore()) {
            UploadRequest request = new UploadRequest(tenant, principal, "source.wav", "audio/wav", bytes.length,
                    digest, "RESTRICTED", Duration.ofDays(7),
                    Map.of("sourceArtifactId", "source-" + runId, "sourceVersion", "sha256:" + digest));
            UploadSession upload = store.begin(request, "ip06-manifest-upload-" + runId);
            store.append(tenant, principal, upload.uploadId(), 0, bytes);
            String artifactId = artifactIdForUpload(tenant, upload.uploadId());

            String foreignTenant = "other-tenant-" + runId;
            String foreignKey = prefix + "/uploads/" + opaque(foreignTenant) + "/foreign-upload/chunks/0";
            putObject(bucket, foreignKey, bytes);
            updateChunkObjectKey(tenant, upload.uploadId(), 0, foreignKey);

            assertThatThrownBy(() -> store.complete(tenant, principal, upload.uploadId()))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("unexpected object key");
            assertThat(artifactCount(tenant, artifactId)).isZero();
            assertThat(objectExists(bucket, foreignKey)).isTrue();

            // Restore the exact owned key and confirm normal completion remains possible.
            String ownedChunkKey = prefix + "/uploads/" + opaque(tenant) + "/" + upload.uploadId() + "/chunks/0";
            updateChunkObjectKey(tenant, upload.uploadId(), 0, ownedChunkKey);
            MediaArtifact recovered = store.complete(tenant, principal, upload.uploadId());
            assertThat(recovered.sha256()).isEqualTo(digest);
            assertThat(getObject(bucket, objectKey(recovered.objectReference()))).containsExactly(bytes);
            assertThat(objectExists(bucket, foreignKey)).isTrue();
        } finally {
            deleteBucketObjects(bucket);
        }
    }

    @Test
    void deduplicatedArtifactReplayRetriesCleanupOfItsOwnFinalObject() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-s3-dedupe-" + runId;
        String prefix = "ip06/dedupe/" + runId;
        String tenant = "tenant-ip06-dedupe-" + runId;
        String principal = "principal-ip06-dedupe-" + runId;
        byte[] bytes = wav(("ip06-dedupe-source:" + runId).getBytes(StandardCharsets.UTF_8));
        String digest = sha256(bytes);
        Map<String, String> environment = environment(bucket, prefix);
        createBucket(bucket);

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore()) {
            UploadRequest request = new UploadRequest(tenant, principal, "source.wav", "audio/wav", bytes.length,
                    digest, "RESTRICTED", Duration.ofDays(7),
                    Map.of("sourceArtifactId", "source-" + runId, "sourceVersion", "sha256:" + digest));

            UploadSession originalUpload = store.begin(request, "ip06-dedupe-original-" + runId);
            store.append(tenant, principal, originalUpload.uploadId(), 0, bytes);
            MediaArtifact canonical = store.complete(tenant, principal, originalUpload.uploadId());

            UploadSession duplicateUpload = store.begin(request, "ip06-dedupe-duplicate-" + runId);
            store.append(tenant, principal, duplicateUpload.uploadId(), 0, bytes);
            MediaArtifact deduplicated = store.complete(tenant, principal, duplicateUpload.uploadId());
            assertThat(deduplicated.artifactId()).isEqualTo(canonical.artifactId());

            String duplicateFinalKey = prefix + "/quarantine/finalized/" + opaque(tenant) + "/"
                    + duplicateUpload.uploadId() + "/" + digest;
            assertThat(objectExists(bucket, duplicateFinalKey)).isFalse();

            // Recreate the owned orphan to model a failed post-commit cleanup; exact replay must retry it.
            putObject(bucket, duplicateFinalKey, bytes);
            assertThat(objectExists(bucket, duplicateFinalKey)).isTrue();
            assertThat(store.complete(tenant, principal, duplicateUpload.uploadId())).isEqualTo(canonical);
            assertThat(objectExists(bucket, duplicateFinalKey)).isFalse();
            assertThat(artifactCount(tenant, canonical.artifactId())).isEqualTo(1);
        } finally {
            deleteBucketObjects(bucket);
        }
    }

    @Test
    void committedCompletionSurvivesOwnedChunkDeleteFailureAndReplayCleansOrphan() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-s3-delete-failure-" + runId;
        String prefix = "ip06/delete-failure/" + runId;
        String tenant = "tenant-ip06-delete-failure-" + runId;
        String principal = "principal-ip06-delete-failure-" + runId;
        byte[] bytes = wav(("delete-failure-source:" + runId).getBytes(StandardCharsets.UTF_8));
        String digest = sha256(bytes);
        Map<String, String> environment = environment(bucket, prefix);
        createBucket(bucket);
        AtomicReference<String> targetChunkKey = new AtomicReference<>();
        AtomicBoolean failFirstDelete = new AtomicBoolean(true);
        AtomicInteger matchingDeleteCalls = new AtomicInteger();

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment,
                     delegate -> failFirstDeleteForObject(delegate, targetChunkKey, failFirstDelete,
                             matchingDeleteCalls, bucket));
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore()) {
            UploadRequest request = new UploadRequest(tenant, principal, "source.wav", "audio/wav", bytes.length,
                    digest, "RESTRICTED", Duration.ofDays(7), Map.of());
            UploadSession upload = store.begin(request, "ip06-delete-failure-" + runId);
            store.append(tenant, principal, upload.uploadId(), 0, bytes);
            String fingerprint = requestFingerprint(tenant, upload.uploadId());
            String chunkKey = prefix + "/uploads/" + opaque(tenant) + "/" + upload.uploadId() + "/chunks/0";
            targetChunkKey.set(chunkKey);
            assertThat(objectExists(bucket, chunkKey)).isTrue();

            MediaArtifact committed = store.complete(tenant, principal, upload.uploadId());

            String artifactId = artifactIdForUpload(tenant, upload.uploadId());
            assertThat(committed.artifactId()).isEqualTo(artifactId);
            assertThat(committed.sha256()).isEqualTo(digest);
            assertThat(store.artifact(tenant, artifactId)).contains(committed);
            assertThat(artifactCount(tenant, artifactId)).isEqualTo(1);
            assertThat(requestFingerprint(tenant, upload.uploadId())).isEqualTo(fingerprint);
            assertThat(getObject(bucket, objectKey(committed.objectReference()))).containsExactly(bytes);
            assertThat(matchingDeleteCalls).hasValue(1);
            assertThat(objectExists(bucket, chunkKey))
                    .as("the injected S3 delete failure leaves the owned staged object for replay cleanup")
                    .isTrue();

            // The one-shot fault has cleared, so exact completion replay exercises cleanup recovery.
            assertThat(store.complete(tenant, principal, upload.uploadId())).isEqualTo(committed);
            assertThat(matchingDeleteCalls).hasValue(2);
            assertThat(objectExists(bucket, chunkKey)).isFalse();
            assertThat(artifactCount(tenant, artifactId)).isEqualTo(1);
            assertThat(requestFingerprint(tenant, upload.uploadId())).isEqualTo(fingerprint);
        } finally {
            deleteBucketObjects(bucket);
        }
    }

    @Test
    void artifactInsertFailureAfterS3FinalizeRetriesToOneParityCheckedArtifact() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-insfail-" + runId;
        String prefix = "ip06/insfail/" + runId;
        String tenant = "tenant-ip06-artifact-insert-failure-" + runId;
        String principal = "principal-ip06-artifact-insert-failure-" + runId;
        byte[] bytes = wav(("artifact-insert-failure-source:" + runId).getBytes(StandardCharsets.UTF_8));
        String digest = sha256(bytes);
        Map<String, String> environment = environment(bucket, prefix);
        createBucket(bucket);

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore()) {
            UploadRequest request = new UploadRequest(tenant, principal, "source.wav", "audio/wav", bytes.length,
                    digest, "RESTRICTED", Duration.ofDays(7), Map.of());
            UploadSession upload = store.begin(request, "ip06-artifact-insert-failure-" + runId);
            store.append(tenant, principal, upload.uploadId(), 0, bytes);
            String fingerprint = requestFingerprint(tenant, upload.uploadId());
            String finalKey = prefix + "/quarantine/finalized/" + opaque(tenant) + "/"
                    + upload.uploadId() + "/" + digest;
            String stagedChunkKey = prefix + "/uploads/" + opaque(tenant) + "/"
                    + upload.uploadId() + "/chunks/0";

            // Force the failure after multipart S3 finalization, when the final object
            // exists but artifact metadata has not crossed its database commit boundary.
            installArtifactInsertFailureFence();
            try {
                assertThatThrownBy(() -> store.complete(tenant, principal, upload.uploadId()))
                        .isInstanceOf(IllegalStateException.class)
                        .hasMessageContaining("persist Media artifact");
            } finally {
                dropArtifactInsertFailureFence();
            }

            assertThat(artifactIdForUpload(tenant, upload.uploadId())).isNull();
            assertThat(tenantArtifactCount(tenant)).isZero();
            assertThat(objectExists(bucket, finalKey))
                    .as("finalized bytes remain in the private quarantine namespace without DB publication")
                    .isTrue();
            byte[] stagedFinalBytes = getObject(bucket, finalKey);
            assertThat(stagedFinalBytes).containsExactly(bytes);
            assertThat(sha256(stagedFinalBytes)).isEqualTo(digest);
            assertThat(objectExists(bucket, stagedChunkKey)).isTrue();

            MediaArtifact recovered = store.complete(tenant, principal, upload.uploadId());

            String artifactId = recovered.artifactId();
            assertThat(artifactIdForUpload(tenant, upload.uploadId())).isEqualTo(artifactId);
            assertThat(recovered.tenantId()).isEqualTo(tenant);
            assertThat(recovered.principalId()).isEqualTo(principal);
            assertThat(recovered.sizeBytes()).isEqualTo(bytes.length);
            assertThat(recovered.sha256()).isEqualTo(digest);
            assertThat(objectKey(recovered.objectReference())).isEqualTo(finalKey);
            assertThat(store.artifact(tenant, artifactId)).contains(recovered);
            assertThat(artifactCount(tenant, artifactId)).isEqualTo(1);
            byte[] persistedBytes = getObject(bucket, objectKey(recovered.objectReference()));
            assertThat(persistedBytes).containsExactly(bytes);
            assertThat(sha256(persistedBytes)).isEqualTo(recovered.sha256());
            assertThat(objectExists(bucket, stagedChunkKey)).isFalse();
            assertThat(requestFingerprint(tenant, upload.uploadId())).isEqualTo(fingerprint);
        } finally {
            dropArtifactInsertFailureFenceIfPresent();
            deleteBucketObjects(bucket);
        }
    }

    @Test
    void lostS3FinalizeAcknowledgementReopensAndRetriesToOneParityCheckedArtifact() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-acklost-" + runId;
        String prefix = "ip06/acklost/" + runId;
        String tenant = "tenant-ip06-acklost-" + runId;
        String principal = "principal-ip06-acklost-" + runId;
        byte[] bytes = wav(("lost-s3-finalize-ack-source:" + runId).getBytes(StandardCharsets.UTF_8));
        String digest = sha256(bytes);
        Map<String, String> environment = environment(bucket, prefix);
        createBucket(bucket);
        AtomicReference<String> targetFinalKey = new AtomicReference<>();
        AtomicBoolean loseFirstAcknowledgement = new AtomicBoolean(true);
        AtomicInteger matchingFinalizeCalls = new AtomicInteger();
        String uploadId;
        String fingerprint;
        String finalKey;
        String stagedChunkKey;

        try {
            try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment,
                         delegate -> completeThenLoseAcknowledgement(
                                 delegate, targetFinalKey, loseFirstAcknowledgement, matchingFinalizeCalls, bucket));
                 S3PostgresqlMediaArtifactStore firstStore = new S3PostgresqlMediaArtifactStore()) {
                UploadRequest request = new UploadRequest(tenant, principal, "source.wav", "audio/wav", bytes.length,
                        digest, "RESTRICTED", Duration.ofDays(7), Map.of());
                UploadSession upload = firstStore.begin(request, "ip06-acklost-" + runId);
                uploadId = upload.uploadId();
                firstStore.append(tenant, principal, uploadId, 0, bytes);
                fingerprint = requestFingerprint(tenant, uploadId);
                finalKey = prefix + "/quarantine/finalized/" + opaque(tenant) + "/" + uploadId + "/" + digest;
                stagedChunkKey = prefix + "/uploads/" + opaque(tenant) + "/" + uploadId + "/chunks/0";
                targetFinalKey.set(finalKey);

                // LocalStack commits CompleteMultipartUpload, then the decorator loses
                // its acknowledgement as a network failure would. The store cannot know
                // whether the remote side effect happened and must leave metadata hidden.
                assertThatThrownBy(() -> firstStore.complete(tenant, principal, uploadId))
                        .isInstanceOf(S3Exception.class)
                        .hasMessageContaining("lost S3 CompleteMultipartUpload acknowledgement");
                assertThat(matchingFinalizeCalls).hasValue(1);
                assertThat(artifactIdForUpload(tenant, uploadId)).isNull();
                assertThat(tenantArtifactCount(tenant)).isZero();
                assertThat(firstStore.upload(tenant, uploadId).orElseThrow().status().name())
                        .isNotEqualTo("COMPLETED");
                assertThat(objectExists(bucket, finalKey)).isTrue();
                byte[] remoteCommittedBytes = getObject(bucket, finalKey);
                assertThat(remoteCommittedBytes).containsExactly(bytes);
                assertThat(sha256(remoteCommittedBytes)).isEqualTo(digest);
                assertThat(objectExists(bucket, stagedChunkKey)).isTrue();
            }

            // Close the provider lifecycle, reopen it against the same isolated DB, and
            // retry the same upload. The one-shot lost ACK is cleared, so this cold
            // provider readback must converge on one durable receipt.
            try (AutoCloseable restartedLifecycle = MediaAwsPostgresqlRuntimeState.installForTesting(environment,
                         delegate -> completeThenLoseAcknowledgement(
                                 delegate, targetFinalKey, loseFirstAcknowledgement, matchingFinalizeCalls, bucket));
                 S3PostgresqlMediaArtifactStore restarted = new S3PostgresqlMediaArtifactStore()) {
                MediaArtifact recovered = restarted.complete(tenant, principal, uploadId);
                String artifactId = recovered.artifactId();
                assertThat(artifactIdForUpload(tenant, uploadId)).isEqualTo(artifactId);
                assertThat(recovered.tenantId()).isEqualTo(tenant);
                assertThat(recovered.principalId()).isEqualTo(principal);
                assertThat(recovered.sizeBytes()).isEqualTo(bytes.length);
                assertThat(recovered.sha256()).isEqualTo(digest);
                assertThat(objectKey(recovered.objectReference())).isEqualTo(finalKey);
                assertThat(restarted.artifact(tenant, artifactId)).contains(recovered);
                assertThat(artifactCount(tenant, artifactId)).isEqualTo(1);
                byte[] persistedBytes = getObject(bucket, objectKey(recovered.objectReference()));
                assertThat(persistedBytes).containsExactly(bytes);
                assertThat(sha256(persistedBytes)).isEqualTo(recovered.sha256());
                assertThat(objectExists(bucket, stagedChunkKey)).isFalse();
                assertThat(requestFingerprint(tenant, uploadId)).isEqualTo(fingerprint);
            }
            assertThat(matchingFinalizeCalls).hasValue(2);
        } finally {
            deleteBucketObjects(bucket);
        }
    }

    private static Process startWorker(Map<String, String> environment, String applicationName,
            Path marker, Path log, String operation, Path payload, String tenant, String principal,
            String uploadId) throws Exception {
        String classpath = System.getProperty("media.child.classpath", "");
        if (classpath.isBlank()) throw new IllegalStateException("Gradle did not provide media.child.classpath");
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        ProcessBuilder builder = new ProcessBuilder(java.toString(), "-cp", classpath,
                MediaPostgresqlS3ProcessCrashWorker.class.getName(), operation, marker.toString(),
                payload.toString(), tenant, principal, uploadId);
        builder.environment().keySet().removeIf(key -> key.startsWith("MEDIA_"));
        builder.environment().putAll(environment);
        builder.environment().put("MEDIA_POSTGRES_JDBC_URL", withApplicationName(POSTGRES.getJdbcUrl(), applicationName));
        builder.redirectErrorStream(true);
        builder.redirectOutput(log.toFile());
        return builder.start();
    }

    private static void awaitMarker(Process process, Path marker, String expected, Path log) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            if (Files.exists(marker) && Files.readString(marker, StandardCharsets.UTF_8).contains(expected)) return;
            if (!process.isAlive()) throw new AssertionError("S3 crash worker exited before " + expected + ": " + logText(log));
            Thread.sleep(25);
        }
        throw new AssertionError("timed out waiting for " + expected + ": " + logText(log));
    }

    private static void awaitLockWait(String applicationName, Path log) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        try (Connection connection = databaseConnection();
             var query = connection.prepareStatement(
                     "SELECT COUNT(*) FROM pg_stat_activity WHERE application_name=? AND wait_event_type='Lock'")) {
            query.setString(1, applicationName);
            while (System.nanoTime() < deadline) {
                try (var rows = query.executeQuery()) {
                    rows.next();
                    if (rows.getLong(1) > 0) return;
                }
                Thread.sleep(25);
            }
        }
        throw new AssertionError("child did not reach S3/DB commit fence: " + logText(log));
    }

    private static void installChunkInsertFence() throws Exception {
        try (Connection connection = databaseConnection(); var statement = connection.createStatement()) {
            statement.execute("CREATE FUNCTION media_ip06_pause_chunk_insert() RETURNS trigger LANGUAGE plpgsql "
                    + "AS $$ BEGIN PERFORM pg_advisory_xact_lock(" + ADVISORY_LOCK_CLASS + "," + ADVISORY_LOCK_ID
                    + "); RETURN NEW; END; $$");
            statement.execute("CREATE TRIGGER media_ip06_pause_chunk_insert BEFORE INSERT ON media_upload_chunks "
                    + "FOR EACH ROW EXECUTE FUNCTION media_ip06_pause_chunk_insert()");
        }
    }

    private static void dropChunkInsertFence() throws Exception {
        try (Connection connection = databaseConnection(); var statement = connection.createStatement()) {
            statement.execute("DROP TRIGGER IF EXISTS media_ip06_pause_chunk_insert ON media_upload_chunks");
            statement.execute("DROP FUNCTION IF EXISTS media_ip06_pause_chunk_insert()");
        }
    }

    private static void dropChunkInsertFenceIfPresent() {
        try { dropChunkInsertFence(); } catch (Exception ignored) { /* Testcontainers disposes the isolated DB. */ }
    }

    private static void installArtifactInsertFailureFence() throws Exception {
        try (Connection connection = databaseConnection(); var statement = connection.createStatement()) {
            statement.execute("CREATE FUNCTION media_ip06_fail_artifact_insert() RETURNS trigger LANGUAGE plpgsql "
                    + "AS $$ BEGIN RAISE EXCEPTION 'injected IP-06 artifact metadata insert failure'; END; $$");
            statement.execute("CREATE TRIGGER media_ip06_fail_artifact_insert BEFORE INSERT ON media_artifacts "
                    + "FOR EACH ROW EXECUTE FUNCTION media_ip06_fail_artifact_insert()");
        }
    }

    private static void dropArtifactInsertFailureFence() throws Exception {
        try (Connection connection = databaseConnection(); var statement = connection.createStatement()) {
            statement.execute("DROP TRIGGER IF EXISTS media_ip06_fail_artifact_insert ON media_artifacts");
            statement.execute("DROP FUNCTION IF EXISTS media_ip06_fail_artifact_insert()");
        }
    }

    private static void dropArtifactInsertFailureFenceIfPresent() {
        try { dropArtifactInsertFailureFence(); }
        catch (Exception ignored) { /* Testcontainers disposes the isolated DB. */ }
    }

    private static int readChunkCount(String tenant, String uploadId) throws Exception {
        try (Connection connection = databaseConnection();
             var query = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_upload_chunks WHERE tenant_id=? AND upload_id=?")) {
            query.setString(1, tenant);
            query.setString(2, uploadId);
            try (var rows = query.executeQuery()) { rows.next(); return rows.getInt(1); }
        }
    }

    private static void updateChunkObjectKey(String tenant, String uploadId, int chunkIndex, String objectKey)
            throws Exception {
        try (Connection connection = databaseConnection();
             var update = connection.prepareStatement(
                     "UPDATE media_upload_chunks SET object_key=? WHERE tenant_id=? AND upload_id=? AND chunk_index=?")) {
            update.setString(1, objectKey);
            update.setString(2, tenant);
            update.setString(3, uploadId);
            update.setInt(4, chunkIndex);
            assertThat(update.executeUpdate()).isEqualTo(1);
        }
    }

    private static int artifactCount(String tenant, String artifactId) throws Exception {
        try (Connection connection = databaseConnection();
             var query = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=? AND artifact_id=?")) {
            query.setString(1, tenant);
            query.setString(2, artifactId);
            try (var rows = query.executeQuery()) { rows.next(); return rows.getInt(1); }
        }
    }

    private static int tenantArtifactCount(String tenant) throws Exception {
        try (Connection connection = databaseConnection();
             var query = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=?")) {
            query.setString(1, tenant);
            try (var rows = query.executeQuery()) { rows.next(); return rows.getInt(1); }
        }
    }

    private static String artifactIdForUpload(String tenant, String uploadId) throws Exception {
        try (Connection connection = databaseConnection();
             var query = connection.prepareStatement(
                     "SELECT artifact_id FROM media_upload_sessions WHERE tenant_id=? AND upload_id=?")) {
            query.setString(1, tenant);
            query.setString(2, uploadId);
            try (var rows = query.executeQuery()) { assertThat(rows.next()).isTrue(); return rows.getString(1); }
        }
    }

    private static String requestFingerprint(String tenant, String uploadId) throws Exception {
        try (Connection connection = databaseConnection();
             var query = connection.prepareStatement(
                     "SELECT request_fingerprint FROM media_upload_sessions WHERE tenant_id=? AND upload_id=?")) {
            query.setString(1, tenant);
            query.setString(2, uploadId);
            try (var rows = query.executeQuery()) { assertThat(rows.next()).isTrue(); return rows.getString(1); }
        }
    }

    private static String objectKey(String objectReference) {
        return java.net.URI.create(objectReference).getPath().substring(1);
    }

    private static String opaque(String value) { return sha256(value.getBytes(StandardCharsets.UTF_8)).substring(0, 32); }
    private static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    private static byte[] wav(byte[] payload) {
        byte[] bytes = new byte[44 + payload.length];
        bytes[0] = 'R'; bytes[1] = 'I'; bytes[2] = 'F'; bytes[3] = 'F';
        int fileSize = bytes.length - 8;
        bytes[4] = (byte) fileSize; bytes[5] = (byte) (fileSize >>> 8);
        bytes[6] = (byte) (fileSize >>> 16); bytes[7] = (byte) (fileSize >>> 24);
        bytes[8] = 'W'; bytes[9] = 'A'; bytes[10] = 'V'; bytes[11] = 'E';
        bytes[12] = 'f'; bytes[13] = 'm'; bytes[14] = 't'; bytes[15] = ' ';
        bytes[16] = 16; bytes[20] = 1; bytes[22] = 1; bytes[24] = 0x40; bytes[25] = 0x1f;
        bytes[28] = (byte) 0x80; bytes[29] = 0x3e; bytes[32] = 2; bytes[34] = 16;
        bytes[36] = 'd'; bytes[37] = 'a'; bytes[38] = 't'; bytes[39] = 'a';
        bytes[40] = (byte) payload.length; bytes[41] = (byte) (payload.length >>> 8);
        bytes[42] = (byte) (payload.length >>> 16); bytes[43] = (byte) (payload.length >>> 24);
        System.arraycopy(payload, 0, bytes, 44, payload.length);
        return bytes;
    }

    private static Map<String, String> environment(String bucket, String prefix) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_IP06_S3_DB_PASSWORD");
        environment.put("MEDIA_IP06_S3_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_PREFIX", prefix);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_IP06_S3_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_IP06_S3_SECRET");
        environment.put("MEDIA_IP06_S3_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_IP06_S3_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }

    private static void createBucket(String bucket) {
        try (S3Client client = s3Client()) { client.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
    }

    private static S3Client failFirstDeleteForObject(
            S3Client delegate,
            AtomicReference<String> targetKey,
            AtomicBoolean failFirstDelete,
            AtomicInteger matchingDeleteCalls,
            String bucket) {
        return (S3Client) Proxy.newProxyInstance(S3Client.class.getClassLoader(), new Class<?>[] {S3Client.class},
                (proxy, method, arguments) -> {
                    if (method.getName().equals("deleteObject") && arguments != null && arguments.length > 0
                            && arguments[0] instanceof DeleteObjectRequest request
                            && bucket.equals(request.bucket()) && request.key().equals(targetKey.get())) {
                        matchingDeleteCalls.incrementAndGet();
                        if (failFirstDelete.compareAndSet(true, false)) {
                            throw S3Exception.builder()
                                    .message("injected one-time IP-06 S3 DeleteObject failure")
                                    .statusCode(503)
                                    .build();
                        }
                    }
                    try {
                        return method.invoke(delegate, arguments);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    private static S3Client completeThenLoseAcknowledgement(
            S3Client delegate,
            AtomicReference<String> targetKey,
            AtomicBoolean loseAcknowledgement,
            AtomicInteger matchingCalls,
            String bucket) {
        return (S3Client) Proxy.newProxyInstance(S3Client.class.getClassLoader(), new Class<?>[] {S3Client.class},
                (proxy, method, arguments) -> {
                    if (method.getName().equals("completeMultipartUpload") && arguments != null
                            && arguments.length > 0
                            && arguments[0] instanceof software.amazon.awssdk.services.s3.model.CompleteMultipartUploadRequest request
                            && bucket.equals(request.bucket()) && request.key().equals(targetKey.get())) {
                        Object result;
                        try {
                            result = method.invoke(delegate, arguments);
                        } catch (InvocationTargetException failure) {
                            throw failure.getCause();
                        }
                        matchingCalls.incrementAndGet();
                        if (loseAcknowledgement.compareAndSet(true, false)) {
                            throw S3Exception.builder()
                                    .message("injected IP-06 lost S3 CompleteMultipartUpload acknowledgement")
                                    .statusCode(503)
                                    .build();
                        }
                        return result;
                    }
                    try {
                        return method.invoke(delegate, arguments);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    private static boolean objectExists(String bucket, String key) {
        try (S3Client client = s3Client()) {
            client.headObject(HeadObjectRequest.builder().bucket(bucket).key(key).build());
            return true;
        } catch (software.amazon.awssdk.services.s3.model.NoSuchKeyException missing) { return false; }
    }

    private static byte[] getObject(String bucket, String key) {
        try (S3Client client = s3Client()) {
            return client.getObject(GetObjectRequest.builder().bucket(bucket).key(key).build()).readAllBytes();
        } catch (java.io.IOException failure) { throw new AssertionError("S3 object read failed", failure); }
    }

    private static void putObject(String bucket, String key, byte[] bytes) {
        try (S3Client client = s3Client()) {
            client.putObject(PutObjectRequest.builder().bucket(bucket).key(key)
                    .contentLength((long) bytes.length).build(), RequestBody.fromBytes(bytes));
        }
    }

    private static void deleteBucketObjects(String bucket) {
        try (S3Client client = s3Client()) {
            for (var object : client.listObjectsV2(ListObjectsV2Request.builder().bucket(bucket).build()).contents()) {
                client.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(object.key()).build());
            }
            try { client.deleteBucket(b -> b.bucket(bucket)); } catch (RuntimeException ignored) { }
        } catch (RuntimeException ignored) { }
    }

    private static S3Client s3Client() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();
    }

    private static Connection databaseConnection() throws Exception {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private static String withApplicationName(String jdbcUrl, String applicationName) {
        return jdbcUrl + (jdbcUrl.contains("?") ? "&" : "?") + "ApplicationName=" + applicationName;
    }

    private static String logText(Path log) throws Exception {
        return Files.exists(log) ? Files.readString(log, StandardCharsets.UTF_8) : "<no child output>";
    }
}
