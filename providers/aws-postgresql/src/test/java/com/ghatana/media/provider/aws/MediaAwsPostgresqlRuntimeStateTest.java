package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.sync.ResponseTransformer;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.ListObjectsV2Request;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** End-to-end provider-state journey using H2 and a real S3-compatible LocalStack endpoint. */
class MediaAwsPostgresqlRuntimeStateTest {

    @Test
    void persistsChecksumVerifiedArtifactsIdempotentJobsAndLeasedStreams() throws Exception {
        try (LocalStackContainer localstack = new LocalStackContainer(
                DockerImageName.parse("localstack/localstack:2.3")).withServices(S3)) {
            localstack.start();
            String bucket = "media-runtime-" + UUID.randomUUID().toString().replace("-", "");
            try (S3Client admin = S3Client.builder()
                    .endpointOverride(localstack.getEndpointOverride(S3))
                    .region(Region.of(localstack.getRegion()))
                    .credentialsProvider(StaticCredentialsProvider.create(
                            AwsBasicCredentials.create(localstack.getAccessKey(), localstack.getSecretKey())))
                    .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                    .build()) {
                admin.createBucket(CreateBucketRequest.builder().bucket(bucket).build());

                Map<String, String> environment = new LinkedHashMap<>();
                environment.put("MEDIA_RUNTIME_ENVIRONMENT", "integration");
                environment.put("MEDIA_POSTGRES_JDBC_URL", "jdbc:h2:mem:media_"
                        + UUID.randomUUID().toString().replace("-", "")
                        + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
                environment.put("MEDIA_POSTGRES_DRIVER", "org.h2.Driver");
                environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
                environment.put("MEDIA_S3_BUCKET", bucket);
                environment.put("MEDIA_S3_ENDPOINT", localstack.getEndpointOverride(S3).toString());
                environment.put("MEDIA_S3_REGION", localstack.getRegion());
                environment.put("MEDIA_S3_PATH_STYLE", "true");
                environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
                environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:TEST_AWS_ACCESS_KEY");
                environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:TEST_AWS_SECRET_KEY");
                environment.put("TEST_AWS_ACCESS_KEY", localstack.getAccessKey());
                environment.put("TEST_AWS_SECRET_KEY", localstack.getSecretKey());

                try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
                     S3PostgresqlMediaArtifactStore artifacts = new S3PostgresqlMediaArtifactStore();
                     PostgresqlMediaJobStore jobs = new PostgresqlMediaJobStore();
                     PostgresqlMediaStreamSessionStore streams = new PostgresqlMediaStreamSessionStore()) {
                    assertThat(artifacts.ready()).isTrue();
                    assertThat(jobs.ready()).isTrue();
                    assertThat(streams.ready()).isTrue();

                    verifiesFailedAppendRemovesUnownedChunk(environment, admin, bucket, artifacts);

                    byte[] content = new byte[5 * 1024 * 1024 + 257];
                    Arrays.fill(content, (byte) 7);
                    String digest = sha256(content);
                    var upload = artifacts.begin(new UploadRequest(
                            "tenant-a", "principal-a", "clip.bin", "application/octet-stream", content.length,
                            digest, "restricted", Duration.ofDays(30), Map.of("source", "test")));
                    int split = 3 * 1024 * 1024;
                    artifacts.append("tenant-a", upload.uploadId(), 0, Arrays.copyOfRange(content, 0, split));
                    var progress = artifacts.append(
                            "tenant-a", upload.uploadId(), 1, Arrays.copyOfRange(content, split, content.length));
                    assertThat(progress.bytesReceived()).isEqualTo(content.length);
                    assertThat(artifacts.append(
                            "tenant-a", upload.uploadId(), 1,
                            Arrays.copyOfRange(content, split, content.length))).isEqualTo(progress);

                    var artifact = artifacts.complete("tenant-a", upload.uploadId());
                    assertThat(artifact.sha256()).isEqualTo(digest);
                    assertThat(artifact.principalId()).isEqualTo("principal-a");
                    assertThat(artifact.objectReference()).startsWith("s3://" + bucket + "/");
                    assertThat(artifact.expiresAt()).isAfter(Instant.now().plus(Duration.ofDays(29)));
                    assertThat(artifacts.artifact("tenant-b", artifact.artifactId())).isEmpty();
                    String objectKey = artifact.objectReference().substring(("s3://" + bucket + "/").length());
                    byte[] stored = admin.getObject(
                            GetObjectRequest.builder().bucket(bucket).key(objectKey).build(),
                            ResponseTransformer.toBytes()).asByteArray();
                    assertThat(stored).isEqualTo(content);

                    verifiesGovernedByteDeduplication(artifacts);
                    verifiesConcurrentGovernedByteDeduplication(artifacts);

                    ProcessingJob accepted = new ProcessingJob(
                            "job-a", "request-a", "tenant-a", "principal-a", artifact.artifactId(), JobType.VISION,
                            "http-media-processing", JobStatus.ACCEPTED,
                            Instant.now().truncatedTo(ChronoUnit.MILLIS), null, null,
                            Map.of(), "", 1);
                    assertThat(jobs.create(accepted)).isEqualTo(accepted);
                    ProcessingJob duplicateRequest = new ProcessingJob(
                            "job-other", "request-a", "tenant-a", "principal-a", artifact.artifactId(), JobType.VISION,
                            "http-media-processing", JobStatus.ACCEPTED, Instant.now(), null, null,
                            Map.of(), "", 1);
                    assertThat(jobs.create(duplicateRequest)).isEqualTo(accepted);
                    ProcessingJob replayedByOtherPrincipal = new ProcessingJob(
                            "job-replayed", "request-a", "tenant-a", "principal-b",
                            artifact.artifactId(), JobType.VISION, "http-media-processing",
                            JobStatus.ACCEPTED, Instant.now(), null, null, Map.of(), "", 1);
                    assertThatThrownBy(() -> jobs.create(replayedByOtherPrincipal))
                            .isInstanceOf(IllegalStateException.class)
                            .hasMessageContaining("reused");
                    var lease = jobs.claim(accepted, "worker-a", Instant.now().plusSeconds(60));
                    assertThat(jobs.leaseValid(lease)).isTrue();
                    assertThatThrownBy(() -> jobs.claim(
                            accepted, "worker-b", Instant.now().plusSeconds(60)))
                            .isInstanceOf(IllegalStateException.class)
                            .hasMessageContaining("another worker");
                    ProcessingJob running = new ProcessingJob(
                            accepted.jobId(), accepted.requestId(), accepted.tenantId(), accepted.principalId(), accepted.artifactId(),
                            accepted.jobType(), accepted.providerId(), JobStatus.RUNNING, accepted.createdAt(),
                            Instant.now().truncatedTo(ChronoUnit.MILLIS), null, Map.of(), "", 2);
                    assertThat(jobs.update(lease, accepted, running)).isEqualTo(running);
                    assertThat(jobs.leaseValid(lease)).isTrue();
                    try (var connection = DriverManager.getConnection(environment.get("MEDIA_POSTGRES_JDBC_URL"));
                         var expireLease = connection.prepareStatement(
                                 "UPDATE media_processing_jobs SET lease_expires_at=? WHERE tenant_id=? AND job_id=?")) {
                        expireLease.setLong(1, Instant.now().minusSeconds(1).toEpochMilli());
                        expireLease.setString(2, running.tenantId());
                        expireLease.setString(3, running.jobId());
                        assertThat(expireLease.executeUpdate()).isEqualTo(1);
                    }
                    var replacementLease = jobs.claim(running, "worker-b", Instant.now().plusSeconds(60));
                    ProcessingJob staleCompletion = new ProcessingJob(
                            running.jobId(), running.requestId(), running.tenantId(), running.principalId(), running.artifactId(),
                            running.jobType(), running.providerId(), JobStatus.COMPLETED, running.createdAt(),
                            running.startedAt(), Instant.now().truncatedTo(ChronoUnit.MILLIS), Map.of(), "", 3);
                    assertThatThrownBy(() -> jobs.update(lease, running, staleCompletion))
                            .isInstanceOf(IllegalStateException.class)
                            .hasMessageContaining("lease fence");
                    ProcessingJob replacementRunning = new ProcessingJob(
                            running.jobId(), running.requestId(), running.tenantId(), running.principalId(), running.artifactId(),
                            running.jobType(), running.providerId(), JobStatus.RUNNING, running.createdAt(),
                            running.startedAt(), null, Map.of(), "", 3);
                    assertThat(jobs.update(replacementLease, running, replacementRunning)).isEqualTo(replacementRunning);
                    assertThat(jobs.find("tenant-a", running.jobId())).contains(replacementRunning);
                    jobs.release(replacementLease);
                    jobs.release(lease);
                    assertThat(jobs.leaseValid(lease)).isFalse();
                    assertThat(jobs.recoverable(10)).contains(replacementRunning);
                    assertThatThrownBy(() -> jobs.update(running, replacementRunning))
                            .isInstanceOf(IllegalStateException.class)
                            .hasMessageContaining("version changed");
                    assertThat(jobs.find("tenant-b", accepted.jobId())).isEmpty();

                    String rawToken = "stream-token-a";
                    String tokenHash = sha256(rawToken.getBytes(StandardCharsets.UTF_8));
                    Instant now = Instant.now().truncatedTo(ChronoUnit.MILLIS);
                    StreamSession opened = new StreamSession(
                            "tenant-a", "stream-a", "principal-a", StreamKind.VIDEO,
                            "http-media-streaming", StreamState.OPEN, -1, 0, 1024, 0,
                            null, now, now, null, Map.of("correlationId", "corr-a"), 1);
                    assertThat(streams.create(opened, tokenHash)).isEqualTo(opened);
                    assertThat(streams.find("tenant-b", "stream-a")).isEmpty();
                    assertThatThrownBy(() -> streams.connect(
                            opened, "0".repeat(64), Instant.now().plusSeconds(60)))
                            .isInstanceOf(SecurityException.class);
                    StreamSession connected = streams.connect(
                            opened, tokenHash, Instant.now().plusSeconds(60));
                    assertThat(connected.state()).isEqualTo(StreamState.CONNECTED);
                    assertThat(connected.reconnectCount()).isEqualTo(1);
                    StreamSession frameZero = streams.recordFrame(connected, 0, 128, false);
                    assertThat(frameZero.lastSequence()).isZero();
                    assertThat(frameZero.bufferedBytes()).isEqualTo(128);
                    assertThatThrownBy(() -> streams.recordFrame(frameZero, 2, 256, false))
                            .isInstanceOf(IllegalArgumentException.class)
                            .hasMessageContaining("not contiguous");
                    StreamSession draining = streams.recordFrame(frameZero, 1, 0, true);
                    assertThat(draining.state()).isEqualTo(StreamState.DRAINING);
                    assertThatThrownBy(() -> streams.connect(
                            draining, tokenHash, Instant.now().plusSeconds(60)))
                            .isInstanceOf(IllegalStateException.class)
                            .hasMessageContaining("cannot connect");
                    StreamSession closed = streams.transition(draining, StreamState.CLOSED);
                    assertThat(closed.closedAt()).isNotNull();
                    assertThat(streams.find("tenant-a", "stream-a")).contains(closed);
                    try (PostgresqlMediaStreamSessionStore restartedStreams =
                                 new PostgresqlMediaStreamSessionStore()) {
                        assertThat(restartedStreams.find("tenant-a", "stream-a"))
                                .contains(closed);
                        assertThatThrownBy(() -> restartedStreams.connect(
                                closed, tokenHash, Instant.now().plusSeconds(60)))
                                .isInstanceOf(IllegalStateException.class)
                                .hasMessageContaining("cannot connect");
                    }

                    verifiesPhysicalRetentionDeletesBlobsAndDerivedRuntimeState(
                            environment, admin, bucket, artifacts, jobs, streams,
                            artifact, objectKey, replacementRunning, closed);
                    ProcessingJob unknownAccepted = new ProcessingJob(
                            "job-unknown", "request-unknown", "tenant-a", "principal-a",
                            artifact.artifactId(), JobType.VISION, "http-media-processing",
                            JobStatus.ACCEPTED, Instant.now().truncatedTo(ChronoUnit.MILLIS),
                            null, null, Map.of(), "", 1);
                    assertThat(jobs.create(unknownAccepted)).isEqualTo(unknownAccepted);
                    var unknownLease = jobs.claim(unknownAccepted, "worker-before-reconciliation",
                            Instant.now().plusSeconds(60));
                    ProcessingJob unknownFromLeased = new ProcessingJob(
                            unknownAccepted.jobId(), unknownAccepted.requestId(), unknownAccepted.tenantId(),
                            unknownAccepted.principalId(), unknownAccepted.artifactId(), unknownAccepted.jobType(),
                            unknownAccepted.providerId(), JobStatus.OUTCOME_UNKNOWN, unknownAccepted.createdAt(),
                            null, null, Map.of("reconciliation", "provider outcome unknown after runtime restart"),
                            "", 2);
                    assertThat(jobs.update(unknownAccepted, unknownFromLeased)).isEqualTo(unknownFromLeased);
                    assertThat(jobs.leaseValid(unknownLease)).isFalse();
                    assertThat(jobs.recoverable(10)).doesNotContain(unknownFromLeased);
                    assertThatThrownBy(() -> jobs.claim(
                            unknownFromLeased, "worker-after-restart", Instant.now().plusSeconds(60)))
                            .isInstanceOf(IllegalStateException.class)
                            .hasMessageContaining("cannot be leased");
                }
            }
        }
    }

