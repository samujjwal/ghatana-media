package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanVerdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactScanner;
import com.ghatana.media.runtime.MediaRuntimeContracts.QuarantinedArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.ListObjectsV2Request;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.http.AbortableInputStream;

import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** IP-06: after restart, a committed S3 locator cannot serve bytes that drift from its source hash. */
@Testcontainers(disabledWithoutDocker = true)
class MediaPostgresqlS3IntegrityRestartTest {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void scannerUnavailableAfterFinalizeKeepsArtifactHiddenAndColdRetryPublishesOnce() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-scan-unavailable-" + runId;
        String prefix = "ip06-scan-unavailable/" + runId;
        String tenant = "tenant-ip06-scan-unavailable-" + runId;
        String principal = "principal-ip06-scan-unavailable-" + runId;
        byte[] bytes = wav(("scanner-unavailable:" + runId).getBytes(StandardCharsets.UTF_8));
        String digest = sha256(bytes);
        createBucket(bucket);

        Map<String, String> environment = environment(bucket, prefix);
        AtomicInteger unavailableScans = new AtomicInteger();
        AtomicInteger cleanScans = new AtomicInteger();
        UploadSession upload;
        String finalKey;
        String stagedChunkKey;
        try {
            try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
                 S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore(
                         unavailableScanner(unavailableScans))) {
                upload = store.begin(new UploadRequest(tenant, principal, "source.wav", "audio/wav",
                        bytes.length, digest, "RESTRICTED", Duration.ofDays(7), Map.of()),
                        "ip06-scan-unavailable-" + runId);
                store.append(tenant, principal, upload.uploadId(), 0, bytes);
                finalKey = prefix + "/quarantine/finalized/" + opaque(tenant) + "/"
                        + upload.uploadId() + "/" + digest;
                stagedChunkKey = chunkObjectKey(tenant, upload.uploadId());

                assertThatThrownBy(() -> store.complete(tenant, principal, upload.uploadId()))
                        .isInstanceOf(IllegalStateException.class)
                        .hasMessageContaining("scan did not return a clean verdict: UNAVAILABLE");
                assertThat(unavailableScans).hasValue(1);
                assertThat(store.upload(tenant, upload.uploadId()).orElseThrow().status())
                        .isEqualTo(com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus.OPEN);
                assertThat(scanStatus(tenant, upload.uploadId())).isEqualTo("UNAVAILABLE");
                assertThat(artifactIdForUpload(tenant, upload.uploadId())).isNull();
                assertThat(artifactCountForTenant(tenant)).isZero();
                assertThat(s3Object(bucket, "s3://" + bucket + "/" + finalKey)).containsExactly(bytes);
                assertThat(s3ObjectCount(bucket, stagedChunkKey)).isEqualTo(1);
                assertThat(chunkRowCount(tenant, upload.uploadId())).isEqualTo(1);
            }