    private static void verifiesPhysicalRetentionDeletesBlobsAndDerivedRuntimeState(
            Map<String, String> environment,
            S3Client admin,
            String bucket,
            S3PostgresqlMediaArtifactStore artifacts,
            PostgresqlMediaJobStore jobs,
            PostgresqlMediaStreamSessionStore streams,
            MediaArtifact artifact,
            String artifactObjectKey,
            ProcessingJob running,
            StreamSession closed) throws Exception {
        byte[] abandonedBytes = "expired-abandoned-upload".getBytes(StandardCharsets.UTF_8);
        UploadSession abandoned = artifacts.begin(new UploadRequest(
                "tenant-expired", "principal-expired", "expired.bin", "application/octet-stream",
                abandonedBytes.length, sha256(abandonedBytes), "restricted", Duration.ofDays(1), Map.of()));
        artifacts.append("tenant-expired", abandoned.uploadId(), 0, abandonedBytes);

        Instant completedAt = Instant.now().truncatedTo(ChronoUnit.MILLIS);
        ProcessingJob completed = new ProcessingJob(
                running.jobId(), running.requestId(), running.tenantId(), running.principalId(),
                running.artifactId(), running.jobType(), running.providerId(), JobStatus.COMPLETED,
                running.createdAt(), running.startedAt(), completedAt,
                Map.of("derivedFaceCount", 2, "transcriptSummary", "sensitive-result"), "", running.version() + 1);
        assertThat(jobs.update(running, completed)).isEqualTo(completed);

        long expiredAt = Instant.now().minus(Duration.ofDays(2)).toEpochMilli();
        try (var connection = DriverManager.getConnection(environment.get("MEDIA_POSTGRES_JDBC_URL"))) {
            try (var statement = connection.prepareStatement(
                    "UPDATE media_artifacts SET expires_at=? WHERE tenant_id=? AND artifact_id=?")) {
                statement.setLong(1, expiredAt);
                statement.setString(2, artifact.tenantId());
                statement.setString(3, artifact.artifactId());
                assertThat(statement.executeUpdate()).isEqualTo(1);
            }
            try (var statement = connection.prepareStatement(
                    "UPDATE media_upload_sessions SET expires_at=? WHERE tenant_id=? AND upload_id=?")) {
                statement.setLong(1, expiredAt);
                statement.setString(2, "tenant-expired");
                statement.setString(3, abandoned.uploadId());
                assertThat(statement.executeUpdate()).isEqualTo(1);
            }
            try (var statement = connection.prepareStatement(
                    "UPDATE media_processing_jobs SET completed_at=? WHERE tenant_id=? AND job_id=?")) {
                statement.setLong(1, expiredAt);
                statement.setString(2, completed.tenantId());
                statement.setString(3, completed.jobId());
                assertThat(statement.executeUpdate()).isEqualTo(1);
            }
            try (var statement = connection.prepareStatement(
                    "UPDATE media_stream_sessions SET closed_at=? WHERE tenant_id=? AND session_id=?")) {
                statement.setLong(1, expiredAt);
                statement.setString(2, closed.tenantId());
                statement.setString(3, closed.sessionId());
                assertThat(statement.executeUpdate()).isEqualTo(1);
            }
        }

        Map<String, String> maintenanceEnvironment = new LinkedHashMap<>(environment);
        maintenanceEnvironment.put("MEDIA_PRIVACY_PURGE_BATCH_SIZE", "100");
        maintenanceEnvironment.put("MEDIA_JOB_RETENTION_DAYS", "1");
        maintenanceEnvironment.put("MEDIA_STREAM_RETENTION_DAYS", "1");
        try (PostgresqlMediaPrivacyMaintenance maintenance =
                     new PostgresqlMediaPrivacyMaintenance(maintenanceEnvironment)) {
            var report = maintenance.purgeExpired(Instant.now());
            assertThat(report.artifactsDeleted()).isEqualTo(1);
            assertThat(report.uploadsDeleted()).isEqualTo(1);
            assertThat(report.chunksDeleted()).isEqualTo(1);
            assertThat(report.jobsDeleted()).isEqualTo(1);
            assertThat(report.streamsDeleted()).isEqualTo(1);
        }

        assertThat(artifacts.artifact(artifact.tenantId(), artifact.artifactId())).isEmpty();
        assertThat(artifacts.upload("tenant-expired", abandoned.uploadId())).isEmpty();
        assertThat(jobs.find(completed.tenantId(), completed.jobId())).isEmpty();
        assertThat(streams.find(closed.tenantId(), closed.sessionId())).isEmpty();
        assertThat(admin.listObjectsV2(ListObjectsV2Request.builder().bucket(bucket).build()).contents())
                .noneMatch(object -> object.key().equals(artifactObjectKey))
                .noneMatch(object -> object.key().contains(abandoned.uploadId()));

        verifiesArtifactRenewalCannotRaceBlobDeletion(environment, admin, artifacts, bucket);
        verifiesActiveUploadCannotRaceChunkDeletion(environment, admin, artifacts, bucket);
        verifiesRetryReconcilesArtifactAfterObjectWasAlreadyDeleted(environment, admin, artifacts, bucket);
    }

    /** Injects a metadata-delete failure after S3 deletion, then verifies purge retry recovery. */
    private static void verifiesRetryReconcilesArtifactAfterObjectWasAlreadyDeleted(
            Map<String, String> environment,
            S3Client admin,
            S3PostgresqlMediaArtifactStore artifacts,
            String bucket) throws Exception {
        MediaArtifact artifact = upload(
                artifacts, "purge-retry-after-object-delete".getBytes(StandardCharsets.UTF_8),
                "retry.bin", "application/octet-stream", "restricted", Duration.ofDays(30), Map.of());
        String key = objectKey(artifact.objectReference());
        try (var connection = DriverManager.getConnection(environment.get("MEDIA_POSTGRES_JDBC_URL"));
             var update = connection.prepareStatement(
                     "UPDATE media_artifacts SET expires_at=? WHERE tenant_id=? AND artifact_id=?")) {
            update.setLong(1, Instant.now().minus(Duration.ofDays(2)).toEpochMilli());
            update.setString(2, artifact.tenantId());
            update.setString(3, artifact.artifactId());
            assertThat(update.executeUpdate()).isEqualTo(1);
        }

        try (var connection = DriverManager.getConnection(environment.get("MEDIA_POSTGRES_JDBC_URL"));
             var statement = connection.createStatement()) {
            statement.execute("CREATE TRIGGER fail_media_artifact_delete BEFORE DELETE ON media_artifacts "
                    + "FOR EACH ROW CALL 'com.ghatana.media.provider.aws.MediaAwsPostgresqlRuntimeStateTest$"
                    + "FailArtifactDeleteTrigger'");
        }
        Map<String, String> maintenanceEnvironment = new LinkedHashMap<>(environment);
        try (PostgresqlMediaPrivacyMaintenance maintenance =
                     new PostgresqlMediaPrivacyMaintenance(maintenanceEnvironment)) {
            assertThatThrownBy(() -> maintenance.purgeExpired(Instant.now()))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("delete expired Media artifact metadata");
        }
        assertThat(artifactRowExists(environment, artifact)).isTrue();
        assertThatThrownBy(() -> admin.headObject(HeadObjectRequest.builder().bucket(bucket).key(key).build()))
                .isInstanceOf(software.amazon.awssdk.services.s3.model.NoSuchKeyException.class);

        try (var connection = DriverManager.getConnection(environment.get("MEDIA_POSTGRES_JDBC_URL"));
             var statement = connection.createStatement()) {
            statement.execute("DROP TRIGGER fail_media_artifact_delete");
        }
        try (PostgresqlMediaPrivacyMaintenance maintenance =
                     new PostgresqlMediaPrivacyMaintenance(maintenanceEnvironment)) {
            assertThat(maintenance.purgeExpired(Instant.now()).artifactsDeleted()).isEqualTo(1);
        }
        assertThat(artifactRowExists(environment, artifact)).isFalse();
        assertThatThrownBy(() -> admin.headObject(HeadObjectRequest.builder().bucket(bucket).key(key).build()))
                .isInstanceOf(software.amazon.awssdk.services.s3.model.NoSuchKeyException.class);
    }