            try (AutoCloseable restartedLifecycle = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
                 S3PostgresqlMediaArtifactStore restarted = new S3PostgresqlMediaArtifactStore(
                         cleanScanner(cleanScans))) {
                MediaArtifact recovered = restarted.complete(tenant, principal, upload.uploadId());
                assertThat(cleanScans).hasValue(1);
                assertThat(recovered.tenantId()).isEqualTo(tenant);
                assertThat(recovered.principalId()).isEqualTo(principal);
                assertThat(recovered.sha256()).isEqualTo(digest);
                assertThat(recovered.sizeBytes()).isEqualTo(bytes.length);
                assertThat(objectKey(recovered.objectReference())).isEqualTo(finalKey);
                assertThat(artifactIdForUpload(tenant, upload.uploadId())).isEqualTo(recovered.artifactId());
                assertThat(restarted.artifact(tenant, recovered.artifactId())).contains(recovered);
                assertThat(artifactCount(tenant, recovered.artifactId())).isEqualTo(1);
                assertThat(s3Object(bucket, recovered.objectReference())).containsExactly(bytes);
                assertThat(s3ObjectCount(bucket, stagedChunkKey)).isZero();
                assertThat(chunkRowCount(tenant, upload.uploadId()))
                        .as("the durable manifest remains available for orphan cleanup replay")
                        .isEqualTo(1);
                assertThat(scanStatus(tenant, upload.uploadId())).isEqualTo("CLEAN");

                MediaArtifact replayed = restarted.complete(tenant, principal, upload.uploadId());
                assertThat(replayed).isEqualTo(recovered);
                assertThat(artifactIdForUpload(tenant, upload.uploadId())).isEqualTo(recovered.artifactId());
                assertThat(artifactCount(tenant, recovered.artifactId())).isEqualTo(1);
                assertThat(s3ObjectCount(bucket, finalKey)).isEqualTo(1);
                assertThat(s3Object(bucket, recovered.objectReference())).containsExactly(bytes);
            }
        } finally {
            deleteBucketObjects(bucket);
        }
    }

    @Test
    void rejectedQuarantinedObjectIsRecordedAndDeletedWithoutArtifactPublication() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-quarantine-" + runId;
        String prefix = "ip06-quarantine/" + runId;
        String tenant = "tenant-ip06-quarantine-" + runId;
        String principal = "principal-ip06-quarantine-" + runId;
        byte[] bytes = wav(("scanner-rejected:" + runId).getBytes(StandardCharsets.UTF_8));
        String digest = sha256(bytes);
        createBucket(bucket);

        Map<String, String> environment = environment(bucket, prefix);
        UploadSession upload;
        String stagedChunkKey;
        AtomicInteger rejectScans = new AtomicInteger();
        AtomicInteger cleanScans = new AtomicInteger();
        AtomicBoolean failDeleteAfterCommit = new AtomicBoolean(true);
        AtomicReference<String> finalizedKey = new AtomicReference<>();
        try {
            try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment,
                         delegate -> failAfterDeleteAcknowledgement(delegate, bucket, finalizedKey,
                                 failDeleteAfterCommit));
                 S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore(
                         rejectingScanner(rejectScans))) {
                upload = store.begin(new UploadRequest(tenant, principal, "rejected.wav", "audio/wav",
                        bytes.length, digest, "RESTRICTED", Duration.ofDays(7), Map.of()),
                        "ip06-quarantine-" + runId);
                store.append(tenant, principal, upload.uploadId(), 0, bytes);
                stagedChunkKey = chunkObjectKey(tenant, upload.uploadId());
                finalizedKey.set(prefix + "/quarantine/finalized/" + opaque(tenant) + "/"
                        + upload.uploadId() + "/" + digest);
                assertThat(s3Object(bucket, "s3://" + bucket + "/" + stagedChunkKey)).containsExactly(bytes);

                assertThatThrownBy(() -> store.complete(tenant, principal, upload.uploadId()))
                        .isInstanceOf(S3Exception.class)
                        .hasMessageContaining("injected after-delete acknowledgement loss");

                UploadSession rejected = store.upload(tenant, upload.uploadId()).orElseThrow();
                assertThat(rejected.status())
                        .isEqualTo(com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus.FINALIZING);
                assertThat(rejectScans).hasValue(1);
                assertThat(cleanScans).hasValue(0);
                assertThat(quarantineObjectCount(bucket, prefix)).as("rejected finalized bytes are deleted").isZero();
                assertThat(s3ObjectCount(bucket, stagedChunkKey)).as("staged bytes remain owned for retry").isEqualTo(1);
                assertThat(chunkRowCount(tenant, upload.uploadId())).as("staged manifest remains retryable").isEqualTo(1);
                assertThat(artifactCountForTenant(tenant)).as("rejected bytes never become artifact metadata").isZero();
                assertThat(scanStatus(tenant, upload.uploadId())).isEqualTo("REJECTED");
            }
            makeFinalizationStale(tenant, upload.uploadId());
            try (AutoCloseable restartedEnvironment = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
                 S3PostgresqlMediaArtifactStore restarted = new S3PostgresqlMediaArtifactStore(
                         cleanScanner(cleanScans))) {
                assertThatThrownBy(() -> restarted.complete(tenant, principal, upload.uploadId()))
                        .isInstanceOf(IllegalStateException.class)
                        .hasMessageContaining("scan did not return a clean verdict: REJECT");
                assertThat(restarted.upload(tenant, upload.uploadId()).orElseThrow().status())
                        .isEqualTo(com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus.ABORTED);
                assertThat(cleanScans).as("persisted rejection bypasses the replacement CLEAN scanner").hasValue(0);
                assertThat(scanStatus(tenant, upload.uploadId())).isEqualTo("REJECTED");
                assertThat(artifactCountForTenant(tenant)).isZero();
                assertThat(s3ObjectCount(bucket, finalizedKey.get())).isZero();
                assertThat(s3ObjectCount(bucket, stagedChunkKey)).isZero();
                assertThat(chunkRowCount(tenant, upload.uploadId())).isZero();
            }
        } finally {
            deleteBucketObjects(bucket);
        }
    }

    @Test
    void restartedReaderRejectsDriftedObjectWithoutPublishingAnUnverifiedPrefix() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-integrity-" + runId;
        String prefix = "ip06-integrity/" + runId;
        String tenant = "tenant-ip06-integrity-" + runId;
        String principal = "principal-ip06-integrity-" + runId;
        byte[] sourceBytes = wav(("source-object-version:" + runId).getBytes(StandardCharsets.UTF_8));
        byte[] tamperedBytes = sourceBytes.clone();
        tamperedBytes[tamperedBytes.length - 1] ^= 0x01;
        String sourceHash = sha256(sourceBytes);
        String sourceArtifactId = "source-artifact-" + runId;
        String sourceVersion = "sha256:" + sourceHash;
        createBucket(bucket);

        Map<String, String> environment = environment(bucket, prefix);
        UploadSession upload;
        MediaArtifact committed;
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore writer = new S3PostgresqlMediaArtifactStore()) {
            UploadRequest request = new UploadRequest(tenant, principal, "source.wav", "audio/wav",
                    sourceBytes.length, sourceHash, "RESTRICTED", Duration.ofDays(7),
                    Map.of("sourceArtifactId", sourceArtifactId, "sourceVersion", sourceVersion));
            upload = writer.begin(request, "ip06-integrity-" + runId);
            writer.append(tenant, principal, upload.uploadId(), 0, sourceBytes);
            committed = writer.complete(tenant, principal, upload.uploadId());
            assertThat(committed.sha256()).isEqualTo(sourceHash);
            assertThat(committed.metadata()).containsEntry("sourceArtifactId", sourceArtifactId)
                    .containsEntry("sourceVersion", sourceVersion);
            assertThat(committed.version()).isEqualTo(ArtifactVersion.fromSha256(sourceHash));
            assertThat(s3Object(bucket, committed.objectReference())).containsExactly(sourceBytes);
        }

        // Model an object-store mutation after the DB transaction committed. Reopening the
        // canonical provider makes the next read a durable readback, not an in-process buffer hit.
        overwriteObject(bucket, committed.objectReference(), tamperedBytes);
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore restarted = new S3PostgresqlMediaArtifactStore()) {
            MediaArtifact persisted = restarted.artifact(tenant, committed.artifactId()).orElseThrow();
            assertThat(persisted.version()).isEqualTo(ArtifactVersion.fromSha256(sourceHash));
            assertThat(persisted.metadata()).containsEntry("sourceArtifactId", sourceArtifactId)
                    .containsEntry("sourceVersion", sourceVersion);

            ByteArrayOutputStream callerSink = new ByteArrayOutputStream();
            assertThatThrownBy(() -> restarted.copyContent(tenant, principal, committed.artifactId(),
                    ArtifactVersion.fromSha256(sourceHash), callerSink, sourceBytes.length))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("do not match the requested immutable version");
            // The reader stages privately and publishes only after complete size/hash verification.
            assertThat(callerSink.size()).as("unverified object bytes must not escape to the caller").isZero();
            assertThat(s3Object(bucket, committed.objectReference())).containsExactly(tamperedBytes);
            assertThat(artifactCount(tenant, committed.artifactId())).isEqualTo(1);
            assertThat(restarted.artifact("wrong-tenant-" + runId, committed.artifactId())).isEmpty();
        } finally {
            deleteBucketObjects(bucket);
        }
    }

    @Test
    void interruptedObjectBodyDoesNotPublishPrefixAndSameVersionCanBeRetried() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-read-interrupt-" + runId;
        String prefix = "ip06-read-interrupt/" + runId;
        String tenant = "tenant-ip06-read-interrupt-" + runId;
        String principal = "principal-ip06-read-interrupt-" + runId;
        byte[] sourceBytes = wav(("interrupted-object-body:" + runId).getBytes(StandardCharsets.UTF_8));
        String sourceHash = sha256(sourceBytes);
        createBucket(bucket);

        Map<String, String> environment = environment(bucket, prefix);
        MediaArtifact committed;
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore writer = new S3PostgresqlMediaArtifactStore()) {
            UploadSession upload = writer.begin(new UploadRequest(tenant, principal, "source.wav", "audio/wav",
                    sourceBytes.length, sourceHash, "RESTRICTED", Duration.ofDays(7), Map.of()),
                    "ip06-read-interrupt-" + runId);
            writer.append(tenant, principal, upload.uploadId(), 0, sourceBytes);
            committed = writer.complete(tenant, principal, upload.uploadId());
            assertThat(committed.sha256()).isEqualTo(sourceHash);
            assertThat(s3Object(bucket, committed.objectReference())).containsExactly(sourceBytes);
        }

        String objectKey = objectKey(committed.objectReference());
        AtomicBoolean failOnce = new AtomicBoolean(true);
        AtomicBoolean interruptedBodyClosed = new AtomicBoolean(false);
        AtomicInteger emittedPrefixBytes = new AtomicInteger();
        try {
            try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment,
                         delegate -> failAfterObjectReadPrefix(delegate, bucket, objectKey, failOnce,
                                 emittedPrefixBytes, interruptedBodyClosed));
                 S3PostgresqlMediaArtifactStore interruptedReader = new S3PostgresqlMediaArtifactStore()) {
                ByteArrayOutputStream callerSink = new ByteArrayOutputStream();
                assertThatThrownBy(() -> interruptedReader.copyContent(tenant, principal, committed.artifactId(),
                        ArtifactVersion.fromSha256(sourceHash), callerSink, sourceBytes.length))
                        .isInstanceOf(IOException.class)
                        .hasMessageContaining("injected after S3 body prefix");
                assertThat(emittedPrefixBytes).as("the GET body yielded a nonempty prefix").hasValue(16);
                assertThat(interruptedBodyClosed).as("the interrupted S3 body is closed").isTrue();
                assertThat(callerSink.size()).as("partial bytes stay in private staging").isZero();
                assertThat(interruptedReader.artifact(tenant, committed.artifactId())).contains(committed);
                assertThat(artifactCount(tenant, committed.artifactId())).isEqualTo(1);
            }

            try (AutoCloseable restartedLifecycle = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
                 S3PostgresqlMediaArtifactStore restartedReader = new S3PostgresqlMediaArtifactStore()) {
                ByteArrayOutputStream callerSink = new ByteArrayOutputStream();
                var receipt = restartedReader.copyContent(tenant, principal, committed.artifactId(),
                        ArtifactVersion.fromSha256(sourceHash), callerSink, sourceBytes.length).orElseThrow();
                assertThat(callerSink.toByteArray()).containsExactly(sourceBytes);
                assertThat(receipt.version()).isEqualTo(ArtifactVersion.fromSha256(sourceHash));
                assertThat(receipt.sha256()).isEqualTo(sourceHash);
                assertThat(receipt.bytesCopied()).isEqualTo(sourceBytes.length);
                assertThat(restartedReader.artifact(tenant, committed.artifactId())).contains(committed);
                assertThat(artifactCount(tenant, committed.artifactId())).isEqualTo(1);
            }
        } finally {
            deleteBucketObjects(bucket);
        }
    }

    @Test
    void staleRejectScannerCannotDeleteObjectPublishedByNewFinalizationToken() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-stale-reject-" + runId;
        String prefix = "ip06-stale-reject/" + runId;
        String tenant = "tenant-ip06-stale-reject-" + runId;
        String principal = "principal-ip06-stale-reject-" + runId;
        byte[] bytes = wav(("stale-reject-source:" + runId).getBytes(StandardCharsets.UTF_8));
        String digest = sha256(bytes);
        createBucket(bucket);
        Map<String, String> environment = environment(bucket, prefix);
        CountDownLatch rejectScannerEntered = new CountDownLatch(1);
        CountDownLatch releaseRejectScanner = new CountDownLatch(1);
        AtomicInteger staleScans = new AtomicInteger();
        AtomicInteger currentScans = new AtomicInteger();
        ExecutorService executor = Executors.newSingleThreadExecutor();

        try {
            try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
                 S3PostgresqlMediaArtifactStore staleStore = new S3PostgresqlMediaArtifactStore(
                         blockingRejectScanner(staleScans, rejectScannerEntered, releaseRejectScanner));
                 S3PostgresqlMediaArtifactStore currentStore = new S3PostgresqlMediaArtifactStore(
                         cleanScanner(currentScans))) {
                UploadSession upload = staleStore.begin(new UploadRequest(tenant, principal, "source.wav", "audio/wav",
                        bytes.length, digest, "RESTRICTED", Duration.ofDays(7), Map.of()),
                        "ip06-stale-reject-" + runId);
                staleStore.append(tenant, principal, upload.uploadId(), 0, bytes);
                Future<?> staleCompletion = executor.submit(
                        () -> staleStore.complete(tenant, principal, upload.uploadId()));
                assertThat(rejectScannerEntered.await(10, TimeUnit.SECONDS))
                        .as("first finalizer reaches scanner after S3 finalize").isTrue();
                makeFinalizationStale(tenant, upload.uploadId());

                MediaArtifact currentArtifact = currentStore.complete(tenant, principal, upload.uploadId());
                assertThat(currentArtifact.sha256()).isEqualTo(digest);
                String finalKey = objectKey(currentArtifact.objectReference());
                assertThat(s3Object(bucket, currentArtifact.objectReference())).containsExactly(bytes);
                assertThat(artifactCountForTenant(tenant)).isEqualTo(1);

                releaseRejectScanner.countDown();
                assertThatThrownBy(() -> staleCompletion.get(15, TimeUnit.SECONDS))
                        .isInstanceOf(ExecutionException.class)
                        .hasRootCauseInstanceOf(IllegalStateException.class)
                        .hasRootCauseMessage("Media upload finalization ownership changed before scanner status was recorded");
                assertThat(staleScans).hasValue(1);
                assertThat(currentScans).hasValue(1);
                assertThat(staleStore.upload(tenant, upload.uploadId()).orElseThrow().status())
                        .isEqualTo(com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus.COMPLETED);
                assertThat(scanStatus(tenant, upload.uploadId())).isEqualTo("CLEAN");
                assertThat(artifactCountForTenant(tenant)).isEqualTo(1);
                assertThat(s3Object(bucket, "s3://" + bucket + "/" + finalKey)).containsExactly(bytes);
            }
        } finally {
            releaseRejectScanner.countDown();
            executor.shutdownNow();
            deleteBucketObjects(bucket);
        }
    }

    private static Map<String, String> environment(String bucket, String prefix) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_IP06_INTEGRITY_DB_PASSWORD");
        environment.put("MEDIA_IP06_INTEGRITY_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_PREFIX", prefix);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_IP06_INTEGRITY_S3_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_IP06_INTEGRITY_S3_SECRET");
        environment.put("MEDIA_IP06_INTEGRITY_S3_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_IP06_INTEGRITY_S3_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }

    private static S3Client s3Client() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();
    }

    private static void createBucket(String bucket) {
        try (S3Client s3 = s3Client()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
    }

    private static void overwriteObject(String bucket, String reference, byte[] bytes) {
        try (S3Client s3 = s3Client()) {
            s3.putObject(PutObjectRequest.builder().bucket(bucket).key(objectKey(reference))
                    .contentLength((long) bytes.length).build(), RequestBody.fromBytes(bytes));
        }
    }

    private static byte[] s3Object(String bucket, String reference) throws Exception {
        try (S3Client s3 = s3Client()) {
            try (var object = s3.getObject(
                    GetObjectRequest.builder().bucket(bucket).key(objectKey(reference)).build())) {
                return object.readAllBytes();
            }
        }
    }

    private static void deleteBucketObjects(String bucket) {
        try (S3Client s3 = s3Client()) {
            for (var object : s3.listObjectsV2(ListObjectsV2Request.builder().bucket(bucket).build()).contents()) {
                s3.deleteObject(b -> b.bucket(bucket).key(object.key()));
            }
            s3.deleteBucket(b -> b.bucket(bucket));
        } catch (RuntimeException ignored) {
            // Disposable LocalStack and PostgreSQL containers are the outer cleanup boundary.
        }
    }

    private static int artifactCount(String tenant, String artifactId) throws Exception {
        try (var connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=? AND artifact_id=?")) {
            query.setString(1, tenant);
            query.setString(2, artifactId);
            try (var rows = query.executeQuery()) {
                rows.next();
                return rows.getInt(1);
            }
        }
    }

    private static int artifactCountForTenant(String tenant) throws Exception {
        try (var connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement("SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=?")) {
            query.setString(1, tenant);
            try (var rows = query.executeQuery()) {
                rows.next();
                return rows.getInt(1);
            }
        }
    }

    private static String artifactIdForUpload(String tenant, String uploadId) throws Exception {
        try (var connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(
                     "SELECT artifact_id FROM media_upload_sessions WHERE tenant_id=? AND upload_id=?")) {
            query.setString(1, tenant);
            query.setString(2, uploadId);
            try (var rows = query.executeQuery()) {
                if (!rows.next()) throw new AssertionError("upload row disappeared");
                return rows.getString(1);
            }
        }
    }

    private static String scanStatus(String tenant, String uploadId) throws Exception {
        try (var connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(
                     "SELECT scan_status FROM media_upload_sessions WHERE tenant_id=? AND upload_id=?")) {
            query.setString(1, tenant);
            query.setString(2, uploadId);
            try (var rows = query.executeQuery()) {
                if (!rows.next()) throw new AssertionError("rejected upload row disappeared");
                return rows.getString(1);
            }
        }
    }

    private static int quarantineObjectCount(String bucket, String prefix) {
        try (S3Client s3 = s3Client()) {
            return s3.listObjectsV2(ListObjectsV2Request.builder()
                    .bucket(bucket).prefix(prefix + "/quarantine/finalized/").build()).contents().size();
        }
    }

    private static int s3ObjectCount(String bucket, String key) {
        try (S3Client s3 = s3Client()) {
            return s3.listObjectsV2(ListObjectsV2Request.builder().bucket(bucket).prefix(key).build())
                    .contents().size();
        }
    }

    private static int chunkRowCount(String tenant, String uploadId) throws Exception {
        try (var connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_upload_chunks WHERE tenant_id=? AND upload_id=?")) {
            query.setString(1, tenant);
            query.setString(2, uploadId);
            try (var rows = query.executeQuery()) {
                rows.next();
                return rows.getInt(1);
            }
        }
    }

    private static String chunkObjectKey(String tenant, String uploadId) throws Exception {
        try (var connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(
                     "SELECT object_key FROM media_upload_chunks WHERE tenant_id=? AND upload_id=? AND chunk_index=0")) {
            query.setString(1, tenant);
            query.setString(2, uploadId);
            try (var rows = query.executeQuery()) {
                if (!rows.next()) throw new AssertionError("staged chunk manifest row is missing");
                return rows.getString(1);
            }
        }
    }

    private static MediaArtifactScanner rejectingScanner(AtomicInteger scans) {
        return new MediaArtifactScanner() {
            @Override public String scannerId() { return "ip06-test-rejector"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }

            @Override
            public ArtifactScanDecision scan(QuarantinedArtifact artifact) {
                scans.incrementAndGet();
                Instant now = Instant.now();
                return new ArtifactScanDecision(scannerId(), "test-v1", "ip06-test-policy", "v1",
                        artifact.tenantId(), artifact.principalId(), artifact.uploadId(), artifact.sha256(),
                        artifact.sizeBytes(), artifact.contentType(), ArtifactScanVerdict.REJECT,
                        now, now.plusSeconds(60));
            }
        };
    }

    private static MediaArtifactScanner unavailableScanner(AtomicInteger scans) {
        return new MediaArtifactScanner() {
            @Override public String scannerId() { return "ip06-test-unavailable-scanner"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }

            @Override
            public ArtifactScanDecision scan(QuarantinedArtifact artifact) {
                scans.incrementAndGet();
                Instant now = Instant.now();
                return new ArtifactScanDecision(scannerId(), "test-v1", "ip06-test-policy", "v1",
                        artifact.tenantId(), artifact.principalId(), artifact.uploadId(), artifact.sha256(),
                        artifact.sizeBytes(), artifact.contentType(), ArtifactScanVerdict.UNAVAILABLE,
                        now, now.plusSeconds(60));
            }
        };
    }

    private static MediaArtifactScanner cleanScanner(AtomicInteger scans) {
        return new MediaArtifactScanner() {
            @Override public String scannerId() { return "ip06-test-clean-retry"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }

            @Override
            public ArtifactScanDecision scan(QuarantinedArtifact artifact) {
                scans.incrementAndGet();
                Instant now = Instant.now();
                return new ArtifactScanDecision(scannerId(), "test-v1", "ip06-test-policy", "v1",
                        artifact.tenantId(), artifact.principalId(), artifact.uploadId(), artifact.sha256(),
                        artifact.sizeBytes(), artifact.contentType(), ArtifactScanVerdict.CLEAN,
                        now, now.plusSeconds(60));
            }
        };
    }

    private static MediaArtifactScanner blockingRejectScanner(
            AtomicInteger scans, CountDownLatch entered, CountDownLatch release) {
        return new MediaArtifactScanner() {
            @Override public String scannerId() { return "ip06-test-blocking-rejector"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }

            @Override
            public ArtifactScanDecision scan(QuarantinedArtifact artifact) {
                scans.incrementAndGet();
                entered.countDown();
                try {
                    if (!release.await(15, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("test scanner release timed out");
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("test scanner was interrupted", interrupted);
                }
                Instant now = Instant.now();
                return new ArtifactScanDecision(scannerId(), "test-v1", "ip06-test-policy", "v1",
                        artifact.tenantId(), artifact.principalId(), artifact.uploadId(), artifact.sha256(),
                        artifact.sizeBytes(), artifact.contentType(), ArtifactScanVerdict.REJECT,
                        now, now.plusSeconds(60));
            }
        };
    }

    private static S3Client failAfterDeleteAcknowledgement(
            S3Client delegate, String bucket, AtomicReference<String> targetKey, AtomicBoolean failOnce) {
        return (S3Client) Proxy.newProxyInstance(S3Client.class.getClassLoader(), new Class<?>[] {S3Client.class},
                (proxy, method, arguments) -> {
                    Object result;
                    try {
                        result = method.invoke(delegate, arguments);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                    if ("deleteObject".equals(method.getName()) && arguments != null && arguments.length > 0
                            && arguments[0] instanceof DeleteObjectRequest request
                            && bucket.equals(request.bucket()) && request.key().equals(targetKey.get())
                            && failOnce.compareAndSet(true, false)) {
                        throw S3Exception.builder().statusCode(503)
                                .message("injected after-delete acknowledgement loss").build();
                    }
                    return result;
                });
    }

    private static S3Client failAfterObjectReadPrefix(
            S3Client delegate, String bucket, String targetKey, AtomicBoolean failOnce,
            AtomicInteger emittedPrefixBytes, AtomicBoolean interruptedBodyClosed) {
        return (S3Client) Proxy.newProxyInstance(S3Client.class.getClassLoader(), new Class<?>[] {S3Client.class},
                (proxy, method, arguments) -> {
                    Object result;
                    try {
                        result = method.invoke(delegate, arguments);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                    if ("getObject".equals(method.getName()) && arguments != null && arguments.length > 0
                            && arguments[0] instanceof GetObjectRequest request
                            && bucket.equals(request.bucket()) && targetKey.equals(request.key())
                            && failOnce.compareAndSet(true, false)
                            && result instanceof ResponseInputStream<?> response) {
                        @SuppressWarnings("unchecked")
                        ResponseInputStream<software.amazon.awssdk.services.s3.model.GetObjectResponse> object =
                                (ResponseInputStream<software.amazon.awssdk.services.s3.model.GetObjectResponse>) response;
                        InputStream interruptedBody = new FilterInputStream(object) {
                            private static final int PREFIX_BYTES = 16;
                            private int remaining = PREFIX_BYTES;

                            @Override
                            public int read() throws IOException {
                                if (remaining == 0) throw injectedReadFailure();
                                int value = super.read();
                                if (value >= 0) {
                                    remaining--;
                                    emittedPrefixBytes.incrementAndGet();
                                }
                                return value;
                            }

                            @Override
                            public int read(byte[] bytes, int offset, int length) throws IOException {
                                if (remaining == 0) throw injectedReadFailure();
                                int count = super.read(bytes, offset, Math.min(length, remaining));
                                if (count > 0) {
                                    remaining -= count;
                                    emittedPrefixBytes.addAndGet(count);
                                }
                                return count;
                            }

                            private IOException injectedReadFailure() {
                                return new IOException("injected after S3 body prefix");
                            }

                            @Override
                            public void close() throws IOException {
                                interruptedBodyClosed.set(true);
                                super.close();
                            }
                        };
                        return new ResponseInputStream<>(object.response(),
                                AbortableInputStream.create(interruptedBody, object::abort));
                    }
                    return result;
                });
    }

    private static void makeFinalizationStale(String tenant, String uploadId) throws Exception {
        try (var connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var update = connection.prepareStatement(
                     "UPDATE media_upload_sessions SET finalization_started_at=? WHERE tenant_id=? AND upload_id=?")) {
            update.setLong(1, System.currentTimeMillis() - Duration.ofMinutes(16).toMillis());
            update.setString(2, tenant);
            update.setString(3, uploadId);
            assertThat(update.executeUpdate()).isEqualTo(1);
        }
    }

    private static String opaque(String value) throws Exception {
        return sha256(value.getBytes(StandardCharsets.UTF_8)).substring(0, 32);
    }

    private static String objectKey(String reference) {
        return java.net.URI.create(reference).getPath().substring(1);
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

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