    /** Test-only H2 fault injection for the metadata half of the S3/PostgreSQL purge sequence. */
    public static final class FailArtifactDeleteTrigger implements org.h2.api.Trigger {
        @Override public void init(java.sql.Connection connection, String schemaName, String triggerName,
                                   String tableName, boolean before, int type) { }

        @Override public void fire(java.sql.Connection connection, Object[] oldRow, Object[] newRow)
                throws java.sql.SQLException {
            throw new java.sql.SQLException("injected metadata deletion failure");
        }

        @Override public void close() { }
        @Override public void remove() { }
    }

    private static boolean artifactRowExists(Map<String, String> environment, MediaArtifact artifact)
            throws Exception {
        try (var connection = DriverManager.getConnection(environment.get("MEDIA_POSTGRES_JDBC_URL"));
             var statement = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=? AND artifact_id=?")) {
            statement.setString(1, artifact.tenantId());
            statement.setString(2, artifact.artifactId());
            try (var result = statement.executeQuery()) {
                result.next();
                return result.getInt(1) == 1;
            }
        }
    }

    private static void verifiesArtifactRenewalCannotRaceBlobDeletion(
            Map<String, String> environment,
            S3Client admin,
            S3PostgresqlMediaArtifactStore artifacts,
            String bucket) throws Exception {
        MediaArtifact artifact = upload(
                artifacts, "renew-during-purge".getBytes(StandardCharsets.UTF_8),
                "renew.bin", "application/octet-stream", "restricted", Duration.ofDays(30), Map.of());
        long expiredAt = Instant.now().minus(Duration.ofDays(2)).toEpochMilli();
        long renewedUntil = Instant.now().plus(Duration.ofDays(30)).toEpochMilli();
        String jdbcUrl = environment.get("MEDIA_POSTGRES_JDBC_URL");
        // Commit the expired state first so the purge's initial candidate scan can see it.
        try (var expire = DriverManager.getConnection(jdbcUrl);
             var update = expire.prepareStatement(
                     "UPDATE media_artifacts SET expires_at=? WHERE tenant_id=? AND artifact_id=?")) {
            update.setLong(1, expiredAt);
            update.setString(2, artifact.tenantId());
            update.setString(3, artifact.artifactId());
            assertThat(update.executeUpdate()).isEqualTo(1);
        }

        try (var renewal = DriverManager.getConnection(jdbcUrl)) {
            renewal.setAutoCommit(false);
            try (var update = renewal.prepareStatement(
                    "UPDATE media_artifacts SET expires_at=? WHERE tenant_id=? AND artifact_id=?")) {
                update.setLong(1, renewedUntil);
                update.setString(2, artifact.tenantId());
                update.setString(3, artifact.artifactId());
                assertThat(update.executeUpdate()).isEqualTo(1);
            }

            // Prove the same non-locking candidate scan used by purge still observes the
            // committed expired version while the renewal transaction has an uncommitted future
            // expiry. This makes the ordering precondition explicit for the concurrency check.
            try (var scan = DriverManager.getConnection(jdbcUrl);
                 var candidates = scan.prepareStatement(
                         "SELECT tenant_id,artifact_id FROM media_artifacts "
                                 + "WHERE tenant_id=? AND artifact_id=? AND expires_at<=? "
                                 + "ORDER BY expires_at LIMIT ?")) {
                candidates.setString(1, artifact.tenantId());
                candidates.setString(2, artifact.artifactId());
                candidates.setLong(3, Instant.now().toEpochMilli());
                candidates.setInt(4, 100);
                try (var rows = candidates.executeQuery()) {
                    assertThat(rows.next()).isTrue();
                    assertThat(rows.getString("tenant_id")).isEqualTo(artifact.tenantId());
                    assertThat(rows.getString("artifact_id")).isEqualTo(artifact.artifactId());
                }
            }

            Map<String, String> maintenanceEnvironment = new LinkedHashMap<>(environment);
            maintenanceEnvironment.put("MEDIA_PRIVACY_PURGE_BATCH_SIZE", "100");
            try (PostgresqlMediaPrivacyMaintenance maintenance =
                         new PostgresqlMediaPrivacyMaintenance(maintenanceEnvironment);
                 ExecutorService executor = Executors.newSingleThreadExecutor()) {
                Future<?> purge = executor.submit(() -> maintenance.purgeExpired(Instant.now()));
                // The purge first sees the committed expired value, then must wait on this row
                // lock before it can remove the object. Under the former implementation it
                // deleted the S3 object while waiting on the later metadata DELETE.
                awaitBlockedStatement(jdbcUrl, "SELECT OBJECT_REFERENCE FROM MEDIA_ARTIFACTS");
                assertThat(admin.headObject(HeadObjectRequest.builder()
                        .bucket(bucket).key(objectKey(artifact.objectReference())).build()).contentLength())
                        .isGreaterThan(0);
                renewal.commit();
                purge.get(10, TimeUnit.SECONDS);
            } catch (Exception failure) {
                renewal.rollback();
                throw failure;
            }
        }
        assertThat(artifacts.artifact(artifact.tenantId(), artifact.artifactId())).isPresent();
        assertThat(admin.headObject(HeadObjectRequest.builder()
                .bucket(bucket).key(objectKey(artifact.objectReference())).build()).contentLength())
                .isGreaterThan(0);
    }

    private static String objectKey(String objectReference) {
        return java.net.URI.create(objectReference).getPath().substring(1);
    }

    private static void awaitBlockedStatement(String jdbcUrl, String statementFragment) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        String pattern = "%" + statementFragment.toLowerCase(java.util.Locale.ROOT) + "%";
        while (System.nanoTime() < deadline) {
            try (var connection = DriverManager.getConnection(jdbcUrl);
                 var statement = connection.prepareStatement(
                         "SELECT COUNT(*) FROM INFORMATION_SCHEMA.SESSIONS "
                                 + "WHERE BLOCKER_ID IS NOT NULL AND LOWER(EXECUTING_STATEMENT) LIKE ?")) {
                statement.setString(1, pattern);
                try (var result = statement.executeQuery()) {
                    result.next();
                    if (result.getInt(1) > 0) return;
                }
            }
            Thread.sleep(20);
        }
        throw new AssertionError("Timed out waiting for purge to block on SQL: " + statementFragment);
    }

    private static void verifiesActiveUploadCannotRaceChunkDeletion(
            Map<String, String> environment,
            S3Client admin,
            S3PostgresqlMediaArtifactStore artifacts,
            String bucket) throws Exception {
        byte[] chunk = "active-finalization-chunk".getBytes(StandardCharsets.UTF_8);
        UploadSession upload = artifacts.begin(new UploadRequest(
                "tenant-active-finalization", "principal-active-finalization", "finalizing.bin",
                "application/octet-stream", chunk.length, sha256(chunk), "restricted",
                Duration.ofDays(30), Map.of()));
        artifacts.append(upload.tenantId(), upload.uploadId(), 0, chunk);

        String jdbcUrl = environment.get("MEDIA_POSTGRES_JDBC_URL");
        String chunkObjectKey;
        try (var connection = DriverManager.getConnection(jdbcUrl);
             var statement = connection.prepareStatement(
                     "SELECT object_key FROM media_upload_chunks WHERE tenant_id=? AND upload_id=?")) {
            statement.setString(1, upload.tenantId());
            statement.setString(2, upload.uploadId());
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).isTrue();
                chunkObjectKey = rows.getString("object_key");
            }
        }

        long expiredAt = Instant.now().minus(Duration.ofDays(2)).toEpochMilli();
        try (var expire = DriverManager.getConnection(jdbcUrl);
             var update = expire.prepareStatement(
                     "UPDATE media_upload_sessions SET expires_at=? WHERE tenant_id=? AND upload_id=?")) {
            update.setLong(1, expiredAt);
            update.setString(2, upload.tenantId());
            update.setString(3, upload.uploadId());
            assertThat(update.executeUpdate()).isEqualTo(1);
        }

        long renewedUntil = Instant.now().plus(Duration.ofDays(30)).toEpochMilli();
        long finalizationStarted = Instant.now().toEpochMilli();
        try (var finalization = DriverManager.getConnection(jdbcUrl)) {
            finalization.setAutoCommit(false);
            try (var update = finalization.prepareStatement(
                    "UPDATE media_upload_sessions SET expires_at=?,status='FINALIZING',"
                            + "finalization_started_at=? WHERE tenant_id=? AND upload_id=?")) {
                update.setLong(1, renewedUntil);
                update.setLong(2, finalizationStarted);
                update.setString(3, upload.tenantId());
                update.setString(4, upload.uploadId());
                assertThat(update.executeUpdate()).isEqualTo(1);
            }

            // Verify the purge's non-locking candidate predicate sees the committed expired OPEN
            // state despite this transaction's uncommitted future expiry and FINALIZING state.
            try (var scan = DriverManager.getConnection(jdbcUrl);
                 var candidates = scan.prepareStatement(
                         "SELECT tenant_id,upload_id FROM media_upload_sessions "
                                 + "WHERE tenant_id=? AND upload_id=? AND expires_at<=? "
                                 + "AND (status<>'FINALIZING' OR finalization_started_at<=?) "
                                 + "ORDER BY expires_at LIMIT ?")) {
                candidates.setString(1, upload.tenantId());
                candidates.setString(2, upload.uploadId());
                candidates.setLong(3, Instant.now().toEpochMilli());
                candidates.setLong(4, Instant.now().minus(Duration.ofMinutes(15)).toEpochMilli());
                candidates.setInt(5, 100);
                try (var rows = candidates.executeQuery()) {
                    assertThat(rows.next()).isTrue();
                    assertThat(rows.getString("tenant_id")).isEqualTo(upload.tenantId());
                    assertThat(rows.getString("upload_id")).isEqualTo(upload.uploadId());
                }
            }

            Map<String, String> maintenanceEnvironment = new LinkedHashMap<>(environment);
            maintenanceEnvironment.put("MEDIA_PRIVACY_PURGE_BATCH_SIZE", "100");
            try (PostgresqlMediaPrivacyMaintenance maintenance =
                         new PostgresqlMediaPrivacyMaintenance(maintenanceEnvironment);
                 ExecutorService executor = Executors.newSingleThreadExecutor()) {
                Future<?> purge = executor.submit(() -> maintenance.purgeExpired(Instant.now()));
                // The prior implementation deleted this object before waiting on the locked
                // upload row during metadata deletion. The fenced path waits before deleting it.
                awaitBlockedStatement(jdbcUrl,
                        "SELECT EXPIRES_AT,STATUS,FINALIZATION_STARTED_AT FROM MEDIA_UPLOAD_SESSIONS");
                assertThat(admin.headObject(HeadObjectRequest.builder()
                        .bucket(bucket).key(chunkObjectKey).build()).contentLength()).isEqualTo((long) chunk.length);
                finalization.commit();
                purge.get(10, TimeUnit.SECONDS);
            } catch (Exception failure) {
                finalization.rollback();
                throw failure;
            }
        }
        assertThat(admin.headObject(HeadObjectRequest.builder()
                .bucket(bucket).key(chunkObjectKey).build()).contentLength()).isEqualTo((long) chunk.length);
        assertThat(artifacts.upload(upload.tenantId(), upload.uploadId())).isPresent();
    }

    private static void verifiesFailedAppendRemovesUnownedChunk(
            Map<String, String> environment,
            S3Client admin,
            String bucket,
            S3PostgresqlMediaArtifactStore artifacts) throws Exception {
        byte[] bytes = "rollback-cleanup".getBytes(StandardCharsets.UTF_8);
        UploadSession upload = artifacts.begin(new UploadRequest(
                "tenant-rollback", "principal-rollback", "rollback.bin", "application/octet-stream", bytes.length,
                sha256(bytes), "restricted", Duration.ofDays(1), Map.of("source", "rollback")));
        String jdbcUrl = environment.get("MEDIA_POSTGRES_JDBC_URL");
        try (var connection = DriverManager.getConnection(jdbcUrl);
             var statement = connection.createStatement()) {
            statement.execute("ALTER TABLE media_upload_sessions ADD CONSTRAINT "
                    + "media_chunk_progress_guard CHECK (next_chunk_index = 0)");
        }
        try {
            assertThatThrownBy(() -> artifacts.append(
                    "tenant-rollback", upload.uploadId(), 0, bytes))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("append Media upload chunk");
        } finally {
            try (var connection = DriverManager.getConnection(jdbcUrl);
                 var statement = connection.createStatement()) {
                statement.execute("ALTER TABLE media_upload_sessions DROP CONSTRAINT "
                        + "media_chunk_progress_guard");
            }
        }

        UploadSession unchanged = artifacts.upload("tenant-rollback", upload.uploadId()).orElseThrow();
        assertThat(unchanged.bytesReceived()).isZero();
        assertThat(unchanged.nextChunkIndex()).isZero();
        assertThat(admin.listObjectsV2(ListObjectsV2Request.builder().bucket(bucket).build()).contents())
                .noneMatch(object -> object.key().contains(upload.uploadId()));
    }

    private static void verifiesGovernedByteDeduplication(
            S3PostgresqlMediaArtifactStore artifacts) throws Exception {
        byte[] bytes = "governed-deduplication".getBytes(StandardCharsets.UTF_8);
        Map<String, Object> metadata = Map.of("source", "dedup", "consent", "verified");
        MediaArtifact original = upload(
                artifacts, bytes, "dedup.bin", "application/octet-stream",
                "restricted", Duration.ofDays(30), metadata);
        MediaArtifact compatible = upload(
                artifacts, bytes, "dedup.bin", "application/octet-stream",
                "restricted", Duration.ofDays(29), metadata);
        assertThat(compatible.artifactId()).isEqualTo(original.artifactId());

        assertConflict(artifacts, bytes, "different.bin", "application/octet-stream",
                "restricted", Duration.ofDays(29), metadata, "fileName");
        assertConflict(artifacts, bytes, "dedup.bin", "text/plain",
                "restricted", Duration.ofDays(29), metadata, "contentType");
        assertConflict(artifacts, bytes, "dedup.bin", "application/octet-stream",
                "internal", Duration.ofDays(29), metadata, "classification");
        assertConflict(artifacts, bytes, "dedup.bin", "application/octet-stream",
                "restricted", Duration.ofDays(29), Map.of("source", "other"), "metadata");
        assertConflict(artifacts, bytes, "dedup.bin", "application/octet-stream",
                "restricted", Duration.ofDays(31), metadata, "retention");
    }

    private static void verifiesConcurrentGovernedByteDeduplication(
            S3PostgresqlMediaArtifactStore artifacts) throws Exception {
        byte[] bytes = "concurrent-governed-deduplication".getBytes(StandardCharsets.UTF_8);
        Map<String, Object> metadata = Map.of("source", "concurrent-dedup", "consent", "verified");
        UploadSession first = prepareUpload(
                artifacts, bytes, "concurrent.bin", "application/octet-stream",
                "restricted", Duration.ofDays(30), metadata);
        UploadSession second = prepareUpload(
                artifacts, bytes, "concurrent.bin", "application/octet-stream",
                "restricted", Duration.ofDays(30), metadata);

        ExecutorService executor = Executors.newFixedThreadPool(2);
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            Future<MediaArtifact> firstResult = executor.submit(
                    () -> completeAfterBarrier(artifacts, first, ready, start));
            Future<MediaArtifact> secondResult = executor.submit(
                    () -> completeAfterBarrier(artifacts, second, ready, start));
            assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            MediaArtifact firstArtifact = firstResult.get(60, TimeUnit.SECONDS);
            MediaArtifact secondArtifact = secondResult.get(60, TimeUnit.SECONDS);
            assertThat(secondArtifact.artifactId()).isEqualTo(firstArtifact.artifactId());
        } finally {
            start.countDown();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(10, TimeUnit.SECONDS)).isTrue();
        }
    }

    private static MediaArtifact completeAfterBarrier(
            S3PostgresqlMediaArtifactStore artifacts,
            UploadSession upload,
            CountDownLatch ready,
            CountDownLatch start) throws Exception {
        ready.countDown();
        if (!start.await(10, TimeUnit.SECONDS)) {
            throw new IllegalStateException("Concurrent Media deduplication barrier timed out");
        }
        return artifacts.complete("tenant-dedup", upload.uploadId());
    }

    private static UploadSession prepareUpload(
            S3PostgresqlMediaArtifactStore artifacts,
            byte[] bytes,
            String fileName,
            String contentType,
            String classification,
            Duration retention,
            Map<String, Object> metadata) throws Exception {
        UploadSession upload = artifacts.begin(new UploadRequest(
                "tenant-dedup", "principal-dedup", fileName, contentType, bytes.length, sha256(bytes),
                classification, retention, metadata));
        artifacts.append("tenant-dedup", upload.uploadId(), 0, bytes);
        return upload;
    }

    private static MediaArtifact upload(
            S3PostgresqlMediaArtifactStore artifacts,
            byte[] bytes,
            String fileName,
            String contentType,
            String classification,
            Duration retention,
            Map<String, Object> metadata) throws Exception {
        UploadSession upload = prepareUpload(
                artifacts, bytes, fileName, contentType, classification, retention, metadata);
        return artifacts.complete("tenant-dedup", upload.uploadId());
    }

    private static void assertConflict(
            S3PostgresqlMediaArtifactStore artifacts,
            byte[] bytes,
            String fileName,
            String contentType,
            String classification,
            Duration retention,
            Map<String, Object> metadata,
            String expectedField) throws Exception {
        UploadSession upload = prepareUpload(
                artifacts, bytes, fileName, contentType, classification, retention, metadata);
        assertThatThrownBy(() -> artifacts.complete("tenant-dedup", upload.uploadId()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("governed metadata")
                .hasMessageContaining(expectedField);
    }

    private static String sha256(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    }
}
